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
        if (args[i - 1] === "--interval")
            return false; // the value after --interval
        if (args[i] === "--once")
            return false;
        if (args[i] === "--interval")
            return false;
        if (args[i] === "--verbose")
            return false;
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
        while (ns.isRunning(pid))
            await ns.sleep(200);
        return true;
    }
    if (once) {
        await runNukeOnce();
        return;
    }
    if (verbose)
        ns.tprint(`monitor-nuke: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, nuke-args=[${nukeArgs.join(" ") || "(none)"}]`);
    while (true) {
        await runNukeOnce();
        await ns.sleep(intervalMs);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1udWtlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21vbml0b3ItbnVrZS5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLG1FQUFtRTtBQUNuRSx1RUFBdUU7QUFDdkUscUVBQXFFO0FBQ3JFLG1EQUFtRDtBQUNuRCxFQUFFO0FBQ0Ysc0VBQXNFO0FBQ3RFLG1FQUFtRTtBQUNuRSxtRUFBbUU7QUFDbkUsRUFBRTtBQUNGLG1FQUFtRTtBQUNuRSxtRUFBbUU7QUFDbkUsa0VBQWtFO0FBQ2xFLG9FQUFvRTtBQUNwRSxFQUFFO0FBQ0YsdUJBQXVCO0FBQ3ZCLG1FQUFtRTtBQUNuRSxpRUFBaUU7QUFDakUsa0VBQWtFO0FBQ2xFLG1FQUFtRTtBQUNuRSxlQUFlO0FBQ2YsRUFBRTtBQUNGLGtFQUFrRTtBQUNsRSw0QkFBNEI7QUFDNUIsRUFBRTtBQUNGLFNBQVM7QUFDVCxpRkFBaUY7QUFDakYsNkZBQTZGO0FBQzdGLHVFQUF1RTtBQUN2RSxvRkFBb0Y7QUFDcEYsc0dBQXNHO0FBQ3RHLEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7Ozs7O0NBTWIsQ0FBQztBQUVGLE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQztBQUN2QixNQUFNLG1CQUFtQixHQUFHLE1BQU0sQ0FBQztBQUVuQyxNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDeEQsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQixPQUFPO0tBQ1I7SUFFRCxpRUFBaUU7SUFDakUsaUVBQWlFO0lBQ2pFLGlDQUFpQztJQUNqQyxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsTUFB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LElBQUksUUFBUSxHQUFHLENBQUMsQ0FBQztJQUNsSyxPQUFPLElBQUksRUFBRTtRQUNYLE1BQU0sV0FBVyxFQUFFLENBQUM7UUFDcEIsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0tBQzVCO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIExvbmctbGl2ZWQgd3JhcHBlciB0aGF0IHJlLWludm9rZXMgbnVrZS5qcyBvbiBhIHRpbWVyLiBFYWNoIHRpY2tcbi8vIGp1c3QgcnVucyBgbnVrZS5qc2AgKHdoaWNoIGRvZXMgdGhlIGFjdHVhbCBwb3J0LW9wZW5pbmcgKyBudWtlIHdvcmspXG4vLyBhbmQgd2FpdHMgZm9yIGl0IHRvIGZpbmlzaC4gbnVrZS5qcyBpcyB0aGUgb25lIHNvdXJjZSBvZiB0cnV0aCBmb3Jcbi8vIHRoZSBwZXItaG9zdCBsb2dpYyDigJQgdGhpcyBmaWxlIGlzIG9ubHkgdGhlIGxvb3AuXG4vL1xuLy8gSWRlbXBvdGVudDogcmUtcnVubmluZyBpcyBzYWZlLiBudWtlLmpzIGl0c2VsZiBza2lwcyBhbHJlYWR5LXJvb3RlZFxuLy8gaG9zdHMsIHNvIHN1YnNlcXVlbnQgcGFzc2VzIGFyZSBtb3N0bHkgbm8tb3BzIGV4Y2VwdCBmb3IgYW55IG5ld1xuLy8gc2VydmVyIHRoYXQgYmVjYW1lIHJlYWNoYWJsZSAobmV3IHB1cmNoYXNlLCBuZXcgYmFja2Rvb3IsIGV0Yy4pLlxuLy9cbi8vIE91dHB1dCBkZWZhdWx0cyB0byBRVUlFVCDigJQgb25seSBOVUtFRCAvIEZBSUwgLyBzdW1tYXJ5IGxpbmVzIGFyZVxuLy8gcHJpbnRlZC4gT3RoZXJ3aXNlIHRoZSB0ZXJtaW5hbCBmaWxscyB1cCB3aXRoIHRoZSBzYW1lIFNLSVAtaGFja1xuLy8gbGluZXMgZXZlcnkgaW50ZXJ2YWwuIFBhc3MgLS12ZXJib3NlIHRvIHJlLWVuYWJsZSBwZXItaG9zdCBTS0lQXG4vLyBvdXRwdXQuIC0tb25jZSBhbHdheXMgcHJpbnRzIGZ1bGwgb3V0cHV0IChpdCdzIGEgZGlhZ25vc3RpYyBydW4pLlxuLy9cbi8vIFdoeSBhIHNlcGFyYXRlIGZpbGU6XG4vLyAgIG51a2UuanMgaXMgdGhlIG9uZS1zaG90IHZlcnNpb24uIFBsYXllcnMgd2l0aCBsaW1pdGVkIGhvbWUgUkFNXG4vLyAgIGNhbiBydW4gaXQgZGlyZWN0bHkgd2l0aG91dCBwYXlpbmcgZm9yIGEgbG9uZy1saXZlZCBtb25pdG9yLlxuLy8gICBtb25pdG9yLW51a2UuanMgaXMgdGhlIGFsd2F5cy1vbiB2ZXJzaW9uIGZvciBwbGF5ZXJzIHdpdGggUkFNXG4vLyAgIHRvIHNwYXJlLiBUaGUgdHdvIGFyZSBpbmRlcGVuZGVudCDigJQgZGVsZXRpbmcgb25lIGRvZXNuJ3QgYnJlYWtcbi8vICAgdGhlIG90aGVyLlxuLy9cbi8vIFJlcXVpcmVzIG51a2UuanMgdG8gYmUgcHJlc2VudCBvbiBob21lIChpdCBub3JtYWxseSBpcywgdmlhIHRoZVxuLy8gc3RhbmRhcmQgYnVpbGQgcGlwZWxpbmUpLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gbW9uaXRvci1udWtlLmpzICAgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IDYwcywgUVVJRVQgKGRlZmF1bHQpXG4vLyAgIHJ1biBtb25pdG9yLW51a2UuanMgLS1vbmNlICAgICAgICAgICAgICAgICMgb25lIG51a2UuanMgcGFzcyB3aXRoIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbi8vICAgcnVuIG1vbml0b3ItbnVrZS5qcyAtLWludGVydmFsIDMwMDAwICAgICAgIyBsb29wLCBldmVyeSAzMHMsIFFVSUVUXG4vLyAgIHJ1biBtb25pdG9yLW51a2UuanMgLS10YXJnZXRzIENTRUMgICAgICAgICMgcGluIG1vZGUgKHBhc3NlZCB0byBudWtlLmpzKSwgUVVJRVRcbi8vICAgcnVuIG1vbml0b3ItbnVrZS5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyBsb29wIHdpdGggcGVyLWhvc3QgU0tJUCBsaW5lcyAodGhlIG9sZCBsb3VkIGJlaGF2aW9yKVxuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxuICBydW4gbW9uaXRvci1udWtlLmpzICAgICAgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IDYwcywgUVVJRVQgKGRlZmF1bHQpXG4gIHJ1biBtb25pdG9yLW51a2UuanMgLS1vbmNlICAgICAgICAgICAgICAgICAgICMgb25lIG51a2UuanMgcGFzcyB3aXRoIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbiAgcnVuIG1vbml0b3ItbnVrZS5qcyAtLWludGVydmFsIDMwMDAwICAgICAgICAgIyBsb29wLCBldmVyeSAzMHMsIFFVSUVUXG4gIHJ1biBtb25pdG9yLW51a2UuanMgLS10YXJnZXRzIG5lby1uZXQgQ1NFQyAgICMgcGluIG1vZGUgKHBhc3NlZCB0byBudWtlLmpzKSwgUVVJRVRcbiAgcnVuIG1vbml0b3ItbnVrZS5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgICAgIyBsb29wIHdpdGggcGVyLWhvc3QgU0tJUCBsaW5lcyAodGhlIG9sZCBsb3VkIGJlaGF2aW9yKVxuYDtcblxuY29uc3QgTlVLRSA9IFwibnVrZS5qc1wiO1xuY29uc3QgREVGQVVMVF9JTlRFUlZBTF9NUyA9IDYwXzAwMDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnMpIHtcbiAgaWYgKG5zLmFyZ3MuaW5jbHVkZXMoXCItaFwiKSB8fCBucy5hcmdzLmluY2x1ZGVzKFwiLS1oZWxwXCIpKSB7XG4gICAgbnMudHByaW50KFVTQUdFKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZWZ1c2UgdG8gcnVuIGlmIG51a2UuanMgaXNuJ3Qgb24gaG9tZS4gV2l0aG91dCBpdCwgZXZlcnkgdGlja1xuICAvLyB3b3VsZCBzaWxlbnRseSBuby1vcC4gVGhlIGNoZWNrIGlzIGNoZWFwIGFuZCB0dXJucyBhIGNvbmZ1c2luZ1xuICAvLyBmYWlsdXJlIG1vZGUgaW50byBhIGNsZWFyIG9uZS5cbiAgaWYgKCFucy5maWxlRXhpc3RzKE5VS0UsIFwiaG9tZVwiKSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1udWtlOiAke05VS0V9IG5vdCBvbiBob21lIOKAlCBwdXNoIGl0IHZpYSBmaWxlc3luYyBmaXJzdGApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFBhcnNlIGFyZ3MuIC0tdGFyZ2V0cyBhbmQgaXRzIHBvc2l0aW9uYWwgbGlzdCBwYXNzIHRocm91Z2ggdG9cbiAgLy8gbnVrZS5qcyB2ZXJiYXRpbS4gLS1vbmNlIG1lYW5zIGEgc2luZ2xlIG51a2UuanMgcnVuIHRoZW4gZXhpdC5cbiAgLy8gLS12ZXJib3NlIG9wdHMgYmFjayBpbnRvIHBlci1ob3N0IFNLSVAgbGluZXM7IGRlZmF1bHQgaXMgcXVpZXQuXG4gIGNvbnN0IGFyZ3MgPSBucy5hcmdzLnNsaWNlKCk7XG4gIGNvbnN0IG9uY2UgPSBhcmdzLmluY2x1ZGVzKFwiLS1vbmNlXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgY29uc3QgaW50ZXJ2YWxJZHggPSBhcmdzLmluZGV4T2YoXCItLWludGVydmFsXCIpO1xuICBjb25zdCBpbnRlcnZhbE1zID0gaW50ZXJ2YWxJZHggPj0gMFxuICAgID8gTnVtYmVyKGFyZ3NbaW50ZXJ2YWxJZHggKyAxXSlcbiAgICA6IERFRkFVTFRfSU5URVJWQUxfTVM7XG4gIGlmIChpbnRlcnZhbElkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKGludGVydmFsTXMpIHx8IGludGVydmFsTXMgPCAwKSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1udWtlOiAtLWludGVydmFsIG11c3QgYmUgYSBub24tbmVnYXRpdmUgbnVtYmVyIChnb3QgJHthcmdzW2ludGVydmFsSWR4ICsgMV19KWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFN0cmlwIG91ciBmbGFncyBmcm9tIHRoZSBhcmcgbGlzdCBiZWZvcmUgZm9yd2FyZGluZyB0byBudWtlLmpzLlxuICAvLyBudWtlLmpzIGRvZXNuJ3Qga25vdyBhYm91dCAtLW9uY2UsIC0taW50ZXJ2YWwsIG9yIC0tdmVyYm9zZSwgc29cbiAgLy8gd2UgcmVtb3ZlIHRob3NlLiAtLXF1aWV0IGlzIHNwZWNpYWw6IHdlIEFERCBpdCBieSBkZWZhdWx0ICh1bmxlc3NcbiAgLy8gdGhlIHVzZXIgcGFzc2VkIC0tdmVyYm9zZSBvciAtLW9uY2UsIHdoaWNoIGFsd2F5cyB3YW50IGZ1bGwgb3V0cHV0KS5cbiAgY29uc3QgbnVrZUFyZ3MgPSBhcmdzLmZpbHRlcigoXywgaSkgPT4ge1xuICAgIGlmIChhcmdzW2kgLSAxXSA9PT0gXCItLWludGVydmFsXCIpIHJldHVybiBmYWxzZTsgIC8vIHRoZSB2YWx1ZSBhZnRlciAtLWludGVydmFsXG4gICAgaWYgKGFyZ3NbaV0gPT09IFwiLS1vbmNlXCIpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoYXJnc1tpXSA9PT0gXCItLWludGVydmFsXCIpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoYXJnc1tpXSA9PT0gXCItLXZlcmJvc2VcIikgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiB0cnVlO1xuICB9KTtcbiAgLy8gRGVmYXVsdCB0byBxdWlldC4gLS12ZXJib3NlIG9wdHMgb3V0LiAtLW9uY2UgYWx3YXlzIHdhbnRzIGZ1bGxcbiAgLy8gb3V0cHV0IChpdCdzIGEgZGlhZ25vc3RpYyBydW4pLlxuICBpZiAoIXZlcmJvc2UgJiYgIW9uY2UgJiYgIW51a2VBcmdzLmluY2x1ZGVzKFwiLS1xdWlldFwiKSkge1xuICAgIG51a2VBcmdzLnB1c2goXCItLXF1aWV0XCIpO1xuICB9XG5cbiAgLy8gT25lIG51a2UuanMgaW52b2NhdGlvbi4gbnVrZS5qcyBkb2VzIGl0cyBvd24gcHJpbnRpbmc7IHdlIHdhaXRcbiAgLy8gZm9yIGl0IHRvIGZpbmlzaCBzbyB3ZSBrbm93IHdoZW4gdG8gZmlyZSB0aGUgbmV4dCB0aWNrLlxuICBhc3luYyBmdW5jdGlvbiBydW5OdWtlT25jZSgpIHtcbiAgICBjb25zdCBwaWQgPSBucy5ydW4oTlVLRSwgMSwgLi4ubnVrZUFyZ3MpO1xuICAgIGlmIChwaWQgPT09IDApIHtcbiAgICAgIG5zLnRwcmludChgbW9uaXRvci1udWtlOiBmYWlsZWQgdG8gc3RhcnQgJHtOVUtFfSAobm90IGVub3VnaCBSQU0/KSDigJQgd2lsbCByZXRyeSBvbiBuZXh0IHRpY2tgKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgd2hpbGUgKG5zLmlzUnVubmluZyhwaWQpKSBhd2FpdCBucy5zbGVlcCgyMDApO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKG9uY2UpIHtcbiAgICBhd2FpdCBydW5OdWtlT25jZSgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh2ZXJib3NlKSBucy50cHJpbnQoYG1vbml0b3ItbnVrZTogc3RhcnRlZCwgaW50ZXJ2YWw9JHtpbnRlcnZhbE1zfW1zLCBvdXRwdXQ9JHt2ZXJib3NlID8gXCJ2ZXJib3NlXCIgOiBcInF1aWV0XCJ9LCBudWtlLWFyZ3M9WyR7bnVrZUFyZ3Muam9pbihcIiBcIikgfHwgXCIobm9uZSlcIn1dYCk7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgYXdhaXQgcnVuTnVrZU9uY2UoKTtcbiAgICBhd2FpdCBucy5zbGVlcChpbnRlcnZhbE1zKTtcbiAgfVxufVxuIl19