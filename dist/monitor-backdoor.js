/** @param {NS} ns */
//
// Backdoor status monitor.
//
// Bitburner requires you to type `backdoor` in the terminal at the
// target server's shell. NS scripts can't initiate that — only the
// terminal can. So this script doesn't START backdoors; it just
// reports the backdoor state of every reachable server so you know:
//
//   - which servers are eligible (rooted, hackable, not yet backdoored)
//     and waiting for you to type `connect <host> ; backdoor`
//   - which servers already have a backdoor
//   - which servers you can't backdoor yet (no root, under-levelled,
//     need a port-opener program you don't have)
//
// On startup it prints the full status table. Then it polls every
// POLL_MS and only re-prints when state changes (a new server gets
// backdoored, or a new server becomes reachable), so a long-running
// monitor doesn't spam your terminal.
//
// Output defaults to QUIET — change prints are suppressed unless a
// new READY server appeared (the actionable event). Pass --verbose
// to see every state change. --once prints the full table once and
// exits, ignoring the quiet default (it's a diagnostic run).
//
// Usage:
//   run monitor-backdoor.js                       # one full table on startup, then poll, QUIET (default)
//   run monitor-backdoor.js --once                # print once, exit (full output)
//   run monitor-backdoor.js --include-backdoored  # also list backdoored servers in the table
//   run monitor-backdoor.js --no-path             # suppress the home→host path block (off by default)
//   run monitor-backdoor.js --verbose             # re-enable all state-change prints (default is quiet)
//
const USAGE = `Usage:
 run monitor-backdoor.js                       # one full table on startup, then poll, QUIET (default)
 run monitor-backdoor.js --once                # print once and exit (full output)
 run monitor-backdoor.js --include-backdoored  # also list backdoored servers in the table
 run monitor-backdoor.js --no-path             # suppress the home→host path block (off by default)
 run monitor-backdoor.js --verbose             # re-enable all state-change prints (default is quiet)
`;
// Bitburner requires you to walk the path one hop at a time. The READY
// line includes the full `home ; connect <a> ; ... ; backdoor` chain
// you can copy-paste directly into the terminal — single line, just
// the command body, nothing else per server.
//
// Faction-relevant servers (in roughly unlock order):
//   CSEC, avmnite-04, I.I.I.I, runtheNET, The-Cave, foodnstuff,
//   sigma-cosmetics, joesguns, hong-fang-tea, max-hardware, n00dles,
//   phantasy. The "eligible" section of the table will be the actionable
//   list — those are the ones to connect+backdoor in the terminal.
//
// Note: this script does NOT need to be running for backdoors to work.
// It's purely a "what's the state of my network" panel. Idempotent.
//
const POLL_MS = 30_000;
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("scan");
    // Output mode: default QUIET — only the very first table is
    // shown (so you can see the script started and what its initial
    // state is), then we suppress all subsequent tables UNLESS a new
    // READY server appeared (the actionable event) or --verbose is
    // passed. monitor-backdoor's quiet mode is what the rest of the
    // monitor family now follows.
    //
    // --once disables quiet and prints the full table on the first
    // pass and exits (diagnostic).
    const args = (ns.args || []).map(String);
    const once = args.includes("--once");
    const includeBackdoored = args.includes("--include-backdoored");
    const showPath = !args.includes("--no-path");
    const verbose = args.includes("--verbose");
    // Print the "started" banner only in verbose mode. Quiet mode
    // assumes the user knows monitor-backdoor.js is running (it's in
    // master.js) and doesn't need the per-tick confirmation.
    if (verbose) {
        ns.tprint(`monitor-backdoor: started, interval=${POLL_MS}ms, output=verbose`);
    }
    // BFS the reachable network. We also build a `parent` map so we
    // can reconstruct the path from home to any host — useful for
    // printing the `home ; connect <a> ; ... ; backdoor` chain for
    // a server that's more than one hop from home.
    function bfsFromHome() {
        const seen = new Set(["home"]);
        const parent = new Map([["home", null]]);
        const queue = ["home"];
        while (queue.length > 0) {
            const h = queue.shift();
            for (const n of ns.scan(h)) {
                if (!seen.has(n)) {
                    seen.add(n);
                    parent.set(n, h);
                    queue.push(n);
                }
            }
        }
        return { seen, parent };
    }
    // Reconstruct the path from home to `host` as an array, e.g.
    // ["home", "CSEC", "avmnite-04", "I.I.I.I", "max-hardware"].
    // Returns null if the host is unreachable.
    function pathTo(parent, host) {
        if (!parent.has(host))
            return null;
        const path = [];
        let cur = host;
        while (cur !== null) {
            path.push(cur);
            cur = parent.get(cur);
        }
        return path.reverse();
    }
    // Format a connect chain as a copy-paste-able command body.
    // Always starts with `home ;` so the one-liner works regardless of
    // the current shell. Path of length 1 (just `home` itself) returns
    // `"home ; backdoor"`. Path of length 2+ returns
    // `"home ; connect a ; connect b ; backdoor"`.
    function connectChain(path) {
        if (!path || path.length <= 1)
            return "home ; backdoor";
        const hops = path.slice(1).map((h) => `connect ${h}`).join(" ; ");
        return `home ; ${hops} ; backdoor`;
    }
    // Get a per-server status line. Returns null if the server is
    // not interesting to display (e.g. home).
    function statusOf(host, me) {
        if (host === "home")
            return null;
        const s = ns.getServer(host);
        const reqHack = s.requiredHackingSkill ?? 0;
        const ports = s.numOpenPortsRequired ?? s.requiredOpenPorts ?? 0;
        const backdoored = s.backdoorInstalled === true;
        const rooted = s.hasAdminRights === true;
        const purchased = s.purchasedByPlayer === true;
        const minSec = s.minDifficulty ?? null;
        const maxMoney = s.moneyMax ?? 0;
        const hasMoney = maxMoney > 0;
        // Backdoor is only meaningful on faction-relevant servers:
        // rooted, hackable by us, with money OR is one of the named
        // faction-trigger servers. (Money-bearing is a decent heuristic —
        // CSEC, avmnite-04, runtheNET, I.I.I.I, The-Cave are all moneyMax=0
        // but those names will still surface as "eligible" because
        // we explicitly list them below.)
        const namedFactionHosts = new Set([
            "CSEC", "avmnite-04", "I.I.I.I", "runtheNET", "The-Cave",
            "The Black Hand", "NiteSec", "BitRunners",
        ]);
        const isFaction = namedFactionHosts.has(host);
        // Already backdoored.
        if (backdoored) {
            if (!includeBackdoored)
                return null;
            return `DONE         ${host}`;
        }
        // Player can't backdoor their own purchased servers.
        if (purchased)
            return null;
        // Must be rooted. Otherwise it has nothing to backdoor anyway.
        if (!rooted) {
            // If we COULD root it (hack sufficient, port opener sufficient),
            // surface as "blocked-root"; if not, "blocked-unkillable".
            if (reqHack > me) {
                return `BLOCK-hack   ${host}  (need hack ${reqHack}, have ${me})`;
            }
            if (ports > 0) {
                return `BLOCK-ports  ${host}  (need ${ports} port-opener, root this with nuke.js)`;
            }
            // Hackable + no ports needed but unrooted — odd, but possible.
            return `BLOCK-root   ${host}  (rooted=false; try re-running nuke.js)`;
        }
        // Out-of-level, rooted but can't be backdoored until level up.
        if (reqHack > me) {
            return `BLOCK-hack   ${host}  (rooted, need hack ${reqHack}, have ${me})`;
        }
        // Eligible! You can `connect <host>` and run `backdoor` in the
        // terminal. Note: faction hosts (CSEC etc.) have moneyMax=0,
        // which is why we explicitly treat them as eligible.
        if (!hasMoney && !isFaction) {
            // Not a money server and not a named faction host — probably
            // some no-cash server we don't care about.
            return `SKIP-nomoney ${host}  (no money, not a faction-trigger)`;
        }
        // Eligible! Return a structured marker so printTable can build
        // the line with the actual `home ; connect <a> ; ...` path —
        // Bitburner requires you to walk the path one hop at a time.
        return `READY        ${host}`;
    }
    // Print the full table once, with a counter summary.
    // `parent` is the BFS parent map, used to reconstruct the path
    // from home to each READY host. Without it, the user can't
    // connect to anything more than one hop from home.
    function printTable(reason, parent) {
        const me = ns.getPlayer().skills.hacking;
        const hosts = [...parent.keys()].filter((h) => h !== "home").sort();
        const lines = [];
        const counters = { READY: 0, DONE: 0 };
        for (const h of hosts) {
            const line = statusOf(h, me);
            if (!line)
                continue;
            const isReady = line.startsWith("READY");
            const isDone = line.startsWith("DONE");
            if (isReady) {
                counters.READY++;
                const path = pathTo(parent, h);
                const chain = connectChain(path);
                if (showPath) {
                    // Single-line copy-paste body for the terminal. The
                    // bitburner terminal accepts `; `-chained commands
                    // separated by spaces, so the user can paste the
                    // quoted chain straight in. One line per READY
                    // server — no extra context, just the command.
                    lines.push(`monitor-backdoor.js: READY: "${chain}"`);
                }
                else {
                    // Compact: just the server name, no chain. Useful for
                    // long-lived monitors that already know the topology.
                    lines.push(`monitor-backdoor.js: READY: ${h}`);
                }
            }
            else if (isDone) {
                counters.DONE++;
            }
        }
        // Header. We print the table even when empty so the user knows
        // the script is alive and there's nothing to backdoor.
        const header = reason ? `monitor-backdoor (${reason}):` : `monitor-backdoor:`;
        ns.tprint(header);
        if (lines.length === 0) {
            ns.tprint(`  (no READY servers; everything is backdoored, blocked, or out-of-level)`);
        }
        else {
            for (const l of lines)
                ns.tprint(l);
        }
        const summaryParts = [`READY=${counters.READY}`];
        if (includeBackdoored)
            summaryParts.push(`DONE=${counters.DONE}`);
        summaryParts.push(`scanned ${hosts.length + 1} hosts`); // +1 for home
        ns.tprint(`  ${summaryParts.join(" ")}`);
        return lines;
    }
    // Poll loop: re-print the table only when something changes.
    // Change-detection needs the FULL status (including BLOCK- and
    // SKIP-), not just READY, because the most common state change is
    // BLOCK-hack → READY (player levels up and a server becomes
    // backdoorable) or READY → DONE (player just backdoored a server).
    // The print function still filters to READY-only output.
    //
    // In quiet mode (the default), we suppress the change print when
    // the new snapshot still has READY=0 — the "interesting" event is
    // a new backdoorable server appearing, not incidental BLOCK-hack
    // status-line churn. --verbose opts back into all state changes.
    function fullSnapshot() {
        const me = ns.getPlayer().skills.hacking;
        const { seen, parent } = bfsFromHome();
        const m = new Map();
        let readyCount = 0;
        for (const h of seen) {
            const l = statusOf(h, me);
            if (l) {
                m.set(h, l);
                if (l.startsWith("READY"))
                    readyCount++;
            }
        }
        return { status: m, parent, readyCount };
    }
    // Initial table. In quiet mode (the default) we DON'T print
    // the startup table either — the user explicitly asked for
    // "only see these messages when something positively changed",
    // so the initial empty table ("no READY servers") would
    // contradict that. Print the initial table only in --once or
    // --verbose.
    let last = fullSnapshot();
    if (once || verbose) {
        printTable("startup", last.parent);
    }
    if (once)
        return;
    while (true) {
        await ns.sleep(POLL_MS);
        const next = fullSnapshot();
        let changed = next.status.size !== last.status.size;
        if (!changed) {
            for (const [h, l] of next.status) {
                if (last.status.get(h) !== l) {
                    changed = true;
                    break;
                }
            }
        }
        if (changed) {
            // In quiet mode, only re-print when the new snapshot has a
            // READY server. Otherwise the change is just incidental
            // BLOCK-hack churn that the user already knows about.
            if (verbose || next.readyCount > 0) {
                last = next;
                printTable("change", next.parent);
            }
            else {
                // Update last so we don't keep firing on the same no-op
                // change. Without this, every poll would re-detect the
                // churn and the gate would re-evaluate.
                last = next;
            }
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1iYWNrZG9vci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9tb25pdG9yLWJhY2tkb29yLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsMkJBQTJCO0FBQzNCLEVBQUU7QUFDRixtRUFBbUU7QUFDbkUsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSxvRUFBb0U7QUFDcEUsRUFBRTtBQUNGLHdFQUF3RTtBQUN4RSw4REFBOEQ7QUFDOUQsNENBQTRDO0FBQzVDLHFFQUFxRTtBQUNyRSxpREFBaUQ7QUFDakQsRUFBRTtBQUNGLGtFQUFrRTtBQUNsRSxtRUFBbUU7QUFDbkUsb0VBQW9FO0FBQ3BFLHNDQUFzQztBQUN0QyxFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLG1FQUFtRTtBQUNuRSxtRUFBbUU7QUFDbkUsNkRBQTZEO0FBQzdELEVBQUU7QUFDRixTQUFTO0FBQ1QsMEdBQTBHO0FBQzFHLG1GQUFtRjtBQUNuRiw4RkFBOEY7QUFDOUYsdUdBQXVHO0FBQ3ZHLHlHQUF5RztBQUN6RyxFQUFFO0FBQ0YsTUFBTSxLQUFLLEdBQUc7Ozs7OztDQU1iLENBQUM7QUFDRix1RUFBdUU7QUFDdkUscUVBQXFFO0FBQ3JFLG9FQUFvRTtBQUNwRSw2Q0FBNkM7QUFDN0MsRUFBRTtBQUNGLHNEQUFzRDtBQUN0RCxnRUFBZ0U7QUFDaEUscUVBQXFFO0FBQ3JFLHlFQUF5RTtBQUN6RSxtRUFBbUU7QUFDbkUsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSxvRUFBb0U7QUFDcEUsRUFBRTtBQUVGLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUV2QixNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDeEQs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bkIsVUFBVSxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7S0FDcEM7SUFDRCxJQUFJLElBQUk7UUFBRSxPQUFPO0lBRWpCLE9BQU8sSUFBSSxFQUFFO1FBQ1gsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3hCLE1BQU0sSUFBSSxHQUFHLFlBQVksRUFBRSxDQUFDO1FBQzVCLElBQUksT0FBTyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDO1FBQ3BELElBQUksQ0FBQyxPQUFPLEVBQUU7WUFDWixLQUFLLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLE1BQU0sRUFBRTtnQkFDaEMsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUU7b0JBQUUsT0FBTyxHQUFHLElBQUksQ0FBQztvQkFBQyxNQUFNO2lCQUFFO2FBQ3pEO1NBQ0Y7UUFDRCxJQUFJLE9BQU8sRUFBRTtZQUNYLDJEQUEyRDtZQUMzRCx3REFBd0Q7WUFDeEQsc0RBQXNEO1lBQ3RELElBQUksT0FBTyxJQUFJLElBQUksQ0FBQyxVQUFVLEdBQUcsQ0FBQyxFQUFFO2dCQUNsQyxJQUFJLEdBQUcsSUFBSSxDQUFDO2dCQUNaLFVBQVUsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2FBQ25DO2lCQUFNO2dCQUNMLHdEQUF3RDtnQkFDeEQsdURBQXVEO2dCQUN2RCx3Q0FBd0M7Z0JBQ3hDLElBQUksR0FBRyxJQUFJLENBQUM7YUFDYjtTQUNGO0tBQ0Y7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gQmFja2Rvb3Igc3RhdHVzIG1vbml0b3IuXG4vL1xuLy8gQml0YnVybmVyIHJlcXVpcmVzIHlvdSB0byB0eXBlIGBiYWNrZG9vcmAgaW4gdGhlIHRlcm1pbmFsIGF0IHRoZVxuLy8gdGFyZ2V0IHNlcnZlcidzIHNoZWxsLiBOUyBzY3JpcHRzIGNhbid0IGluaXRpYXRlIHRoYXQg4oCUIG9ubHkgdGhlXG4vLyB0ZXJtaW5hbCBjYW4uIFNvIHRoaXMgc2NyaXB0IGRvZXNuJ3QgU1RBUlQgYmFja2Rvb3JzOyBpdCBqdXN0XG4vLyByZXBvcnRzIHRoZSBiYWNrZG9vciBzdGF0ZSBvZiBldmVyeSByZWFjaGFibGUgc2VydmVyIHNvIHlvdSBrbm93OlxuLy9cbi8vICAgLSB3aGljaCBzZXJ2ZXJzIGFyZSBlbGlnaWJsZSAocm9vdGVkLCBoYWNrYWJsZSwgbm90IHlldCBiYWNrZG9vcmVkKVxuLy8gICAgIGFuZCB3YWl0aW5nIGZvciB5b3UgdG8gdHlwZSBgY29ubmVjdCA8aG9zdD4gOyBiYWNrZG9vcmBcbi8vICAgLSB3aGljaCBzZXJ2ZXJzIGFscmVhZHkgaGF2ZSBhIGJhY2tkb29yXG4vLyAgIC0gd2hpY2ggc2VydmVycyB5b3UgY2FuJ3QgYmFja2Rvb3IgeWV0IChubyByb290LCB1bmRlci1sZXZlbGxlZCxcbi8vICAgICBuZWVkIGEgcG9ydC1vcGVuZXIgcHJvZ3JhbSB5b3UgZG9uJ3QgaGF2ZSlcbi8vXG4vLyBPbiBzdGFydHVwIGl0IHByaW50cyB0aGUgZnVsbCBzdGF0dXMgdGFibGUuIFRoZW4gaXQgcG9sbHMgZXZlcnlcbi8vIFBPTExfTVMgYW5kIG9ubHkgcmUtcHJpbnRzIHdoZW4gc3RhdGUgY2hhbmdlcyAoYSBuZXcgc2VydmVyIGdldHNcbi8vIGJhY2tkb29yZWQsIG9yIGEgbmV3IHNlcnZlciBiZWNvbWVzIHJlYWNoYWJsZSksIHNvIGEgbG9uZy1ydW5uaW5nXG4vLyBtb25pdG9yIGRvZXNuJ3Qgc3BhbSB5b3VyIHRlcm1pbmFsLlxuLy9cbi8vIE91dHB1dCBkZWZhdWx0cyB0byBRVUlFVCDigJQgY2hhbmdlIHByaW50cyBhcmUgc3VwcHJlc3NlZCB1bmxlc3MgYVxuLy8gbmV3IFJFQURZIHNlcnZlciBhcHBlYXJlZCAodGhlIGFjdGlvbmFibGUgZXZlbnQpLiBQYXNzIC0tdmVyYm9zZVxuLy8gdG8gc2VlIGV2ZXJ5IHN0YXRlIGNoYW5nZS4gLS1vbmNlIHByaW50cyB0aGUgZnVsbCB0YWJsZSBvbmNlIGFuZFxuLy8gZXhpdHMsIGlnbm9yaW5nIHRoZSBxdWlldCBkZWZhdWx0IChpdCdzIGEgZGlhZ25vc3RpYyBydW4pLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gbW9uaXRvci1iYWNrZG9vci5qcyAgICAgICAgICAgICAgICAgICAgICAgIyBvbmUgZnVsbCB0YWJsZSBvbiBzdGFydHVwLCB0aGVuIHBvbGwsIFFVSUVUIChkZWZhdWx0KVxuLy8gICBydW4gbW9uaXRvci1iYWNrZG9vci5qcyAtLW9uY2UgICAgICAgICAgICAgICAgIyBwcmludCBvbmNlLCBleGl0IChmdWxsIG91dHB1dClcbi8vICAgcnVuIG1vbml0b3ItYmFja2Rvb3IuanMgLS1pbmNsdWRlLWJhY2tkb29yZWQgICMgYWxzbyBsaXN0IGJhY2tkb29yZWQgc2VydmVycyBpbiB0aGUgdGFibGVcbi8vICAgcnVuIG1vbml0b3ItYmFja2Rvb3IuanMgLS1uby1wYXRoICAgICAgICAgICAgICMgc3VwcHJlc3MgdGhlIGhvbWXihpJob3N0IHBhdGggYmxvY2sgKG9mZiBieSBkZWZhdWx0KVxuLy8gICBydW4gbW9uaXRvci1iYWNrZG9vci5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyByZS1lbmFibGUgYWxsIHN0YXRlLWNoYW5nZSBwcmludHMgKGRlZmF1bHQgaXMgcXVpZXQpXG4vL1xuY29uc3QgVVNBR0UgPSBgVXNhZ2U6XG4gcnVuIG1vbml0b3ItYmFja2Rvb3IuanMgICAgICAgICAgICAgICAgICAgICAgICMgb25lIGZ1bGwgdGFibGUgb24gc3RhcnR1cCwgdGhlbiBwb2xsLCBRVUlFVCAoZGVmYXVsdClcbiBydW4gbW9uaXRvci1iYWNrZG9vci5qcyAtLW9uY2UgICAgICAgICAgICAgICAgIyBwcmludCBvbmNlIGFuZCBleGl0IChmdWxsIG91dHB1dClcbiBydW4gbW9uaXRvci1iYWNrZG9vci5qcyAtLWluY2x1ZGUtYmFja2Rvb3JlZCAgIyBhbHNvIGxpc3QgYmFja2Rvb3JlZCBzZXJ2ZXJzIGluIHRoZSB0YWJsZVxuIHJ1biBtb25pdG9yLWJhY2tkb29yLmpzIC0tbm8tcGF0aCAgICAgICAgICAgICAjIHN1cHByZXNzIHRoZSBob21l4oaSaG9zdCBwYXRoIGJsb2NrIChvZmYgYnkgZGVmYXVsdClcbiBydW4gbW9uaXRvci1iYWNrZG9vci5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyByZS1lbmFibGUgYWxsIHN0YXRlLWNoYW5nZSBwcmludHMgKGRlZmF1bHQgaXMgcXVpZXQpXG5gO1xuLy8gQml0YnVybmVyIHJlcXVpcmVzIHlvdSB0byB3YWxrIHRoZSBwYXRoIG9uZSBob3AgYXQgYSB0aW1lLiBUaGUgUkVBRFlcbi8vIGxpbmUgaW5jbHVkZXMgdGhlIGZ1bGwgYGhvbWUgOyBjb25uZWN0IDxhPiA7IC4uLiA7IGJhY2tkb29yYCBjaGFpblxuLy8geW91IGNhbiBjb3B5LXBhc3RlIGRpcmVjdGx5IGludG8gdGhlIHRlcm1pbmFsIOKAlCBzaW5nbGUgbGluZSwganVzdFxuLy8gdGhlIGNvbW1hbmQgYm9keSwgbm90aGluZyBlbHNlIHBlciBzZXJ2ZXIuXG4vL1xuLy8gRmFjdGlvbi1yZWxldmFudCBzZXJ2ZXJzIChpbiByb3VnaGx5IHVubG9jayBvcmRlcik6XG4vLyAgIENTRUMsIGF2bW5pdGUtMDQsIEkuSS5JLkksIHJ1bnRoZU5FVCwgVGhlLUNhdmUsIGZvb2Ruc3R1ZmYsXG4vLyAgIHNpZ21hLWNvc21ldGljcywgam9lc2d1bnMsIGhvbmctZmFuZy10ZWEsIG1heC1oYXJkd2FyZSwgbjAwZGxlcyxcbi8vICAgcGhhbnRhc3kuIFRoZSBcImVsaWdpYmxlXCIgc2VjdGlvbiBvZiB0aGUgdGFibGUgd2lsbCBiZSB0aGUgYWN0aW9uYWJsZVxuLy8gICBsaXN0IOKAlCB0aG9zZSBhcmUgdGhlIG9uZXMgdG8gY29ubmVjdCtiYWNrZG9vciBpbiB0aGUgdGVybWluYWwuXG4vL1xuLy8gTm90ZTogdGhpcyBzY3JpcHQgZG9lcyBOT1QgbmVlZCB0byBiZSBydW5uaW5nIGZvciBiYWNrZG9vcnMgdG8gd29yay5cbi8vIEl0J3MgcHVyZWx5IGEgXCJ3aGF0J3MgdGhlIHN0YXRlIG9mIG15IG5ldHdvcmtcIiBwYW5lbC4gSWRlbXBvdGVudC5cbi8vXG5cbmNvbnN0IFBPTExfTVMgPSAzMF8wMDA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGlmIChucy5hcmdzLmluY2x1ZGVzKFwiLWhcIikgfHwgbnMuYXJncy5pbmNsdWRlcyhcIi0taGVscFwiKSkge1xuICAgIG5zLnRwcmludChVU0FHRSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIG5zLmRpc2FibGVMb2coXCJzbGVlcFwiKTtcbiAgbnMuZGlzYWJsZUxvZyhcImdldFNlcnZlck1vbmV5QXZhaWxhYmxlXCIpO1xuICBucy5kaXNhYmxlTG9nKFwic2NhblwiKTtcbiAgLy8gT3V0cHV0IG1vZGU6IGRlZmF1bHQgUVVJRVQg4oCUIG9ubHkgdGhlIHZlcnkgZmlyc3QgdGFibGUgaXNcbiAgLy8gc2hvd24gKHNvIHlvdSBjYW4gc2VlIHRoZSBzY3JpcHQgc3RhcnRlZCBhbmQgd2hhdCBpdHMgaW5pdGlhbFxuICAvLyBzdGF0ZSBpcyksIHRoZW4gd2Ugc3VwcHJlc3MgYWxsIHN1YnNlcXVlbnQgdGFibGVzIFVOTEVTUyBhIG5ld1xuICAvLyBSRUFEWSBzZXJ2ZXIgYXBwZWFyZWQgKHRoZSBhY3Rpb25hYmxlIGV2ZW50KSBvciAtLXZlcmJvc2UgaXNcbiAgLy8gcGFzc2VkLiBtb25pdG9yLWJhY2tkb29yJ3MgcXVpZXQgbW9kZSBpcyB3aGF0IHRoZSByZXN0IG9mIHRoZVxuICAvLyBtb25pdG9yIGZhbWlseSBub3cgZm9sbG93cy5cbiAgLy9cbiAgLy8gLS1vbmNlIGRpc2FibGVzIHF1aWV0IGFuZCBwcmludHMgdGhlIGZ1bGwgdGFibGUgb24gdGhlIGZpcnN0XG4gIC8vIHBhc3MgYW5kIGV4aXRzIChkaWFnbm9zdGljKS5cbiAgY29uc3QgYXJncyA9IChucy5hcmdzIHx8IFtdKS5tYXAoU3RyaW5nKTtcbiAgY29uc3Qgb25jZSA9IGFyZ3MuaW5jbHVkZXMoXCItLW9uY2VcIik7XG4gIGNvbnN0IGluY2x1ZGVCYWNrZG9vcmVkID0gYXJncy5pbmNsdWRlcyhcIi0taW5jbHVkZS1iYWNrZG9vcmVkXCIpO1xuICBjb25zdCBzaG93UGF0aCA9ICFhcmdzLmluY2x1ZGVzKFwiLS1uby1wYXRoXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgLy8gUHJpbnQgdGhlIFwic3RhcnRlZFwiIGJhbm5lciBvbmx5IGluIHZlcmJvc2UgbW9kZS4gUXVpZXQgbW9kZVxuICAvLyBhc3N1bWVzIHRoZSB1c2VyIGtub3dzIG1vbml0b3ItYmFja2Rvb3IuanMgaXMgcnVubmluZyAoaXQncyBpblxuICAvLyBtYXN0ZXIuanMpIGFuZCBkb2Vzbid0IG5lZWQgdGhlIHBlci10aWNrIGNvbmZpcm1hdGlvbi5cbiAgaWYgKHZlcmJvc2UpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3ItYmFja2Rvb3I6IHN0YXJ0ZWQsIGludGVydmFsPSR7UE9MTF9NU31tcywgb3V0cHV0PXZlcmJvc2VgKTtcbiAgfVxuXG4gIC8vIEJGUyB0aGUgcmVhY2hhYmxlIG5ldHdvcmsuIFdlIGFsc28gYnVpbGQgYSBgcGFyZW50YCBtYXAgc28gd2VcbiAgLy8gY2FuIHJlY29uc3RydWN0IHRoZSBwYXRoIGZyb20gaG9tZSB0byBhbnkgaG9zdCDigJQgdXNlZnVsIGZvclxuICAvLyBwcmludGluZyB0aGUgYGhvbWUgOyBjb25uZWN0IDxhPiA7IC4uLiA7IGJhY2tkb29yYCBjaGFpbiBmb3JcbiAgLy8gYSBzZXJ2ZXIgdGhhdCdzIG1vcmUgdGhhbiBvbmUgaG9wIGZyb20gaG9tZS5cbiAgZnVuY3Rpb24gYmZzRnJvbUhvbWUoKSB7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoW1wiaG9tZVwiXSk7XG4gICAgY29uc3QgcGFyZW50ID0gbmV3IE1hcChbW1wiaG9tZVwiLCBudWxsXV0pO1xuICAgIGNvbnN0IHF1ZXVlID0gW1wiaG9tZVwiXTtcbiAgICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgaCA9IHF1ZXVlLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IG4gb2YgbnMuc2NhbihoKSkge1xuICAgICAgICBpZiAoIXNlZW4uaGFzKG4pKSB7XG4gICAgICAgICAgc2Vlbi5hZGQobik7XG4gICAgICAgICAgcGFyZW50LnNldChuLCBoKTtcbiAgICAgICAgICBxdWV1ZS5wdXNoKG4pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IHNlZW4sIHBhcmVudCB9O1xuICB9XG5cbiAgLy8gUmVjb25zdHJ1Y3QgdGhlIHBhdGggZnJvbSBob21lIHRvIGBob3N0YCBhcyBhbiBhcnJheSwgZS5nLlxuICAvLyBbXCJob21lXCIsIFwiQ1NFQ1wiLCBcImF2bW5pdGUtMDRcIiwgXCJJLkkuSS5JXCIsIFwibWF4LWhhcmR3YXJlXCJdLlxuICAvLyBSZXR1cm5zIG51bGwgaWYgdGhlIGhvc3QgaXMgdW5yZWFjaGFibGUuXG4gIGZ1bmN0aW9uIHBhdGhUbyhwYXJlbnQsIGhvc3QpIHtcbiAgICBpZiAoIXBhcmVudC5oYXMoaG9zdCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHBhdGggPSBbXTtcbiAgICBsZXQgY3VyID0gaG9zdDtcbiAgICB3aGlsZSAoY3VyICE9PSBudWxsKSB7XG4gICAgICBwYXRoLnB1c2goY3VyKTtcbiAgICAgIGN1ciA9IHBhcmVudC5nZXQoY3VyKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhdGgucmV2ZXJzZSgpO1xuICB9XG5cbiAgLy8gRm9ybWF0IGEgY29ubmVjdCBjaGFpbiBhcyBhIGNvcHktcGFzdGUtYWJsZSBjb21tYW5kIGJvZHkuXG4gIC8vIEFsd2F5cyBzdGFydHMgd2l0aCBgaG9tZSA7YCBzbyB0aGUgb25lLWxpbmVyIHdvcmtzIHJlZ2FyZGxlc3Mgb2ZcbiAgLy8gdGhlIGN1cnJlbnQgc2hlbGwuIFBhdGggb2YgbGVuZ3RoIDEgKGp1c3QgYGhvbWVgIGl0c2VsZikgcmV0dXJuc1xuICAvLyBgXCJob21lIDsgYmFja2Rvb3JcImAuIFBhdGggb2YgbGVuZ3RoIDIrIHJldHVybnNcbiAgLy8gYFwiaG9tZSA7IGNvbm5lY3QgYSA7IGNvbm5lY3QgYiA7IGJhY2tkb29yXCJgLlxuICBmdW5jdGlvbiBjb25uZWN0Q2hhaW4ocGF0aCkge1xuICAgIGlmICghcGF0aCB8fCBwYXRoLmxlbmd0aCA8PSAxKSByZXR1cm4gXCJob21lIDsgYmFja2Rvb3JcIjtcbiAgICBjb25zdCBob3BzID0gcGF0aC5zbGljZSgxKS5tYXAoKGgpID0+IGBjb25uZWN0ICR7aH1gKS5qb2luKFwiIDsgXCIpO1xuICAgIHJldHVybiBgaG9tZSA7ICR7aG9wc30gOyBiYWNrZG9vcmA7XG4gIH1cblxuICAvLyBHZXQgYSBwZXItc2VydmVyIHN0YXR1cyBsaW5lLiBSZXR1cm5zIG51bGwgaWYgdGhlIHNlcnZlciBpc1xuICAvLyBub3QgaW50ZXJlc3RpbmcgdG8gZGlzcGxheSAoZS5nLiBob21lKS5cbiAgZnVuY3Rpb24gc3RhdHVzT2YoaG9zdCwgbWUpIHtcbiAgICBpZiAoaG9zdCA9PT0gXCJob21lXCIpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHMgPSBucy5nZXRTZXJ2ZXIoaG9zdCk7XG4gICAgY29uc3QgcmVxSGFjayA9IHMucmVxdWlyZWRIYWNraW5nU2tpbGwgPz8gMDtcbiAgICBjb25zdCBwb3J0cyA9IHMubnVtT3BlblBvcnRzUmVxdWlyZWQgPz8gcy5yZXF1aXJlZE9wZW5Qb3J0cyA/PyAwO1xuICAgIGNvbnN0IGJhY2tkb29yZWQgPSBzLmJhY2tkb29ySW5zdGFsbGVkID09PSB0cnVlO1xuICAgIGNvbnN0IHJvb3RlZCA9IHMuaGFzQWRtaW5SaWdodHMgPT09IHRydWU7XG4gICAgY29uc3QgcHVyY2hhc2VkID0gcy5wdXJjaGFzZWRCeVBsYXllciA9PT0gdHJ1ZTtcbiAgICBjb25zdCBtaW5TZWMgPSBzLm1pbkRpZmZpY3VsdHkgPz8gbnVsbDtcbiAgICBjb25zdCBtYXhNb25leSA9IHMubW9uZXlNYXggPz8gMDtcbiAgICBjb25zdCBoYXNNb25leSA9IG1heE1vbmV5ID4gMDtcbiAgICAvLyBCYWNrZG9vciBpcyBvbmx5IG1lYW5pbmdmdWwgb24gZmFjdGlvbi1yZWxldmFudCBzZXJ2ZXJzOlxuICAgIC8vIHJvb3RlZCwgaGFja2FibGUgYnkgdXMsIHdpdGggbW9uZXkgT1IgaXMgb25lIG9mIHRoZSBuYW1lZFxuICAgIC8vIGZhY3Rpb24tdHJpZ2dlciBzZXJ2ZXJzLiAoTW9uZXktYmVhcmluZyBpcyBhIGRlY2VudCBoZXVyaXN0aWMg4oCUXG4gICAgLy8gQ1NFQywgYXZtbml0ZS0wNCwgcnVudGhlTkVULCBJLkkuSS5JLCBUaGUtQ2F2ZSBhcmUgYWxsIG1vbmV5TWF4PTBcbiAgICAvLyBidXQgdGhvc2UgbmFtZXMgd2lsbCBzdGlsbCBzdXJmYWNlIGFzIFwiZWxpZ2libGVcIiBiZWNhdXNlXG4gICAgLy8gd2UgZXhwbGljaXRseSBsaXN0IHRoZW0gYmVsb3cuKVxuICAgIGNvbnN0IG5hbWVkRmFjdGlvbkhvc3RzID0gbmV3IFNldChbXG4gICAgICBcIkNTRUNcIiwgXCJhdm1uaXRlLTA0XCIsIFwiSS5JLkkuSVwiLCBcInJ1bnRoZU5FVFwiLCBcIlRoZS1DYXZlXCIsXG4gICAgICBcIlRoZSBCbGFjayBIYW5kXCIsIFwiTml0ZVNlY1wiLCBcIkJpdFJ1bm5lcnNcIixcbiAgICBdKTtcbiAgICBjb25zdCBpc0ZhY3Rpb24gPSBuYW1lZEZhY3Rpb25Ib3N0cy5oYXMoaG9zdCk7XG4gICAgLy8gQWxyZWFkeSBiYWNrZG9vcmVkLlxuICAgIGlmIChiYWNrZG9vcmVkKSB7XG4gICAgICBpZiAoIWluY2x1ZGVCYWNrZG9vcmVkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiBgRE9ORSAgICAgICAgICR7aG9zdH1gO1xuICAgIH1cbiAgICAvLyBQbGF5ZXIgY2FuJ3QgYmFja2Rvb3IgdGhlaXIgb3duIHB1cmNoYXNlZCBzZXJ2ZXJzLlxuICAgIGlmIChwdXJjaGFzZWQpIHJldHVybiBudWxsO1xuICAgIC8vIE11c3QgYmUgcm9vdGVkLiBPdGhlcndpc2UgaXQgaGFzIG5vdGhpbmcgdG8gYmFja2Rvb3IgYW55d2F5LlxuICAgIGlmICghcm9vdGVkKSB7XG4gICAgICAvLyBJZiB3ZSBDT1VMRCByb290IGl0IChoYWNrIHN1ZmZpY2llbnQsIHBvcnQgb3BlbmVyIHN1ZmZpY2llbnQpLFxuICAgICAgLy8gc3VyZmFjZSBhcyBcImJsb2NrZWQtcm9vdFwiOyBpZiBub3QsIFwiYmxvY2tlZC11bmtpbGxhYmxlXCIuXG4gICAgICBpZiAocmVxSGFjayA+IG1lKSB7XG4gICAgICAgIHJldHVybiBgQkxPQ0staGFjayAgICR7aG9zdH0gIChuZWVkIGhhY2sgJHtyZXFIYWNrfSwgaGF2ZSAke21lfSlgO1xuICAgICAgfVxuICAgICAgaWYgKHBvcnRzID4gMCkge1xuICAgICAgICByZXR1cm4gYEJMT0NLLXBvcnRzICAke2hvc3R9ICAobmVlZCAke3BvcnRzfSBwb3J0LW9wZW5lciwgcm9vdCB0aGlzIHdpdGggbnVrZS5qcylgO1xuICAgICAgfVxuICAgICAgLy8gSGFja2FibGUgKyBubyBwb3J0cyBuZWVkZWQgYnV0IHVucm9vdGVkIOKAlCBvZGQsIGJ1dCBwb3NzaWJsZS5cbiAgICAgIHJldHVybiBgQkxPQ0stcm9vdCAgICR7aG9zdH0gIChyb290ZWQ9ZmFsc2U7IHRyeSByZS1ydW5uaW5nIG51a2UuanMpYDtcbiAgICB9XG4gICAgLy8gT3V0LW9mLWxldmVsLCByb290ZWQgYnV0IGNhbid0IGJlIGJhY2tkb29yZWQgdW50aWwgbGV2ZWwgdXAuXG4gICAgaWYgKHJlcUhhY2sgPiBtZSkge1xuICAgICAgcmV0dXJuIGBCTE9DSy1oYWNrICAgJHtob3N0fSAgKHJvb3RlZCwgbmVlZCBoYWNrICR7cmVxSGFja30sIGhhdmUgJHttZX0pYDtcbiAgICB9XG4gICAgLy8gRWxpZ2libGUhIFlvdSBjYW4gYGNvbm5lY3QgPGhvc3Q+YCBhbmQgcnVuIGBiYWNrZG9vcmAgaW4gdGhlXG4gICAgLy8gdGVybWluYWwuIE5vdGU6IGZhY3Rpb24gaG9zdHMgKENTRUMgZXRjLikgaGF2ZSBtb25leU1heD0wLFxuICAgIC8vIHdoaWNoIGlzIHdoeSB3ZSBleHBsaWNpdGx5IHRyZWF0IHRoZW0gYXMgZWxpZ2libGUuXG4gICAgaWYgKCFoYXNNb25leSAmJiAhaXNGYWN0aW9uKSB7XG4gICAgICAvLyBOb3QgYSBtb25leSBzZXJ2ZXIgYW5kIG5vdCBhIG5hbWVkIGZhY3Rpb24gaG9zdCDigJQgcHJvYmFibHlcbiAgICAgIC8vIHNvbWUgbm8tY2FzaCBzZXJ2ZXIgd2UgZG9uJ3QgY2FyZSBhYm91dC5cbiAgICAgIHJldHVybiBgU0tJUC1ub21vbmV5ICR7aG9zdH0gIChubyBtb25leSwgbm90IGEgZmFjdGlvbi10cmlnZ2VyKWA7XG4gICAgfVxuICAgIC8vIEVsaWdpYmxlISBSZXR1cm4gYSBzdHJ1Y3R1cmVkIG1hcmtlciBzbyBwcmludFRhYmxlIGNhbiBidWlsZFxuICAgIC8vIHRoZSBsaW5lIHdpdGggdGhlIGFjdHVhbCBgaG9tZSA7IGNvbm5lY3QgPGE+IDsgLi4uYCBwYXRoIOKAlFxuICAgIC8vIEJpdGJ1cm5lciByZXF1aXJlcyB5b3UgdG8gd2FsayB0aGUgcGF0aCBvbmUgaG9wIGF0IGEgdGltZS5cbiAgICByZXR1cm4gYFJFQURZICAgICAgICAke2hvc3R9YDtcbiAgfVxuXG4gIC8vIFByaW50IHRoZSBmdWxsIHRhYmxlIG9uY2UsIHdpdGggYSBjb3VudGVyIHN1bW1hcnkuXG4gIC8vIGBwYXJlbnRgIGlzIHRoZSBCRlMgcGFyZW50IG1hcCwgdXNlZCB0byByZWNvbnN0cnVjdCB0aGUgcGF0aFxuICAvLyBmcm9tIGhvbWUgdG8gZWFjaCBSRUFEWSBob3N0LiBXaXRob3V0IGl0LCB0aGUgdXNlciBjYW4ndFxuICAvLyBjb25uZWN0IHRvIGFueXRoaW5nIG1vcmUgdGhhbiBvbmUgaG9wIGZyb20gaG9tZS5cbiAgZnVuY3Rpb24gcHJpbnRUYWJsZShyZWFzb24sIHBhcmVudCkge1xuICAgIGNvbnN0IG1lID0gbnMuZ2V0UGxheWVyKCkuc2tpbGxzLmhhY2tpbmc7XG4gICAgY29uc3QgaG9zdHMgPSBbLi4ucGFyZW50LmtleXMoKV0uZmlsdGVyKChoKSA9PiBoICE9PSBcImhvbWVcIikuc29ydCgpO1xuICAgIGNvbnN0IGxpbmVzID0gW107XG4gICAgY29uc3QgY291bnRlcnMgPSB7IFJFQURZOiAwLCBET05FOiAwIH07XG4gICAgZm9yIChjb25zdCBoIG9mIGhvc3RzKSB7XG4gICAgICBjb25zdCBsaW5lID0gc3RhdHVzT2YoaCwgbWUpO1xuICAgICAgaWYgKCFsaW5lKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGlzUmVhZHkgPSBsaW5lLnN0YXJ0c1dpdGgoXCJSRUFEWVwiKTtcbiAgICAgIGNvbnN0IGlzRG9uZSA9IGxpbmUuc3RhcnRzV2l0aChcIkRPTkVcIik7XG4gICAgICBpZiAoaXNSZWFkeSkge1xuICAgICAgICBjb3VudGVycy5SRUFEWSsrO1xuICAgICAgICBjb25zdCBwYXRoID0gcGF0aFRvKHBhcmVudCwgaCk7XG4gICAgICAgIGNvbnN0IGNoYWluID0gY29ubmVjdENoYWluKHBhdGgpO1xuICAgICAgICBpZiAoc2hvd1BhdGgpIHtcbiAgICAgICAgICAvLyBTaW5nbGUtbGluZSBjb3B5LXBhc3RlIGJvZHkgZm9yIHRoZSB0ZXJtaW5hbC4gVGhlXG4gICAgICAgICAgLy8gYml0YnVybmVyIHRlcm1pbmFsIGFjY2VwdHMgYDsgYC1jaGFpbmVkIGNvbW1hbmRzXG4gICAgICAgICAgLy8gc2VwYXJhdGVkIGJ5IHNwYWNlcywgc28gdGhlIHVzZXIgY2FuIHBhc3RlIHRoZVxuICAgICAgICAgIC8vIHF1b3RlZCBjaGFpbiBzdHJhaWdodCBpbi4gT25lIGxpbmUgcGVyIFJFQURZXG4gICAgICAgICAgLy8gc2VydmVyIOKAlCBubyBleHRyYSBjb250ZXh0LCBqdXN0IHRoZSBjb21tYW5kLlxuICAgICAgICAgIGxpbmVzLnB1c2goYG1vbml0b3ItYmFja2Rvb3IuanM6IFJFQURZOiBcIiR7Y2hhaW59XCJgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBDb21wYWN0OiBqdXN0IHRoZSBzZXJ2ZXIgbmFtZSwgbm8gY2hhaW4uIFVzZWZ1bCBmb3JcbiAgICAgICAgICAvLyBsb25nLWxpdmVkIG1vbml0b3JzIHRoYXQgYWxyZWFkeSBrbm93IHRoZSB0b3BvbG9neS5cbiAgICAgICAgICBsaW5lcy5wdXNoKGBtb25pdG9yLWJhY2tkb29yLmpzOiBSRUFEWTogJHtofWApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGlzRG9uZSkge1xuICAgICAgICBjb3VudGVycy5ET05FKys7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIEhlYWRlci4gV2UgcHJpbnQgdGhlIHRhYmxlIGV2ZW4gd2hlbiBlbXB0eSBzbyB0aGUgdXNlciBrbm93c1xuICAgIC8vIHRoZSBzY3JpcHQgaXMgYWxpdmUgYW5kIHRoZXJlJ3Mgbm90aGluZyB0byBiYWNrZG9vci5cbiAgICBjb25zdCBoZWFkZXIgPSByZWFzb24gPyBgbW9uaXRvci1iYWNrZG9vciAoJHtyZWFzb259KTpgIDogYG1vbml0b3ItYmFja2Rvb3I6YDtcbiAgICBucy50cHJpbnQoaGVhZGVyKTtcbiAgICBpZiAobGluZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICBucy50cHJpbnQoYCAgKG5vIFJFQURZIHNlcnZlcnM7IGV2ZXJ5dGhpbmcgaXMgYmFja2Rvb3JlZCwgYmxvY2tlZCwgb3Igb3V0LW9mLWxldmVsKWApO1xuICAgIH0gZWxzZSB7XG4gICAgICBmb3IgKGNvbnN0IGwgb2YgbGluZXMpIG5zLnRwcmludChsKTtcbiAgICB9XG4gICAgY29uc3Qgc3VtbWFyeVBhcnRzID0gW2BSRUFEWT0ke2NvdW50ZXJzLlJFQURZfWBdO1xuICAgIGlmIChpbmNsdWRlQmFja2Rvb3JlZCkgc3VtbWFyeVBhcnRzLnB1c2goYERPTkU9JHtjb3VudGVycy5ET05FfWApO1xuICAgIHN1bW1hcnlQYXJ0cy5wdXNoKGBzY2FubmVkICR7aG9zdHMubGVuZ3RoICsgMX0gaG9zdHNgKTsgIC8vICsxIGZvciBob21lXG4gICAgbnMudHByaW50KGAgICR7c3VtbWFyeVBhcnRzLmpvaW4oXCIgXCIpfWApO1xuICAgIHJldHVybiBsaW5lcztcbiAgfVxuXG4gIC8vIFBvbGwgbG9vcDogcmUtcHJpbnQgdGhlIHRhYmxlIG9ubHkgd2hlbiBzb21ldGhpbmcgY2hhbmdlcy5cbiAgLy8gQ2hhbmdlLWRldGVjdGlvbiBuZWVkcyB0aGUgRlVMTCBzdGF0dXMgKGluY2x1ZGluZyBCTE9DSy0gYW5kXG4gIC8vIFNLSVAtKSwgbm90IGp1c3QgUkVBRFksIGJlY2F1c2UgdGhlIG1vc3QgY29tbW9uIHN0YXRlIGNoYW5nZSBpc1xuICAvLyBCTE9DSy1oYWNrIOKGkiBSRUFEWSAocGxheWVyIGxldmVscyB1cCBhbmQgYSBzZXJ2ZXIgYmVjb21lc1xuICAvLyBiYWNrZG9vcmFibGUpIG9yIFJFQURZIOKGkiBET05FIChwbGF5ZXIganVzdCBiYWNrZG9vcmVkIGEgc2VydmVyKS5cbiAgLy8gVGhlIHByaW50IGZ1bmN0aW9uIHN0aWxsIGZpbHRlcnMgdG8gUkVBRFktb25seSBvdXRwdXQuXG4gIC8vXG4gIC8vIEluIHF1aWV0IG1vZGUgKHRoZSBkZWZhdWx0KSwgd2Ugc3VwcHJlc3MgdGhlIGNoYW5nZSBwcmludCB3aGVuXG4gIC8vIHRoZSBuZXcgc25hcHNob3Qgc3RpbGwgaGFzIFJFQURZPTAg4oCUIHRoZSBcImludGVyZXN0aW5nXCIgZXZlbnQgaXNcbiAgLy8gYSBuZXcgYmFja2Rvb3JhYmxlIHNlcnZlciBhcHBlYXJpbmcsIG5vdCBpbmNpZGVudGFsIEJMT0NLLWhhY2tcbiAgLy8gc3RhdHVzLWxpbmUgY2h1cm4uIC0tdmVyYm9zZSBvcHRzIGJhY2sgaW50byBhbGwgc3RhdGUgY2hhbmdlcy5cbiAgZnVuY3Rpb24gZnVsbFNuYXBzaG90KCkge1xuICAgIGNvbnN0IG1lID0gbnMuZ2V0UGxheWVyKCkuc2tpbGxzLmhhY2tpbmc7XG4gICAgY29uc3QgeyBzZWVuLCBwYXJlbnQgfSA9IGJmc0Zyb21Ib21lKCk7XG4gICAgY29uc3QgbSA9IG5ldyBNYXAoKTtcbiAgICBsZXQgcmVhZHlDb3VudCA9IDA7XG4gICAgZm9yIChjb25zdCBoIG9mIHNlZW4pIHtcbiAgICAgIGNvbnN0IGwgPSBzdGF0dXNPZihoLCBtZSk7XG4gICAgICBpZiAobCkge1xuICAgICAgICBtLnNldChoLCBsKTtcbiAgICAgICAgaWYgKGwuc3RhcnRzV2l0aChcIlJFQURZXCIpKSByZWFkeUNvdW50Kys7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IHN0YXR1czogbSwgcGFyZW50LCByZWFkeUNvdW50IH07XG4gIH1cblxuICAvLyBJbml0aWFsIHRhYmxlLiBJbiBxdWlldCBtb2RlICh0aGUgZGVmYXVsdCkgd2UgRE9OJ1QgcHJpbnRcbiAgLy8gdGhlIHN0YXJ0dXAgdGFibGUgZWl0aGVyIOKAlCB0aGUgdXNlciBleHBsaWNpdGx5IGFza2VkIGZvclxuICAvLyBcIm9ubHkgc2VlIHRoZXNlIG1lc3NhZ2VzIHdoZW4gc29tZXRoaW5nIHBvc2l0aXZlbHkgY2hhbmdlZFwiLFxuICAvLyBzbyB0aGUgaW5pdGlhbCBlbXB0eSB0YWJsZSAoXCJubyBSRUFEWSBzZXJ2ZXJzXCIpIHdvdWxkXG4gIC8vIGNvbnRyYWRpY3QgdGhhdC4gUHJpbnQgdGhlIGluaXRpYWwgdGFibGUgb25seSBpbiAtLW9uY2Ugb3JcbiAgLy8gLS12ZXJib3NlLlxuICBsZXQgbGFzdCA9IGZ1bGxTbmFwc2hvdCgpO1xuICBpZiAob25jZSB8fCB2ZXJib3NlKSB7XG4gICAgcHJpbnRUYWJsZShcInN0YXJ0dXBcIiwgbGFzdC5wYXJlbnQpO1xuICB9XG4gIGlmIChvbmNlKSByZXR1cm47XG5cbiAgd2hpbGUgKHRydWUpIHtcbiAgICBhd2FpdCBucy5zbGVlcChQT0xMX01TKTtcbiAgICBjb25zdCBuZXh0ID0gZnVsbFNuYXBzaG90KCk7XG4gICAgbGV0IGNoYW5nZWQgPSBuZXh0LnN0YXR1cy5zaXplICE9PSBsYXN0LnN0YXR1cy5zaXplO1xuICAgIGlmICghY2hhbmdlZCkge1xuICAgICAgZm9yIChjb25zdCBbaCwgbF0gb2YgbmV4dC5zdGF0dXMpIHtcbiAgICAgICAgaWYgKGxhc3Quc3RhdHVzLmdldChoKSAhPT0gbCkgeyBjaGFuZ2VkID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGNoYW5nZWQpIHtcbiAgICAgIC8vIEluIHF1aWV0IG1vZGUsIG9ubHkgcmUtcHJpbnQgd2hlbiB0aGUgbmV3IHNuYXBzaG90IGhhcyBhXG4gICAgICAvLyBSRUFEWSBzZXJ2ZXIuIE90aGVyd2lzZSB0aGUgY2hhbmdlIGlzIGp1c3QgaW5jaWRlbnRhbFxuICAgICAgLy8gQkxPQ0staGFjayBjaHVybiB0aGF0IHRoZSB1c2VyIGFscmVhZHkga25vd3MgYWJvdXQuXG4gICAgICBpZiAodmVyYm9zZSB8fCBuZXh0LnJlYWR5Q291bnQgPiAwKSB7XG4gICAgICAgIGxhc3QgPSBuZXh0O1xuICAgICAgICBwcmludFRhYmxlKFwiY2hhbmdlXCIsIG5leHQucGFyZW50KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFVwZGF0ZSBsYXN0IHNvIHdlIGRvbid0IGtlZXAgZmlyaW5nIG9uIHRoZSBzYW1lIG5vLW9wXG4gICAgICAgIC8vIGNoYW5nZS4gV2l0aG91dCB0aGlzLCBldmVyeSBwb2xsIHdvdWxkIHJlLWRldGVjdCB0aGVcbiAgICAgICAgLy8gY2h1cm4gYW5kIHRoZSBnYXRlIHdvdWxkIHJlLWV2YWx1YXRlLlxuICAgICAgICBsYXN0ID0gbmV4dDtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==