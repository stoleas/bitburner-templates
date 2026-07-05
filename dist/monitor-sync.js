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
// files that exist on remote but not on home. Pass --quiet to
// sync-all.js if you don't want the per-host SKIP/SYNCED lines
// (recommended for the 30s loop — the cluster is huge and the
// per-host status is noise). --once runs a single sync-all.js pass
// with full output (the diagnostic use case).
//
// Usage:
//   run monitor-sync.js                  # loop, every 30s, QUIET (default)
//   run monitor-sync.js --once           # one sync-all.js pass, full output, then exit
//   run monitor-sync.js --interval 15000 # loop, every 15s
//   run monitor-sync.js --keep-stale     # forward to sync-all.js: don't remove stale files
//   run monitor-sync.js --verbose        # loop, full per-host output (no --quiet)
//
// Requires sync-all.js to be present on home (it normally is, via
// the standard build pipeline).
//
const USAGE = `Usage:
run monitor-sync.js                  # loop, every 30s, QUIET (default)
run monitor-sync.js --once           # one sync-all.js pass, full output, then exit
run monitor-sync.js --interval 15000 # loop, every 15s
run monitor-sync.js --keep-stale     # forward to sync-all.js: don't remove stale files
run monitor-sync.js --verbose        # loop, full per-host output
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
    const args = ns.args.slice();
    const once = args.includes("--once");
    const verbose = args.includes("--verbose");
    const intervalIdx = args.indexOf("--interval");
    const intervalMs = intervalIdx >= 0
        ? Number(args[intervalIdx + 1])
        : DEFAULT_INTERVAL_MS;
    if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
        ns.tprint(`monitor-sync: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
        return;
    }
    // Build the sync-all.js arg list: pass through everything except
    // our own flags (--once, --interval, --verbose, --help/-h, and
    // the value after --interval). sync-all.js doesn't know about
    // those. We ADD --quiet by default so the 30s loop doesn't flood
    // the terminal with per-host SKIP/SYNCED lines — --verbose opts
    // out, --once always wants full output.
    const syncArgs = args.filter((a, i) => {
        if (a === "--once" || a === "--verbose" || a === "-h" || a === "--help")
            return false;
        if (a === "--interval")
            return false;
        if (i > 0 && args[i - 1] === "--interval")
            return false; // the value after --interval
        return true;
    });
    if (!verbose && !once && !syncArgs.includes("--quiet")) {
        syncArgs.push("--quiet");
    }
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
        while (ns.isRunning(pid))
            await ns.sleep(200);
        return true;
    }
    if (once) {
        await runSyncOnce();
        return;
    }
    if (verbose)
        ns.tprint(`monitor-sync: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, sync-args=[${syncArgs.join(" ") || "(none)"}]`);
    while (true) {
        await runSyncOnce();
        await ns.sleep(intervalMs);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21vbml0b3Itc3luYy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLG1FQUFtRTtBQUNuRSwrREFBK0Q7QUFDL0QsbUVBQW1FO0FBQ25FLGtFQUFrRTtBQUNsRSxvQkFBb0I7QUFDcEIsRUFBRTtBQUNGLHVCQUF1QjtBQUN2QixvRUFBb0U7QUFDcEUsc0VBQXNFO0FBQ3RFLGtFQUFrRTtBQUNsRSxvRUFBb0U7QUFDcEUscUVBQXFFO0FBQ3JFLGlFQUFpRTtBQUNqRSxrRUFBa0U7QUFDbEUsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxvRUFBb0U7QUFDcEUsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSwyREFBMkQ7QUFDM0QsbUVBQW1FO0FBQ25FLHNFQUFzRTtBQUN0RSxtQkFBbUI7QUFDbkIsRUFBRTtBQUNGLDhEQUE4RDtBQUM5RCxpRUFBaUU7QUFDakUsZ0VBQWdFO0FBQ2hFLGlFQUFpRTtBQUNqRSwrREFBK0Q7QUFDL0QsV0FBVztBQUNYLEVBQUU7QUFDRixxRUFBcUU7QUFDckUsa0VBQWtFO0FBQ2xFLDhEQUE4RDtBQUM5RCwrREFBK0Q7QUFDL0QsOERBQThEO0FBQzlELG1FQUFtRTtBQUNuRSw4Q0FBOEM7QUFDOUMsRUFBRTtBQUNGLFNBQVM7QUFDVCw0RUFBNEU7QUFDNUUsd0ZBQXdGO0FBQ3hGLDJEQUEyRDtBQUMzRCw0RkFBNEY7QUFDNUYsbUZBQW1GO0FBQ25GLEVBQUU7QUFDRixrRUFBa0U7QUFDbEUsZ0NBQWdDO0FBQ2hDLEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7Ozs7O0NBTWIsQ0FBQztBQUVGLE1BQU0sSUFBSSxHQUFHLGFBQWEsQ0FBQztBQUMzQixNQUFNLG1CQUFtQixHQUFHLE1BQU0sQ0FBQztBQUVuQyxNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxD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TyxFQUFFLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQztZQUFFLE1BQU0sRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM5QyxPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFFRCxJQUFJLElBQUksRUFBRTtRQUNSLE1BQU0sV0FBVyxFQUFFLENBQUM7UUFDcEIsT0FBTztLQUNSO0lBRUQsSUFBSSxPQUFPO1FBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxtQ0FBbUMsVUFBVSxjQUFjLE9BQU8sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxPQUFPLGdCQUFnQixRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUM7SUFDbEssT0FBTyxJQUFJLEVBQUU7UUFDWCxNQUFNLFdBQVcsRUFBRSxDQUFDO1FBQ3BCLE1BQU0sRUFBRSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztLQUM1QjtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyBtb25pdG9yLXN5bmMuanMg4oCUIGxvbmctbGl2ZWQgd3JhcHBlciB0aGF0IHJlLXJ1bnMgc3luYy1hbGwuanMgb25cbi8vIGEgdGltZXIuIEVhY2ggdGljayBydW5zIGBzeW5jLWFsbC5qc2AgKHdoaWNoIGRvZXMgdGhlIGFjdHVhbFxuLy8gcHVzaC10by1uZXR3b3JrIHdvcmspIGFuZCB3YWl0cyBmb3IgaXQgdG8gZmluaXNoLiBzeW5jLWFsbC5qcyBpc1xuLy8gdGhlIG9uZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSBwZXItaG9zdCBzeW5jIGxvZ2ljIOKAlCB0aGlzIGZpbGVcbi8vIGlzIG9ubHkgdGhlIGxvb3AuXG4vL1xuLy8gV2h5IGEgc2VwYXJhdGUgZmlsZTpcbi8vICAgc3luYy1hbGwuanMgaXMgdGhlIG9uZS1zaG90IHZlcnNpb24uIEl0IGRvZXMgYSBzaW5nbGUgcGFzcyBvdmVyXG4vLyAgIHRoZSBuZXR3b3JrLCBwcmludHMgdGhlIGZ1bGwgc3RhdHVzIHRhYmxlLCB0aGVuIGV4aXRzLiBUaGF0J3MgdGhlXG4vLyAgIHJpZ2h0IHNoYXBlIGZvciBcIkkganVzdCBlZGl0ZWQgYSBzY3JpcHQsIHB1c2ggaXQgb3V0IG9uY2UgYW5kXG4vLyAgIHNlZSB3aGF0IGdvdCB3aGVyZVwiLiBCdXQgZm9yIHRoZSBhbHdheXMtb24gXCJmaWxlc3luYyBpcyBmZWVkaW5nXG4vLyAgIG1lIG5ldyBlZGl0cyBhbmQgSSB3YW50IHRoZSBmbGVldCB0byBwaWNrIHRoZW0gdXAgYXV0b21hdGljYWxseVwiXG4vLyAgIHVzZS1jYXNlLCBhIG9uZS1zaG90IG1lYW5zIHlvdSBoYXZlIHRvIHJlbWVtYmVyIHRvIHJlLXJ1biBpdFxuLy8gICBhZnRlciBldmVyeSBzYXZlLiBtb25pdG9yLXN5bmMuanMgaGFuZGxlcyB0aGF0IGF1dG9tYXRpY2FsbHkuXG4vL1xuLy8gSWRlbXBvdGVudDogc3luYy1hbGwuanMgaXMgc2FmZSB0byByZS1ydW4g4oCUIHNjcCBvdmVyd3JpdGVzIGFuZCB0aGVcbi8vIHJtIG9mIHN0YWxlIGZpbGVzIG9ubHkgZmlyZXMgd2hlbiBhIGhvc3QgaGFzIGEgZmlsZSBob21lIGRvZXNuJ3QuXG4vL1xuLy8gRGVmYXVsdCBjYWRlbmNlOiAzMHMuIE92ZXJyaWRlIHdpdGggLS1pbnRlcnZhbCA8bXM+LiBUaGUgMzBzIGRlZmF1bHRcbi8vIGlzIHRoZSBzYW1lIGFzIHRoZSBvdGhlciAzMHMgbW9uaXRvcnMgKG1vbml0b3ItYmFja2Rvb3IsXG4vLyBtb25pdG9yLWRlcGxveSwgbW9uaXRvci1idXkpIHNvIHRoZSBuZXR3b3JrIFwic2V0dGxlc1wiIHRvZ2V0aGVyIOKAlFxuLy8gd2hlbiBhIG5ldyBzZXJ2ZXIgZ2V0cyByb290ZWQsIGFsbCB0aGUgcmVsZXZhbnQgcGlja3MgaGFwcGVuIGluIHRoZVxuLy8gc2FtZSAzMHMgd2luZG93LlxuLy9cbi8vICAgV2h5IG5vdCBmYXN0ZXI/IHN5bmMtYWxsLmpzIGRvZXMgYW4gc2NwIHBlciBob21lLWZpbGUgcGVyXG4vLyAgIHJlYWNoYWJsZSBzZXJ2ZXIgYW5kIGEgcHMoKSBwZXIgaG9zdC4gQXQgMzBzIMOXIDI1IHBzZXJ2cyDDlyBOXG4vLyAgIHdvcmtlciBmaWxlcywgdGhhdCdzIGEgbG90IG9mIGNodXJuLiBGaWxlc3luYyAodGhlIGV4dGVybmFsXG4vLyAgIHRvb2wgdGhhdCB3YXRjaGVzIHlvdXIgbG9jYWwgc3JjLyBhbmQgd3JpdGVzIHRvIGhvbWUpIGlzIHRoZVxuLy8gICByZWFsLXRpbWUgcGF0aDsgdGhlIDMwcyByZS1ydW4gaXMgdGhlIHNhZmV0eSBuZXQgZm9yIHN0YXRlXG4vLyAgIGRyaWZ0LlxuLy9cbi8vIE91dHB1dDogc3luYy1hbGwuanMgZG9lcyBpdHMgb3duIHByaW50aW5nOyB3ZSBqdXN0IHJlbGF5IGFuZCB3YWl0LlxuLy8gUGFzcyAtLWtlZXAtc3RhbGUgdG8gc3luYy1hbGwuanMgaWYgeW91IGRvbid0IHdhbnQgaXQgdG8gcmVtb3ZlXG4vLyBmaWxlcyB0aGF0IGV4aXN0IG9uIHJlbW90ZSBidXQgbm90IG9uIGhvbWUuIFBhc3MgLS1xdWlldCB0b1xuLy8gc3luYy1hbGwuanMgaWYgeW91IGRvbid0IHdhbnQgdGhlIHBlci1ob3N0IFNLSVAvU1lOQ0VEIGxpbmVzXG4vLyAocmVjb21tZW5kZWQgZm9yIHRoZSAzMHMgbG9vcCDigJQgdGhlIGNsdXN0ZXIgaXMgaHVnZSBhbmQgdGhlXG4vLyBwZXItaG9zdCBzdGF0dXMgaXMgbm9pc2UpLiAtLW9uY2UgcnVucyBhIHNpbmdsZSBzeW5jLWFsbC5qcyBwYXNzXG4vLyB3aXRoIGZ1bGwgb3V0cHV0ICh0aGUgZGlhZ25vc3RpYyB1c2UgY2FzZSkuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBtb25pdG9yLXN5bmMuanMgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IDMwcywgUVVJRVQgKGRlZmF1bHQpXG4vLyAgIHJ1biBtb25pdG9yLXN5bmMuanMgLS1vbmNlICAgICAgICAgICAjIG9uZSBzeW5jLWFsbC5qcyBwYXNzLCBmdWxsIG91dHB1dCwgdGhlbiBleGl0XG4vLyAgIHJ1biBtb25pdG9yLXN5bmMuanMgLS1pbnRlcnZhbCAxNTAwMCAjIGxvb3AsIGV2ZXJ5IDE1c1xuLy8gICBydW4gbW9uaXRvci1zeW5jLmpzIC0ta2VlcC1zdGFsZSAgICAgIyBmb3J3YXJkIHRvIHN5bmMtYWxsLmpzOiBkb24ndCByZW1vdmUgc3RhbGUgZmlsZXNcbi8vICAgcnVuIG1vbml0b3Itc3luYy5qcyAtLXZlcmJvc2UgICAgICAgICMgbG9vcCwgZnVsbCBwZXItaG9zdCBvdXRwdXQgKG5vIC0tcXVpZXQpXG4vL1xuLy8gUmVxdWlyZXMgc3luYy1hbGwuanMgdG8gYmUgcHJlc2VudCBvbiBob21lIChpdCBub3JtYWxseSBpcywgdmlhXG4vLyB0aGUgc3RhbmRhcmQgYnVpbGQgcGlwZWxpbmUpLlxuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxucnVuIG1vbml0b3Itc3luYy5qcyAgICAgICAgICAgICAgICAgICMgbG9vcCwgZXZlcnkgMzBzLCBRVUlFVCAoZGVmYXVsdClcbnJ1biBtb25pdG9yLXN5bmMuanMgLS1vbmNlICAgICAgICAgICAjIG9uZSBzeW5jLWFsbC5qcyBwYXNzLCBmdWxsIG91dHB1dCwgdGhlbiBleGl0XG5ydW4gbW9uaXRvci1zeW5jLmpzIC0taW50ZXJ2YWwgMTUwMDAgIyBsb29wLCBldmVyeSAxNXNcbnJ1biBtb25pdG9yLXN5bmMuanMgLS1rZWVwLXN0YWxlICAgICAjIGZvcndhcmQgdG8gc3luYy1hbGwuanM6IGRvbid0IHJlbW92ZSBzdGFsZSBmaWxlc1xucnVuIG1vbml0b3Itc3luYy5qcyAtLXZlcmJvc2UgICAgICAgICMgbG9vcCwgZnVsbCBwZXItaG9zdCBvdXRwdXRcbmA7XG5cbmNvbnN0IFNZTkMgPSBcInN5bmMtYWxsLmpzXCI7XG5jb25zdCBERUZBVUxUX0lOVEVSVkFMX01TID0gMzBfMDAwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuICBucy5kaXNhYmxlTG9nKFwic2xlZXBcIik7XG5cbiAgLy8gUmVmdXNlIHRvIHJ1biBpZiBzeW5jLWFsbC5qcyBpc24ndCBvbiBob21lLiBXaXRob3V0IGl0LCBldmVyeVxuICAvLyB0aWNrIHdvdWxkIHNpbGVudGx5IG5vLW9wLiBUaGUgY2hlY2sgaXMgY2hlYXAgYW5kIHR1cm5zIGFcbiAgLy8gY29uZnVzaW5nIGZhaWx1cmUgbW9kZSAocHJvY2VzcyB0aGF0IGRvZXMgbm90aGluZywgbm8gZXJyb3IpXG4gIC8vIGludG8gYSBjbGVhciBvbmUuXG4gIGlmICghbnMuZmlsZUV4aXN0cyhTWU5DLCBcImhvbWVcIikpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc3luYzogJHtTWU5DfSBub3Qgb24gaG9tZSDigJQgcHVzaCBpdCB2aWEgZmlsZXN5bmMgZmlyc3RgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBQYXJzZSBvdXIgb3duIGZsYWdzIGZpcnN0LCB0aGVuIGZvcndhcmQgZXZlcnl0aGluZyBlbHNlIHRvXG4gIC8vIHN5bmMtYWxsLmpzIHZlcmJhdGltLiBUaGUgYC0tYCBzZXBhcmF0b3IgaXMgY29udmVudGlvbmFsIGZvclxuICAvLyBcImV2ZXJ5dGhpbmcgYWZ0ZXIgdGhpcyBpcyBmb3IgdGhlIGNoaWxkXCIgYnV0IHdlIGRvbid0IHN0cmljdGx5XG4gIC8vIHJlcXVpcmUgaXQg4oCUIGFueSBhcmcgdGhhdCBpc24ndCBvbmUgb2Ygb3VycyBpcyBwYXNzZWQgdGhyb3VnaC5cbiAgY29uc3QgYXJncyA9IG5zLmFyZ3Muc2xpY2UoKTtcbiAgY29uc3Qgb25jZSA9IGFyZ3MuaW5jbHVkZXMoXCItLW9uY2VcIik7XG4gIGNvbnN0IHZlcmJvc2UgPSBhcmdzLmluY2x1ZGVzKFwiLS12ZXJib3NlXCIpO1xuICBjb25zdCBpbnRlcnZhbElkeCA9IGFyZ3MuaW5kZXhPZihcIi0taW50ZXJ2YWxcIik7XG4gIGNvbnN0IGludGVydmFsTXMgPSBpbnRlcnZhbElkeCA+PSAwXG4gICAgPyBOdW1iZXIoYXJnc1tpbnRlcnZhbElkeCArIDFdKVxuICAgIDogREVGQVVMVF9JTlRFUlZBTF9NUztcbiAgaWYgKGludGVydmFsSWR4ID49IDAgJiYgKCFOdW1iZXIuaXNGaW5pdGUoaW50ZXJ2YWxNcykgfHwgaW50ZXJ2YWxNcyA8IDApKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLXN5bmM6IC0taW50ZXJ2YWwgbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBudW1iZXIgKGdvdCAke2FyZ3NbaW50ZXJ2YWxJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIHN5bmMtYWxsLmpzIGFyZyBsaXN0OiBwYXNzIHRocm91Z2ggZXZlcnl0aGluZyBleGNlcHRcbiAgLy8gb3VyIG93biBmbGFncyAoLS1vbmNlLCAtLWludGVydmFsLCAtLXZlcmJvc2UsIC0taGVscC8taCwgYW5kXG4gIC8vIHRoZSB2YWx1ZSBhZnRlciAtLWludGVydmFsKS4gc3luYy1hbGwuanMgZG9lc24ndCBrbm93IGFib3V0XG4gIC8vIHRob3NlLiBXZSBBREQgLS1xdWlldCBieSBkZWZhdWx0IHNvIHRoZSAzMHMgbG9vcCBkb2Vzbid0IGZsb29kXG4gIC8vIHRoZSB0ZXJtaW5hbCB3aXRoIHBlci1ob3N0IFNLSVAvU1lOQ0VEIGxpbmVzIOKAlCAtLXZlcmJvc2Ugb3B0c1xuICAvLyBvdXQsIC0tb25jZSBhbHdheXMgd2FudHMgZnVsbCBvdXRwdXQuXG4gIGNvbnN0IHN5bmNBcmdzID0gYXJncy5maWx0ZXIoKGEsIGkpID0+IHtcbiAgICBpZiAoYSA9PT0gXCItLW9uY2VcIiB8fCBhID09PSBcIi0tdmVyYm9zZVwiIHx8IGEgPT09IFwiLWhcIiB8fCBhID09PSBcIi0taGVscFwiKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGEgPT09IFwiLS1pbnRlcnZhbFwiKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGkgPiAwICYmIGFyZ3NbaSAtIDFdID09PSBcIi0taW50ZXJ2YWxcIikgcmV0dXJuIGZhbHNlOyAgLy8gdGhlIHZhbHVlIGFmdGVyIC0taW50ZXJ2YWxcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSk7XG4gIGlmICghdmVyYm9zZSAmJiAhb25jZSAmJiAhc3luY0FyZ3MuaW5jbHVkZXMoXCItLXF1aWV0XCIpKSB7XG4gICAgc3luY0FyZ3MucHVzaChcIi0tcXVpZXRcIik7XG4gIH1cblxuICAvLyBPbmUgc3luYy1hbGwuanMgaW52b2NhdGlvbi4gV2Ugd2FpdCBmb3IgaXQgdG8gZmluaXNoIHNvIHdlIGtub3dcbiAgLy8gd2hlbiB0byBmaXJlIHRoZSBuZXh0IHRpY2sg4oCUIHJ1bm5pbmcgdHdvIHN5bmMtYWxsLmpzIHBhc3NlcyBpblxuICAvLyBwYXJhbGxlbCB3b3VsZCByYWNlIG9uIGBwcyBob3N0YCBhbmQgY291bGQgZG91YmxlLXJlbW92ZSBzdGFsZVxuICAvLyBmaWxlcy5cbiAgYXN5bmMgZnVuY3Rpb24gcnVuU3luY09uY2UoKSB7XG4gICAgY29uc3QgcGlkID0gbnMucnVuKFNZTkMsIDEsIC4uLnN5bmNBcmdzKTtcbiAgICBpZiAocGlkID09PSAwKSB7XG4gICAgICBucy50cHJpbnQoYG1vbml0b3Itc3luYzogZmFpbGVkIHRvIHN0YXJ0ICR7U1lOQ30gKG5vdCBlbm91Z2ggUkFNPykg4oCUIHdpbGwgcmV0cnkgb24gbmV4dCB0aWNrYCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHdoaWxlIChucy5pc1J1bm5pbmcocGlkKSkgYXdhaXQgbnMuc2xlZXAoMjAwKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmIChvbmNlKSB7XG4gICAgYXdhaXQgcnVuU3luY09uY2UoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBtb25pdG9yLXN5bmM6IHN0YXJ0ZWQsIGludGVydmFsPSR7aW50ZXJ2YWxNc31tcywgb3V0cHV0PSR7dmVyYm9zZSA/IFwidmVyYm9zZVwiIDogXCJxdWlldFwifSwgc3luYy1hcmdzPVske3N5bmNBcmdzLmpvaW4oXCIgXCIpIHx8IFwiKG5vbmUpXCJ9XWApO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGF3YWl0IHJ1blN5bmNPbmNlKCk7XG4gICAgYXdhaXQgbnMuc2xlZXAoaW50ZXJ2YWxNcyk7XG4gIH1cbn1cbiJdfQ==