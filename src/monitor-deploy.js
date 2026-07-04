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
//   run monitor-deploy.js -- hack-loop.js  # custom worker (passed to deploy.js)
//
// Requires deploy.js to be present on home (it normally is, via the
// standard build pipeline).
//
const USAGE = `Usage:
run monitor-deploy.js                  # loop, every 30s, QUIET (default)
run monitor-deploy.js --once           # one deploy.js pass with full output, then exit
run monitor-deploy.js --interval 15000 # loop, every 15s
run monitor-deploy.js --verbose        # loop with per-host DEPLOY/SKIP lines
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
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0
    ? Number(args[intervalIdx + 1])
    : DEFAULT_INTERVAL_MS;
  if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
    ns.tprint(`monitor-deploy: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
    return;
  }

  // Build the deploy.js arg list: pass through everything except
  // our own flags (--once, --interval, --verbose, --help/-h, and the
  // value after --interval). deploy.js doesn't know about those.
  // We ADD --quiet by default so the 30s loop doesn't flood the
  // terminal — --verbose opts out, --once always wants full output.
  const deployArgs = args.filter((a, i) => {
    if (a === "--once" || a === "--verbose" || a === "-h" || a === "--help") return false;
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
