/** @param {NS} ns */
//
// monitor-deploy.js — long-lived wrapper that re-invokes deploy.js on
// a timer. Each tick runs `deploy.js` (which does the actual fan-out
// work) and waits for it to finish. deploy.js is the one source of
// truth for the per-host logic — this file is only the loop.
//
// Why a separate file:
//   deploy.js is the one-shot version. It does a single pass, prints
//   the full status table, then exits. That's the right shape for
//   "run this once after an aug and see what's going on". But for the
//   always-on "I just nicked a new server, fan workers out to it"
//   use-case, a one-shot doesn't pick up newly-nuked hosts — you'd
//   have to remember to re-run it. monitor-deploy.js handles that
//   automatically.
//
//   The original deploy.js had a 5-minute auto-restart baked in
//   (line 159). That was the right idea but wrong cadence: 5 minutes
//   is too long to wait for a newly-nuked target to start producing,
//   and the bake-in meant there was no way to run a one-shot without
//   editing the file. Splitting into deploy.js + monitor-deploy.js
//   separates the two use-cases cleanly.
//
// Idempotent: re-running is safe. deploy.js itself skips hosts that
// already have the worker running, so subsequent passes are mostly
// no-ops except for any new server that became nukable / hackable.
//
// Default cadence: 30s. Override with --interval <ms>. The 30s
// default is the same as the other monitors (monitor-backdoor,
// monitor-buy) so the network "settles" together — when a new server
// gets rooted, all the relevant picks happen in the same 30s window.
//
// Output: deploy.js does its own printing; we just relay and wait.
// Pass --quiet to deploy.js by default — we don't want a fresh status
// table every 30s. --once runs a single deploy.js pass with full
// output (the diagnostic use case).
//
// Usage:
//   run monitor-deploy.js                  # loop, every 30s
//   run monitor-deploy.js --once           # one deploy.js pass, full output, then exit
//   run monitor-deploy.js --interval 15000 # loop, every 15s
//   run monitor-deploy.js --verbose        # re-enable deploy.js per-host output
//   run monitor-deploy.js --force          # override mid-game guard (manager.js running)
//   run monitor-deploy.js -- hack-loop.js  # custom worker (passed to deploy.js)
//
// Requires deploy.js to be present on home (it normally is, via the
// standard build pipeline).
//
// Mid-game refusal: mirrors deploy.js. If manager.js is running on
// home, the centralized HWGW orchestrator already owns the rooted
// target set. Per-server hack-loop.js fan-out at this point drains
// moneyAvailable on a continuous loop and breaks manager.js's
// pserv-launched ns.hack() (returns $0.000 on otherwise-sane
// targets — Pitfall 8 in bitburner-dev: per-server and centralized
// HWGW systems can't coexist). The wrapper refuses to launch
// deploy.js, prints a clear actionable message, and (in loop mode)
// re-checks every interval so killing manager.js resumes the
// fan-out without manual restart. --force opts in for the
// early-game case or for explicit testing. The same check is also
// in deploy.js itself as belt-and-suspenders — running `deploy.js`
// directly with manager.js up refuses on its own. The
// wrapper-level check is the one that matters for the 30s loop,
// since the child check would otherwise fire on every tick.
//
const USAGE = `Usage:
run monitor-deploy.js                  # loop, every 30s, QUIET (default)
run monitor-deploy.js --once           # one deploy.js pass with full output, then exit
run monitor-deploy.js --interval 15000 # loop, every 15s
run monitor-deploy.js --verbose        # loop with per-host DEPLOY/SKIP lines
run monitor-deploy.js --force          # override mid-game guard (manager.js running)
run monitor-deploy.js -- worker.js     # custom worker (default: hack-loop.js)
`;

