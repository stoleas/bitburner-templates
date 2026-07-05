/** @param {NS} ns */
//
// Deploy the worker script to every rooted, in-level target server and
// run it with the maximum thread count that fits. This is the early-game
// "fan out" pattern from the Beginners Guide: instead of one script on
// home hacking a single target, we put N copies of the script on N
// target servers so the work actually scales.
//
// Default worker is hack-loop.js. Override with the first positional
// arg if you ever need a different worker.
//
// Mid-game refusal: if manager.js is currently running on home, the
// centralized HWGW orchestrator already owns the rooted target set.
// Per-server hack-loop.js fan-out at this point is HARMFUL — it
// drains moneyAvailable on a continuous loop, so manager.js's
// pserv-launched ns.hack() returns $0.000 on otherwise-sane targets
// (Pitfall 8 in bitburner-dev: per-server and centralized HWGW
// systems can't coexist). We refuse to deploy by default and require
// --force for the early-game case where manager.js isn't running yet
// or for explicit testing. monitor-deploy.js applies the same guard.
//
// Usage:
//   run deploy.js                            # default: hack-loop.js
//   run deploy.js worker.js                  # custom worker name
//   run deploy.js --force                    # override mid-game guard
//   run deploy.js --quiet                    # suppress per-host DEPLOY/SKIP lines (used by monitor-deploy.js)
//   run deploy.js --quiet worker.js          # custom worker + quiet
//   run deploy.js --force --quiet            # override + quiet
//
// Worker contract: the worker takes a target hostname as its first arg
// and runs the H/G/W loop against that target. hack-loop.js does this.
//
// This is the ONE-SHOT version: it does a single pass over the network
// and exits. For the always-on "re-fan-out when a new server gets
// rooted" use case, see monitor-deploy.js — it loops on a 30s
// cadence. (Older versions of this file had a 5-minute auto-restart
// baked in; that was the right idea at the wrong cadence and made the
// file awkward to use as a one-shot. Splitting the two concerns into
// deploy.js + monitor-deploy.js is cleaner.)
//
const USAGE = `Usage:
 run deploy.js                       # default: hack-loop.js as worker
 run deploy.js worker.js             # custom worker name
 run deploy.js --force               # override mid-game guard (manager.js running)
 run deploy.js --quiet               # suppress per-host DEPLOY/SKIP lines (used by monitor-deploy.js)
 run deploy.js --quiet worker.js     # custom worker + quiet
 run deploy.js --force --quiet       # override + quiet
`;
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    // --quiet suppresses the per-host DEPLOY/SKIP/FAIL lines but keeps
    // the summary. monitor-deploy.js passes this by default on its 30s
    // loop so the terminal doesn't get flooded with per-host status.
    // NOTE: --quiet must be parsed BEFORE ns.args[0] is read as the
    // worker name, otherwise deploy.js will treat it as a worker.
    const quiet = ns.args.includes("--quiet");
    const force = ns.args.includes("--force");
    // Filter --quiet and --force out before treating ns.args[0] as the
    // worker name. The order matters: --quiet is a deploy.js flag
    // (relay from monitor-deploy.js), --force is a deploy.js flag
    // (override mid-game guard). Both are stripped here so a stray
    // --force in argv[0] doesn't get treated as a worker filename.
    const filteredArgs = ns.args.filter((a) => a !== "--quiet" && a !== "--force");
    const worker = filteredArgs[0]?.toString() ?? "hack-loop.js";
    // Mid-game guard: if manager.js is running on home, refuse by
    // default. The centralized orchestrator already owns the rooted
    // target set; per-server fan-out at this point drains
    // moneyAvailable on a continuous loop and breaks manager.js's
    // pserv-launched ns.hack() (returns $0.000 on otherwise-sane
    // targets). --force opts in for the early-game case or for
    // explicit testing. The check is cheap (one ns.ps() call) and
    // turns a silent destructive side-effect ("hack-loop.js quietly
    // appeared on every rooted target") into a clear, actionable
    // refusal. See Pitfall 8 in bitburner-dev and the long comment
    // at the top of master.js.
    const managerRunning = ns.ps("home").some((p) => p.filename === "manager.js");
    if (managerRunning && !force) {
        ns.tprint("deploy: refused — manager.js is running on home. " +
            "The centralized HWGW orchestrator already owns the rooted target set; " +
            "per-server hack-loop.js fan-out drains moneyAvailable and breaks " +
            "manager.js's $X.XXX hacks (Pitfall 8 in bitburner-dev). " +
            "Pass --force to override, or run manager.js for the centralized system.");
        return;
    }
    if (managerRunning && force) {
        ns.tprint("deploy: WARNING --force with manager.js running — " +
            "hack-loop.js on targets will drain moneyAvailable and break " +
            "manager.js's pserv-launched hacks. Remove the hack-loop.js " +
            "processes (kill hack-loop.js) when you're done testing.");
    }
    const SOURCE = "home";
    const me = ns.getPlayer();
    const myHack = me.skills.hacking;
    // BFS the network from home
    const seen = new Set([SOURCE]);
    const queue = [SOURCE];
    while (queue.length > 0) {
        const host = queue.shift();
        for (const n of ns.scan(host)) {
            if (!seen.has(n)) {
                seen.add(n);
                queue.push(n);
            }
        }
    }
    // Make sure the worker script exists on home so we can scp it.
    if (!ns.fileExists(worker, SOURCE)) {
        ns.tprint(`ERROR: ${worker} not on ${SOURCE}. Push it via filesync first.`);
        return;
    }
    // Quiet-by-default: only DEPLOYED and FAIL-* events are
    // interesting per-host. SKIP-* events (rooted, hack, etc.) are
    // expected noise during a normal run — printing them per-host
    // floods the terminal. The final summary at the end aggregates
    // all counter values regardless, so the user still sees how
    // many hosts were skipped and why. DEPLOYED events are the
    // positive signal we want surfaced; everything else is silent
    // (matching manager.js's error-only print rule).
    const print = (line) => { if (!quiet)
        ns.tprint(line); };
    // Always-print wrapper for DEPLOYED and FAIL events (no --quiet
    // gating). SKIP events use the gated `print()` above.
    const alert = (line) => ns.tprint(line);
    let deployed = 0;
    const counters = {
        "DEPLOYED": 0,
        "SKIP-self": 0,
        "SKIP-purchased": 0,
        "SKIP-nomoney": 0,
        "SKIP-rooted": 0,
        "SKIP-hack": 0,
        "SKIP-running": 0,
        "SKIP-ram": 0,
        "FAIL-scp": 0,
        "FAIL-exec": 0,
    };
    // Sort hosts for a stable, alphabetical status block (CSEC will always
    // appear in the same place between runs).
    const hosts = [...seen].sort();
    for (const host of hosts) {
        if (host === SOURCE) {
            print(`SKIP-self  ${host}`);
            counters["SKIP-self"]++;
            continue;
        }
        const s = ns.getServer(host);
        // Skip purchased servers — they have no money to hack. Run
        // deploy-share.js to put share.js on them instead.
        if (s.purchasedByPlayer) {
            print(`SKIP-purchased  ${host}  (run deploy-share.js to put share.js here)`);
            counters["SKIP-purchased"]++;
            continue;
        }
        // Check root BEFORE money: getServer() hides moneyMax on unrooted
        // hosts, so an unrooted server with $0 would otherwise look like a
        // nomoney server and get the wrong status line.
        if (!s.hasAdminRights) {
            const req = ns.getServerNumPortsRequired(host);
            const reqHack = ns.getServerRequiredHackingLevel(host);
            print(`SKIP-rooted     ${host}  (need ${req} port-opener, hack ${reqHack}/${myHack})`);
            counters["SKIP-rooted"]++;
            continue;
        }
        if (!s.moneyMax || s.moneyMax <= 0) {
            print(`SKIP-nomoney    ${host}  (moneyMax=0 — faction/backdoor server, no cash to steal)`);
            counters["SKIP-nomoney"]++;
            continue;
        }
        if ((s.requiredHackingSkill ?? 0) > myHack) {
            print(`SKIP-hack       ${host}  (need hack ${s.requiredHackingSkill}, have ${myHack})`);
            counters["SKIP-hack"]++;
            continue;
        }
        // If a copy of the worker is already running on the host, leave it
        // alone. This makes deploy.js safe to re-run.
        if (ns.ps(host).some((p) => p.filename === worker)) {
            print(`SKIP-running    ${host}  (${worker} already running)`);
            counters["SKIP-running"]++;
            continue;
        }
        // Copy the worker script to the target.
        if (!ns.scp(worker, host, SOURCE)) {
            print(`FAIL-scp        ${host}`);
            counters["FAIL-scp"]++;
            continue;
        }
        // Run with max threads. RAM/threads formula per the docs.
        const ramPerThread = ns.getScriptRam(worker, host);
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        const threads = Math.max(1, Math.floor(free / ramPerThread));
        if (threads < 1 || ramPerThread <= 0) {
            print(`SKIP-ram        ${host}  (no free RAM: ${free.toFixed(2)} GB, ${worker} needs ${ramPerThread.toFixed(2)} GB)`);
            counters["SKIP-ram"]++;
            continue;
        }
        // The worker takes a target as its first arg. We pass the host
        // itself so the worker hacks its own server — that's the simplest
        // and the guide's recommended pattern. You can change this to a
        // single hardcoded target if you want a "swarm" all hitting one.
        const pid = ns.exec(worker, host, threads, host);
        if (pid === 0) {
            print(`FAIL-exec       ${host}  (exec returned 0 — RAM contention or other script running)`);
            counters["FAIL-exec"]++;
            continue;
        }
        alert(`DEPLOYED        ${host}  ${worker} x${threads} (pid ${pid})`);
        counters["DEPLOYED"]++;
    }
    // Summary line — easier than scanning the block.
    const summary = Object.entries(counters)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    ns.tprint(`done: ${summary} (scanned ${hosts.length} hosts)`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVwbG95LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2RlcGxveS5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSx5RUFBeUU7QUFDekUsdUVBQXVFO0FBQ3ZFLG1FQUFtRTtBQUNuRSw4Q0FBOEM7QUFDOUMsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSwyQ0FBMkM7QUFDM0MsRUFBRTtBQUNGLG9FQUFvRTtBQUNwRSxvRUFBb0U7QUFDcEUsZ0VBQWdFO0FBQ2hFLDhEQUE4RDtBQUM5RCxvRUFBb0U7QUFDcEUsK0RBQStEO0FBQy9ELHFFQUFxRTtBQUNyRSxxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLEVBQUU7QUFDRixTQUFTO0FBQ1QscUVBQXFFO0FBQ3JFLGtFQUFrRTtBQUNsRSx1RUFBdUU7QUFDdkUsK0dBQStHO0FBQy9HLHFFQUFxRTtBQUNyRSxnRUFBZ0U7QUFDaEUsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSx1RUFBdUU7QUFDdkUsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSxrRUFBa0U7QUFDbEUsOERBQThEO0FBQzlELG9FQUFvRTtBQUNwRSxzRUFBc0U7QUFDdEUscUVBQXFFO0FBQ3JFLDZDQUE2QztBQUM3QyxFQUFFO0FBQ0YsTUFBTSxLQUFLLEdBQUc7Ozs7Ozs7Q0FPYixDQUFDO0FBRUYsTUFBTSxDQUFDLEtBQUssVUFBVSxJQUFJLENBQUMsRUFBRTtJQUMzQixJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxFQUFFO1FBQ3hELEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDakIsT0FBTztLQUNSO0lBQ0QsbUVBQW1FO0lBQ25FLG1FQUFtRTtJQUNuRSxpRUFBaUU7SUFDakUsZ0VBQWdFO0lBQ2hFLDhEQUE4RDtJQUM5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RSxDQUFDO1lBQ3hCLFNBQVM7U0FDVjtRQUVELEtBQUssQ0FBQyxtQkFBbUIsSUFBSSxLQUFLLE1BQU0sS0FBSyxPQUFPLFNBQVMsR0FBRyxHQUFHLENBQUMsQ0FBQztRQUNyRSxRQUFRLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztLQUN4QjtJQUVELGlEQUFpRDtJQUNqRCxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztTQUNyQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztTQUN6QixHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7U0FDNUIsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2IsRUFBRSxDQUFDLE1BQU0sQ0FBQyxTQUFTLE9BQU8sYUFBYSxLQUFLLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQztBQUNoRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gRGVwbG95IHRoZSB3b3JrZXIgc2NyaXB0IHRvIGV2ZXJ5IHJvb3RlZCwgaW4tbGV2ZWwgdGFyZ2V0IHNlcnZlciBhbmRcbi8vIHJ1biBpdCB3aXRoIHRoZSBtYXhpbXVtIHRocmVhZCBjb3VudCB0aGF0IGZpdHMuIFRoaXMgaXMgdGhlIGVhcmx5LWdhbWVcbi8vIFwiZmFuIG91dFwiIHBhdHRlcm4gZnJvbSB0aGUgQmVnaW5uZXJzIEd1aWRlOiBpbnN0ZWFkIG9mIG9uZSBzY3JpcHQgb25cbi8vIGhvbWUgaGFja2luZyBhIHNpbmdsZSB0YXJnZXQsIHdlIHB1dCBOIGNvcGllcyBvZiB0aGUgc2NyaXB0IG9uIE5cbi8vIHRhcmdldCBzZXJ2ZXJzIHNvIHRoZSB3b3JrIGFjdHVhbGx5IHNjYWxlcy5cbi8vXG4vLyBEZWZhdWx0IHdvcmtlciBpcyBoYWNrLWxvb3AuanMuIE92ZXJyaWRlIHdpdGggdGhlIGZpcnN0IHBvc2l0aW9uYWxcbi8vIGFyZyBpZiB5b3UgZXZlciBuZWVkIGEgZGlmZmVyZW50IHdvcmtlci5cbi8vXG4vLyBNaWQtZ2FtZSByZWZ1c2FsOiBpZiBtYW5hZ2VyLmpzIGlzIGN1cnJlbnRseSBydW5uaW5nIG9uIGhvbWUsIHRoZVxuLy8gY2VudHJhbGl6ZWQgSFdHVyBvcmNoZXN0cmF0b3IgYWxyZWFkeSBvd25zIHRoZSByb290ZWQgdGFyZ2V0IHNldC5cbi8vIFBlci1zZXJ2ZXIgaGFjay1sb29wLmpzIGZhbi1vdXQgYXQgdGhpcyBwb2ludCBpcyBIQVJNRlVMIOKAlCBpdFxuLy8gZHJhaW5zIG1vbmV5QXZhaWxhYmxlIG9uIGEgY29udGludW91cyBsb29wLCBzbyBtYW5hZ2VyLmpzJ3Ncbi8vIHBzZXJ2LWxhdW5jaGVkIG5zLmhhY2soKSByZXR1cm5zICQwLjAwMCBvbiBvdGhlcndpc2Utc2FuZSB0YXJnZXRzXG4vLyAoUGl0ZmFsbCA4IGluIGJpdGJ1cm5lci1kZXY6IHBlci1zZXJ2ZXIgYW5kIGNlbnRyYWxpemVkIEhXR1dcbi8vIHN5c3RlbXMgY2FuJ3QgY29leGlzdCkuIFdlIHJlZnVzZSB0byBkZXBsb3kgYnkgZGVmYXVsdCBhbmQgcmVxdWlyZVxuLy8gLS1mb3JjZSBmb3IgdGhlIGVhcmx5LWdhbWUgY2FzZSB3aGVyZSBtYW5hZ2VyLmpzIGlzbid0IHJ1bm5pbmcgeWV0XG4vLyBvciBmb3IgZXhwbGljaXQgdGVzdGluZy4gbW9uaXRvci1kZXBsb3kuanMgYXBwbGllcyB0aGUgc2FtZSBndWFyZC5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIGRlcGxveS5qcyAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGRlZmF1bHQ6IGhhY2stbG9vcC5qc1xuLy8gICBydW4gZGVwbG95LmpzIHdvcmtlci5qcyAgICAgICAgICAgICAgICAgICMgY3VzdG9tIHdvcmtlciBuYW1lXG4vLyAgIHJ1biBkZXBsb3kuanMgLS1mb3JjZSAgICAgICAgICAgICAgICAgICAgIyBvdmVycmlkZSBtaWQtZ2FtZSBndWFyZFxuLy8gICBydW4gZGVwbG95LmpzIC0tcXVpZXQgICAgICAgICAgICAgICAgICAgICMgc3VwcHJlc3MgcGVyLWhvc3QgREVQTE9ZL1NLSVAgbGluZXMgKHVzZWQgYnkgbW9uaXRvci1kZXBsb3kuanMpXG4vLyAgIHJ1biBkZXBsb3kuanMgLS1xdWlldCB3b3JrZXIuanMgICAgICAgICAgIyBjdXN0b20gd29ya2VyICsgcXVpZXRcbi8vICAgcnVuIGRlcGxveS5qcyAtLWZvcmNlIC0tcXVpZXQgICAgICAgICAgICAjIG92ZXJyaWRlICsgcXVpZXRcbi8vXG4vLyBXb3JrZXIgY29udHJhY3Q6IHRoZSB3b3JrZXIgdGFrZXMgYSB0YXJnZXQgaG9zdG5hbWUgYXMgaXRzIGZpcnN0IGFyZ1xuLy8gYW5kIHJ1bnMgdGhlIEgvRy9XIGxvb3AgYWdhaW5zdCB0aGF0IHRhcmdldC4gaGFjay1sb29wLmpzIGRvZXMgdGhpcy5cbi8vXG4vLyBUaGlzIGlzIHRoZSBPTkUtU0hPVCB2ZXJzaW9uOiBpdCBkb2VzIGEgc2luZ2xlIHBhc3Mgb3ZlciB0aGUgbmV0d29ya1xuLy8gYW5kIGV4aXRzLiBGb3IgdGhlIGFsd2F5cy1vbiBcInJlLWZhbi1vdXQgd2hlbiBhIG5ldyBzZXJ2ZXIgZ2V0c1xuLy8gcm9vdGVkXCIgdXNlIGNhc2UsIHNlZSBtb25pdG9yLWRlcGxveS5qcyDigJQgaXQgbG9vcHMgb24gYSAzMHNcbi8vIGNhZGVuY2UuIChPbGRlciB2ZXJzaW9ucyBvZiB0aGlzIGZpbGUgaGFkIGEgNS1taW51dGUgYXV0by1yZXN0YXJ0XG4vLyBiYWtlZCBpbjsgdGhhdCB3YXMgdGhlIHJpZ2h0IGlkZWEgYXQgdGhlIHdyb25nIGNhZGVuY2UgYW5kIG1hZGUgdGhlXG4vLyBmaWxlIGF3a3dhcmQgdG8gdXNlIGFzIGEgb25lLXNob3QuIFNwbGl0dGluZyB0aGUgdHdvIGNvbmNlcm5zIGludG9cbi8vIGRlcGxveS5qcyArIG1vbml0b3ItZGVwbG95LmpzIGlzIGNsZWFuZXIuKVxuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxuIHJ1biBkZXBsb3kuanMgICAgICAgICAgICAgICAgICAgICAgICMgZGVmYXVsdDogaGFjay1sb29wLmpzIGFzIHdvcmtlclxuIHJ1biBkZXBsb3kuanMgd29ya2VyLmpzICAgICAgICAgICAgICMgY3VzdG9tIHdvcmtlciBuYW1lXG4gcnVuIGRlcGxveS5qcyAtLWZvcmNlICAgICAgICAgICAgICAgIyBvdmVycmlkZSBtaWQtZ2FtZSBndWFyZCAobWFuYWdlci5qcyBydW5uaW5nKVxuIHJ1biBkZXBsb3kuanMgLS1xdWlldCAgICAgICAgICAgICAgICMgc3VwcHJlc3MgcGVyLWhvc3QgREVQTE9ZL1NLSVAgbGluZXMgKHVzZWQgYnkgbW9uaXRvci1kZXBsb3kuanMpXG4gcnVuIGRlcGxveS5qcyAtLXF1aWV0IHdvcmtlci5qcyAgICAgIyBjdXN0b20gd29ya2VyICsgcXVpZXRcbiBydW4gZGVwbG95LmpzIC0tZm9yY2UgLS1xdWlldCAgICAgICAjIG92ZXJyaWRlICsgcXVpZXRcbmA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGlmIChucy5hcmdzLmluY2x1ZGVzKFwiLWhcIikgfHwgbnMuYXJncy5pbmNsdWRlcyhcIi0taGVscFwiKSkge1xuICAgIG5zLnRwcmludChVU0FHRSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIC0tcXVpZXQgc3VwcHJlc3NlcyB0aGUgcGVyLWhvc3QgREVQTE9ZL1NLSVAvRkFJTCBsaW5lcyBidXQga2VlcHNcbiAgLy8gdGhlIHN1bW1hcnkuIG1vbml0b3ItZGVwbG95LmpzIHBhc3NlcyB0aGlzIGJ5IGRlZmF1bHQgb24gaXRzIDMwc1xuICAvLyBsb29wIHNvIHRoZSB0ZXJtaW5hbCBkb2Vzbid0IGdldCBmbG9vZGVkIHdpdGggcGVyLWhvc3Qgc3RhdHVzLlxuICAvLyBOT1RFOiAtLXF1aWV0IG11c3QgYmUgcGFyc2VkIEJFRk9SRSBucy5hcmdzWzBdIGlzIHJlYWQgYXMgdGhlXG4gIC8vIHdvcmtlciBuYW1lLCBvdGhlcndpc2UgZGVwbG95LmpzIHdpbGwgdHJlYXQgaXQgYXMgYSB3b3JrZXIuXG4gIGNvbnN0IHF1aWV0ID0gbnMuYXJncy5pbmNsdWRlcyhcIi0tcXVpZXRcIik7XG4gIGNvbnN0IGZvcmNlID0gbnMuYXJncy5pbmNsdWRlcyhcIi0tZm9yY2VcIik7XG4gIC8vIEZpbHRlciAtLXF1aWV0IGFuZCAtLWZvcmNlIG91dCBiZWZvcmUgdHJlYXRpbmcgbnMuYXJnc1swXSBhcyB0aGVcbiAgLy8gd29ya2VyIG5hbWUuIFRoZSBvcmRlciBtYXR0ZXJzOiAtLXF1aWV0IGlzIGEgZGVwbG95LmpzIGZsYWdcbiAgLy8gKHJlbGF5IGZyb20gbW9uaXRvci1kZXBsb3kuanMpLCAtLWZvcmNlIGlzIGEgZGVwbG95LmpzIGZsYWdcbiAgLy8gKG92ZXJyaWRlIG1pZC1nYW1lIGd1YXJkKS4gQm90aCBhcmUgc3RyaXBwZWQgaGVyZSBzbyBhIHN0cmF5XG4gIC8vIC0tZm9yY2UgaW4gYXJndlswXSBkb2Vzbid0IGdldCB0cmVhdGVkIGFzIGEgd29ya2VyIGZpbGVuYW1lLlxuICBjb25zdCBmaWx0ZXJlZEFyZ3MgPSBucy5hcmdzLmZpbHRlcigoYSkgPT4gYSAhPT0gXCItLXF1aWV0XCIgJiYgYSAhPT0gXCItLWZvcmNlXCIpO1xuICBjb25zdCB3b3JrZXIgPSBmaWx0ZXJlZEFyZ3NbMF0/LnRvU3RyaW5nKCkgPz8gXCJoYWNrLWxvb3AuanNcIjtcblxuICAvLyBNaWQtZ2FtZSBndWFyZDogaWYgbWFuYWdlci5qcyBpcyBydW5uaW5nIG9uIGhvbWUsIHJlZnVzZSBieVxuICAvLyBkZWZhdWx0LiBUaGUgY2VudHJhbGl6ZWQgb3JjaGVzdHJhdG9yIGFscmVhZHkgb3ducyB0aGUgcm9vdGVkXG4gIC8vIHRhcmdldCBzZXQ7IHBlci1zZXJ2ZXIgZmFuLW91dCBhdCB0aGlzIHBvaW50IGRyYWluc1xuICAvLyBtb25leUF2YWlsYWJsZSBvbiBhIGNvbnRpbnVvdXMgbG9vcCBhbmQgYnJlYWtzIG1hbmFnZXIuanMnc1xuICAvLyBwc2Vydi1sYXVuY2hlZCBucy5oYWNrKCkgKHJldHVybnMgJDAuMDAwIG9uIG90aGVyd2lzZS1zYW5lXG4gIC8vIHRhcmdldHMpLiAtLWZvcmNlIG9wdHMgaW4gZm9yIHRoZSBlYXJseS1nYW1lIGNhc2Ugb3IgZm9yXG4gIC8vIGV4cGxpY2l0IHRlc3RpbmcuIFRoZSBjaGVjayBpcyBjaGVhcCAob25lIG5zLnBzKCkgY2FsbCkgYW5kXG4gIC8vIHR1cm5zIGEgc2lsZW50IGRlc3RydWN0aXZlIHNpZGUtZWZmZWN0IChcImhhY2stbG9vcC5qcyBxdWlldGx5XG4gIC8vIGFwcGVhcmVkIG9uIGV2ZXJ5IHJvb3RlZCB0YXJnZXRcIikgaW50byBhIGNsZWFyLCBhY3Rpb25hYmxlXG4gIC8vIHJlZnVzYWwuIFNlZSBQaXRmYWxsIDggaW4gYml0YnVybmVyLWRldiBhbmQgdGhlIGxvbmcgY29tbWVudFxuICAvLyBhdCB0aGUgdG9wIG9mIG1hc3Rlci5qcy5cbiAgY29uc3QgbWFuYWdlclJ1bm5pbmcgPSBucy5wcyhcImhvbWVcIikuc29tZSgocCkgPT4gcC5maWxlbmFtZSA9PT0gXCJtYW5hZ2VyLmpzXCIpO1xuICBpZiAobWFuYWdlclJ1bm5pbmcgJiYgIWZvcmNlKSB7XG4gICAgbnMudHByaW50KFxuICAgICAgXCJkZXBsb3k6IHJlZnVzZWQg4oCUIG1hbmFnZXIuanMgaXMgcnVubmluZyBvbiBob21lLiBcIiArXG4gICAgICBcIlRoZSBjZW50cmFsaXplZCBIV0dXIG9yY2hlc3RyYXRvciBhbHJlYWR5IG93bnMgdGhlIHJvb3RlZCB0YXJnZXQgc2V0OyBcIiArXG4gICAgICBcInBlci1zZXJ2ZXIgaGFjay1sb29wLmpzIGZhbi1vdXQgZHJhaW5zIG1vbmV5QXZhaWxhYmxlIGFuZCBicmVha3MgXCIgK1xuICAgICAgXCJtYW5hZ2VyLmpzJ3MgJFguWFhYIGhhY2tzIChQaXRmYWxsIDggaW4gYml0YnVybmVyLWRldikuIFwiICtcbiAgICAgIFwiUGFzcyAtLWZvcmNlIHRvIG92ZXJyaWRlLCBvciBydW4gbWFuYWdlci5qcyBmb3IgdGhlIGNlbnRyYWxpemVkIHN5c3RlbS5cIlxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChtYW5hZ2VyUnVubmluZyAmJiBmb3JjZSkge1xuICAgIG5zLnRwcmludChcbiAgICAgIFwiZGVwbG95OiBXQVJOSU5HIC0tZm9yY2Ugd2l0aCBtYW5hZ2VyLmpzIHJ1bm5pbmcg4oCUIFwiICtcbiAgICAgIFwiaGFjay1sb29wLmpzIG9uIHRhcmdldHMgd2lsbCBkcmFpbiBtb25leUF2YWlsYWJsZSBhbmQgYnJlYWsgXCIgK1xuICAgICAgXCJtYW5hZ2VyLmpzJ3MgcHNlcnYtbGF1bmNoZWQgaGFja3MuIFJlbW92ZSB0aGUgaGFjay1sb29wLmpzIFwiICtcbiAgICAgIFwicHJvY2Vzc2VzIChraWxsIGhhY2stbG9vcC5qcykgd2hlbiB5b3UncmUgZG9uZSB0ZXN0aW5nLlwiXG4gICAgKTtcbiAgfVxuICBjb25zdCBTT1VSQ0UgPSBcImhvbWVcIjtcblxuICBjb25zdCBtZSA9IG5zLmdldFBsYXllcigpO1xuICBjb25zdCBteUhhY2sgPSBtZS5za2lsbHMuaGFja2luZztcblxuICAvLyBCRlMgdGhlIG5ldHdvcmsgZnJvbSBob21lXG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0KFtTT1VSQ0VdKTtcbiAgY29uc3QgcXVldWUgPSBbU09VUkNFXTtcbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBob3N0ID0gcXVldWUuc2hpZnQoKTtcbiAgICBmb3IgKGNvbnN0IG4gb2YgbnMuc2Nhbihob3N0KSkge1xuICAgICAgaWYgKCFzZWVuLmhhcyhuKSkgeyBzZWVuLmFkZChuKTsgcXVldWUucHVzaChuKTsgfVxuICAgIH1cbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB0aGUgd29ya2VyIHNjcmlwdCBleGlzdHMgb24gaG9tZSBzbyB3ZSBjYW4gc2NwIGl0LlxuICBpZiAoIW5zLmZpbGVFeGlzdHMod29ya2VyLCBTT1VSQ0UpKSB7XG4gICAgbnMudHByaW50KGBFUlJPUjogJHt3b3JrZXJ9IG5vdCBvbiAke1NPVVJDRX0uIFB1c2ggaXQgdmlhIGZpbGVzeW5jIGZpcnN0LmApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFF1aWV0LWJ5LWRlZmF1bHQ6IG9ubHkgREVQTE9ZRUQgYW5kIEZBSUwtKiBldmVudHMgYXJlXG4gIC8vIGludGVyZXN0aW5nIHBlci1ob3N0LiBTS0lQLSogZXZlbnRzIChyb290ZWQsIGhhY2ssIGV0Yy4pIGFyZVxuICAvLyBleHBlY3RlZCBub2lzZSBkdXJpbmcgYSBub3JtYWwgcnVuIOKAlCBwcmludGluZyB0aGVtIHBlci1ob3N0XG4gIC8vIGZsb29kcyB0aGUgdGVybWluYWwuIFRoZSBmaW5hbCBzdW1tYXJ5IGF0IHRoZSBlbmQgYWdncmVnYXRlc1xuICAvLyBhbGwgY291bnRlciB2YWx1ZXMgcmVnYXJkbGVzcywgc28gdGhlIHVzZXIgc3RpbGwgc2VlcyBob3dcbiAgLy8gbWFueSBob3N0cyB3ZXJlIHNraXBwZWQgYW5kIHdoeS4gREVQTE9ZRUQgZXZlbnRzIGFyZSB0aGVcbiAgLy8gcG9zaXRpdmUgc2lnbmFsIHdlIHdhbnQgc3VyZmFjZWQ7IGV2ZXJ5dGhpbmcgZWxzZSBpcyBzaWxlbnRcbiAgLy8gKG1hdGNoaW5nIG1hbmFnZXIuanMncyBlcnJvci1vbmx5IHByaW50IHJ1bGUpLlxuICBjb25zdCBwcmludCA9IChsaW5lKSA9PiB7IGlmICghcXVpZXQpIG5zLnRwcmludChsaW5lKTsgfTtcbiAgLy8gQWx3YXlzLXByaW50IHdyYXBwZXIgZm9yIERFUExPWUVEIGFuZCBGQUlMIGV2ZW50cyAobm8gLS1xdWlldFxuICAvLyBnYXRpbmcpLiBTS0lQIGV2ZW50cyB1c2UgdGhlIGdhdGVkIGBwcmludCgpYCBhYm92ZS5cbiAgY29uc3QgYWxlcnQgPSAobGluZSkgPT4gbnMudHByaW50KGxpbmUpO1xuXG4gIGxldCBkZXBsb3llZCA9IDA7XG4gIGNvbnN0IGNvdW50ZXJzID0ge1xuICAgIFwiREVQTE9ZRURcIjogMCxcbiAgICBcIlNLSVAtc2VsZlwiOiAwLFxuICAgIFwiU0tJUC1wdXJjaGFzZWRcIjogMCxcbiAgICBcIlNLSVAtbm9tb25leVwiOiAwLFxuICAgIFwiU0tJUC1yb290ZWRcIjogMCxcbiAgICBcIlNLSVAtaGFja1wiOiAwLFxuICAgIFwiU0tJUC1ydW5uaW5nXCI6IDAsXG4gICAgXCJTS0lQLXJhbVwiOiAwLFxuICAgIFwiRkFJTC1zY3BcIjogMCxcbiAgICBcIkZBSUwtZXhlY1wiOiAwLFxuICB9O1xuXG4gIC8vIFNvcnQgaG9zdHMgZm9yIGEgc3RhYmxlLCBhbHBoYWJldGljYWwgc3RhdHVzIGJsb2NrIChDU0VDIHdpbGwgYWx3YXlzXG4gIC8vIGFwcGVhciBpbiB0aGUgc2FtZSBwbGFjZSBiZXR3ZWVuIHJ1bnMpLlxuICBjb25zdCBob3N0cyA9IFsuLi5zZWVuXS5zb3J0KCk7XG5cbiAgZm9yIChjb25zdCBob3N0IG9mIGhvc3RzKSB7XG4gICAgaWYgKGhvc3QgPT09IFNPVVJDRSkge1xuICAgICAgcHJpbnQoYFNLSVAtc2VsZiAgJHtob3N0fWApO1xuICAgICAgY291bnRlcnNbXCJTS0lQLXNlbGZcIl0rKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHMgPSBucy5nZXRTZXJ2ZXIoaG9zdCk7XG5cbiAgICAvLyBTa2lwIHB1cmNoYXNlZCBzZXJ2ZXJzIOKAlCB0aGV5IGhhdmUgbm8gbW9uZXkgdG8gaGFjay4gUnVuXG4gICAgLy8gZGVwbG95LXNoYXJlLmpzIHRvIHB1dCBzaGFyZS5qcyBvbiB0aGVtIGluc3RlYWQuXG4gICAgaWYgKHMucHVyY2hhc2VkQnlQbGF5ZXIpIHtcbiAgICAgIHByaW50KGBTS0lQLXB1cmNoYXNlZCAgJHtob3N0fSAgKHJ1biBkZXBsb3ktc2hhcmUuanMgdG8gcHV0IHNoYXJlLmpzIGhlcmUpYCk7XG4gICAgICBjb3VudGVyc1tcIlNLSVAtcHVyY2hhc2VkXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayByb290IEJFRk9SRSBtb25leTogZ2V0U2VydmVyKCkgaGlkZXMgbW9uZXlNYXggb24gdW5yb290ZWRcbiAgICAvLyBob3N0cywgc28gYW4gdW5yb290ZWQgc2VydmVyIHdpdGggJDAgd291bGQgb3RoZXJ3aXNlIGxvb2sgbGlrZSBhXG4gICAgLy8gbm9tb25leSBzZXJ2ZXIgYW5kIGdldCB0aGUgd3Jvbmcgc3RhdHVzIGxpbmUuXG4gICAgaWYgKCFzLmhhc0FkbWluUmlnaHRzKSB7XG4gICAgICBjb25zdCByZXEgPSBucy5nZXRTZXJ2ZXJOdW1Qb3J0c1JlcXVpcmVkKGhvc3QpO1xuICAgICAgY29uc3QgcmVxSGFjayA9IG5zLmdldFNlcnZlclJlcXVpcmVkSGFja2luZ0xldmVsKGhvc3QpO1xuICAgICAgcHJpbnQoYFNLSVAtcm9vdGVkICAgICAke2hvc3R9ICAobmVlZCAke3JlcX0gcG9ydC1vcGVuZXIsIGhhY2sgJHtyZXFIYWNrfS8ke215SGFja30pYCk7XG4gICAgICBjb3VudGVyc1tcIlNLSVAtcm9vdGVkXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoIXMubW9uZXlNYXggfHwgcy5tb25leU1heCA8PSAwKSB7XG4gICAgICBwcmludChgU0tJUC1ub21vbmV5ICAgICR7aG9zdH0gIChtb25leU1heD0wIOKAlCBmYWN0aW9uL2JhY2tkb29yIHNlcnZlciwgbm8gY2FzaCB0byBzdGVhbClgKTtcbiAgICAgIGNvdW50ZXJzW1wiU0tJUC1ub21vbmV5XCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoKHMucmVxdWlyZWRIYWNraW5nU2tpbGwgPz8gMCkgPiBteUhhY2spIHtcbiAgICAgIHByaW50KGBTS0lQLWhhY2sgICAgICAgJHtob3N0fSAgKG5lZWQgaGFjayAke3MucmVxdWlyZWRIYWNraW5nU2tpbGx9LCBoYXZlICR7bXlIYWNrfSlgKTtcbiAgICAgIGNvdW50ZXJzW1wiU0tJUC1oYWNrXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBJZiBhIGNvcHkgb2YgdGhlIHdvcmtlciBpcyBhbHJlYWR5IHJ1bm5pbmcgb24gdGhlIGhvc3QsIGxlYXZlIGl0XG4gICAgLy8gYWxvbmUuIFRoaXMgbWFrZXMgZGVwbG95LmpzIHNhZmUgdG8gcmUtcnVuLlxuICAgIGlmIChucy5wcyhob3N0KS5zb21lKChwKSA9PiBwLmZpbGVuYW1lID09PSB3b3JrZXIpKSB7XG4gICAgICBwcmludChgU0tJUC1ydW5uaW5nICAgICR7aG9zdH0gICgke3dvcmtlcn0gYWxyZWFkeSBydW5uaW5nKWApO1xuICAgICAgY291bnRlcnNbXCJTS0lQLXJ1bm5pbmdcIl0rKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIENvcHkgdGhlIHdvcmtlciBzY3JpcHQgdG8gdGhlIHRhcmdldC5cbiAgICBpZiAoIW5zLnNjcCh3b3JrZXIsIGhvc3QsIFNPVVJDRSkpIHtcbiAgICAgIHByaW50KGBGQUlMLXNjcCAgICAgICAgJHtob3N0fWApO1xuICAgICAgY291bnRlcnNbXCJGQUlMLXNjcFwiXSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gUnVuIHdpdGggbWF4IHRocmVhZHMuIFJBTS90aHJlYWRzIGZvcm11bGEgcGVyIHRoZSBkb2NzLlxuICAgIGNvbnN0IHJhbVBlclRocmVhZCA9IG5zLmdldFNjcmlwdFJhbSh3b3JrZXIsIGhvc3QpO1xuICAgIGNvbnN0IGZyZWUgPSBucy5nZXRTZXJ2ZXJNYXhSYW0oaG9zdCkgLSBucy5nZXRTZXJ2ZXJVc2VkUmFtKGhvc3QpO1xuICAgIGNvbnN0IHRocmVhZHMgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKGZyZWUgLyByYW1QZXJUaHJlYWQpKTtcblxuICAgIGlmICh0aHJlYWRzIDwgMSB8fCByYW1QZXJUaHJlYWQgPD0gMCkge1xuICAgICAgcHJpbnQoYFNLSVAtcmFtICAgICAgICAke2hvc3R9ICAobm8gZnJlZSBSQU06ICR7ZnJlZS50b0ZpeGVkKDIpfSBHQiwgJHt3b3JrZXJ9IG5lZWRzICR7cmFtUGVyVGhyZWFkLnRvRml4ZWQoMil9IEdCKWApO1xuICAgICAgY291bnRlcnNbXCJTS0lQLXJhbVwiXSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gVGhlIHdvcmtlciB0YWtlcyBhIHRhcmdldCBhcyBpdHMgZmlyc3QgYXJnLiBXZSBwYXNzIHRoZSBob3N0XG4gICAgLy8gaXRzZWxmIHNvIHRoZSB3b3JrZXIgaGFja3MgaXRzIG93biBzZXJ2ZXIg4oCUIHRoYXQncyB0aGUgc2ltcGxlc3RcbiAgICAvLyBhbmQgdGhlIGd1aWRlJ3MgcmVjb21tZW5kZWQgcGF0dGVybi4gWW91IGNhbiBjaGFuZ2UgdGhpcyB0byBhXG4gICAgLy8gc2luZ2xlIGhhcmRjb2RlZCB0YXJnZXQgaWYgeW91IHdhbnQgYSBcInN3YXJtXCIgYWxsIGhpdHRpbmcgb25lLlxuICAgIGNvbnN0IHBpZCA9IG5zLmV4ZWMod29ya2VyLCBob3N0LCB0aHJlYWRzLCBob3N0KTtcbiAgICBpZiAocGlkID09PSAwKSB7XG4gICAgICBwcmludChgRkFJTC1leGVjICAgICAgICR7aG9zdH0gIChleGVjIHJldHVybmVkIDAg4oCUIFJBTSBjb250ZW50aW9uIG9yIG90aGVyIHNjcmlwdCBydW5uaW5nKWApO1xuICAgICAgY291bnRlcnNbXCJGQUlMLWV4ZWNcIl0rKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGFsZXJ0KGBERVBMT1lFRCAgICAgICAgJHtob3N0fSAgJHt3b3JrZXJ9IHgke3RocmVhZHN9IChwaWQgJHtwaWR9KWApO1xuICAgIGNvdW50ZXJzW1wiREVQTE9ZRURcIl0rKztcbiAgfVxuXG4gIC8vIFN1bW1hcnkgbGluZSDigJQgZWFzaWVyIHRoYW4gc2Nhbm5pbmcgdGhlIGJsb2NrLlxuICBjb25zdCBzdW1tYXJ5ID0gT2JqZWN0LmVudHJpZXMoY291bnRlcnMpXG4gICAgLmZpbHRlcigoW18sIHZdKSA9PiB2ID4gMClcbiAgICAubWFwKChbaywgdl0pID0+IGAke2t9PSR7dn1gKVxuICAgIC5qb2luKFwiIFwiKTtcbiAgbnMudHByaW50KGBkb25lOiAke3N1bW1hcnl9IChzY2FubmVkICR7aG9zdHMubGVuZ3RofSBob3N0cylgKTtcbn1cbiJdfQ==