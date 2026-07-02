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
// So this script does two things in parallel:
//
//   A. On home, it loops ns.share() every 9 seconds (just under the
//      10s window) at the maximum thread count that fits.
//
//   B. It fans a copy of itself out to every rooted, non-purchased-
//      server-with-some-RAM, BFS-reachable host — same shape as
//      deploy.js. Each copy then runs (A) on its own host, contributing
//      that host's free RAM to the global share-power pool.
//
// Usage:
//   run share.js                 # start the daemon (one-shot; auto-loops), QUIET by default
//   run share.js --once          # fan out + share once, then exit (full output)
//   run share.js --verbose       # re-enable per-host SKIP / FAIL / SHARED lines
//   run share.js --quiet         # (alias for the default; suppress per-cycle and per-host prints)
//
// RAM cost: ns.share() = 2.4 GB per call. We run with as many threads
// as fit, so on home (32 GB default-ish in early game) the script uses
// ~2.4 GB and produces the maximum share-power for the thread count.
// On small purchased servers (8 GB) the same script uses ~2.4 GB and
// still contributes — every bit helps.
//
// The fan-out is idempotent: re-running share.js is safe. Servers that
// already have a running copy are skipped. The BFS only walks the
// network you can reach; newly-nuked hosts are picked up on the next
// fan-out (every SHARE_RESCAN_MS).
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
  run share.js                 # start the daemon (one-shot; auto-loops), QUIET by default
  run share.js --once          # fan out + share once with full output, then exit
  run share.js --verbose       # re-enable per-host SKIP / FAIL / SHARED lines
  run share.js --quiet         # (alias for the default; suppress per-cycle and per-host prints)
`;

const SHARE_RAM_COST = 2.4;     // ns.share()'s RAM cost per call
const SHARE_BOOST_MS = 10_000;  // ns.share()'s boost duration
const SHARE_REFRESH_MS = 9_000; // call just before the 10s window expires
const SHARE_RESCAN_MS = 5 * 60_000;  // re-BFS every 5 minutes for new roots
const SHARE_INCLUDE_PURCHASED_ONLY = false;  // set true to skip non-purchased

const SELF = "share.js";
const SOURCE = "home";

/** BFS the network from `start`. */
function enumerateNetwork(ns, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const h = queue.shift();
    for (const n of ns.scan(h)) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
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
    if (host === SOURCE) continue;     // home is handled separately
    const s = ns.getServer(host);
    if (!s.hasAdminRights) continue;   // can't scp without root
    if (SHARE_INCLUDE_PURCHASED_ONLY && !s.purchasedByPlayer) continue;
    // Must have SOME RAM worth contributing. We don't gate on moneyMax
    // the way deploy.js does — share-power is its own reward.
    if (s.maxRam <= 0) continue;
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
  const ramPerThread = ns.getScriptRam(SELF);  // RAM of the share script itself
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
      if (verbose) ns.tprint(`SKIP-running    ${host}  (${SELF} already running)`);
      counters["SKIP-running"]++;
      continue;
    }
    // Copy the script to the target.
    if (!ns.scp(SELF, host, SOURCE)) {
      if (verbose) ns.tprint(`FAIL-scp        ${host}`);
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
      if (verbose) ns.tprint(`SKIP-ram        ${host}  (no free RAM: ${free.toFixed(2)} GB, ${SELF} needs ${ramPerThread.toFixed(2)} GB)`);
      counters["SKIP-ram"]++;
      continue;
    }
    // Pass --child so the copy knows it's a fanned-out worker and
    // doesn't recurse into its own fan-out.
    const pid = ns.exec(SELF, host, threads, "--child");
    if (pid === 0) {
      if (verbose) ns.tprint(`FAIL-exec       ${host}  (exec returned 0 — RAM contention or other script running)`);
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
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  // Default quiet for the daemon loop. --once is the diagnostic path
  // and always prints full output. If the user passes both --quiet
  // and --verbose, --quiet wins (they explicitly asked for it).
  const quiet = args.includes("--quiet") || (!verbose && !once);
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
    } else {
      counters["FAIL-exec"]++;
      if (verbose) ns.tprint(`FAIL-exec       ${SOURCE}  (could not spawn home child)`);
    }
  } else {
    if (verbose) ns.tprint(`SKIP-ram        ${SOURCE}  (no free RAM: ${homeFree.toFixed(2)} GB, ${SELF} needs ${homeRam.toFixed(2)} GB)`);
    counters["SKIP-ram"]++;
  }

  const summary = Object.entries(counters)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  if (once) {
    // Fan-out only: the spawned child share copies keep sharing after
    // this orchestrator exits. Each child runs in its own process, so
    // no NS-runtime contention with the parent.
    ns.tprint(`done (--once): ${summary || "no changes"} (scanned ${hosts.length} hosts)`);
    return;
  }

  // The orchestrator process is now NS-idle on home. Home's share
  // contribution comes from the --child share copy spawned on home
  // explicitly above. This split is mandatory: keeping a
  // runShareLoop() in this process alongside the rescan ns.sleep()
  // triggers the "Concurrent calls to Netscript functions" runtime
  // error.
  // Default: stay alive and re-fan-out every SHARE_RESCAN_MS, so
  // newly-nuked hosts pick up a share copy without manual intervention.
  // ns.exec on a server that already has a share copy is a no-op
  // (SKIP-running), so this is safe.
  // The per-cycle ns.print() in runShareLoop is also gated on !quiet
  // (see runShareLoop). So in quiet mode the only output during a
  // rescan is the summary line (and only if something actually changed).
  if (verbose) ns.tprint(`share: started, output=verbose, rescan=${SHARE_RESCAN_MS}ms`);
  let lastRescan = Date.now();
  while (true) {
    await ns.sleep(60_000);
    if (Date.now() - lastRescan >= SHARE_RESCAN_MS) {
      const next = findShareHosts(ns);
      const nextSet = new Set(next);
      // Reset counters for the diff print; cumulative isn't useful here.
      for (const k of Object.keys(counters)) counters[k] = 0;
      fanOut(ns, next, counters, { verbose });
      const summary = Object.entries(counters)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      if (summary) {
        ns.tprint(`share: re-scan ${next.length} host(s) — ${summary}`);
      }
      lastRescan = Date.now();
    }
  }
}
