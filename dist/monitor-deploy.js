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
        ns.tprint("monitor-deploy: refused — manager.js is running on home. " +
            "The centralized HWGW orchestrator already owns the rooted target set; " +
            "per-server hack-loop.js fan-out drains moneyAvailable and breaks " +
            "manager.js's $X.XXX hacks (Pitfall 8 in bitburner-dev). " +
            "Pass --force to override, or run manager.js for the centralized system.");
        // If the user passed --once, return immediately (one-shot
        // mode). Otherwise, sleep the full interval and re-check — if
        // manager.js is killed later, monitor-deploy.js will resume on
        // its own without requiring a manual restart. This is the
        // same restart-on-collision pattern master.js uses for its
        // own MONITORS.
        if (once)
            return;
        while (managerRunning) {
            await ns.sleep(intervalMs);
            // Re-check on every wake. Cheap (one ns.ps() call).
            if (!ns.ps("home").some((p) => p.filename === "manager.js"))
                break;
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
        if (a === "--once" || a === "--verbose" || a === "-h" || a === "--help" || a === "--force")
            return false;
        if (a === "--interval")
            return false;
        if (i > 0 && args[i - 1] === "--interval")
            return false; // the value after --interval
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
        while (ns.isRunning(pid))
            await ns.sleep(200);
        return true;
    }
    if (once) {
        await runDeployOnce();
        return;
    }
    if (verbose)
        ns.tprint(`monitor-deploy: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, deploy-args=[${deployArgs.join(" ") || "(none)"}]`);
    while (true) {
        await runDeployOnce();
        await ns.sleep(intervalMs);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1kZXBsb3kuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvbW9uaXRvci1kZXBsb3kuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscUJBQXFCO0FBQ3JCLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUscUVBQXFFO0FBQ3JFLG1FQUFtRTtBQUNuRSw2REFBNkQ7QUFDN0QsRUFBRTtBQUNGLHVCQUF1QjtBQUN2QixxRUFBcUU7QUFDckUsa0VBQWtFO0FBQ2xFLHNFQUFzRTtBQUN0RSxrRUFBa0U7QUFDbEUsbUVBQW1FO0FBQ25FLGtFQUFrRTtBQUNsRSxtQkFBbUI7QUFDbkIsRUFBRTtBQUNGLGdFQUFnRTtBQUNoRSxxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLHFFQUFxRTtBQUNyRSxtRUFBbUU7QUFDbkUseUNBQXlDO0FBQ3pDLEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsbUVBQW1FO0FBQ25FLG1FQUFtRTtBQUNuRSxFQUFFO0FBQ0YsK0RBQStEO0FBQy9ELCtEQUErRDtBQUMvRCxxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLEVBQUU7QUFDRixtRUFBbUU7QUFDbkUsc0VBQXNFO0FBQ3RFLGlFQUFpRTtBQUNqRSxvQ0FBb0M7QUFDcEMsRUFBRTtBQUNGLFNBQVM7QUFDVCw2REFBNkQ7QUFDN0Qsd0ZBQXdGO0FBQ3hGLDZEQUE2RDtBQUM3RCxpRkFBaUY7QUFDakYsMEZBQTBGO0FBQzFGLGlGQUFpRjtBQUNqRixFQUFFO0FBQ0Ysb0VBQW9FO0FBQ3BFLDRCQUE0QjtBQUM1QixFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLGtFQUFrRTtBQUNsRSxtRUFBbUU7QUFDbkUsOERBQThEO0FBQzlELDZEQUE2RDtBQUM3RCxtRUFBbUU7QUFDbkUsNkRBQTZEO0FBQzdELG1FQUFtRTtBQUNuRSw2REFBNkQ7QUFDN0QsMERBQTBEO0FBQzFELGtFQUFrRTtBQUNsRSxtRUFBbUU7QUFDbkUsc0RBQXNEO0FBQ3RELGdFQUFnRTtBQUNoRSw0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QVUsYUFBYTtRQUMxQixNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsR0FBRyxVQUFVLENBQUMsQ0FBQztRQUM3QyxJQUFJLEdBQUcsS0FBSyxDQUFDLEVBQUU7WUFDYixFQUFFLENBQUMsTUFBTSxDQUFDLG1DQUFtQyxNQUFNLDhDQUE4QyxDQUFDLENBQUM7WUFDbkcsT0FBTyxLQUFLLENBQUM7U0FDZDtRQUNELE9BQU8sRUFBRSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUM7WUFBRSxNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDOUMsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBRUQsSUFBSSxJQUFJLEVBQUU7UUFDUixNQUFNLGFBQWEsRUFBRSxDQUFDO1FBQ3RCLE9BQU87S0FDUjtJQUVELElBQUksT0FBTztRQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMscUNBQXFDLFVBQVUsY0FBYyxPQUFPLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxrQkFBa0IsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFDO0lBQ3hLLE9BQU8sSUFBSSxFQUFFO1FBQ1gsTUFBTSxhQUFhLEVBQUUsQ0FBQztRQUN0QixNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7S0FDNUI7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gbW9uaXRvci1kZXBsb3kuanMg4oCUIGxvbmctbGl2ZWQgd3JhcHBlciB0aGF0IHJlLWludm9rZXMgZGVwbG95LmpzIG9uXG4vLyBhIHRpbWVyLiBFYWNoIHRpY2sgcnVucyBgZGVwbG95LmpzYCAod2hpY2ggZG9lcyB0aGUgYWN0dWFsIGZhbi1vdXRcbi8vIHdvcmspIGFuZCB3YWl0cyBmb3IgaXQgdG8gZmluaXNoLiBkZXBsb3kuanMgaXMgdGhlIG9uZSBzb3VyY2Ugb2Zcbi8vIHRydXRoIGZvciB0aGUgcGVyLWhvc3QgbG9naWMg4oCUIHRoaXMgZmlsZSBpcyBvbmx5IHRoZSBsb29wLlxuLy9cbi8vIFdoeSBhIHNlcGFyYXRlIGZpbGU6XG4vLyAgIGRlcGxveS5qcyBpcyB0aGUgb25lLXNob3QgdmVyc2lvbi4gSXQgZG9lcyBhIHNpbmdsZSBwYXNzLCBwcmludHNcbi8vICAgdGhlIGZ1bGwgc3RhdHVzIHRhYmxlLCB0aGVuIGV4aXRzLiBUaGF0J3MgdGhlIHJpZ2h0IHNoYXBlIGZvclxuLy8gICBcInJ1biB0aGlzIG9uY2UgYWZ0ZXIgYW4gYXVnIGFuZCBzZWUgd2hhdCdzIGdvaW5nIG9uXCIuIEJ1dCBmb3IgdGhlXG4vLyAgIGFsd2F5cy1vbiBcIkkganVzdCBuaWNrZWQgYSBuZXcgc2VydmVyLCBmYW4gd29ya2VycyBvdXQgdG8gaXRcIlxuLy8gICB1c2UtY2FzZSwgYSBvbmUtc2hvdCBkb2Vzbid0IHBpY2sgdXAgbmV3bHktbnVrZWQgaG9zdHMg4oCUIHlvdSdkXG4vLyAgIGhhdmUgdG8gcmVtZW1iZXIgdG8gcmUtcnVuIGl0LiBtb25pdG9yLWRlcGxveS5qcyBoYW5kbGVzIHRoYXRcbi8vICAgYXV0b21hdGljYWxseS5cbi8vXG4vLyAgIFRoZSBvcmlnaW5hbCBkZXBsb3kuanMgaGFkIGEgNS1taW51dGUgYXV0by1yZXN0YXJ0IGJha2VkIGluXG4vLyAgIChsaW5lIDE1OSkuIFRoYXQgd2FzIHRoZSByaWdodCBpZGVhIGJ1dCB3cm9uZyBjYWRlbmNlOiA1IG1pbnV0ZXNcbi8vICAgaXMgdG9vIGxvbmcgdG8gd2FpdCBmb3IgYSBuZXdseS1udWtlZCB0YXJnZXQgdG8gc3RhcnQgcHJvZHVjaW5nLFxuLy8gICBhbmQgdGhlIGJha2UtaW4gbWVhbnQgdGhlcmUgd2FzIG5vIHdheSB0byBydW4gYSBvbmUtc2hvdCB3aXRob3V0XG4vLyAgIGVkaXRpbmcgdGhlIGZpbGUuIFNwbGl0dGluZyBpbnRvIGRlcGxveS5qcyArIG1vbml0b3ItZGVwbG95LmpzXG4vLyAgIHNlcGFyYXRlcyB0aGUgdHdvIHVzZS1jYXNlcyBjbGVhbmx5LlxuLy9cbi8vIElkZW1wb3RlbnQ6IHJlLXJ1bm5pbmcgaXMgc2FmZS4gZGVwbG95LmpzIGl0c2VsZiBza2lwcyBob3N0cyB0aGF0XG4vLyBhbHJlYWR5IGhhdmUgdGhlIHdvcmtlciBydW5uaW5nLCBzbyBzdWJzZXF1ZW50IHBhc3NlcyBhcmUgbW9zdGx5XG4vLyBuby1vcHMgZXhjZXB0IGZvciBhbnkgbmV3IHNlcnZlciB0aGF0IGJlY2FtZSBudWthYmxlIC8gaGFja2FibGUuXG4vL1xuLy8gRGVmYXVsdCBjYWRlbmNlOiAzMHMuIE92ZXJyaWRlIHdpdGggLS1pbnRlcnZhbCA8bXM+LiBUaGUgMzBzXG4vLyBkZWZhdWx0IGlzIHRoZSBzYW1lIGFzIHRoZSBvdGhlciBtb25pdG9ycyAobW9uaXRvci1iYWNrZG9vcixcbi8vIG1vbml0b3ItYnV5KSBzbyB0aGUgbmV0d29yayBcInNldHRsZXNcIiB0b2dldGhlciDigJQgd2hlbiBhIG5ldyBzZXJ2ZXJcbi8vIGdldHMgcm9vdGVkLCBhbGwgdGhlIHJlbGV2YW50IHBpY2tzIGhhcHBlbiBpbiB0aGUgc2FtZSAzMHMgd2luZG93LlxuLy9cbi8vIE91dHB1dDogZGVwbG95LmpzIGRvZXMgaXRzIG93biBwcmludGluZzsgd2UganVzdCByZWxheSBhbmQgd2FpdC5cbi8vIFBhc3MgLS1xdWlldCB0byBkZXBsb3kuanMgYnkgZGVmYXVsdCDigJQgd2UgZG9uJ3Qgd2FudCBhIGZyZXNoIHN0YXR1c1xuLy8gdGFibGUgZXZlcnkgMzBzLiAtLW9uY2UgcnVucyBhIHNpbmdsZSBkZXBsb3kuanMgcGFzcyB3aXRoIGZ1bGxcbi8vIG91dHB1dCAodGhlIGRpYWdub3N0aWMgdXNlIGNhc2UpLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gbW9uaXRvci1kZXBsb3kuanMgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IDMwc1xuLy8gICBydW4gbW9uaXRvci1kZXBsb3kuanMgLS1vbmNlICAgICAgICAgICAjIG9uZSBkZXBsb3kuanMgcGFzcywgZnVsbCBvdXRwdXQsIHRoZW4gZXhpdFxuLy8gICBydW4gbW9uaXRvci1kZXBsb3kuanMgLS1pbnRlcnZhbCAxNTAwMCAjIGxvb3AsIGV2ZXJ5IDE1c1xuLy8gICBydW4gbW9uaXRvci1kZXBsb3kuanMgLS12ZXJib3NlICAgICAgICAjIHJlLWVuYWJsZSBkZXBsb3kuanMgcGVyLWhvc3Qgb3V0cHV0XG4vLyAgIHJ1biBtb25pdG9yLWRlcGxveS5qcyAtLWZvcmNlICAgICAgICAgICMgb3ZlcnJpZGUgbWlkLWdhbWUgZ3VhcmQgKG1hbmFnZXIuanMgcnVubmluZylcbi8vICAgcnVuIG1vbml0b3ItZGVwbG95LmpzIC0tIGhhY2stbG9vcC5qcyAgIyBjdXN0b20gd29ya2VyIChwYXNzZWQgdG8gZGVwbG95LmpzKVxuLy9cbi8vIFJlcXVpcmVzIGRlcGxveS5qcyB0byBiZSBwcmVzZW50IG9uIGhvbWUgKGl0IG5vcm1hbGx5IGlzLCB2aWEgdGhlXG4vLyBzdGFuZGFyZCBidWlsZCBwaXBlbGluZSkuXG4vL1xuLy8gTWlkLWdhbWUgcmVmdXNhbDogbWlycm9ycyBkZXBsb3kuanMuIElmIG1hbmFnZXIuanMgaXMgcnVubmluZyBvblxuLy8gaG9tZSwgdGhlIGNlbnRyYWxpemVkIEhXR1cgb3JjaGVzdHJhdG9yIGFscmVhZHkgb3ducyB0aGUgcm9vdGVkXG4vLyB0YXJnZXQgc2V0LiBQZXItc2VydmVyIGhhY2stbG9vcC5qcyBmYW4tb3V0IGF0IHRoaXMgcG9pbnQgZHJhaW5zXG4vLyBtb25leUF2YWlsYWJsZSBvbiBhIGNvbnRpbnVvdXMgbG9vcCBhbmQgYnJlYWtzIG1hbmFnZXIuanMnc1xuLy8gcHNlcnYtbGF1bmNoZWQgbnMuaGFjaygpIChyZXR1cm5zICQwLjAwMCBvbiBvdGhlcndpc2Utc2FuZVxuLy8gdGFyZ2V0cyDigJQgUGl0ZmFsbCA4IGluIGJpdGJ1cm5lci1kZXY6IHBlci1zZXJ2ZXIgYW5kIGNlbnRyYWxpemVkXG4vLyBIV0dXIHN5c3RlbXMgY2FuJ3QgY29leGlzdCkuIFRoZSB3cmFwcGVyIHJlZnVzZXMgdG8gbGF1bmNoXG4vLyBkZXBsb3kuanMsIHByaW50cyBhIGNsZWFyIGFjdGlvbmFibGUgbWVzc2FnZSwgYW5kIChpbiBsb29wIG1vZGUpXG4vLyByZS1jaGVja3MgZXZlcnkgaW50ZXJ2YWwgc28ga2lsbGluZyBtYW5hZ2VyLmpzIHJlc3VtZXMgdGhlXG4vLyBmYW4tb3V0IHdpdGhvdXQgbWFudWFsIHJlc3RhcnQuIC0tZm9yY2Ugb3B0cyBpbiBmb3IgdGhlXG4vLyBlYXJseS1nYW1lIGNhc2Ugb3IgZm9yIGV4cGxpY2l0IHRlc3RpbmcuIFRoZSBzYW1lIGNoZWNrIGlzIGFsc29cbi8vIGluIGRlcGxveS5qcyBpdHNlbGYgYXMgYmVsdC1hbmQtc3VzcGVuZGVycyDigJQgcnVubmluZyBgZGVwbG95LmpzYFxuLy8gZGlyZWN0bHkgd2l0aCBtYW5hZ2VyLmpzIHVwIHJlZnVzZXMgb24gaXRzIG93bi4gVGhlXG4vLyB3cmFwcGVyLWxldmVsIGNoZWNrIGlzIHRoZSBvbmUgdGhhdCBtYXR0ZXJzIGZvciB0aGUgMzBzIGxvb3AsXG4vLyBzaW5jZSB0aGUgY2hpbGQgY2hlY2sgd291bGQgb3RoZXJ3aXNlIGZpcmUgb24gZXZlcnkgdGljay5cbi8vXG5jb25zdCBVU0FHRSA9IGBVc2FnZTpcbnJ1biBtb25pdG9yLWRlcGxveS5qcyAgICAgICAgICAgICAgICAgICMgbG9vcCwgZXZlcnkgMzBzLCBRVUlFVCAoZGVmYXVsdClcbnJ1biBtb25pdG9yLWRlcGxveS5qcyAtLW9uY2UgICAgICAgICAgICMgb25lIGRlcGxveS5qcyBwYXNzIHdpdGggZnVsbCBvdXRwdXQsIHRoZW4gZXhpdFxucnVuIG1vbml0b3ItZGVwbG95LmpzIC0taW50ZXJ2YWwgMTUwMDAgIyBsb29wLCBldmVyeSAxNXNcbnJ1biBtb25pdG9yLWRlcGxveS5qcyAtLXZlcmJvc2UgICAgICAgICMgbG9vcCB3aXRoIHBlci1ob3N0IERFUExPWS9TS0lQIGxpbmVzXG5ydW4gbW9uaXRvci1kZXBsb3kuanMgLS1mb3JjZSAgICAgICAgICAjIG92ZXJyaWRlIG1pZC1nYW1lIGd1YXJkIChtYW5hZ2VyLmpzIHJ1bm5pbmcpXG5ydW4gbW9uaXRvci1kZXBsb3kuanMgLS0gd29ya2VyLmpzICAgICAjIGN1c3RvbSB3b3JrZXIgKGRlZmF1bHQ6IGhhY2stbG9vcC5qcylcbmA7XG5cbmNvbnN0IERFUExPWSA9IFwiZGVwbG95LmpzXCI7XG5jb25zdCBERUZBVUxUX0lOVEVSVkFMX01TID0gMzBfMDAwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuICBucy5kaXNhYmxlTG9nKFwic2xlZXBcIik7XG5cbiAgLy8gUmVmdXNlIHRvIHJ1biBpZiBkZXBsb3kuanMgaXNuJ3Qgb24gaG9tZS4gV2l0aG91dCBpdCwgZXZlcnkgdGlja1xuICAvLyB3b3VsZCBzaWxlbnRseSBuby1vcC4gVGhlIGNoZWNrIGlzIGNoZWFwIGFuZCB0dXJucyBhIGNvbmZ1c2luZ1xuICAvLyBmYWlsdXJlIG1vZGUgKHByb2Nlc3MgdGhhdCBkb2VzIG5vdGhpbmcsIG5vIGVycm9yKSBpbnRvIGEgY2xlYXJcbiAgLy8gb25lLlxuICBpZiAoIW5zLmZpbGVFeGlzdHMoREVQTE9ZLCBcImhvbWVcIikpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3ItZGVwbG95OiAke0RFUExPWX0gbm90IG9uIGhvbWUg4oCUIHB1c2ggaXQgdmlhIGZpbGVzeW5jIGZpcnN0YCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gUGFyc2Ugb3VyIG93biBmbGFncyBmaXJzdCwgdGhlbiBmb3J3YXJkIGV2ZXJ5dGhpbmcgZWxzZSB0b1xuICAvLyBkZXBsb3kuanMgdmVyYmF0aW0uIFRoZSBgLS1gIHNlcGFyYXRvciBpcyBjb252ZW50aW9uYWwgZm9yXG4gIC8vIFwiZXZlcnl0aGluZyBhZnRlciB0aGlzIGlzIGZvciB0aGUgY2hpbGRcIiBidXQgd2UgZG9uJ3Qgc3RyaWN0bHlcbiAgLy8gcmVxdWlyZSBpdCDigJQgYW55IGFyZyB0aGF0IGlzbid0IG9uZSBvZiBvdXJzIGlzIHBhc3NlZCB0aHJvdWdoLlxuICAvLyBUaGlzIHdheSBgcnVuIG1vbml0b3ItZGVwbG95LmpzIC0taW50ZXJ2YWwgMTUwMDBgIHdvcmtzIHRoZSBzYW1lXG4gIC8vIGFzIGBydW4gbW9uaXRvci1kZXBsb3kuanMgaGFjay1sb29wLmpzYCAocGFzcyBoYWNrLWxvb3AuanMgYXMgdGhlXG4gIC8vIHdvcmtlciBhcmcgdG8gZGVwbG95LmpzKS5cbiAgY29uc3QgYXJncyA9IG5zLmFyZ3Muc2xpY2UoKTtcbiAgY29uc3Qgb25jZSA9IGFyZ3MuaW5jbHVkZXMoXCItLW9uY2VcIik7XG4gIGNvbnN0IHZlcmJvc2UgPSBhcmdzLmluY2x1ZGVzKFwiLS12ZXJib3NlXCIpO1xuICBjb25zdCBmb3JjZSA9IGFyZ3MuaW5jbHVkZXMoXCItLWZvcmNlXCIpO1xuICBjb25zdCBpbnRlcnZhbElkeCA9IGFyZ3MuaW5kZXhPZihcIi0taW50ZXJ2YWxcIik7XG4gIGNvbnN0IGludGVydmFsTXMgPSBpbnRlcnZhbElkeCA+PSAwXG4gICAgPyBOdW1iZXIoYXJnc1tpbnRlcnZhbElkeCArIDFdKVxuICAgIDogREVGQVVMVF9JTlRFUlZBTF9NUztcbiAgaWYgKGludGVydmFsSWR4ID49IDAgJiYgKCFOdW1iZXIuaXNGaW5pdGUoaW50ZXJ2YWxNcykgfHwgaW50ZXJ2YWxNcyA8IDApKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLWRlcGxveTogLS1pbnRlcnZhbCBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIG51bWJlciAoZ290ICR7YXJnc1tpbnRlcnZhbElkeCArIDFdfSlgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBNaWQtZ2FtZSBndWFyZCAobWlycm9ycyBkZXBsb3kuanMpOiBpZiBtYW5hZ2VyLmpzIGlzIHJ1bm5pbmcgb25cbiAgLy8gaG9tZSwgdGhlIGNlbnRyYWxpemVkIEhXR1cgb3JjaGVzdHJhdG9yIGFscmVhZHkgb3ducyB0aGUgcm9vdGVkXG4gIC8vIHRhcmdldCBzZXQuIFBlci1zZXJ2ZXIgaGFjay1sb29wLmpzIGZhbi1vdXQgYXQgdGhpcyBwb2ludFxuICAvLyBkcmFpbnMgbW9uZXlBdmFpbGFibGUgb24gYSBjb250aW51b3VzIGxvb3AgYW5kIGJyZWFrc1xuICAvLyBtYW5hZ2VyLmpzJ3MgcHNlcnYtbGF1bmNoZWQgbnMuaGFjaygpIChyZXR1cm5zICQwLjAwMCBvblxuICAvLyBvdGhlcndpc2Utc2FuZSB0YXJnZXRzIOKAlCBQaXRmYWxsIDggaW4gYml0YnVybmVyLWRldikuIFJlZnVzZVxuICAvLyBoZXJlIGF0IHRoZSB3cmFwcGVyIGxldmVsIHNvIHRoZSBtZXNzYWdlIHByaW50cyBvbmNlIHBlclxuICAvLyAzMHMgdGljayBpbnN0ZWFkIG9mIGJ1YmJsaW5nIHVwIGZyb20gZXZlcnkgbmVzdGVkIGRlcGxveS5qc1xuICAvLyBjaGlsZC4gLS1mb3JjZSBvcHRzIGluIGZvciB0aGUgZWFybHktZ2FtZSBjYXNlIG9yIGZvciBleHBsaWNpdFxuICAvLyB0ZXN0aW5nLiBOb3RlOiB0aGUgc2FtZSBjaGVjayBpcyBhbHNvIGluIGRlcGxveS5qcyBpdHNlbGYgYXNcbiAgLy8gYmVsdC1hbmQtc3VzcGVuZGVycyDigJQgaWYgc29tZW9uZSBydW5zIGBkZXBsb3kuanNgIGRpcmVjdGx5XG4gIC8vIHdoaWxlIG1hbmFnZXIuanMgaXMgdXAsIGRlcGxveS5qcyByZWZ1c2VzIG9uIGl0cyBvd24uIFRoaXNcbiAgLy8gd3JhcHBlci1sZXZlbCBjaGVjayBpcyB0aGUgb25lIHRoYXQgbWF0dGVycyBmb3IgdGhlXG4gIC8vIG1vbml0b3ItZGVwbG95LmpzIDMwcyBsb29wLCBzaW5jZSB0aGUgY2hpbGQgY2hlY2sgd291bGRcbiAgLy8gb3RoZXJ3aXNlIGZpcmUgb24gZXZlcnkgdGljay5cbiAgY29uc3QgbWFuYWdlclJ1bm5pbmcgPSBucy5wcyhcImhvbWVcIikuc29tZSgocCkgPT4gcC5maWxlbmFtZSA9PT0gXCJtYW5hZ2VyLmpzXCIpO1xuICBpZiAobWFuYWdlclJ1bm5pbmcgJiYgIWZvcmNlKSB7XG4gICAgbnMudHByaW50KFxuICAgICAgXCJtb25pdG9yLWRlcGxveTogcmVmdXNlZCDigJQgbWFuYWdlci5qcyBpcyBydW5uaW5nIG9uIGhvbWUuIFwiICtcbiAgICAgIFwiVGhlIGNlbnRyYWxpemVkIEhXR1cgb3JjaGVzdHJhdG9yIGFscmVhZHkgb3ducyB0aGUgcm9vdGVkIHRhcmdldCBzZXQ7IFwiICtcbiAgICAgIFwicGVyLXNlcnZlciBoYWNrLWxvb3AuanMgZmFuLW91dCBkcmFpbnMgbW9uZXlBdmFpbGFibGUgYW5kIGJyZWFrcyBcIiArXG4gICAgICBcIm1hbmFnZXIuanMncyAkWC5YWFggaGFja3MgKFBpdGZhbGwgOCBpbiBiaXRidXJuZXItZGV2KS4gXCIgK1xuICAgICAgXCJQYXNzIC0tZm9yY2UgdG8gb3ZlcnJpZGUsIG9yIHJ1biBtYW5hZ2VyLmpzIGZvciB0aGUgY2VudHJhbGl6ZWQgc3lzdGVtLlwiXG4gICAgKTtcbiAgICAvLyBJZiB0aGUgdXNlciBwYXNzZWQgLS1vbmNlLCByZXR1cm4gaW1tZWRpYXRlbHkgKG9uZS1zaG90XG4gICAgLy8gbW9kZSkuIE90aGVyd2lzZSwgc2xlZXAgdGhlIGZ1bGwgaW50ZXJ2YWwgYW5kIHJlLWNoZWNrIOKAlCBpZlxuICAgIC8vIG1hbmFnZXIuanMgaXMga2lsbGVkIGxhdGVyLCBtb25pdG9yLWRlcGxveS5qcyB3aWxsIHJlc3VtZSBvblxuICAgIC8vIGl0cyBvd24gd2l0aG91dCByZXF1aXJpbmcgYSBtYW51YWwgcmVzdGFydC4gVGhpcyBpcyB0aGVcbiAgICAvLyBzYW1lIHJlc3RhcnQtb24tY29sbGlzaW9uIHBhdHRlcm4gbWFzdGVyLmpzIHVzZXMgZm9yIGl0c1xuICAgIC8vIG93biBNT05JVE9SUy5cbiAgICBpZiAob25jZSkgcmV0dXJuO1xuICAgIHdoaWxlIChtYW5hZ2VyUnVubmluZykge1xuICAgICAgYXdhaXQgbnMuc2xlZXAoaW50ZXJ2YWxNcyk7XG4gICAgICAvLyBSZS1jaGVjayBvbiBldmVyeSB3YWtlLiBDaGVhcCAob25lIG5zLnBzKCkgY2FsbCkuXG4gICAgICBpZiAoIW5zLnBzKFwiaG9tZVwiKS5zb21lKChwKSA9PiBwLmZpbGVuYW1lID09PSBcIm1hbmFnZXIuanNcIikpIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIC8vIEJ1aWxkIHRoZSBkZXBsb3kuanMgYXJnIGxpc3Q6IHBhc3MgdGhyb3VnaCBldmVyeXRoaW5nIGV4Y2VwdFxuICAvLyBvdXIgb3duIGZsYWdzICgtLW9uY2UsIC0taW50ZXJ2YWwsIC0tdmVyYm9zZSwgLS1oZWxwLy1oLFxuICAvLyAtLWZvcmNlLCBhbmQgdGhlIHZhbHVlIGFmdGVyIC0taW50ZXJ2YWwpLiBkZXBsb3kuanMgZG9lc24ndFxuICAvLyBrbm93IGFib3V0IHRob3NlLiAtLWZvcmNlIGlzIGNvbnN1bWVkIGJ5IHRoZSB3cmFwcGVyJ3NcbiAgLy8gbWlkLWdhbWUgZ3VhcmQgYWJvdmU7IHBhc3NpbmcgaXQgdGhyb3VnaCB3b3VsZCBoYXZlIGRlcGxveS5qc1xuICAvLyBwcmludCBhIFwiV0FSTklORyAtLWZvcmNlIHdpdGggbWFuYWdlci5qcyBydW5uaW5nXCIgbGluZSB0aGF0XG4gIC8vIGRvZXNuJ3QgYXBwbHkgKHRoZSB3cmFwcGVyIGFscmVhZHkgaGFuZGxlZCB0aGUgb3ZlcnJpZGVcbiAgLy8gZGVjaXNpb24pLiBXZSBBREQgLS1xdWlldCBieSBkZWZhdWx0IHNvIHRoZSAzMHMgbG9vcCBkb2Vzbid0XG4gIC8vIGZsb29kIHRoZSB0ZXJtaW5hbCDigJQgLS12ZXJib3NlIG9wdHMgb3V0LCAtLW9uY2UgYWx3YXlzIHdhbnRzXG4gIC8vIGZ1bGwgb3V0cHV0LlxuICBjb25zdCBkZXBsb3lBcmdzID0gYXJncy5maWx0ZXIoKGEsIGkpID0+IHtcbiAgICBpZiAoYSA9PT0gXCItLW9uY2VcIiB8fCBhID09PSBcIi0tdmVyYm9zZVwiIHx8IGEgPT09IFwiLWhcIiB8fCBhID09PSBcIi0taGVscFwiIHx8IGEgPT09IFwiLS1mb3JjZVwiKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGEgPT09IFwiLS1pbnRlcnZhbFwiKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGkgPiAwICYmIGFyZ3NbaSAtIDFdID09PSBcIi0taW50ZXJ2YWxcIikgcmV0dXJuIGZhbHNlOyAgLy8gdGhlIHZhbHVlIGFmdGVyIC0taW50ZXJ2YWxcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSk7XG4gIGlmICghdmVyYm9zZSAmJiAhb25jZSAmJiAhZGVwbG95QXJncy5pbmNsdWRlcyhcIi0tcXVpZXRcIikpIHtcbiAgICBkZXBsb3lBcmdzLnB1c2goXCItLXF1aWV0XCIpO1xuICB9XG5cbiAgLy8gT25lIGRlcGxveS5qcyBpbnZvY2F0aW9uLiBXZSB3YWl0IGZvciBpdCB0byBmaW5pc2ggc28gd2Uga25vd1xuICAvLyB3aGVuIHRvIGZpcmUgdGhlIG5leHQgdGljayDigJQgcnVubmluZyB0d28gZGVwbG95LmpzIHBhc3NlcyBpblxuICAvLyBwYXJhbGxlbCB3b3VsZCByYWNlIG9uIGBwcyBob3N0YCBhbmQgY291bGQgZG91YmxlLWRlcGxveVxuICAvLyB3b3JrZXJzLlxuICBhc3luYyBmdW5jdGlvbiBydW5EZXBsb3lPbmNlKCkge1xuICAgIGNvbnN0IHBpZCA9IG5zLnJ1bihERVBMT1ksIDEsIC4uLmRlcGxveUFyZ3MpO1xuICAgIGlmIChwaWQgPT09IDApIHtcbiAgICAgIG5zLnRwcmludChgbW9uaXRvci1kZXBsb3k6IGZhaWxlZCB0byBzdGFydCAke0RFUExPWX0gKG5vdCBlbm91Z2ggUkFNPykg4oCUIHdpbGwgcmV0cnkgb24gbmV4dCB0aWNrYCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHdoaWxlIChucy5pc1J1bm5pbmcocGlkKSkgYXdhaXQgbnMuc2xlZXAoMjAwKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlmIChvbmNlKSB7XG4gICAgYXdhaXQgcnVuRGVwbG95T25jZSgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh2ZXJib3NlKSBucy50cHJpbnQoYG1vbml0b3ItZGVwbG95OiBzdGFydGVkLCBpbnRlcnZhbD0ke2ludGVydmFsTXN9bXMsIG91dHB1dD0ke3ZlcmJvc2UgPyBcInZlcmJvc2VcIiA6IFwicXVpZXRcIn0sIGRlcGxveS1hcmdzPVske2RlcGxveUFyZ3Muam9pbihcIiBcIikgfHwgXCIobm9uZSlcIn1dYCk7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgYXdhaXQgcnVuRGVwbG95T25jZSgpO1xuICAgIGF3YWl0IG5zLnNsZWVwKGludGVydmFsTXMpO1xuICB9XG59XG4iXX0=