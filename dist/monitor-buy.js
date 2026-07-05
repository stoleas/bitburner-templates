/** @param {NS} ns */
//
// Watch the dark-web TOR router for new port-opener programs arriving
// on home, then auto-run nuke.js + deploy.js so the new money target
// (currently phantasy) gets rooted and a worker gets fanned out to it
// without you babysitting the terminal.
//
// Usage:
//   run monitor-buy.js
//
// Polls every 30s. When a new *.exe in the opener list appears on
// home, it kicks off nuke.js, waits for that to finish, then runs
// deploy.js. Idempotent: re-running this script is safe.
//
// The opener list is what nuke.js looks for; we only fire when a new
// member of that list lands.
//
const USAGE = `Usage:
  run monitor-buy.js
`;
const POLL_MS = 30_000;
const NUKE = "nuke.js";
const DEPLOY = "deploy.js";
const OPENER_PROGRAMS = [
    "BruteSSH.exe",
    "FTPCrack.exe",
    "relaySMTP.exe",
    "HTTPWorm.exe",
    "SQLInject.exe",
    // Not port-openers, but useful unlocks — AutoLink lets scan-analyze
    // connect directly, ServerProfiler/Deepscan give better visibility.
    // Any new file on home fires the nuke+deploy chain.
    "AutoLink.exe",
    "ServerProfiler.exe",
    "DeepscanV1.exe",
    "DeepscanV2.exe",
];
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    ns.disableLog("sleep");
    ns.tprint(`monitor-buy: watching for ${OPENER_PROGRAMS.join(", ")}`);
    // Track which openers we already have so we only fire on the *new* one.
    const have = new Set(OPENER_PROGRAMS.filter((p) => ns.fileExists(p, "home")));
    // How long to keep retrying ns.run(DEPLOY) after nuke.js finishes.
    // nuke.js frees its own RAM as it exits, but monitor-buy itself is
    // still on home holding RAM — so the first deploy call can race and
    // fail. 15s × 200ms = ~75 attempts is plenty.
    const DEPLOY_RETRY_TIMEOUT_MS = 15_000;
    const DEPLOY_RETRY_INTERVAL_MS = 200;
    while (true) {
        for (const p of OPENER_PROGRAMS) {
            if (have.has(p))
                continue;
            if (!ns.fileExists(p, "home"))
                continue;
            // New opener landed!
            have.add(p);
            ns.tprint(`monitor-buy: ${p} arrived on home — running ${NUKE} then ${DEPLOY}`);
            const nukePid = ns.run(NUKE);
            if (nukePid === 0) {
                ns.tprint(`monitor-buy: failed to start ${NUKE} (not enough RAM?) — will retry on next poll`);
                have.delete(p);
                continue;
            }
            // Wait for nuke.js to finish so deploy.js sees the new roots.
            while (ns.isRunning(nukePid))
                await ns.sleep(500);
            ns.tprint(`monitor-buy: ${NUKE} done — starting ${DEPLOY}`);
            // Retry ns.run(DEPLOY) until it lands or we time out. The first
            // call can fail when monitor-buy's own RAM footprint competes
            // with deploy.js for free home RAM right as nuke.js is exiting.
            const deployDeadline = Date.now() + DEPLOY_RETRY_TIMEOUT_MS;
            let deployPid = 0;
            while (deployPid === 0 && Date.now() < deployDeadline) {
                deployPid = ns.run(DEPLOY);
                if (deployPid === 0)
                    await ns.sleep(DEPLOY_RETRY_INTERVAL_MS);
            }
            if (deployPid === 0) {
                ns.tprint(`monitor-buy: failed to start ${DEPLOY} after ${DEPLOY_RETRY_TIMEOUT_MS / 1000}s — rerun manually`);
            }
            else {
                ns.tprint(`monitor-buy: ${DEPLOY} started (pid ${deployPid}). Exiting.`);
                return;
            }
        }
        await ns.sleep(POLL_MS);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1idXkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvbW9uaXRvci1idXkuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscUJBQXFCO0FBQ3JCLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUscUVBQXFFO0FBQ3JFLHNFQUFzRTtBQUN0RSx3Q0FBd0M7QUFDeEMsRUFBRTtBQUNGLFNBQVM7QUFDVCx1QkFBdUI7QUFDdkIsRUFBRTtBQUNGLGtFQUFrRTtBQUNsRSxrRUFBa0U7QUFDbEUseURBQXlEO0FBQ3pELEVBQUU7QUFDRixxRUFBcUU7QUFDckUsNkJBQTZCO0FBQzdCLEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7Q0FFYixDQUFDO0FBRUYsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDO0FBQ3ZCLE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQztBQUN2QixNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUM7QUFFM0IsTUFBTSxlQUFlLEdBQUc7SUFDdEIsY0FBYztJQUNkLGNBQWM7SUFDZCxlQUFlO0lBQ2YsY0FBYztJQUNkLGVBQWU7SUFDZixvRUFBb0U7SUFDcEUsb0VBQW9FO0lBQ3BFLG9EQUFvRDtJQUNwRCxjQUFjO0lBQ2Qsb0JBQW9CO0lBQ3BCLGdCQUFnQjtJQUNoQixnQkFBZ0I7Q0FDakIsQ0FBQztBQUVGLE1BQU0sQ0FBQyxLQUFLLFVBQVUsSUFBSSxDQUFDLEVBQUU7SUFDM0IsSUFBSSxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRTtRQUN4RCxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pCLE9BQU87S0FDUjtJQUNELEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDdkIsRUFBRSxDQUFDLE1BQU0sQ0FBQyw2QkFBNkIsZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDckUsd0VBQXdFO0lBQ3hFLE1BQU0sSUFBSSxHQUFHLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUU5RSxtRUFBbUU7SUFDbkUsbUVBQW1FO0lBQ25FLG9FQUFvRTtJQUNwRSw4Q0FBOEM7SUFDOUMsTUFBTSx1QkFBdUIsR0FBRyxNQUFNLENBQUM7SUFDdkMsTUFBTSx3QkFBd0IsR0FBRyxHQUFHLENBQUM7SUFFckMsT0FBTyxJQUFJLEVBQUU7UUFDWCxLQUFLLE1BQU0sQ0FBQyxJQUFJLGVBQWUsRUFBRTtZQUMvQixJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO2dCQUFFLFNBQVM7WUFDMUIsSUFBSSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQztnQkFBRSxTQUFTO1lBQ3hDLHFCQUFxQjtZQUNyQixJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ1osRUFBRSxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyw4QkFBOEIsSUFBSSxTQUFTLE1BQU0sRUFBRSxDQUFDLENBQUM7WUFDaEYsTUFBTSxPQUFPLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM3QixJQUFJLE9BQU8sS0FBSyxDQUFDLEVBQUU7Z0JBQ2pCLEVBQUUsQ0FBQyxNQUFNLENBQUMsZ0NBQWdDLElBQUksOENBQThDLENBQUMsQ0FBQztnQkFDOUYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDZixTQUFTO2FBQ1Y7WUFDRCw4REFBOEQ7WUFDOUQsT0FBTyxFQUFFLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQztnQkFBRSxNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDbEQsRUFBRSxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsSUFBSSxvQkFBb0IsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUM1RCxnRUFBZ0U7WUFDaEUsOERBQThEO1lBQzlELGdFQUFnRTtZQUNoRSxNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsdUJBQXVCLENBQUM7WUFDNUQsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDO1lBQ2xCLE9BQU8sU0FBUyxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsY0FBYyxFQUFFO2dCQUNyRCxTQUFTLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQztnQkFDM0IsSUFBSSxTQUFTLEtBQUssQ0FBQztvQkFBRSxNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQzthQUMvRDtZQUNELElBQUksU0FBUyxLQUFLLENBQUMsRUFBRTtnQkFDbkIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxnQ0FBZ0MsTUFBTSxVQUFVLHVCQUF1QixHQUFHLElBQUksb0JBQW9CLENBQUMsQ0FBQzthQUMvRztpQkFBTTtnQkFDTCxFQUFFLENBQUMsTUFBTSxDQUFDLGdCQUFnQixNQUFNLGlCQUFpQixTQUFTLGFBQWEsQ0FBQyxDQUFDO2dCQUN6RSxPQUFPO2FBQ1I7U0FDRjtRQUNELE1BQU0sRUFBRSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztLQUN6QjtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyBXYXRjaCB0aGUgZGFyay13ZWIgVE9SIHJvdXRlciBmb3IgbmV3IHBvcnQtb3BlbmVyIHByb2dyYW1zIGFycml2aW5nXG4vLyBvbiBob21lLCB0aGVuIGF1dG8tcnVuIG51a2UuanMgKyBkZXBsb3kuanMgc28gdGhlIG5ldyBtb25leSB0YXJnZXRcbi8vIChjdXJyZW50bHkgcGhhbnRhc3kpIGdldHMgcm9vdGVkIGFuZCBhIHdvcmtlciBnZXRzIGZhbm5lZCBvdXQgdG8gaXRcbi8vIHdpdGhvdXQgeW91IGJhYnlzaXR0aW5nIHRoZSB0ZXJtaW5hbC5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIG1vbml0b3ItYnV5LmpzXG4vL1xuLy8gUG9sbHMgZXZlcnkgMzBzLiBXaGVuIGEgbmV3ICouZXhlIGluIHRoZSBvcGVuZXIgbGlzdCBhcHBlYXJzIG9uXG4vLyBob21lLCBpdCBraWNrcyBvZmYgbnVrZS5qcywgd2FpdHMgZm9yIHRoYXQgdG8gZmluaXNoLCB0aGVuIHJ1bnNcbi8vIGRlcGxveS5qcy4gSWRlbXBvdGVudDogcmUtcnVubmluZyB0aGlzIHNjcmlwdCBpcyBzYWZlLlxuLy9cbi8vIFRoZSBvcGVuZXIgbGlzdCBpcyB3aGF0IG51a2UuanMgbG9va3MgZm9yOyB3ZSBvbmx5IGZpcmUgd2hlbiBhIG5ld1xuLy8gbWVtYmVyIG9mIHRoYXQgbGlzdCBsYW5kcy5cbi8vXG5jb25zdCBVU0FHRSA9IGBVc2FnZTpcbiAgcnVuIG1vbml0b3ItYnV5LmpzXG5gO1xuXG5jb25zdCBQT0xMX01TID0gMzBfMDAwO1xuY29uc3QgTlVLRSA9IFwibnVrZS5qc1wiO1xuY29uc3QgREVQTE9ZID0gXCJkZXBsb3kuanNcIjtcblxuY29uc3QgT1BFTkVSX1BST0dSQU1TID0gW1xuICBcIkJydXRlU1NILmV4ZVwiLFxuICBcIkZUUENyYWNrLmV4ZVwiLFxuICBcInJlbGF5U01UUC5leGVcIixcbiAgXCJIVFRQV29ybS5leGVcIixcbiAgXCJTUUxJbmplY3QuZXhlXCIsXG4gIC8vIE5vdCBwb3J0LW9wZW5lcnMsIGJ1dCB1c2VmdWwgdW5sb2NrcyDigJQgQXV0b0xpbmsgbGV0cyBzY2FuLWFuYWx5emVcbiAgLy8gY29ubmVjdCBkaXJlY3RseSwgU2VydmVyUHJvZmlsZXIvRGVlcHNjYW4gZ2l2ZSBiZXR0ZXIgdmlzaWJpbGl0eS5cbiAgLy8gQW55IG5ldyBmaWxlIG9uIGhvbWUgZmlyZXMgdGhlIG51a2UrZGVwbG95IGNoYWluLlxuICBcIkF1dG9MaW5rLmV4ZVwiLFxuICBcIlNlcnZlclByb2ZpbGVyLmV4ZVwiLFxuICBcIkRlZXBzY2FuVjEuZXhlXCIsXG4gIFwiRGVlcHNjYW5WMi5leGVcIixcbl07XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGlmIChucy5hcmdzLmluY2x1ZGVzKFwiLWhcIikgfHwgbnMuYXJncy5pbmNsdWRlcyhcIi0taGVscFwiKSkge1xuICAgIG5zLnRwcmludChVU0FHRSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIG5zLmRpc2FibGVMb2coXCJzbGVlcFwiKTtcbiAgbnMudHByaW50KGBtb25pdG9yLWJ1eTogd2F0Y2hpbmcgZm9yICR7T1BFTkVSX1BST0dSQU1TLmpvaW4oXCIsIFwiKX1gKTtcbiAgLy8gVHJhY2sgd2hpY2ggb3BlbmVycyB3ZSBhbHJlYWR5IGhhdmUgc28gd2Ugb25seSBmaXJlIG9uIHRoZSAqbmV3KiBvbmUuXG4gIGNvbnN0IGhhdmUgPSBuZXcgU2V0KE9QRU5FUl9QUk9HUkFNUy5maWx0ZXIoKHApID0+IG5zLmZpbGVFeGlzdHMocCwgXCJob21lXCIpKSk7XG5cbiAgLy8gSG93IGxvbmcgdG8ga2VlcCByZXRyeWluZyBucy5ydW4oREVQTE9ZKSBhZnRlciBudWtlLmpzIGZpbmlzaGVzLlxuICAvLyBudWtlLmpzIGZyZWVzIGl0cyBvd24gUkFNIGFzIGl0IGV4aXRzLCBidXQgbW9uaXRvci1idXkgaXRzZWxmIGlzXG4gIC8vIHN0aWxsIG9uIGhvbWUgaG9sZGluZyBSQU0g4oCUIHNvIHRoZSBmaXJzdCBkZXBsb3kgY2FsbCBjYW4gcmFjZSBhbmRcbiAgLy8gZmFpbC4gMTVzIMOXIDIwMG1zID0gfjc1IGF0dGVtcHRzIGlzIHBsZW50eS5cbiAgY29uc3QgREVQTE9ZX1JFVFJZX1RJTUVPVVRfTVMgPSAxNV8wMDA7XG4gIGNvbnN0IERFUExPWV9SRVRSWV9JTlRFUlZBTF9NUyA9IDIwMDtcblxuICB3aGlsZSAodHJ1ZSkge1xuICAgIGZvciAoY29uc3QgcCBvZiBPUEVORVJfUFJPR1JBTVMpIHtcbiAgICAgIGlmIChoYXZlLmhhcyhwKSkgY29udGludWU7XG4gICAgICBpZiAoIW5zLmZpbGVFeGlzdHMocCwgXCJob21lXCIpKSBjb250aW51ZTtcbiAgICAgIC8vIE5ldyBvcGVuZXIgbGFuZGVkIVxuICAgICAgaGF2ZS5hZGQocCk7XG4gICAgICBucy50cHJpbnQoYG1vbml0b3ItYnV5OiAke3B9IGFycml2ZWQgb24gaG9tZSDigJQgcnVubmluZyAke05VS0V9IHRoZW4gJHtERVBMT1l9YCk7XG4gICAgICBjb25zdCBudWtlUGlkID0gbnMucnVuKE5VS0UpO1xuICAgICAgaWYgKG51a2VQaWQgPT09IDApIHtcbiAgICAgICAgbnMudHByaW50KGBtb25pdG9yLWJ1eTogZmFpbGVkIHRvIHN0YXJ0ICR7TlVLRX0gKG5vdCBlbm91Z2ggUkFNPykg4oCUIHdpbGwgcmV0cnkgb24gbmV4dCBwb2xsYCk7XG4gICAgICAgIGhhdmUuZGVsZXRlKHApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIFdhaXQgZm9yIG51a2UuanMgdG8gZmluaXNoIHNvIGRlcGxveS5qcyBzZWVzIHRoZSBuZXcgcm9vdHMuXG4gICAgICB3aGlsZSAobnMuaXNSdW5uaW5nKG51a2VQaWQpKSBhd2FpdCBucy5zbGVlcCg1MDApO1xuICAgICAgbnMudHByaW50KGBtb25pdG9yLWJ1eTogJHtOVUtFfSBkb25lIOKAlCBzdGFydGluZyAke0RFUExPWX1gKTtcbiAgICAgIC8vIFJldHJ5IG5zLnJ1bihERVBMT1kpIHVudGlsIGl0IGxhbmRzIG9yIHdlIHRpbWUgb3V0LiBUaGUgZmlyc3RcbiAgICAgIC8vIGNhbGwgY2FuIGZhaWwgd2hlbiBtb25pdG9yLWJ1eSdzIG93biBSQU0gZm9vdHByaW50IGNvbXBldGVzXG4gICAgICAvLyB3aXRoIGRlcGxveS5qcyBmb3IgZnJlZSBob21lIFJBTSByaWdodCBhcyBudWtlLmpzIGlzIGV4aXRpbmcuXG4gICAgICBjb25zdCBkZXBsb3lEZWFkbGluZSA9IERhdGUubm93KCkgKyBERVBMT1lfUkVUUllfVElNRU9VVF9NUztcbiAgICAgIGxldCBkZXBsb3lQaWQgPSAwO1xuICAgICAgd2hpbGUgKGRlcGxveVBpZCA9PT0gMCAmJiBEYXRlLm5vdygpIDwgZGVwbG95RGVhZGxpbmUpIHtcbiAgICAgICAgZGVwbG95UGlkID0gbnMucnVuKERFUExPWSk7XG4gICAgICAgIGlmIChkZXBsb3lQaWQgPT09IDApIGF3YWl0IG5zLnNsZWVwKERFUExPWV9SRVRSWV9JTlRFUlZBTF9NUyk7XG4gICAgICB9XG4gICAgICBpZiAoZGVwbG95UGlkID09PSAwKSB7XG4gICAgICAgIG5zLnRwcmludChgbW9uaXRvci1idXk6IGZhaWxlZCB0byBzdGFydCAke0RFUExPWX0gYWZ0ZXIgJHtERVBMT1lfUkVUUllfVElNRU9VVF9NUyAvIDEwMDB9cyDigJQgcmVydW4gbWFudWFsbHlgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5zLnRwcmludChgbW9uaXRvci1idXk6ICR7REVQTE9ZfSBzdGFydGVkIChwaWQgJHtkZXBsb3lQaWR9KS4gRXhpdGluZy5gKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBucy5zbGVlcChQT0xMX01TKTtcbiAgfVxufVxuIl19