/** @param {NS} ns */
//
// Long-lived wrapper that re-invokes nuke.js on a timer. Each tick
// just runs `nuke.js` (which does the actual port-opening + nuke work)
// and waits for it to finish. nuke.js is the one source of truth for
// the per-host logic — this file is only the loop.
//
// Idempotent: re-running is safe. nuke.js itself skips already-rooted
// hosts, so subsequent passes are mostly no-ops except for any new
// server that became reachable (new purchase, new backdoor, etc.).
//
// Output defaults to QUIET — only NUKED / FAIL / summary lines are
// printed. Otherwise the terminal fills up with the same SKIP-hack
// lines every interval. Pass --verbose to re-enable per-host SKIP
// output. --once always prints full output (it's a diagnostic run).
//
// Why a separate file:
//   nuke.js is the one-shot version. Players with limited home RAM
//   can run it directly without paying for a long-lived monitor.
//   monitor-nuke.js is the always-on version for players with RAM
//   to spare. The two are independent — deleting one doesn't break
//   the other.
//
// Requires nuke.js to be present on home (it normally is, via the
// standard build pipeline).
//
// Usage:
//   run monitor-nuke.js                       # loop, every 60s, QUIET (default)
//   run monitor-nuke.js --once                # one nuke.js pass with full output, then exit
//   run monitor-nuke.js --interval 30000      # loop, every 30s, QUIET
//   run monitor-nuke.js --targets CSEC        # pin mode (passed to nuke.js), QUIET
//   run monitor-nuke.js --verbose             # loop with per-host SKIP lines (the old loud behavior)
//
const USAGE = `Usage:
  run monitor-nuke.js                          # loop, every 60s, QUIET (default)
  run monitor-nuke.js --once                   # one nuke.js pass with full output, then exit
  run monitor-nuke.js --interval 30000         # loop, every 30s, QUIET
  run monitor-nuke.js --targets neo-net CSEC   # pin mode (passed to nuke.js), QUIET
  run monitor-nuke.js --verbose                # loop with per-host SKIP lines (the old loud behavior)
`;

const NUKE = "nuke.js";
const DEFAULT_INTERVAL_MS = 60_000;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }

  // Refuse to run if nuke.js isn't on home. Without it, every tick
  // would silently no-op. The check is cheap and turns a confusing
  // failure mode into a clear one.
  if (!ns.fileExists(NUKE, "home")) {
    ns.tprint(`monitor-nuke: ${NUKE} not on home — push it via filesync first`);
    return;
  }

  // Parse args. --targets and its positional list pass through to
  // nuke.js verbatim. --once means a single nuke.js run then exit.
  // --verbose opts back into per-host SKIP lines; default is quiet.
  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0
    ? Number(args[intervalIdx + 1])
    : DEFAULT_INTERVAL_MS;
  if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
    ns.tprint(`monitor-nuke: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
    return;
  }

  // Strip our flags from the arg list before forwarding to nuke.js.
  // nuke.js doesn't know about --once, --interval, or --verbose, so
  // we remove those. --quiet is special: we ADD it by default (unless
  // the user passed --verbose or --once, which always want full output).
  const nukeArgs = args.filter((_, i) => {
    if (args[i - 1] === "--interval") return false;  // the value after --interval
    if (args[i] === "--once") return false;
    if (args[i] === "--interval") return false;
    if (args[i] === "--verbose") return false;
    return true;
  });
  // Default to quiet. --verbose opts out. --once always wants full
  // output (it's a diagnostic run).
  if (!verbose && !once && !nukeArgs.includes("--quiet")) {
    nukeArgs.push("--quiet");
  }

  // One nuke.js invocation. nuke.js does its own printing; we wait
  // for it to finish so we know when to fire the next tick.
  async function runNukeOnce() {
    const pid = ns.run(NUKE, 1, ...nukeArgs);
    if (pid === 0) {
      ns.tprint(`monitor-nuke: failed to start ${NUKE} (not enough RAM?) — will retry on next tick`);
      return false;
    }
    while (ns.isRunning(pid)) await ns.sleep(200);
    return true;
  }

  if (once) {
    await runNukeOnce();
    return;
  }

  ns.tprint(`monitor-nuke: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, nuke-args=[${nukeArgs.join(" ") || "(none)"}]`);
  while (true) {
    await runNukeOnce();
    await ns.sleep(intervalMs);
  }
}
