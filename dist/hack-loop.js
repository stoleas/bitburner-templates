/**
 * Proper HWGW batched hack loop.
 *
 * Each operation's runtime is deterministic given the current target state,
 * so we can `sleep` exactly the gap between operations. This is the
 * "sleeve-stable" loop the in-game tutorial walks you toward.
 *
 * Ideal target: a server you've prepped to min security and max money, then
 * run this on a home/server with enough RAM for many threads. Tune thread
 * counts with `ns.hackAnalyzeThreads` / `ns.growthAnalyze`; once you have
 * the Formulas API, prefer `ns.formulas.hacking.*` for exact sizing.
 *
 * Note: this script is a *worker*. The classic pattern is one orchestrator
 * script on `home` that calls `ns.exec("hack-loop.js", target, threads)` so
 * the heavy work runs on the target server.
 */
export async function main(ns) {
    // Target defaults to foodnstuff for standalone use. The deploy script
    // passes the host as the first arg so each server hacks itself.
    const target = (ns.args[0]?.toString() ?? "foodnstuff").trim();
    // Ensure root access. foodnstuff requires 0 port opens, so a single nuke works.
    if (!ns.hasRootAccess(target)) {
        ns.nuke(target);
    }
    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("getServerSecurityLevel");
    // Cache runtimes — they only change if the target's security or our
    // hacking level changes, which is fine to re-read on each iteration.
    while (true) {
        const hackTime = ns.getHackTime(target);
        const growTime = ns.getGrowTime(target);
        const weakenTime = ns.getWeakenTime(target);
        // h → w → g → w sequence keeps the server's security oscillating
        // close to its minimum and money close to its maximum.
        await ns.hack(target);
        await ns.sleep(weakenTime - hackTime - 50);
        await ns.weaken(target);
        await ns.sleep(growTime - weakenTime - 50);
        await ns.grow(target);
        await ns.sleep(weakenTime - growTime - 50);
        await ns.weaken(target);
        await ns.sleep(hackTime - 50);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGFjay1sb29wLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2hhY2stbG9vcC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQTs7Ozs7Ozs7Ozs7Ozs7O0dBZUc7QUFDSCxNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFNO0lBQy9CLHNFQUFzRTtJQUN0RSxnRUFBZ0U7SUFDaEUsTUFBTSxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxJQUFJLFlBQVksQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0lBRS9ELGdGQUFnRjtJQUNoRixJQUFJLENBQUMsRUFBRSxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsRUFBRTtRQUM3QixFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0tBQ2pCO0lBRUQsRUFBRSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN2QixFQUFFLENBQUMsVUFBVSxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFDekMsRUFBRSxDQUFDLFVBQVUsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBRXhDLG9FQUFvRTtJQUNwRSxxRUFBcUU7SUFDckUsT0FBTyxJQUFJLEVBQUU7UUFDWCxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3hDLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDeEMsTUFBTSxVQUFVLEdBQUcsRUFBRSxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUU1QyxpRUFBaUU7UUFDakUsdURBQXVEO1FBQ3ZELE1BQU0sRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN0QixNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsVUFBVSxHQUFHLFFBQVEsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUMzQyxNQUFNLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDeEIsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDLFFBQVEsR0FBRyxVQUFVLEdBQUcsRUFBRSxDQUFDLENBQUM7UUFDM0MsTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3RCLE1BQU0sRUFBRSxDQUFDLEtBQUssQ0FBQyxVQUFVLEdBQUcsUUFBUSxHQUFHLEVBQUUsQ0FBQyxDQUFDO1FBQzNDLE1BQU0sRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN4QixNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsUUFBUSxHQUFHLEVBQUUsQ0FBQyxDQUFDO0tBQy9CO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IE5TIH0gZnJvbSBcIkBuc1wiO1xuXG4vKipcbiAqIFByb3BlciBIV0dXIGJhdGNoZWQgaGFjayBsb29wLlxuICpcbiAqIEVhY2ggb3BlcmF0aW9uJ3MgcnVudGltZSBpcyBkZXRlcm1pbmlzdGljIGdpdmVuIHRoZSBjdXJyZW50IHRhcmdldCBzdGF0ZSxcbiAqIHNvIHdlIGNhbiBgc2xlZXBgIGV4YWN0bHkgdGhlIGdhcCBiZXR3ZWVuIG9wZXJhdGlvbnMuIFRoaXMgaXMgdGhlXG4gKiBcInNsZWV2ZS1zdGFibGVcIiBsb29wIHRoZSBpbi1nYW1lIHR1dG9yaWFsIHdhbGtzIHlvdSB0b3dhcmQuXG4gKlxuICogSWRlYWwgdGFyZ2V0OiBhIHNlcnZlciB5b3UndmUgcHJlcHBlZCB0byBtaW4gc2VjdXJpdHkgYW5kIG1heCBtb25leSwgdGhlblxuICogcnVuIHRoaXMgb24gYSBob21lL3NlcnZlciB3aXRoIGVub3VnaCBSQU0gZm9yIG1hbnkgdGhyZWFkcy4gVHVuZSB0aHJlYWRcbiAqIGNvdW50cyB3aXRoIGBucy5oYWNrQW5hbHl6ZVRocmVhZHNgIC8gYG5zLmdyb3d0aEFuYWx5emVgOyBvbmNlIHlvdSBoYXZlXG4gKiB0aGUgRm9ybXVsYXMgQVBJLCBwcmVmZXIgYG5zLmZvcm11bGFzLmhhY2tpbmcuKmAgZm9yIGV4YWN0IHNpemluZy5cbiAqXG4gKiBOb3RlOiB0aGlzIHNjcmlwdCBpcyBhICp3b3JrZXIqLiBUaGUgY2xhc3NpYyBwYXR0ZXJuIGlzIG9uZSBvcmNoZXN0cmF0b3JcbiAqIHNjcmlwdCBvbiBgaG9tZWAgdGhhdCBjYWxscyBgbnMuZXhlYyhcImhhY2stbG9vcC5qc1wiLCB0YXJnZXQsIHRocmVhZHMpYCBzb1xuICogdGhlIGhlYXZ5IHdvcmsgcnVucyBvbiB0aGUgdGFyZ2V0IHNlcnZlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnM6IE5TKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFRhcmdldCBkZWZhdWx0cyB0byBmb29kbnN0dWZmIGZvciBzdGFuZGFsb25lIHVzZS4gVGhlIGRlcGxveSBzY3JpcHRcbiAgLy8gcGFzc2VzIHRoZSBob3N0IGFzIHRoZSBmaXJzdCBhcmcgc28gZWFjaCBzZXJ2ZXIgaGFja3MgaXRzZWxmLlxuICBjb25zdCB0YXJnZXQgPSAobnMuYXJnc1swXT8udG9TdHJpbmcoKSA/PyBcImZvb2Ruc3R1ZmZcIikudHJpbSgpO1xuXG4gIC8vIEVuc3VyZSByb290IGFjY2Vzcy4gZm9vZG5zdHVmZiByZXF1aXJlcyAwIHBvcnQgb3BlbnMsIHNvIGEgc2luZ2xlIG51a2Ugd29ya3MuXG4gIGlmICghbnMuaGFzUm9vdEFjY2Vzcyh0YXJnZXQpKSB7XG4gICAgbnMubnVrZSh0YXJnZXQpO1xuICB9XG5cbiAgbnMuZGlzYWJsZUxvZyhcInNsZWVwXCIpO1xuICBucy5kaXNhYmxlTG9nKFwiZ2V0U2VydmVyTW9uZXlBdmFpbGFibGVcIik7XG4gIG5zLmRpc2FibGVMb2coXCJnZXRTZXJ2ZXJTZWN1cml0eUxldmVsXCIpO1xuXG4gIC8vIENhY2hlIHJ1bnRpbWVzIOKAlCB0aGV5IG9ubHkgY2hhbmdlIGlmIHRoZSB0YXJnZXQncyBzZWN1cml0eSBvciBvdXJcbiAgLy8gaGFja2luZyBsZXZlbCBjaGFuZ2VzLCB3aGljaCBpcyBmaW5lIHRvIHJlLXJlYWQgb24gZWFjaCBpdGVyYXRpb24uXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3QgaGFja1RpbWUgPSBucy5nZXRIYWNrVGltZSh0YXJnZXQpO1xuICAgIGNvbnN0IGdyb3dUaW1lID0gbnMuZ2V0R3Jvd1RpbWUodGFyZ2V0KTtcbiAgICBjb25zdCB3ZWFrZW5UaW1lID0gbnMuZ2V0V2Vha2VuVGltZSh0YXJnZXQpO1xuXG4gICAgLy8gaCDihpIgdyDihpIgZyDihpIgdyBzZXF1ZW5jZSBrZWVwcyB0aGUgc2VydmVyJ3Mgc2VjdXJpdHkgb3NjaWxsYXRpbmdcbiAgICAvLyBjbG9zZSB0byBpdHMgbWluaW11bSBhbmQgbW9uZXkgY2xvc2UgdG8gaXRzIG1heGltdW0uXG4gICAgYXdhaXQgbnMuaGFjayh0YXJnZXQpO1xuICAgIGF3YWl0IG5zLnNsZWVwKHdlYWtlblRpbWUgLSBoYWNrVGltZSAtIDUwKTtcbiAgICBhd2FpdCBucy53ZWFrZW4odGFyZ2V0KTtcbiAgICBhd2FpdCBucy5zbGVlcChncm93VGltZSAtIHdlYWtlblRpbWUgLSA1MCk7XG4gICAgYXdhaXQgbnMuZ3Jvdyh0YXJnZXQpO1xuICAgIGF3YWl0IG5zLnNsZWVwKHdlYWtlblRpbWUgLSBncm93VGltZSAtIDUwKTtcbiAgICBhd2FpdCBucy53ZWFrZW4odGFyZ2V0KTtcbiAgICBhd2FpdCBucy5zbGVlcChoYWNrVGltZSAtIDUwKTtcbiAgfVxufVxuIl19