const DEPLOY = "deploy.js";
const DEFAULT_INTERVAL_MS = 30_000;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  ns.disableLog("sleep");

  // Refuse to run if deploy.js isn't on home. Without it, every tick
  // would silently no-op. The check is cheap and turns a confusing
  // failure mode (process that does nothing, no error) into a clear
  // one.
  if (!ns.fileExists(DEPLOY, "home")) {
    ns.tprint(`monitor-deploy: ${DEPLOY} not on home — push it via filesync first`);
    return;
  }

  // Parse our own flags first, then forward everything else to
  // deploy.js verbatim. The `--` separator is conventional for
  // "everything after this is for the child" but we don't strictly
  // require it — any arg that isn't one of ours is passed through.
  // This way `run monitor-deploy.js --interval 15000` works the same
  // as `run monitor-deploy.js hack-loop.js` (pass hack-loop.js as the
  // worker arg to deploy.js).
  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const force = args.includes("--force");
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0
    ? Number(args[intervalIdx + 1])
    : DEFAULT_INTERVAL_MS;
  if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
    ns.tprint(`monitor-deploy: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
    return;
  }

  // Mid-game guard (mirrors deploy.js): if manager.js is running on
  // home, the centralized HWGW orchestrator already owns the rooted
  // target set. Per-server hack-loop.js fan-out at this point
  // drains moneyAvailable on a continuous loop and breaks
  // manager.js's pserv-launched ns.hack() (returns $0.000 on
  // otherwise-sane targets — Pitfall 8 in bitburner-dev). Refuse
  // here at the wrapper level so the message prints once per
  // 30s tick instead of bubbling up from every nested deploy.js
  // child. --force opts in for the early-game case or for explicit
  // testing. Note: the same check is also in deploy.js itself as
  // belt-and-suspenders — if someone runs `deploy.js` directly
  // while manager.js is up, deploy.js refuses on its own. This
  // wrapper-level check is the one that matters for the
  // monitor-deploy.js 30s loop, since the child check would
  // otherwise fire on every tick.
  const managerRunning = ns.ps("home").some((p) => p.filename === "manager.js");
  if (managerRunning && !force) {
    ns.tprint(
      "monitor-deploy: refused — manager.js is running on home. " +
      "The centralized HWGW orchestrator already owns the rooted target set; " +
      "per-server hack-loop.js fan-out drains moneyAvailable and breaks " +
      "manager.js's $X.XXX hacks (Pitfall 8 in bitburner-dev). " +
      "Pass --force to override, or run manager.js for the centralized system."
    );
    // If the user passed --once, return immediately (one-shot
    // mode). Otherwise, sleep the full interval and re-check — if
    // manager.js is killed later, monitor-deploy.js will resume on
    // its own without requiring a manual restart. This is the
    // same restart-on-collision pattern master.js uses for its
    // own MONITORS.
    if (once) return;
    while (managerRunning) {
      await ns.sleep(intervalMs);
      // Re-check on every wake. Cheap (one ns.ps() call).
      if (!ns.ps("home").some((p) => p.filename === "manager.js")) break;
    }
  }

  // Build the deploy.js arg list: pass through everything except
  // our own flags (--once, --interval, --verbose, --help/-h,
  // --force, and the value after --interval). deploy.js doesn't
  // know about those. --force is consumed by the wrapper's
  // mid-game guard above; passing it through would have deploy.js
  // print a "WARNING --force with manager.js running" line that
  // doesn't apply (the wrapper already handled the override
  // decision). We ADD --quiet by default so the 30s loop doesn't
  // flood the terminal — --verbose opts out, --once always wants
  // full output.
  const deployArgs = args.filter((a, i) => {
    if (a === "--once" || a === "--verbose" || a === "-h" || a === "--help" || a === "--force") return false;
    if (a === "--interval") return false;
    if (i > 0 && args[i - 1] === "--interval") return false;  // the value after --interval
    return true;
  });
  if (!verbose && !once && !deployArgs.includes("--quiet")) {
    deployArgs.push("--quiet");
  }

  // One deploy.js invocation. We wait for it to finish so we know
  // when to fire the next tick — running two deploy.js passes in
  // parallel would race on `ps host` and could double-deploy
  // workers.
  async function runDeployOnce() {
    const pid = ns.run(DEPLOY, 1, ...deployArgs);
    if (pid === 0) {
      ns.tprint(`monitor-deploy: failed to start ${DEPLOY} (not enough RAM?) — will retry on next tick`);
      return false;
    }
    while (ns.isRunning(pid)) await ns.sleep(200);
    return true;
  }

  if (once) {
    await runDeployOnce();
    return;
  }

  if (verbose) ns.tprint(`monitor-deploy: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, deploy-args=[${deployArgs.join(" ") || "(none)"}]`);
  while (true) {
    await runDeployOnce();
    await ns.sleep(intervalMs);
  }
}
