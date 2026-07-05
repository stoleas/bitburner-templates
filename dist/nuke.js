/** @param {NS} ns */
//
// Open every required port on every reachable server, then ns.nuke it.
// Idempotent — safe to re-run. Scans the whole network reachable from
// home by default, so newly-purchased servers / freshly-unlocked paths
// get nuked without editing a list.
//
// Usage:
//   run nuke.js                       # BFS the network, nuke every reachable host
//   run nuke.js --targets neo-net CSEC  # pin to specific servers
//   run nuke.js --quiet               # only print NUKED / FAIL / summary (suppress SKIP lines)
//
// Out-of-level targets are reported (so you can see what you're
// missing) but not acted on — nuke() silently fails on under-levelled
// hosts, so we filter before trying. Servers you don't have the
// port-opener programs for are also reported (with a count of how
// many you're missing) and skipped. Pass --quiet to suppress the
// SKIP-* noise and only see NUKED / FAIL / summary.
//
const USAGE = `Usage:
  run nuke.js                          # BFS the network, nuke every reachable host
  run nuke.js --targets neo-net CSEC   # pin to specific servers
  run nuke.js --quiet                  # only print NUKED / FAIL / summary
`;
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    // Parse args. --targets <list...> takes the rest as the target list.
    const args = ns.args.slice();
    const quiet = args.includes("--quiet");
    const targetsIdx = args.indexOf("--targets");
    const pinned = targetsIdx >= 0 ? args.slice(targetsIdx + 1) : null;
    // Opener programs on home and the matching NS functions.
    const openers = [
        { file: "BruteSSH.exe", open: (h) => ns.brutessh(h) },
        { file: "FTPCrack.exe", open: (h) => ns.ftpcrack(h) },
        { file: "relaySMTP.exe", open: (h) => ns.relaysmtp(h) },
        { file: "HTTPWorm.exe", open: (h) => ns.httpworm(h) },
        { file: "SQLInject.exe", open: (h) => ns.sqlinject(h) },
    ];
    // Build the target list. Pinned mode skips the BFS.
    let hosts;
    if (pinned) {
        hosts = pinned;
    }
    else {
        const seen = new Set(["home"]);
        const queue = ["home"];
        while (queue.length > 0) {
            const h = queue.shift();
            for (const n of ns.scan(h)) {
                if (!seen.has(n)) {
                    seen.add(n);
                    queue.push(n);
                }
            }
        }
        hosts = [...seen].sort();
    }
    const myHack = ns.getPlayer().skills.hacking;
    const counters = {
        "NUKED": 0,
        "SKIP-rooted": 0,
        "SKIP-self": 0,
        "SKIP-purchased": 0,
        "SKIP-hack": 0,
        "SKIP-port": 0,
        "FAIL-notfound": 0,
        "FAIL-nuke": 0,
    };
    for (const host of hosts) {
        if (host === "home") {
            if (!quiet)
                ns.tprint(`SKIP-self      home`);
            counters["SKIP-self"]++;
            continue;
        }
        if (ns.hasRootAccess(host)) {
            if (!quiet)
                ns.tprint(`SKIP-rooted    ${host}  (already rooted)`);
            counters["SKIP-rooted"]++;
            continue;
        }
        // Check the server exists in the network.
        // getServerNumPortsRequired returns -1 for unknown hostnames.
        const needed = ns.getServerNumPortsRequired(host);
        if (needed < 0) {
            // FAIL lines are always printed — they signal a real issue
            // (typo in --targets, or a server that needs a backdoor first).
            ns.tprint(`FAIL-notfound  ${host}  (host not in network — BFS may need a purchase or a backdoor)`);
            counters["FAIL-notfound"]++;
            continue;
        }
        // Filter out purchased servers — you own those, you don't "nuke" them.
        // getServer() works on unknown hosts in Bitburner, so this is safe.
        const s = ns.getServer(host);
        if (s.purchasedByPlayer) {
            if (!quiet)
                ns.tprint(`SKIP-purchased ${host}`);
            counters["SKIP-purchased"]++;
            continue;
        }
        // Hack-level check. nuke() silently fails under-levelled, so we filter.
        // We still *report* the level block, so the user can see what they're
        // missing — but we don't try to nuke.
        const reqHack = ns.getServerRequiredHackingLevel(host);
        if (reqHack > myHack) {
            if (!quiet)
                ns.tprint(`SKIP-hack      ${host}  (need hack ${reqHack}, you have ${myHack})`);
            counters["SKIP-hack"]++;
            continue;
        }
        // Open every port we have a program for.
        const haveOpeners = openers.filter((o) => ns.fileExists(o.file, "home"));
        for (const op of haveOpeners)
            op.open(host);
        if (haveOpeners.length < needed) {
            if (!quiet)
                ns.tprint(`SKIP-port      ${host}  (need ${needed} port-opener programs, you have ${haveOpeners.length}: ${haveOpeners.map((o) => o.file).join(", ") || "none"})`);
            counters["SKIP-port"]++;
            continue;
        }
        // Try to nuke.
        ns.nuke(host);
        if (ns.hasRootAccess(host)) {
            ns.tprint(`NUKED          ${host}`);
            counters["NUKED"]++;
        }
        else {
            // FAIL-nuke is always printed (rare, indicates a bug).
            ns.tprint(`FAIL-nuke      ${host}  (ports opened, hack sufficient, but nuke failed — bug?)`);
            counters["FAIL-nuke"]++;
        }
    }
    // In quiet mode, suppress the summary line entirely when nothing
    // interesting happened. We only print it if at least one NUKED
    // (the whole point of running this) or any FAIL- (real issue).
    // In verbose mode, always print the summary — it's the per-run
    // report you can scroll back through.
    const summary = Object.entries(counters)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    const interesting = counters.NUKED > 0 || counters["FAIL-notfound"] > 0 || counters["FAIL-nuke"] > 0;
    if (!quiet || interesting) {
        ns.tprint(`done: ${summary} (scanned ${hosts.length} hosts)`);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibnVrZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9udWtlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsdUVBQXVFO0FBQ3ZFLHNFQUFzRTtBQUN0RSx1RUFBdUU7QUFDdkUsb0NBQW9DO0FBQ3BDLEVBQUU7QUFDRixTQUFTO0FBQ1QsbUZBQW1GO0FBQ25GLGtFQUFrRTtBQUNsRSxnR0FBZ0c7QUFDaEcsRUFBRTtBQUNGLGdFQUFnRTtBQUNoRSxzRUFBc0U7QUFDdEUsZ0VBQWdFO0FBQ2hFLGtFQUFrRTtBQUNsRSxpRUFBaUU7QUFDakUsb0RBQW9EO0FBQ3BELEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7OztDQUliLENBQUM7QUFFRixNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDeEQsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQixPQUFPO0tBQ1I7SUFDRCxxRUFBcUU7SUFDckUsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUM3QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3ZDLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDN0MsTUFBTSxNQUFNLEdBQUcsVUFBVSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUVuRSx5REFBeUQ7SUFDekQsTUFBTSxPQUFPLEdBQUc7UUFDZCxFQUFF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Q0FBQyxLQUFLLEdBQUcsQ0FBQyxJQUFJLFFBQVEsQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksUUFBUSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNyRyxJQUFJLENBQUMsS0FBSyxJQUFJLFdBQVcsRUFBRTtRQUN6QixFQUFFLENBQUMsTUFBTSxDQUFDLFNBQVMsT0FBTyxhQUFhLEtBQUssQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDO0tBQy9EO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIE9wZW4gZXZlcnkgcmVxdWlyZWQgcG9ydCBvbiBldmVyeSByZWFjaGFibGUgc2VydmVyLCB0aGVuIG5zLm51a2UgaXQuXG4vLyBJZGVtcG90ZW50IOKAlCBzYWZlIHRvIHJlLXJ1bi4gU2NhbnMgdGhlIHdob2xlIG5ldHdvcmsgcmVhY2hhYmxlIGZyb21cbi8vIGhvbWUgYnkgZGVmYXVsdCwgc28gbmV3bHktcHVyY2hhc2VkIHNlcnZlcnMgLyBmcmVzaGx5LXVubG9ja2VkIHBhdGhzXG4vLyBnZXQgbnVrZWQgd2l0aG91dCBlZGl0aW5nIGEgbGlzdC5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIG51a2UuanMgICAgICAgICAgICAgICAgICAgICAgICMgQkZTIHRoZSBuZXR3b3JrLCBudWtlIGV2ZXJ5IHJlYWNoYWJsZSBob3N0XG4vLyAgIHJ1biBudWtlLmpzIC0tdGFyZ2V0cyBuZW8tbmV0IENTRUMgICMgcGluIHRvIHNwZWNpZmljIHNlcnZlcnNcbi8vICAgcnVuIG51a2UuanMgLS1xdWlldCAgICAgICAgICAgICAgICMgb25seSBwcmludCBOVUtFRCAvIEZBSUwgLyBzdW1tYXJ5IChzdXBwcmVzcyBTS0lQIGxpbmVzKVxuLy9cbi8vIE91dC1vZi1sZXZlbCB0YXJnZXRzIGFyZSByZXBvcnRlZCAoc28geW91IGNhbiBzZWUgd2hhdCB5b3UncmVcbi8vIG1pc3NpbmcpIGJ1dCBub3QgYWN0ZWQgb24g4oCUIG51a2UoKSBzaWxlbnRseSBmYWlscyBvbiB1bmRlci1sZXZlbGxlZFxuLy8gaG9zdHMsIHNvIHdlIGZpbHRlciBiZWZvcmUgdHJ5aW5nLiBTZXJ2ZXJzIHlvdSBkb24ndCBoYXZlIHRoZVxuLy8gcG9ydC1vcGVuZXIgcHJvZ3JhbXMgZm9yIGFyZSBhbHNvIHJlcG9ydGVkICh3aXRoIGEgY291bnQgb2YgaG93XG4vLyBtYW55IHlvdSdyZSBtaXNzaW5nKSBhbmQgc2tpcHBlZC4gUGFzcyAtLXF1aWV0IHRvIHN1cHByZXNzIHRoZVxuLy8gU0tJUC0qIG5vaXNlIGFuZCBvbmx5IHNlZSBOVUtFRCAvIEZBSUwgLyBzdW1tYXJ5LlxuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxuICBydW4gbnVrZS5qcyAgICAgICAgICAgICAgICAgICAgICAgICAgIyBCRlMgdGhlIG5ldHdvcmssIG51a2UgZXZlcnkgcmVhY2hhYmxlIGhvc3RcbiAgcnVuIG51a2UuanMgLS10YXJnZXRzIG5lby1uZXQgQ1NFQyAgICMgcGluIHRvIHNwZWNpZmljIHNlcnZlcnNcbiAgcnVuIG51a2UuanMgLS1xdWlldCAgICAgICAgICAgICAgICAgICMgb25seSBwcmludCBOVUtFRCAvIEZBSUwgLyBzdW1tYXJ5XG5gO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBQYXJzZSBhcmdzLiAtLXRhcmdldHMgPGxpc3QuLi4+IHRha2VzIHRoZSByZXN0IGFzIHRoZSB0YXJnZXQgbGlzdC5cbiAgY29uc3QgYXJncyA9IG5zLmFyZ3Muc2xpY2UoKTtcbiAgY29uc3QgcXVpZXQgPSBhcmdzLmluY2x1ZGVzKFwiLS1xdWlldFwiKTtcbiAgY29uc3QgdGFyZ2V0c0lkeCA9IGFyZ3MuaW5kZXhPZihcIi0tdGFyZ2V0c1wiKTtcbiAgY29uc3QgcGlubmVkID0gdGFyZ2V0c0lkeCA+PSAwID8gYXJncy5zbGljZSh0YXJnZXRzSWR4ICsgMSkgOiBudWxsO1xuXG4gIC8vIE9wZW5lciBwcm9ncmFtcyBvbiBob21lIGFuZCB0aGUgbWF0Y2hpbmcgTlMgZnVuY3Rpb25zLlxuICBjb25zdCBvcGVuZXJzID0gW1xuICAgIHsgZmlsZTogXCJCcnV0ZVNTSC5leGVcIiwgIG9wZW46IChoKSA9PiBucy5icnV0ZXNzaChoKSB9LFxuICAgIHsgZmlsZTogXCJGVFBDcmFjay5leGVcIiwgIG9wZW46IChoKSA9PiBucy5mdHBjcmFjayhoKSB9LFxuICAgIHsgZmlsZTogXCJyZWxheVNNVFAuZXhlXCIsIG9wZW46IChoKSA9PiBucy5yZWxheXNtdHAoaCkgfSxcbiAgICB7IGZpbGU6IFwiSFRUUFdvcm0uZXhlXCIsICBvcGVuOiAoaCkgPT4gbnMuaHR0cHdvcm0oaCkgfSxcbiAgICB7IGZpbGU6IFwiU1FMSW5qZWN0LmV4ZVwiLCBvcGVuOiAoaCkgPT4gbnMuc3FsaW5qZWN0KGgpIH0sXG4gIF07XG5cbiAgLy8gQnVpbGQgdGhlIHRhcmdldCBsaXN0LiBQaW5uZWQgbW9kZSBza2lwcyB0aGUgQkZTLlxuICBsZXQgaG9zdHM7XG4gIGlmIChwaW5uZWQpIHtcbiAgICBob3N0cyA9IHBpbm5lZDtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldChbXCJob21lXCJdKTtcbiAgICBjb25zdCBxdWV1ZSA9IFtcImhvbWVcIl07XG4gICAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGggPSBxdWV1ZS5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCBuIG9mIG5zLnNjYW4oaCkpIHtcbiAgICAgICAgaWYgKCFzZWVuLmhhcyhuKSkgeyBzZWVuLmFkZChuKTsgcXVldWUucHVzaChuKTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBob3N0cyA9IFsuLi5zZWVuXS5zb3J0KCk7XG4gIH1cblxuICBjb25zdCBteUhhY2sgPSBucy5nZXRQbGF5ZXIoKS5za2lsbHMuaGFja2luZztcblxuICBjb25zdCBjb3VudGVycyA9IHtcbiAgICBcIk5VS0VEXCI6IDAsXG4gICAgXCJTS0lQLXJvb3RlZFwiOiAwLFxuICAgIFwiU0tJUC1zZWxmXCI6IDAsXG4gICAgXCJTS0lQLXB1cmNoYXNlZFwiOiAwLFxuICAgIFwiU0tJUC1oYWNrXCI6IDAsXG4gICAgXCJTS0lQLXBvcnRcIjogMCxcbiAgICBcIkZBSUwtbm90Zm91bmRcIjogMCxcbiAgICBcIkZBSUwtbnVrZVwiOiAwLFxuICB9O1xuXG4gIGZvciAoY29uc3QgaG9zdCBvZiBob3N0cykge1xuICAgIGlmIChob3N0ID09PSBcImhvbWVcIikge1xuICAgICAgaWYgKCFxdWlldCkgbnMudHByaW50KGBTS0lQLXNlbGYgICAgICBob21lYCk7XG4gICAgICBjb3VudGVyc1tcIlNLSVAtc2VsZlwiXSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKG5zLmhhc1Jvb3RBY2Nlc3MoaG9zdCkpIHtcbiAgICAgIGlmICghcXVpZXQpIG5zLnRwcmludChgU0tJUC1yb290ZWQgICAgJHtob3N0fSAgKGFscmVhZHkgcm9vdGVkKWApO1xuICAgICAgY291bnRlcnNbXCJTS0lQLXJvb3RlZFwiXSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgdGhlIHNlcnZlciBleGlzdHMgaW4gdGhlIG5ldHdvcmsuXG4gICAgLy8gZ2V0U2VydmVyTnVtUG9ydHNSZXF1aXJlZCByZXR1cm5zIC0xIGZvciB1bmtub3duIGhvc3RuYW1lcy5cbiAgICBjb25zdCBuZWVkZWQgPSBucy5nZXRTZXJ2ZXJOdW1Qb3J0c1JlcXVpcmVkKGhvc3QpO1xuICAgIGlmIChuZWVkZWQgPCAwKSB7XG4gICAgICAvLyBGQUlMIGxpbmVzIGFyZSBhbHdheXMgcHJpbnRlZCDigJQgdGhleSBzaWduYWwgYSByZWFsIGlzc3VlXG4gICAgICAvLyAodHlwbyBpbiAtLXRhcmdldHMsIG9yIGEgc2VydmVyIHRoYXQgbmVlZHMgYSBiYWNrZG9vciBmaXJzdCkuXG4gICAgICBucy50cHJpbnQoYEZBSUwtbm90Zm91bmQgICR7aG9zdH0gIChob3N0IG5vdCBpbiBuZXR3b3JrIOKAlCBCRlMgbWF5IG5lZWQgYSBwdXJjaGFzZSBvciBhIGJhY2tkb29yKWApO1xuICAgICAgY291bnRlcnNbXCJGQUlMLW5vdGZvdW5kXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBGaWx0ZXIgb3V0IHB1cmNoYXNlZCBzZXJ2ZXJzIOKAlCB5b3Ugb3duIHRob3NlLCB5b3UgZG9uJ3QgXCJudWtlXCIgdGhlbS5cbiAgICAvLyBnZXRTZXJ2ZXIoKSB3b3JrcyBvbiB1bmtub3duIGhvc3RzIGluIEJpdGJ1cm5lciwgc28gdGhpcyBpcyBzYWZlLlxuICAgIGNvbnN0IHMgPSBucy5nZXRTZXJ2ZXIoaG9zdCk7XG4gICAgaWYgKHMucHVyY2hhc2VkQnlQbGF5ZXIpIHtcbiAgICAgIGlmICghcXVpZXQpIG5zLnRwcmludChgU0tJUC1wdXJjaGFzZWQgJHtob3N0fWApO1xuICAgICAgY291bnRlcnNbXCJTS0lQLXB1cmNoYXNlZFwiXSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gSGFjay1sZXZlbCBjaGVjay4gbnVrZSgpIHNpbGVudGx5IGZhaWxzIHVuZGVyLWxldmVsbGVkLCBzbyB3ZSBmaWx0ZXIuXG4gICAgLy8gV2Ugc3RpbGwgKnJlcG9ydCogdGhlIGxldmVsIGJsb2NrLCBzbyB0aGUgdXNlciBjYW4gc2VlIHdoYXQgdGhleSdyZVxuICAgIC8vIG1pc3Npbmcg4oCUIGJ1dCB3ZSBkb24ndCB0cnkgdG8gbnVrZS5cbiAgICBjb25zdCByZXFIYWNrID0gbnMuZ2V0U2VydmVyUmVxdWlyZWRIYWNraW5nTGV2ZWwoaG9zdCk7XG4gICAgaWYgKHJlcUhhY2sgPiBteUhhY2spIHtcbiAgICAgIGlmICghcXVpZXQpIG5zLnRwcmludChgU0tJUC1oYWNrICAgICAgJHtob3N0fSAgKG5lZWQgaGFjayAke3JlcUhhY2t9LCB5b3UgaGF2ZSAke215SGFja30pYCk7XG4gICAgICBjb3VudGVyc1tcIlNLSVAtaGFja1wiXSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gT3BlbiBldmVyeSBwb3J0IHdlIGhhdmUgYSBwcm9ncmFtIGZvci5cbiAgICBjb25zdCBoYXZlT3BlbmVycyA9IG9wZW5lcnMuZmlsdGVyKChvKSA9PiBucy5maWxlRXhpc3RzKG8uZmlsZSwgXCJob21lXCIpKTtcbiAgICBmb3IgKGNvbnN0IG9wIG9mIGhhdmVPcGVuZXJzKSBvcC5vcGVuKGhvc3QpO1xuXG4gICAgaWYgKGhhdmVPcGVuZXJzLmxlbmd0aCA8IG5lZWRlZCkge1xuICAgICAgaWYgKCFxdWlldCkgbnMudHByaW50KGBTS0lQLXBvcnQgICAgICAke2hvc3R9ICAobmVlZCAke25lZWRlZH0gcG9ydC1vcGVuZXIgcHJvZ3JhbXMsIHlvdSBoYXZlICR7aGF2ZU9wZW5lcnMubGVuZ3RofTogJHtoYXZlT3BlbmVycy5tYXAoKG8pID0+IG8uZmlsZSkuam9pbihcIiwgXCIpIHx8IFwibm9uZVwifSlgKTtcbiAgICAgIGNvdW50ZXJzW1wiU0tJUC1wb3J0XCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBUcnkgdG8gbnVrZS5cbiAgICBucy5udWtlKGhvc3QpO1xuICAgIGlmIChucy5oYXNSb290QWNjZXNzKGhvc3QpKSB7XG4gICAgICBucy50cHJpbnQoYE5VS0VEICAgICAgICAgICR7aG9zdH1gKTtcbiAgICAgIGNvdW50ZXJzW1wiTlVLRURcIl0rKztcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRkFJTC1udWtlIGlzIGFsd2F5cyBwcmludGVkIChyYXJlLCBpbmRpY2F0ZXMgYSBidWcpLlxuICAgICAgbnMudHByaW50KGBGQUlMLW51a2UgICAgICAke2hvc3R9ICAocG9ydHMgb3BlbmVkLCBoYWNrIHN1ZmZpY2llbnQsIGJ1dCBudWtlIGZhaWxlZCDigJQgYnVnPylgKTtcbiAgICAgIGNvdW50ZXJzW1wiRkFJTC1udWtlXCJdKys7XG4gICAgfVxuICB9XG5cbiAgLy8gSW4gcXVpZXQgbW9kZSwgc3VwcHJlc3MgdGhlIHN1bW1hcnkgbGluZSBlbnRpcmVseSB3aGVuIG5vdGhpbmdcbiAgLy8gaW50ZXJlc3RpbmcgaGFwcGVuZWQuIFdlIG9ubHkgcHJpbnQgaXQgaWYgYXQgbGVhc3Qgb25lIE5VS0VEXG4gIC8vICh0aGUgd2hvbGUgcG9pbnQgb2YgcnVubmluZyB0aGlzKSBvciBhbnkgRkFJTC0gKHJlYWwgaXNzdWUpLlxuICAvLyBJbiB2ZXJib3NlIG1vZGUsIGFsd2F5cyBwcmludCB0aGUgc3VtbWFyeSDigJQgaXQncyB0aGUgcGVyLXJ1blxuICAvLyByZXBvcnQgeW91IGNhbiBzY3JvbGwgYmFjayB0aHJvdWdoLlxuICBjb25zdCBzdW1tYXJ5ID0gT2JqZWN0LmVudHJpZXMoY291bnRlcnMpXG4gICAgLmZpbHRlcigoW18sIHZdKSA9PiB2ID4gMClcbiAgICAubWFwKChbaywgdl0pID0+IGAke2t9PSR7dn1gKVxuICAgIC5qb2luKFwiIFwiKTtcbiAgY29uc3QgaW50ZXJlc3RpbmcgPSBjb3VudGVycy5OVUtFRCA+IDAgfHwgY291bnRlcnNbXCJGQUlMLW5vdGZvdW5kXCJdID4gMCB8fCBjb3VudGVyc1tcIkZBSUwtbnVrZVwiXSA+IDA7XG4gIGlmICghcXVpZXQgfHwgaW50ZXJlc3RpbmcpIHtcbiAgICBucy50cHJpbnQoYGRvbmU6ICR7c3VtbWFyeX0gKHNjYW5uZWQgJHtob3N0cy5sZW5ndGh9IGhvc3RzKWApO1xuICB9XG59XG4iXX0=