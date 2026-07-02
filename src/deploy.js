/** @param {NS} ns */
//
// Deploy the worker script to every rooted, in-level target server and
// run it with the maximum thread count that fits. This is the early-game
// "fan out" pattern from the Beginners Guide: instead of one script on
// home hacking n00dles, we put N copies of the script on N target
// servers so the work actually scales.
//
// Usage:
//   run deploy.js                            # default: n00dles.js as worker
//   run deploy.js worker.js                  # custom worker name
//
// Worker contract: the worker takes a target hostname as its first arg
// and runs the H/G/W loop against that target. n00dles.js already does
// this; any script with the same shape will work.
//
// Every reachable server gets one status line so silent filters
// (no-root, under-levelled, no-RAM, already-running) become visible —
// no more "where is CSEC?".
//
export async function main(ns) {
  const worker = ns.args[0]?.toString() ?? "n00dles.js";
  const SOURCE = "home";

  const me = ns.getPlayer();
  const myHack = me.skills.hacking;

  // BFS the network from home
  const seen = new Set([SOURCE]);
  const queue = [SOURCE];
  while (queue.length > 0) {
    const host = queue.shift();
    for (const n of ns.scan(host)) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }

  // Make sure the worker script exists on home so we can scp it.
  if (!ns.fileExists(worker, SOURCE)) {
    ns.tprint(`ERROR: ${worker} not on ${SOURCE}. Push it via filesync first.`);
    return;
  }

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
      ns.tprint(`SKIP-self  ${host}`);
      counters["SKIP-self"]++;
      continue;
    }

    const s = ns.getServer(host);

    // Skip purchased servers — they have no money to hack. Run
    // deploy-share.js to put share.js on them instead.
    if (s.purchasedByPlayer) {
      ns.tprint(`SKIP-purchased  ${host}  (run deploy-share.js to put share.js here)`);
      counters["SKIP-purchased"]++;
      continue;
    }

    // Check root BEFORE money: getServer() hides moneyMax on unrooted
    // hosts, so an unrooted server with $0 would otherwise look like a
    // nomoney server and get the wrong status line.
    if (!s.hasAdminRights) {
      const req = ns.getServerNumPortsRequired(host);
      const reqHack = ns.getServerRequiredHackingLevel(host);
      ns.tprint(`SKIP-rooted     ${host}  (need ${req} port-opener, hack ${reqHack}/${myHack})`);
      counters["SKIP-rooted"]++;
      continue;
    }

    if (!s.moneyMax || s.moneyMax <= 0) {
      ns.tprint(`SKIP-nomoney    ${host}  (moneyMax=0 — faction/backdoor server, no cash to steal)`);
      counters["SKIP-nomoney"]++;
      continue;
    }

    if ((s.requiredHackingSkill ?? 0) > myHack) {
      ns.tprint(`SKIP-hack       ${host}  (need hack ${s.requiredHackingSkill}, have ${myHack})`);
      counters["SKIP-hack"]++;
      continue;
    }

    // If a copy of the worker is already running on the host, leave it
    // alone. This makes deploy.js safe to re-run.
    if (ns.ps(host).some((p) => p.filename === worker)) {
      ns.tprint(`SKIP-running    ${host}  (${worker} already running)`);
      counters["SKIP-running"]++;
      continue;
    }

    // Copy the worker script to the target.
    if (!ns.scp(worker, host, SOURCE)) {
      ns.tprint(`FAIL-scp        ${host}`);
      counters["FAIL-scp"]++;
      continue;
    }

    // Run with max threads. RAM/threads formula per the docs.
    const ramPerThread = ns.getScriptRam(worker, host);
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    const threads = Math.max(1, Math.floor(free / ramPerThread));

    if (threads < 1 || ramPerThread <= 0) {
      ns.tprint(`SKIP-ram        ${host}  (no free RAM: ${free.toFixed(2)} GB, ${worker} needs ${ramPerThread.toFixed(2)} GB)`);
      counters["SKIP-ram"]++;
      continue;
    }

    // The worker takes a target as its first arg. We pass the host
    // itself so the worker hacks its own server — that's the simplest
    // and the guide's recommended pattern. You can change this to a
    // single hardcoded target if you want a "swarm" all hitting one.
    const pid = ns.exec(worker, host, threads, host);
    if (pid === 0) {
      ns.tprint(`FAIL-exec       ${host}  (exec returned 0 — RAM contention or other script running)`);
      counters["FAIL-exec"]++;
      continue;
    }

    ns.tprint(`DEPLOYED        ${host}  ${worker} x${threads} (pid ${pid})`);
    counters["DEPLOYED"]++;
  }

  // Summary line — easier than scanning the block.
  const summary = Object.entries(counters)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  ns.tprint(`done: ${summary} (scanned ${hosts.length} hosts)`);
  // Auto-restart every 5 minutes so newly-nuked servers get workers too.
  // ns.exec(...) on a server that already has the worker running is
  // skipped by the check above, so this is safe.
  await ns.sleep(5 * 60 * 1000);
}
