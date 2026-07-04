/** @param {NS} ns */
//
// monitor-sync.js — long-lived wrapper that re-runs sync-all.js on
// a timer. Each tick runs `sync-all.js` (which does the actual
// push-to-network work) and waits for it to finish. sync-all.js is
// the one source of truth for the per-host sync logic — this file
// is only the loop.
//
// Why a separate file:
//   sync-all.js is the one-shot version. It does a single pass over
//   the network, prints the full status table, then exits. That's the
//   right shape for "I just edited a script, push it out once and
//   see what got where". But for the always-on "filesync is feeding
//   me new edits and I want the fleet to pick them up automatically"
//   use-case, a one-shot means you have to remember to re-run it
//   after every save. monitor-sync.js handles that automatically.
//
// Idempotent: sync-all.js is safe to re-run — scp overwrites and the
// rm of stale files only fires when a host has a file home doesn't.
//
// Default cadence: 30s. Override with --interval <ms>. The 30s default
// is the same as the other 30s monitors (monitor-backdoor,
// monitor-deploy, monitor-buy) so the network "settles" together —
// when a new server gets rooted, all the relevant picks happen in the
// same 30s window.
//
//   Why not faster? sync-all.js does an scp per home-file per
//   reachable server and a ps() per host. At 30s × 25 pservs × N
//   worker files, that's a lot of churn. Filesync (the external
//   tool that watches your local src/ and writes to home) is the
//   real-time path; the 30s re-run is the safety net for state
//   drift.
//
// Output: sync-all.js does its own printing; we just relay and wait.
// Pass --keep-stale to sync-all.js if you don't want it to remove
// files that exist on remote but not on home. --once runs a single
// sync-all.js pass with full output (the diagnostic use case).
//
// Usage:
//   run monitor-sync.js                  # loop, every 30s
//   run monitor-sync.js --once           # one sync-all.js pass, full output, then exit
//   run monitor-sync.js --interval 15000 # loop, every 15s
//   run monitor-sync.js --keep-stale     # forward to sync-all.js: don't remove stale files
//
// Requires sync-all.js to be present on home (it normally is, via
// the standard build pipeline).
//
const USAGE = `Usage:
run monitor-sync.js                  # loop, every 30s
run monitor-sync.js --once           # one sync-all.js pass, full output, then exit
run monitor-sync.js --interval 15000 # loop, every 15s
run monitor-sync.js --keep-stale     # forward to sync-all.js: don't remove stale files
`;

const SYNC = "sync-all.js";
const DEFAULT_INTERVAL_MS = 30_000;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  ns.disableLog("sleep");

  // Refuse to run if sync-all.js isn't on home. Without it, every
  // tick would silently no-op. The check is cheap and turns a
  // confusing failure mode (process that does nothing, no error)
  // into a clear one.
  if (!ns.fileExists(SYNC, "home")) {
    ns.tprint(`monitor-sync: ${SYNC} not on home — push it via filesync first`);
    return;
  }

  // Parse our own flags first, then forward everything else to
  // sync-all.js verbatim. The `--` separator is conventional for
  // "everything after this is for the child" but we don't strictly
  // require it — any arg that isn't one of ours is passed through.
  // This way `run monitor-sync.js --keep-stale` and `run
  // monitor-sync.js --keep-stale --verbose` (if we ever add a
  // --verbose) both work.
  const args = ns.args.slice();
  const once = args.includes("--once");
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0
    ? Number(args[intervalIdx + 1])
    : DEFAULT_INTERVAL_MS;
  if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
    ns.tprint(`monitor-sync: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
    return;
  }

  // Build the sync-all.js arg list: pass through everything except
  // our own flags (--once, --interval, --help/-h, and the value
  // after --interval). sync-all.js doesn't know about those.
  const syncArgs = args.filter((a, i) => {
    if (a === "--once" || a === "-h" || a === "--help") return false;
    if (a === "--interval") return false;
    if (i > 0 && args[i - 1] === "--interval") return false;  // the value after --interval
    return true;
  });

  // One sync-all.js invocation. We wait for it to finish so we know
  // when to fire the next tick — running two sync-all.js passes in
  // parallel would race on `ps host` and could double-remove stale
  // files.
  async function runSyncOnce() {
    const pid = ns.run(SYNC, 1, ...syncArgs);
    if (pid === 0) {
      ns.tprint(`monitor-sync: failed to start ${SYNC} (not enough RAM?) — will retry on next tick`);
      return false;
    }
    while (ns.isRunning(pid)) await ns.sleep(200);
    return true;
  }

  if (once) {
    await runSyncOnce();
    return;
  }

  ns.tprint(`monitor-sync: started, interval=${intervalMs}ms, sync-args=[${syncArgs.join(" ") || "(none)"}]`);
  while (true) {
    await runSyncOnce();
    await ns.sleep(intervalMs);
  }
}
