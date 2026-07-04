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
// Usage:
//   run deploy.js                            # default: hack-loop.js
//   run deploy.js worker.js                  # custom worker name
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
 run deploy.js --quiet               # suppress per-host DEPLOY/SKIP lines (used by monitor-deploy.js)
 run deploy.js --quiet worker.js     # custom worker + quiet
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
  // Filter --quiet out before treating ns.args[0] as the worker name.
  const filteredArgs = ns.args.filter((a) => a !== "--quiet");
  const worker = filteredArgs[0]?.toString() ?? "hack-loop.js";
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

  // Quiet-by-default: only DEPLOYED and FAIL-* events are
  // interesting per-host. SKIP-* events (rooted, hack, etc.) are
  // expected noise during a normal run — printing them per-host
  // floods the terminal. The final summary at the end aggregates
  // all counter values regardless, so the user still sees how
  // many hosts were skipped and why. DEPLOYED events are the
  // positive signal we want surfaced; everything else is silent
  // (matching manager.js's error-only print rule).
  const print = (line) => { if (!quiet) ns.tprint(line); };
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
