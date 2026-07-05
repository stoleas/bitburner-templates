/** @param {NS} ns */
//
// Faction-rep share daemon.
//
// Every call to ns.share() generates "share power" for 10 seconds, which
// is a multiplicative boost to reputation gain from ALL faction work
// (hacking contracts, field work, etc.). The boost disappears when the
// 10s window expires, and the RAM is returned to the pool. To keep the
// boost permanently on, we just need to call ns.share() again before
// the window expires.
//
// Two important facts about ns.share():
//
//   1. The share is contributed by the server where the calling script
//      runs. If this script runs on `home`, only home's free RAM is
//      shared. To share a purchased server's free RAM, a copy of this
//      script has to be running on that server.
//
//   2. ns.share() uses the SCRIPT's full thread count as the share-
//      power contribution. So we always run it at max threads.
//
// So this script does two things in one shot:
//
//   A. On home, it spawns a child share.js copy at the maximum thread
//      count that fits. The child loops ns.share() every 9 seconds
//      (just under the 10s window) and keeps running after this
//      orchestrator exits.
//
//   B. It fans a copy of itself out to every rooted, non-purchased-
//      server-with-some-RAM, BFS-reachable host — same shape as
//      deploy.js. Each copy then runs (A) on its own host, contributing
//      that host's free RAM to the global share-power pool.
//
// This is a ONE-SHOT script. The orchestrator exits after fan-out;
// each spawned child keeps sharing indefinitely. Pass --loop to
// keep the orchestrator alive and re-fan-out every 5 minutes
// (useful when actively nuking new servers).
//
// Usage:
//   run share.js                 # one-shot: fan out, spawn home child, exit (default)
//   run share.js --loop          # keep the orchestrator alive; re-fan-out every 5 min
//   run share.js --once          # alias for the default; explicit one-shot
//   run share.js --verbose       # re-enable per-host SKIP / FAIL / SHARED lines
//   run share.js --quiet         # (alias for the default; suppress per-host prints)
//
// RAM cost: ns.share() = 2.4 GB per call. We run with as many threads
// as fit, so on home (32 GB default-ish in early game) the script uses
// ~2.4 GB and produces the maximum share-power for the thread count.
// On small purchased servers (8 GB) the same script uses ~2.4 GB and
// still contributes — every bit helps.
//
// The fan-out is idempotent: re-running share.js is safe. Servers that
// already have a running copy are skipped. The BFS only walks the
// network you can reach; in --loop mode, newly-nuked hosts are picked
// up on the next re-fan-out (every SHARE_RESCAN_MS). In the default
// one-shot mode, re-run the script manually to pick up new roots.
//
// Why fan out to non-purchased servers too? Rooted non-purchased
// servers usually have very little RAM (8–32 GB), and most of it is
// being used by the HWGW workers running on them. The check below
// keeps us from clobbering those workers: if a server has no free RAM
// for even one share.js thread, we SKIP-ram instead of kicking the
// existing worker out. You can also restrict to purchased servers only
// by setting SHARE_INCLUDE_PURCHASED_ONLY=true at the top of the file.
//
const USAGE = `Usage:
  run share.js                 # one-shot: fan out, spawn home child, exit (default)
  run share.js --loop          # keep the orchestrator alive; re-fan-out every 5 min
  run share.js --once          # alias for the default; explicit one-shot
  run share.js --verbose       # re-enable per-host SKIP / FAIL / SHARED lines
  run share.js --quiet         # (alias for the default; suppress per-host prints)
`;
const SHARE_RAM_COST = 2.4; // ns.share()'s RAM cost per call
const SHARE_BOOST_MS = 10_000; // ns.share()'s boost duration
const SHARE_REFRESH_MS = 9_000; // call just before the 10s window expires
const SHARE_RESCAN_MS = 5 * 60_000; // re-BFS every 5 minutes for new roots
const SHARE_INCLUDE_PURCHASED_ONLY = false; // set true to skip non-purchased
const SELF = "share.js";
const SOURCE = "home";
/** BFS the network from `start`. */
function enumerateNetwork(ns, start) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
        const h = queue.shift();
        for (const n of ns.scan(h)) {
            if (!seen.has(n)) {
                seen.add(n);
                queue.push(n);
            }
        }
    }
    return [...seen];
}
/** Find all candidates to host a share.js copy. */
function findShareHosts(ns) {
    const me = ns.getPlayer();
    const myHack = me.skills.hacking;
    const hosts = enumerateNetwork(ns, SOURCE);
    const out = [];
    // Build candidates. home is excluded from the BFS list and handled
    // explicitly below — the orchestrator (us) is itself a share.js
    // instance on home, and we don't want fanOut's SKIP-running check
    // to count us as a duplicate.
    for (const host of hosts) {
        if (host === SOURCE)
            continue; // home is handled separately
        const s = ns.getServer(host);
        if (!s.hasAdminRights)
            continue; // can't scp without root
        if (SHARE_INCLUDE_PURCHASED_ONLY && !s.purchasedByPlayer)
            continue;
        // Must have SOME RAM worth contributing. We don't gate on moneyMax
        // the way deploy.js does — share-power is its own reward.
        if (s.maxRam <= 0)
            continue;
        out.push(host);
    }
    out.sort();
    return out;
}
/** Run the share loop on the calling server. */
async function runShareLoop(ns, opts) {
    ns.disableLog("sleep");
    ns.disableLog("share");
    if (!opts.quiet) {
        ns.tprint(`share[${opts.label}]: starting, refresh=${SHARE_REFRESH_MS}ms`);
    }
    // Calculate max threads. ns.share() RAM cost is per call, not per
    // thread — but threads scale the share-power contribution (with
    // diminishing returns). Run as many as fit.
    const ramPerThread = ns.getScriptRam(SELF); // RAM of the share script itself
    while (true) {
        // ns.share() doesn't take a thread argument; the thread count of
        // the calling script IS the thread count for share-power. We use
        // the script's own thread count, set by ns.exec() on the fan-out
        // side, so all we do here is call it.
        await ns.share();
        const power = ns.getSharePower();
        if (!opts.quiet) {
            const cur = ns.getServerUsedRam(opts.label);
            const max = ns.getServerMaxRam(opts.label);
            ns.print(`share[${opts.label}]: sharePower=${power.toFixed(2)} used=${cur.toFixed(1)}/${max.toFixed(0)}GB`);
        }
        await ns.sleep(SHARE_REFRESH_MS);
    }
}
/** Fan out copies of share.js to every eligible host. */
function fanOut(ns, hosts, counters, opts) {
    // opts.verbose: print per-host lines. When false, suppress the noise
    // and only return counters for the summary.
    const verbose = opts && opts.verbose;
    // Make sure share.js exists on home so we can scp it.
    if (!ns.fileExists(SELF, SOURCE)) {
        ns.tprint(`ERROR: ${SELF} not on ${SOURCE}. Push it via filesync first.`);
        return;
    }
    for (const host of hosts) {
        // Skip if a copy is already running here.
        if (ns.ps(host).some((p) => p.filename === SELF)) {
            if (verbose)
                ns.tprint(`SKIP-running    ${host}  (${SELF} already running)`);
            counters["SKIP-running"]++;
            continue;
        }
        // Copy the script to the target.
        if (!ns.scp(SELF, host, SOURCE)) {
            if (verbose)
                ns.tprint(`FAIL-scp        ${host}`);
            counters["FAIL-scp"]++;
            continue;
        }
        // Run with max threads. SHARE_RAM_COST is the per-call cost; the
        // share script's own RAM is `ns.getScriptRam(SELF, host)` (the
        // 2.4 GB used for ns.share() is already inside the script cost,
        // so we just need the script to fit). The bottleneck is the
        // script's static RAM, not the dynamic call cost.
        const ramPerThread = ns.getScriptRam(SELF, host);
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        const threads = Math.max(1, Math.floor(free / ramPerThread));
        if (threads < 1 || ramPerThread <= 0) {
            if (verbose)
                ns.tprint(`SKIP-ram        ${host}  (no free RAM: ${free.toFixed(2)} GB, ${SELF} needs ${ramPerThread.toFixed(2)} GB)`);
            counters["SKIP-ram"]++;
            continue;
        }
        // Pass --child so the copy knows it's a fanned-out worker and
        // doesn't recurse into its own fan-out.
        const pid = ns.exec(SELF, host, threads, "--child");
        if (pid === 0) {
            if (verbose)
                ns.tprint(`FAIL-exec       ${host}  (exec returned 0 — RAM contention or other script running)`);
            counters["FAIL-exec"]++;
            continue;
        }
        // SHARED is the interesting event — always print it, even in
        // quiet mode. That's the whole point of running share.js.
        ns.tprint(`SHARED          ${host}  ${SELF} x${threads} (pid ${pid})`);
        counters["SHARED"]++;
    }
}
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    const args = (ns.args || []).map(String);
    const loop = args.includes("--loop");
    const verbose = args.includes("--verbose");
    // Default quiet: suppress per-host SKIP/FAIL lines (SHARED is always
    // printed). --loop opts into the daemon mode that re-fans-out every
    // 5 min; --once is an explicit alias for the default one-shot.
    const quiet = args.includes("--quiet") || !verbose;
    const child = args.includes("--child");
    // Child mode: just run the share loop on this host. Never recurse
    // into fan-out, never sleep for the rescan interval.
    if (child) {
        await runShareLoop(ns, { label: ns.getHostname(), quiet });
        return;
    }
    ns.disableLog("sleep");
    ns.disableLog("scan");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("getServerUsedRam");
    const counters = {
        "SHARED": 0,
        "SKIP-running": 0,
        "SKIP-ram": 0,
        "FAIL-scp": 0,
        "FAIL-exec": 0,
    };
    // Phase 1: fan out copies to every eligible host. Re-runs safely.
    // In quiet mode, fanOut suppresses per-host SKIP/FAIL lines but
    // still prints SHARED (the interesting event).
    const hosts = findShareHosts(ns);
    if (verbose) {
        ns.tprint(`share: scanning ${hosts.length} eligible host(s), SHARE_INCLUDE_PURCHASED_ONLY=${SHARE_INCLUDE_PURCHASED_ONLY}`);
    }
    fanOut(ns, hosts, counters, { verbose });
    // Spawn a child share copy on home. We can't reuse fanOut() for this
    // because fanOut's SKIP-running check would match the orchestrator
    // process itself. The child runs in its own process, so its
    // ns.share()/ns.sleep() calls don't contend with this orchestrator's
    // rescan ns.sleep().
    const homeRam = ns.getScriptRam(SELF, SOURCE);
    const homeFree = ns.getServerMaxRam(SOURCE) - ns.getServerUsedRam(SOURCE);
    const homeThreads = Math.max(1, Math.floor(homeFree / homeRam));
    if (homeRam > 0 && homeThreads >= 1) {
        const homePid = ns.exec(SELF, SOURCE, homeThreads, "--child");
        if (homePid > 0) {
            counters["SHARED"]++;
            ns.tprint(`SHARED          ${SOURCE}  ${SELF} x${homeThreads} (pid ${homePid})`);
        }
        else {
            counters["FAIL-exec"]++;
            if (verbose)
                ns.tprint(`FAIL-exec       ${SOURCE}  (could not spawn home child)`);
        }
    }
    else {
        if (verbose)
            ns.tprint(`SKIP-ram        ${SOURCE}  (no free RAM: ${homeFree.toFixed(2)} GB, ${SELF} needs ${homeRam.toFixed(2)} GB)`);
        counters["SKIP-ram"]++;
    }
    // One-shot by default. The fan-out already spawned a child share
    // copy on each eligible host (including home); those children keep
    // running after this orchestrator exits and maintain the share-power
    // window indefinitely. So the orchestrator can just print a summary
    // and exit.
    const summary = Object.entries(counters)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    if (!loop) {
        ns.tprint(`done: ${summary || "no changes"} (scanned ${hosts.length} hosts); children keep sharing, orchestrator exiting`);
        return;
    }
    // --loop mode: stay alive and re-fan-out every SHARE_RESCAN_MS so
    // newly-nuked hosts pick up a share copy without manual intervention.
    // ns.exec on a server that already has a share copy is a no-op
    // (SKIP-running), so this is safe. Use this when actively grinding
    // new ports — the default one-shot mode is what you want for steady
    // state.
    if (verbose)
        ns.tprint(`share: --loop, output=verbose, rescan=${SHARE_RESCAN_MS}ms`);
    let lastRescan = Date.now();
    while (true) {
        await ns.sleep(60_000);
        if (Date.now() - lastRescan >= SHARE_RESCAN_MS) {
            const next = findShareHosts(ns);
            // Reset counters for the diff print; cumulative isn't useful here.
            for (const k of Object.keys(counters))
                counters[k] = 0;
            fanOut(ns, next, counters, { verbose });
            const loopSummary = Object.entries(counters)
                .filter(([_, v]) => v > 0)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ");
            if (loopSummary) {
                // In quiet mode, suppress the re-scan line when no new share
                // copy was actually spawned (SHARED=0). The "interesting"
                // event is a new share.js child starting; SKIP/FAIL on
                // already-running or RAM-contended hosts is noise. In verbose
                // mode, print the summary regardless.
                if (verbose || counters.SHARED > 0) {
                    ns.tprint(`share: re-scan ${next.length} host(s) — ${loopSummary}`);
                }
            }
            lastRescan = Date.now();
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2hhcmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc2hhcmUuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscUJBQXFCO0FBQ3JCLEVBQUU7QUFDRiw0QkFBNEI7QUFDNUIsRUFBRTtBQUNGLHlFQUF5RTtBQUN6RSxxRUFBcUU7QUFDckUsdUVBQXVFO0FBQ3ZFLHVFQUF1RTtBQUN2RSxxRUFBcUU7QUFDckUsc0JBQXNCO0FBQ3RCLEVBQUU7QUFDRix3Q0FBd0M7QUFDeEMsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSxvRUFBb0U7QUFDcEUsc0VBQXNFO0FBQ3RFLGdEQUFnRDtBQUNoRCxFQUFFO0FBQ0Ysb0VBQW9FO0FBQ3BFLCtEQUErRDtBQUMvRCxFQUFFO0FBQ0YsOENBQThDO0FBQzlDLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSwyQkFBMkI7QUFDM0IsRUFBRTtBQUNGLG9FQUFvRTtBQUNwRSxnRUFBZ0U7QUFDaEUsd0VBQXdFO0FBQ3hFLDREQUE0RDtBQUM1RCxFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSw2REFBNkQ7QUFDN0QsNkNBQTZDO0FBQzdDLEVBQUU7QUFDRixTQUFTO0FBQ1QsdUZBQXVGO0FBQ3ZGLHVGQUF1RjtBQUN2Riw0RUFBNEU7QUFDNUUsaUZBQWlGO0FBQ2pGLHFGQUFxRjtBQUNyRixFQUFFO0FBQ0Ysc0VBQXNFO0FBQ3RFLHVFQUF1RTtBQUN2RSxxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLHVDQUF1QztBQUN2QyxFQUFFO0FBQ0YsdUVBQXVFO0FBQ3ZFLGtFQUFrRTtBQUNsRSxzRUFBc0U7QUFDdEUsb0VBQW9FO0FBQ3BFLGtFQUFrRTtBQUNsRSxFQUFFO0FBQ0YsaUVBQWlFO0FBQ2pFLG9FQUFvRTtBQUNwRSxrRUFBa0U7QUFDbEUsc0VBQXNFO0FBQ3RFLG1FQUFtRTtBQUNuRSx1RUFBdUU7QUFDdkUsdUVBQXVFO0FBQ3ZFLEVBQUU7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TUFBTSxJQUFJLEdBQUcsY0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ2hDLG1FQUFtRTtZQUNuRSxLQUFLLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO2dCQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDdkQsTUFBTSxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUN4QyxNQUFNLFdBQVcsR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztpQkFDekMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7aUJBQ3pCLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztpQkFDNUIsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ2IsSUFBSSxXQUFXLEVBQUU7Z0JBQ2YsNkRBQTZEO2dCQUM3RCwwREFBMEQ7Z0JBQzFELHVEQUF1RDtnQkFDdkQsOERBQThEO2dCQUM5RCxzQ0FBc0M7Z0JBQ3RDLElBQUksT0FBTyxJQUFJLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO29CQUNsQyxFQUFFLENBQUMsTUFBTSxDQUFDLGtCQUFrQixJQUFJLENBQUMsTUFBTSxjQUFjLFdBQVcsRUFBRSxDQUFDLENBQUM7aUJBQ3JFO2FBQ0Y7WUFDRCxVQUFVLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1NBQ3pCO0tBQ0Y7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gRmFjdGlvbi1yZXAgc2hhcmUgZGFlbW9uLlxuLy9cbi8vIEV2ZXJ5IGNhbGwgdG8gbnMuc2hhcmUoKSBnZW5lcmF0ZXMgXCJzaGFyZSBwb3dlclwiIGZvciAxMCBzZWNvbmRzLCB3aGljaFxuLy8gaXMgYSBtdWx0aXBsaWNhdGl2ZSBib29zdCB0byByZXB1dGF0aW9uIGdhaW4gZnJvbSBBTEwgZmFjdGlvbiB3b3JrXG4vLyAoaGFja2luZyBjb250cmFjdHMsIGZpZWxkIHdvcmssIGV0Yy4pLiBUaGUgYm9vc3QgZGlzYXBwZWFycyB3aGVuIHRoZVxuLy8gMTBzIHdpbmRvdyBleHBpcmVzLCBhbmQgdGhlIFJBTSBpcyByZXR1cm5lZCB0byB0aGUgcG9vbC4gVG8ga2VlcCB0aGVcbi8vIGJvb3N0IHBlcm1hbmVudGx5IG9uLCB3ZSBqdXN0IG5lZWQgdG8gY2FsbCBucy5zaGFyZSgpIGFnYWluIGJlZm9yZVxuLy8gdGhlIHdpbmRvdyBleHBpcmVzLlxuLy9cbi8vIFR3byBpbXBvcnRhbnQgZmFjdHMgYWJvdXQgbnMuc2hhcmUoKTpcbi8vXG4vLyAgIDEuIFRoZSBzaGFyZSBpcyBjb250cmlidXRlZCBieSB0aGUgc2VydmVyIHdoZXJlIHRoZSBjYWxsaW5nIHNjcmlwdFxuLy8gICAgICBydW5zLiBJZiB0aGlzIHNjcmlwdCBydW5zIG9uIGBob21lYCwgb25seSBob21lJ3MgZnJlZSBSQU0gaXNcbi8vICAgICAgc2hhcmVkLiBUbyBzaGFyZSBhIHB1cmNoYXNlZCBzZXJ2ZXIncyBmcmVlIFJBTSwgYSBjb3B5IG9mIHRoaXNcbi8vICAgICAgc2NyaXB0IGhhcyB0byBiZSBydW5uaW5nIG9uIHRoYXQgc2VydmVyLlxuLy9cbi8vICAgMi4gbnMuc2hhcmUoKSB1c2VzIHRoZSBTQ1JJUFQncyBmdWxsIHRocmVhZCBjb3VudCBhcyB0aGUgc2hhcmUtXG4vLyAgICAgIHBvd2VyIGNvbnRyaWJ1dGlvbi4gU28gd2UgYWx3YXlzIHJ1biBpdCBhdCBtYXggdGhyZWFkcy5cbi8vXG4vLyBTbyB0aGlzIHNjcmlwdCBkb2VzIHR3byB0aGluZ3MgaW4gb25lIHNob3Q6XG4vL1xuLy8gICBBLiBPbiBob21lLCBpdCBzcGF3bnMgYSBjaGlsZCBzaGFyZS5qcyBjb3B5IGF0IHRoZSBtYXhpbXVtIHRocmVhZFxuLy8gICAgICBjb3VudCB0aGF0IGZpdHMuIFRoZSBjaGlsZCBsb29wcyBucy5zaGFyZSgpIGV2ZXJ5IDkgc2Vjb25kc1xuLy8gICAgICAoanVzdCB1bmRlciB0aGUgMTBzIHdpbmRvdykgYW5kIGtlZXBzIHJ1bm5pbmcgYWZ0ZXIgdGhpc1xuLy8gICAgICBvcmNoZXN0cmF0b3IgZXhpdHMuXG4vL1xuLy8gICBCLiBJdCBmYW5zIGEgY29weSBvZiBpdHNlbGYgb3V0IHRvIGV2ZXJ5IHJvb3RlZCwgbm9uLXB1cmNoYXNlZC1cbi8vICAgICAgc2VydmVyLXdpdGgtc29tZS1SQU0sIEJGUy1yZWFjaGFibGUgaG9zdCDigJQgc2FtZSBzaGFwZSBhc1xuLy8gICAgICBkZXBsb3kuanMuIEVhY2ggY29weSB0aGVuIHJ1bnMgKEEpIG9uIGl0cyBvd24gaG9zdCwgY29udHJpYnV0aW5nXG4vLyAgICAgIHRoYXQgaG9zdCdzIGZyZWUgUkFNIHRvIHRoZSBnbG9iYWwgc2hhcmUtcG93ZXIgcG9vbC5cbi8vXG4vLyBUaGlzIGlzIGEgT05FLVNIT1Qgc2NyaXB0LiBUaGUgb3JjaGVzdHJhdG9yIGV4aXRzIGFmdGVyIGZhbi1vdXQ7XG4vLyBlYWNoIHNwYXduZWQgY2hpbGQga2VlcHMgc2hhcmluZyBpbmRlZmluaXRlbHkuIFBhc3MgLS1sb29wIHRvXG4vLyBrZWVwIHRoZSBvcmNoZXN0cmF0b3IgYWxpdmUgYW5kIHJlLWZhbi1vdXQgZXZlcnkgNSBtaW51dGVzXG4vLyAodXNlZnVsIHdoZW4gYWN0aXZlbHkgbnVraW5nIG5ldyBzZXJ2ZXJzKS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIHNoYXJlLmpzICAgICAgICAgICAgICAgICAjIG9uZS1zaG90OiBmYW4gb3V0LCBzcGF3biBob21lIGNoaWxkLCBleGl0IChkZWZhdWx0KVxuLy8gICBydW4gc2hhcmUuanMgLS1sb29wICAgICAgICAgICMga2VlcCB0aGUgb3JjaGVzdHJhdG9yIGFsaXZlOyByZS1mYW4tb3V0IGV2ZXJ5IDUgbWluXG4vLyAgIHJ1biBzaGFyZS5qcyAtLW9uY2UgICAgICAgICAgIyBhbGlhcyBmb3IgdGhlIGRlZmF1bHQ7IGV4cGxpY2l0IG9uZS1zaG90XG4vLyAgIHJ1biBzaGFyZS5qcyAtLXZlcmJvc2UgICAgICAgIyByZS1lbmFibGUgcGVyLWhvc3QgU0tJUCAvIEZBSUwgLyBTSEFSRUQgbGluZXNcbi8vICAgcnVuIHNoYXJlLmpzIC0tcXVpZXQgICAgICAgICAjIChhbGlhcyBmb3IgdGhlIGRlZmF1bHQ7IHN1cHByZXNzIHBlci1ob3N0IHByaW50cylcbi8vXG4vLyBSQU0gY29zdDogbnMuc2hhcmUoKSA9IDIuNCBHQiBwZXIgY2FsbC4gV2UgcnVuIHdpdGggYXMgbWFueSB0aHJlYWRzXG4vLyBhcyBmaXQsIHNvIG9uIGhvbWUgKDMyIEdCIGRlZmF1bHQtaXNoIGluIGVhcmx5IGdhbWUpIHRoZSBzY3JpcHQgdXNlc1xuLy8gfjIuNCBHQiBhbmQgcHJvZHVjZXMgdGhlIG1heGltdW0gc2hhcmUtcG93ZXIgZm9yIHRoZSB0aHJlYWQgY291bnQuXG4vLyBPbiBzbWFsbCBwdXJjaGFzZWQgc2VydmVycyAoOCBHQikgdGhlIHNhbWUgc2NyaXB0IHVzZXMgfjIuNCBHQiBhbmRcbi8vIHN0aWxsIGNvbnRyaWJ1dGVzIOKAlCBldmVyeSBiaXQgaGVscHMuXG4vL1xuLy8gVGhlIGZhbi1vdXQgaXMgaWRlbXBvdGVudDogcmUtcnVubmluZyBzaGFyZS5qcyBpcyBzYWZlLiBTZXJ2ZXJzIHRoYXRcbi8vIGFscmVhZHkgaGF2ZSBhIHJ1bm5pbmcgY29weSBhcmUgc2tpcHBlZC4gVGhlIEJGUyBvbmx5IHdhbGtzIHRoZVxuLy8gbmV0d29yayB5b3UgY2FuIHJlYWNoOyBpbiAtLWxvb3AgbW9kZSwgbmV3bHktbnVrZWQgaG9zdHMgYXJlIHBpY2tlZFxuLy8gdXAgb24gdGhlIG5leHQgcmUtZmFuLW91dCAoZXZlcnkgU0hBUkVfUkVTQ0FOX01TKS4gSW4gdGhlIGRlZmF1bHRcbi8vIG9uZS1zaG90IG1vZGUsIHJlLXJ1biB0aGUgc2NyaXB0IG1hbnVhbGx5IHRvIHBpY2sgdXAgbmV3IHJvb3RzLlxuLy9cbi8vIFdoeSBmYW4gb3V0IHRvIG5vbi1wdXJjaGFzZWQgc2VydmVycyB0b28/IFJvb3RlZCBub24tcHVyY2hhc2VkXG4vLyBzZXJ2ZXJzIHVzdWFsbHkgaGF2ZSB2ZXJ5IGxpdHRsZSBSQU0gKDjigJMzMiBHQiksIGFuZCBtb3N0IG9mIGl0IGlzXG4vLyBiZWluZyB1c2VkIGJ5IHRoZSBIV0dXIHdvcmtlcnMgcnVubmluZyBvbiB0aGVtLiBUaGUgY2hlY2sgYmVsb3dcbi8vIGtlZXBzIHVzIGZyb20gY2xvYmJlcmluZyB0aG9zZSB3b3JrZXJzOiBpZiBhIHNlcnZlciBoYXMgbm8gZnJlZSBSQU1cbi8vIGZvciBldmVuIG9uZSBzaGFyZS5qcyB0aHJlYWQsIHdlIFNLSVAtcmFtIGluc3RlYWQgb2Yga2lja2luZyB0aGVcbi8vIGV4aXN0aW5nIHdvcmtlciBvdXQuIFlvdSBjYW4gYWxzbyByZXN0cmljdCB0byBwdXJjaGFzZWQgc2VydmVycyBvbmx5XG4vLyBieSBzZXR0aW5nIFNIQVJFX0lOQ0xVREVfUFVSQ0hBU0VEX09OTFk9dHJ1ZSBhdCB0aGUgdG9wIG9mIHRoZSBmaWxlLlxuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxuICBydW4gc2hhcmUuanMgICAgICAgICAgICAgICAgICMgb25lLXNob3Q6IGZhbiBvdXQsIHNwYXduIGhvbWUgY2hpbGQsIGV4aXQgKGRlZmF1bHQpXG4gIHJ1biBzaGFyZS5qcyAtLWxvb3AgICAgICAgICAgIyBrZWVwIHRoZSBvcmNoZXN0cmF0b3IgYWxpdmU7IHJlLWZhbi1vdXQgZXZlcnkgNSBtaW5cbiAgcnVuIHNoYXJlLmpzIC0tb25jZSAgICAgICAgICAjIGFsaWFzIGZvciB0aGUgZGVmYXVsdDsgZXhwbGljaXQgb25lLXNob3RcbiAgcnVuIHNoYXJlLmpzIC0tdmVyYm9zZSAgICAgICAjIHJlLWVuYWJsZSBwZXItaG9zdCBTS0lQIC8gRkFJTCAvIFNIQVJFRCBsaW5lc1xuICBydW4gc2hhcmUuanMgLS1xdWlldCAgICAgICAgICMgKGFsaWFzIGZvciB0aGUgZGVmYXVsdDsgc3VwcHJlc3MgcGVyLWhvc3QgcHJpbnRzKVxuYDtcblxuY29uc3QgU0hBUkVfUkFNX0NPU1QgPSAyLjQ7ICAgICAvLyBucy5zaGFyZSgpJ3MgUkFNIGNvc3QgcGVyIGNhbGxcbmNvbnN0IFNIQVJFX0JPT1NUX01TID0gMTBfMDAwOyAgLy8gbnMuc2hhcmUoKSdzIGJvb3N0IGR1cmF0aW9uXG5jb25zdCBTSEFSRV9SRUZSRVNIX01TID0gOV8wMDA7IC8vIGNhbGwganVzdCBiZWZvcmUgdGhlIDEwcyB3aW5kb3cgZXhwaXJlc1xuY29uc3QgU0hBUkVfUkVTQ0FOX01TID0gNSAqIDYwXzAwMDsgIC8vIHJlLUJGUyBldmVyeSA1IG1pbnV0ZXMgZm9yIG5ldyByb290c1xuY29uc3QgU0hBUkVfSU5DTFVERV9QVVJDSEFTRURfT05MWSA9IGZhbHNlOyAgLy8gc2V0IHRydWUgdG8gc2tpcCBub24tcHVyY2hhc2VkXG5cbmNvbnN0IFNFTEYgPSBcInNoYXJlLmpzXCI7XG5jb25zdCBTT1VSQ0UgPSBcImhvbWVcIjtcblxuLyoqIEJGUyB0aGUgbmV0d29yayBmcm9tIGBzdGFydGAuICovXG5mdW5jdGlvbiBlbnVtZXJhdGVOZXR3b3JrKG5zLCBzdGFydCkge1xuICBjb25zdCBzZWVuID0gbmV3IFNldChbc3RhcnRdKTtcbiAgY29uc3QgcXVldWUgPSBbc3RhcnRdO1xuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGggPSBxdWV1ZS5zaGlmdCgpO1xuICAgIGZvciAoY29uc3QgbiBvZiBucy5zY2FuKGgpKSB7XG4gICAgICBpZiAoIXNlZW4uaGFzKG4pKSB7IHNlZW4uYWRkKG4pOyBxdWV1ZS5wdXNoKG4pOyB9XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4uc2Vlbl07XG59XG5cbi8qKiBGaW5kIGFsbCBjYW5kaWRhdGVzIHRvIGhvc3QgYSBzaGFyZS5qcyBjb3B5LiAqL1xuZnVuY3Rpb24gZmluZFNoYXJlSG9zdHMobnMpIHtcbiAgY29uc3QgbWUgPSBucy5nZXRQbGF5ZXIoKTtcbiAgY29uc3QgbXlIYWNrID0gbWUuc2tpbGxzLmhhY2tpbmc7XG4gIGNvbnN0IGhvc3RzID0gZW51bWVyYXRlTmV0d29yayhucywgU09VUkNFKTtcbiAgY29uc3Qgb3V0ID0gW107XG4gIC8vIEJ1aWxkIGNhbmRpZGF0ZXMuIGhvbWUgaXMgZXhjbHVkZWQgZnJvbSB0aGUgQkZTIGxpc3QgYW5kIGhhbmRsZWRcbiAgLy8gZXhwbGljaXRseSBiZWxvdyDigJQgdGhlIG9yY2hlc3RyYXRvciAodXMpIGlzIGl0c2VsZiBhIHNoYXJlLmpzXG4gIC8vIGluc3RhbmNlIG9uIGhvbWUsIGFuZCB3ZSBkb24ndCB3YW50IGZhbk91dCdzIFNLSVAtcnVubmluZyBjaGVja1xuICAvLyB0byBjb3VudCB1cyBhcyBhIGR1cGxpY2F0ZS5cbiAgZm9yIChjb25zdCBob3N0IG9mIGhvc3RzKSB7XG4gICAgaWYgKGhvc3QgPT09IFNPVVJDRSkgY29udGludWU7ICAgICAvLyBob21lIGlzIGhhbmRsZWQgc2VwYXJhdGVseVxuICAgIGNvbnN0IHMgPSBucy5nZXRTZXJ2ZXIoaG9zdCk7XG4gICAgaWYgKCFzLmhhc0FkbWluUmlnaHRzKSBjb250aW51ZTsgICAvLyBjYW4ndCBzY3Agd2l0aG91dCByb290XG4gICAgaWYgKFNIQVJFX0lOQ0xVREVfUFVSQ0hBU0VEX09OTFkgJiYgIXMucHVyY2hhc2VkQnlQbGF5ZXIpIGNvbnRpbnVlO1xuICAgIC8vIE11c3QgaGF2ZSBTT01FIFJBTSB3b3J0aCBjb250cmlidXRpbmcuIFdlIGRvbid0IGdhdGUgb24gbW9uZXlNYXhcbiAgICAvLyB0aGUgd2F5IGRlcGxveS5qcyBkb2VzIOKAlCBzaGFyZS1wb3dlciBpcyBpdHMgb3duIHJld2FyZC5cbiAgICBpZiAocy5tYXhSYW0gPD0gMCkgY29udGludWU7XG4gICAgb3V0LnB1c2goaG9zdCk7XG4gIH1cbiAgb3V0LnNvcnQoKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFJ1biB0aGUgc2hhcmUgbG9vcCBvbiB0aGUgY2FsbGluZyBzZXJ2ZXIuICovXG5hc3luYyBmdW5jdGlvbiBydW5TaGFyZUxvb3AobnMsIG9wdHMpIHtcbiAgbnMuZGlzYWJsZUxvZyhcInNsZWVwXCIpO1xuICBucy5kaXNhYmxlTG9nKFwic2hhcmVcIik7XG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIG5zLnRwcmludChgc2hhcmVbJHtvcHRzLmxhYmVsfV06IHN0YXJ0aW5nLCByZWZyZXNoPSR7U0hBUkVfUkVGUkVTSF9NU31tc2ApO1xuICB9XG4gIC8vIENhbGN1bGF0ZSBtYXggdGhyZWFkcy4gbnMuc2hhcmUoKSBSQU0gY29zdCBpcyBwZXIgY2FsbCwgbm90IHBlclxuICAvLyB0aHJlYWQg4oCUIGJ1dCB0aHJlYWRzIHNjYWxlIHRoZSBzaGFyZS1wb3dlciBjb250cmlidXRpb24gKHdpdGhcbiAgLy8gZGltaW5pc2hpbmcgcmV0dXJucykuIFJ1biBhcyBtYW55IGFzIGZpdC5cbiAgY29uc3QgcmFtUGVyVGhyZWFkID0gbnMuZ2V0U2NyaXB0UmFtKFNFTEYpOyAgLy8gUkFNIG9mIHRoZSBzaGFyZSBzY3JpcHQgaXRzZWxmXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgLy8gbnMuc2hhcmUoKSBkb2Vzbid0IHRha2UgYSB0aHJlYWQgYXJndW1lbnQ7IHRoZSB0aHJlYWQgY291bnQgb2ZcbiAgICAvLyB0aGUgY2FsbGluZyBzY3JpcHQgSVMgdGhlIHRocmVhZCBjb3VudCBmb3Igc2hhcmUtcG93ZXIuIFdlIHVzZVxuICAgIC8vIHRoZSBzY3JpcHQncyBvd24gdGhyZWFkIGNvdW50LCBzZXQgYnkgbnMuZXhlYygpIG9uIHRoZSBmYW4tb3V0XG4gICAgLy8gc2lkZSwgc28gYWxsIHdlIGRvIGhlcmUgaXMgY2FsbCBpdC5cbiAgICBhd2FpdCBucy5zaGFyZSgpO1xuICAgIGNvbnN0IHBvd2VyID0gbnMuZ2V0U2hhcmVQb3dlcigpO1xuICAgIGlmICghb3B0cy5xdWlldCkge1xuICAgICAgY29uc3QgY3VyID0gbnMuZ2V0U2VydmVyVXNlZFJhbShvcHRzLmxhYmVsKTtcbiAgICAgIGNvbnN0IG1heCA9IG5zLmdldFNlcnZlck1heFJhbShvcHRzLmxhYmVsKTtcbiAgICAgIG5zLnByaW50KGBzaGFyZVske29wdHMubGFiZWx9XTogc2hhcmVQb3dlcj0ke3Bvd2VyLnRvRml4ZWQoMil9IHVzZWQ9JHtjdXIudG9GaXhlZCgxKX0vJHttYXgudG9GaXhlZCgwKX1HQmApO1xuICAgIH1cbiAgICBhd2FpdCBucy5zbGVlcChTSEFSRV9SRUZSRVNIX01TKTtcbiAgfVxufVxuXG4vKiogRmFuIG91dCBjb3BpZXMgb2Ygc2hhcmUuanMgdG8gZXZlcnkgZWxpZ2libGUgaG9zdC4gKi9cbmZ1bmN0aW9uIGZhbk91dChucywgaG9zdHMsIGNvdW50ZXJzLCBvcHRzKSB7XG4gIC8vIG9wdHMudmVyYm9zZTogcHJpbnQgcGVyLWhvc3QgbGluZXMuIFdoZW4gZmFsc2UsIHN1cHByZXNzIHRoZSBub2lzZVxuICAvLyBhbmQgb25seSByZXR1cm4gY291bnRlcnMgZm9yIHRoZSBzdW1tYXJ5LlxuICBjb25zdCB2ZXJib3NlID0gb3B0cyAmJiBvcHRzLnZlcmJvc2U7XG4gIC8vIE1ha2Ugc3VyZSBzaGFyZS5qcyBleGlzdHMgb24gaG9tZSBzbyB3ZSBjYW4gc2NwIGl0LlxuICBpZiAoIW5zLmZpbGVFeGlzdHMoU0VMRiwgU09VUkNFKSkge1xuICAgIG5zLnRwcmludChgRVJST1I6ICR7U0VMRn0gbm90IG9uICR7U09VUkNFfS4gUHVzaCBpdCB2aWEgZmlsZXN5bmMgZmlyc3QuYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3QgaG9zdCBvZiBob3N0cykge1xuICAgIC8vIFNraXAgaWYgYSBjb3B5IGlzIGFscmVhZHkgcnVubmluZyBoZXJlLlxuICAgIGlmIChucy5wcyhob3N0KS5zb21lKChwKSA9PiBwLmZpbGVuYW1lID09PSBTRUxGKSkge1xuICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgU0tJUC1ydW5uaW5nICAgICR7aG9zdH0gICgke1NFTEZ9IGFscmVhZHkgcnVubmluZylgKTtcbiAgICAgIGNvdW50ZXJzW1wiU0tJUC1ydW5uaW5nXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gQ29weSB0aGUgc2NyaXB0IHRvIHRoZSB0YXJnZXQuXG4gICAgaWYgKCFucy5zY3AoU0VMRiwgaG9zdCwgU09VUkNFKSkge1xuICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgRkFJTC1zY3AgICAgICAgICR7aG9zdH1gKTtcbiAgICAgIGNvdW50ZXJzW1wiRkFJTC1zY3BcIl0rKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBSdW4gd2l0aCBtYXggdGhyZWFkcy4gU0hBUkVfUkFNX0NPU1QgaXMgdGhlIHBlci1jYWxsIGNvc3Q7IHRoZVxuICAgIC8vIHNoYXJlIHNjcmlwdCdzIG93biBSQU0gaXMgYG5zLmdldFNjcmlwdFJhbShTRUxGLCBob3N0KWAgKHRoZVxuICAgIC8vIDIuNCBHQiB1c2VkIGZvciBucy5zaGFyZSgpIGlzIGFscmVhZHkgaW5zaWRlIHRoZSBzY3JpcHQgY29zdCxcbiAgICAvLyBzbyB3ZSBqdXN0IG5lZWQgdGhlIHNjcmlwdCB0byBmaXQpLiBUaGUgYm90dGxlbmVjayBpcyB0aGVcbiAgICAvLyBzY3JpcHQncyBzdGF0aWMgUkFNLCBub3QgdGhlIGR5bmFtaWMgY2FsbCBjb3N0LlxuICAgIGNvbnN0IHJhbVBlclRocmVhZCA9IG5zLmdldFNjcmlwdFJhbShTRUxGLCBob3N0KTtcbiAgICBjb25zdCBmcmVlID0gbnMuZ2V0U2VydmVyTWF4UmFtKGhvc3QpIC0gbnMuZ2V0U2VydmVyVXNlZFJhbShob3N0KTtcbiAgICBjb25zdCB0aHJlYWRzID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihmcmVlIC8gcmFtUGVyVGhyZWFkKSk7XG4gICAgaWYgKHRocmVhZHMgPCAxIHx8IHJhbVBlclRocmVhZCA8PSAwKSB7XG4gICAgICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBTS0lQLXJhbSAgICAgICAgJHtob3N0fSAgKG5vIGZyZWUgUkFNOiAke2ZyZWUudG9GaXhlZCgyKX0gR0IsICR7U0VMRn0gbmVlZHMgJHtyYW1QZXJUaHJlYWQudG9GaXhlZCgyKX0gR0IpYCk7XG4gICAgICBjb3VudGVyc1tcIlNLSVAtcmFtXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gUGFzcyAtLWNoaWxkIHNvIHRoZSBjb3B5IGtub3dzIGl0J3MgYSBmYW5uZWQtb3V0IHdvcmtlciBhbmRcbiAgICAvLyBkb2Vzbid0IHJlY3Vyc2UgaW50byBpdHMgb3duIGZhbi1vdXQuXG4gICAgY29uc3QgcGlkID0gbnMuZXhlYyhTRUxGLCBob3N0LCB0aHJlYWRzLCBcIi0tY2hpbGRcIik7XG4gICAgaWYgKHBpZCA9PT0gMCkge1xuICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgRkFJTC1leGVjICAgICAgICR7aG9zdH0gIChleGVjIHJldHVybmVkIDAg4oCUIFJBTSBjb250ZW50aW9uIG9yIG90aGVyIHNjcmlwdCBydW5uaW5nKWApO1xuICAgICAgY291bnRlcnNbXCJGQUlMLWV4ZWNcIl0rKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBTSEFSRUQgaXMgdGhlIGludGVyZXN0aW5nIGV2ZW50IOKAlCBhbHdheXMgcHJpbnQgaXQsIGV2ZW4gaW5cbiAgICAvLyBxdWlldCBtb2RlLiBUaGF0J3MgdGhlIHdob2xlIHBvaW50IG9mIHJ1bm5pbmcgc2hhcmUuanMuXG4gICAgbnMudHByaW50KGBTSEFSRUQgICAgICAgICAgJHtob3N0fSAgJHtTRUxGfSB4JHt0aHJlYWRzfSAocGlkICR7cGlkfSlgKTtcbiAgICBjb3VudGVyc1tcIlNIQVJFRFwiXSsrO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGlmIChucy5hcmdzLmluY2x1ZGVzKFwiLWhcIikgfHwgbnMuYXJncy5pbmNsdWRlcyhcIi0taGVscFwiKSkge1xuICAgIG5zLnRwcmludChVU0FHRSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFyZ3MgPSAobnMuYXJncyB8fCBbXSkubWFwKFN0cmluZyk7XG4gIGNvbnN0IGxvb3AgPSBhcmdzLmluY2x1ZGVzKFwiLS1sb29wXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgLy8gRGVmYXVsdCBxdWlldDogc3VwcHJlc3MgcGVyLWhvc3QgU0tJUC9GQUlMIGxpbmVzIChTSEFSRUQgaXMgYWx3YXlzXG4gIC8vIHByaW50ZWQpLiAtLWxvb3Agb3B0cyBpbnRvIHRoZSBkYWVtb24gbW9kZSB0aGF0IHJlLWZhbnMtb3V0IGV2ZXJ5XG4gIC8vIDUgbWluOyAtLW9uY2UgaXMgYW4gZXhwbGljaXQgYWxpYXMgZm9yIHRoZSBkZWZhdWx0IG9uZS1zaG90LlxuICBjb25zdCBxdWlldCA9IGFyZ3MuaW5jbHVkZXMoXCItLXF1aWV0XCIpIHx8ICF2ZXJib3NlO1xuICBjb25zdCBjaGlsZCA9IGFyZ3MuaW5jbHVkZXMoXCItLWNoaWxkXCIpO1xuXG4gIC8vIENoaWxkIG1vZGU6IGp1c3QgcnVuIHRoZSBzaGFyZSBsb29wIG9uIHRoaXMgaG9zdC4gTmV2ZXIgcmVjdXJzZVxuICAvLyBpbnRvIGZhbi1vdXQsIG5ldmVyIHNsZWVwIGZvciB0aGUgcmVzY2FuIGludGVydmFsLlxuICBpZiAoY2hpbGQpIHtcbiAgICBhd2FpdCBydW5TaGFyZUxvb3AobnMsIHsgbGFiZWw6IG5zLmdldEhvc3RuYW1lKCksIHF1aWV0IH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIG5zLmRpc2FibGVMb2coXCJzbGVlcFwiKTtcbiAgbnMuZGlzYWJsZUxvZyhcInNjYW5cIik7XG4gIG5zLmRpc2FibGVMb2coXCJnZXRTZXJ2ZXJNYXhSYW1cIik7XG4gIG5zLmRpc2FibGVMb2coXCJnZXRTZXJ2ZXJVc2VkUmFtXCIpO1xuXG4gIGNvbnN0IGNvdW50ZXJzID0ge1xuICAgIFwiU0hBUkVEXCI6IDAsXG4gICAgXCJTS0lQLXJ1bm5pbmdcIjogMCxcbiAgICBcIlNLSVAtcmFtXCI6IDAsXG4gICAgXCJGQUlMLXNjcFwiOiAwLFxuICAgIFwiRkFJTC1leGVjXCI6IDAsXG4gIH07XG5cbiAgLy8gUGhhc2UgMTogZmFuIG91dCBjb3BpZXMgdG8gZXZlcnkgZWxpZ2libGUgaG9zdC4gUmUtcnVucyBzYWZlbHkuXG4gIC8vIEluIHF1aWV0IG1vZGUsIGZhbk91dCBzdXBwcmVzc2VzIHBlci1ob3N0IFNLSVAvRkFJTCBsaW5lcyBidXRcbiAgLy8gc3RpbGwgcHJpbnRzIFNIQVJFRCAodGhlIGludGVyZXN0aW5nIGV2ZW50KS5cbiAgY29uc3QgaG9zdHMgPSBmaW5kU2hhcmVIb3N0cyhucyk7XG4gIGlmICh2ZXJib3NlKSB7XG4gICAgbnMudHByaW50KGBzaGFyZTogc2Nhbm5pbmcgJHtob3N0cy5sZW5ndGh9IGVsaWdpYmxlIGhvc3QocyksIFNIQVJFX0lOQ0xVREVfUFVSQ0hBU0VEX09OTFk9JHtTSEFSRV9JTkNMVURFX1BVUkNIQVNFRF9PTkxZfWApO1xuICB9XG4gIGZhbk91dChucywgaG9zdHMsIGNvdW50ZXJzLCB7IHZlcmJvc2UgfSk7XG5cbiAgLy8gU3Bhd24gYSBjaGlsZCBzaGFyZSBjb3B5IG9uIGhvbWUuIFdlIGNhbid0IHJldXNlIGZhbk91dCgpIGZvciB0aGlzXG4gIC8vIGJlY2F1c2UgZmFuT3V0J3MgU0tJUC1ydW5uaW5nIGNoZWNrIHdvdWxkIG1hdGNoIHRoZSBvcmNoZXN0cmF0b3JcbiAgLy8gcHJvY2VzcyBpdHNlbGYuIFRoZSBjaGlsZCBydW5zIGluIGl0cyBvd24gcHJvY2Vzcywgc28gaXRzXG4gIC8vIG5zLnNoYXJlKCkvbnMuc2xlZXAoKSBjYWxscyBkb24ndCBjb250ZW5kIHdpdGggdGhpcyBvcmNoZXN0cmF0b3Inc1xuICAvLyByZXNjYW4gbnMuc2xlZXAoKS5cbiAgY29uc3QgaG9tZVJhbSA9IG5zLmdldFNjcmlwdFJhbShTRUxGLCBTT1VSQ0UpO1xuICBjb25zdCBob21lRnJlZSA9IG5zLmdldFNlcnZlck1heFJhbShTT1VSQ0UpIC0gbnMuZ2V0U2VydmVyVXNlZFJhbShTT1VSQ0UpO1xuICBjb25zdCBob21lVGhyZWFkcyA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IoaG9tZUZyZWUgLyBob21lUmFtKSk7XG4gIGlmIChob21lUmFtID4gMCAmJiBob21lVGhyZWFkcyA+PSAxKSB7XG4gICAgY29uc3QgaG9tZVBpZCA9IG5zLmV4ZWMoU0VMRiwgU09VUkNFLCBob21lVGhyZWFkcywgXCItLWNoaWxkXCIpO1xuICAgIGlmIChob21lUGlkID4gMCkge1xuICAgICAgY291bnRlcnNbXCJTSEFSRURcIl0rKztcbiAgICAgIG5zLnRwcmludChgU0hBUkVEICAgICAgICAgICR7U09VUkNFfSAgJHtTRUxGfSB4JHtob21lVGhyZWFkc30gKHBpZCAke2hvbWVQaWR9KWApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb3VudGVyc1tcIkZBSUwtZXhlY1wiXSsrO1xuICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgRkFJTC1leGVjICAgICAgICR7U09VUkNFfSAgKGNvdWxkIG5vdCBzcGF3biBob21lIGNoaWxkKWApO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBTS0lQLXJhbSAgICAgICAgJHtTT1VSQ0V9ICAobm8gZnJlZSBSQU06ICR7aG9tZUZyZWUudG9GaXhlZCgyKX0gR0IsICR7U0VMRn0gbmVlZHMgJHtob21lUmFtLnRvRml4ZWQoMil9IEdCKWApO1xuICAgIGNvdW50ZXJzW1wiU0tJUC1yYW1cIl0rKztcbiAgfVxuXG4gIC8vIE9uZS1zaG90IGJ5IGRlZmF1bHQuIFRoZSBmYW4tb3V0IGFscmVhZHkgc3Bhd25lZCBhIGNoaWxkIHNoYXJlXG4gIC8vIGNvcHkgb24gZWFjaCBlbGlnaWJsZSBob3N0IChpbmNsdWRpbmcgaG9tZSk7IHRob3NlIGNoaWxkcmVuIGtlZXBcbiAgLy8gcnVubmluZyBhZnRlciB0aGlzIG9yY2hlc3RyYXRvciBleGl0cyBhbmQgbWFpbnRhaW4gdGhlIHNoYXJlLXBvd2VyXG4gIC8vIHdpbmRvdyBpbmRlZmluaXRlbHkuIFNvIHRoZSBvcmNoZXN0cmF0b3IgY2FuIGp1c3QgcHJpbnQgYSBzdW1tYXJ5XG4gIC8vIGFuZCBleGl0LlxuICBjb25zdCBzdW1tYXJ5ID0gT2JqZWN0LmVudHJpZXMoY291bnRlcnMpXG4gICAgLmZpbHRlcigoW18sIHZdKSA9PiB2ID4gMClcbiAgICAubWFwKChbaywgdl0pID0+IGAke2t9PSR7dn1gKVxuICAgIC5qb2luKFwiIFwiKTtcblxuICBpZiAoIWxvb3ApIHtcbiAgICBucy50cHJpbnQoYGRvbmU6ICR7c3VtbWFyeSB8fCBcIm5vIGNoYW5nZXNcIn0gKHNjYW5uZWQgJHtob3N0cy5sZW5ndGh9IGhvc3RzKTsgY2hpbGRyZW4ga2VlcCBzaGFyaW5nLCBvcmNoZXN0cmF0b3IgZXhpdGluZ2ApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIC0tbG9vcCBtb2RlOiBzdGF5IGFsaXZlIGFuZCByZS1mYW4tb3V0IGV2ZXJ5IFNIQVJFX1JFU0NBTl9NUyBzb1xuICAvLyBuZXdseS1udWtlZCBob3N0cyBwaWNrIHVwIGEgc2hhcmUgY29weSB3aXRob3V0IG1hbnVhbCBpbnRlcnZlbnRpb24uXG4gIC8vIG5zLmV4ZWMgb24gYSBzZXJ2ZXIgdGhhdCBhbHJlYWR5IGhhcyBhIHNoYXJlIGNvcHkgaXMgYSBuby1vcFxuICAvLyAoU0tJUC1ydW5uaW5nKSwgc28gdGhpcyBpcyBzYWZlLiBVc2UgdGhpcyB3aGVuIGFjdGl2ZWx5IGdyaW5kaW5nXG4gIC8vIG5ldyBwb3J0cyDigJQgdGhlIGRlZmF1bHQgb25lLXNob3QgbW9kZSBpcyB3aGF0IHlvdSB3YW50IGZvciBzdGVhZHlcbiAgLy8gc3RhdGUuXG4gIGlmICh2ZXJib3NlKSBucy50cHJpbnQoYHNoYXJlOiAtLWxvb3AsIG91dHB1dD12ZXJib3NlLCByZXNjYW49JHtTSEFSRV9SRVNDQU5fTVN9bXNgKTtcbiAgbGV0IGxhc3RSZXNjYW4gPSBEYXRlLm5vdygpO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGF3YWl0IG5zLnNsZWVwKDYwXzAwMCk7XG4gICAgaWYgKERhdGUubm93KCkgLSBsYXN0UmVzY2FuID49IFNIQVJFX1JFU0NBTl9NUykge1xuICAgICAgY29uc3QgbmV4dCA9IGZpbmRTaGFyZUhvc3RzKG5zKTtcbiAgICAgIC8vIFJlc2V0IGNvdW50ZXJzIGZvciB0aGUgZGlmZiBwcmludDsgY3VtdWxhdGl2ZSBpc24ndCB1c2VmdWwgaGVyZS5cbiAgICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhjb3VudGVycykpIGNvdW50ZXJzW2tdID0gMDtcbiAgICAgIGZhbk91dChucywgbmV4dCwgY291bnRlcnMsIHsgdmVyYm9zZSB9KTtcbiAgICAgIGNvbnN0IGxvb3BTdW1tYXJ5ID0gT2JqZWN0LmVudHJpZXMoY291bnRlcnMpXG4gICAgICAgIC5maWx0ZXIoKFtfLCB2XSkgPT4gdiA+IDApXG4gICAgICAgIC5tYXAoKFtrLCB2XSkgPT4gYCR7a309JHt2fWApXG4gICAgICAgIC5qb2luKFwiIFwiKTtcbiAgICAgIGlmIChsb29wU3VtbWFyeSkge1xuICAgICAgICAvLyBJbiBxdWlldCBtb2RlLCBzdXBwcmVzcyB0aGUgcmUtc2NhbiBsaW5lIHdoZW4gbm8gbmV3IHNoYXJlXG4gICAgICAgIC8vIGNvcHkgd2FzIGFjdHVhbGx5IHNwYXduZWQgKFNIQVJFRD0wKS4gVGhlIFwiaW50ZXJlc3RpbmdcIlxuICAgICAgICAvLyBldmVudCBpcyBhIG5ldyBzaGFyZS5qcyBjaGlsZCBzdGFydGluZzsgU0tJUC9GQUlMIG9uXG4gICAgICAgIC8vIGFscmVhZHktcnVubmluZyBvciBSQU0tY29udGVuZGVkIGhvc3RzIGlzIG5vaXNlLiBJbiB2ZXJib3NlXG4gICAgICAgIC8vIG1vZGUsIHByaW50IHRoZSBzdW1tYXJ5IHJlZ2FyZGxlc3MuXG4gICAgICAgIGlmICh2ZXJib3NlIHx8IGNvdW50ZXJzLlNIQVJFRCA+IDApIHtcbiAgICAgICAgICBucy50cHJpbnQoYHNoYXJlOiByZS1zY2FuICR7bmV4dC5sZW5ndGh9IGhvc3Qocykg4oCUICR7bG9vcFN1bW1hcnl9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGxhc3RSZXNjYW4gPSBEYXRlLm5vdygpO1xuICAgIH1cbiAgfVxufVxuIl19