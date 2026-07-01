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
export async function main(ns) {
  const worker = ns.args[0]?.toString() ?? "n00dles.js";
  const SOURCE = "home";

  // Hosts the worker will try to run on. We pass each rooted target as
  // the *arg* to the worker, but the script itself runs on the target
  // server (so its RAM costs come from the target's RAM, not home's).
  // This is the key insight: home just orchestrates; the work happens
  // on the targets, which have 16-32 GB each.
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

  // Filter to rooted, money-bearing, in-hack-range targets.
  // Skip home and any player-owned server (we don't want to deploy to
  // a server we paid for with a different purpose).
  const targets = [];
  for (const host of seen) {
    if (host === SOURCE) continue;
    const s = ns.getServer(host);
    if (!s.hasAdminRights) continue;
    if (s.purchasedByPlayer) continue;
    if (!s.moneyMax || s.moneyMax <= 0) continue;
    if ((s.requiredHackingSkill ?? 0) > myHack) continue;
    targets.push(host);
  }

  // Make sure the worker script exists on home so we can scp it.
  if (!ns.fileExists(worker, SOURCE)) {
    ns.tprint(`ERROR: ${worker} not on ${SOURCE}. Push it via filesync first.`);
    return;
  }

  let deployed = 0;
  let skipped = 0;
  for (const host of targets) {
    // If a copy of the worker is already running on the host, leave it
    // alone. This makes deploy.js safe to re-run.
    const running = ns.ps(host).some((p) => p.filename === worker);
    if (running) {
      ns.tprint(`SKIP ${host} (${worker} already running)`);
      skipped++;
      continue;
    }

    // Copy the worker script to the target.
    if (!ns.scp(worker, host, SOURCE)) {
      ns.tprint(`FAIL  ${host} (scp failed)`);
      continue;
    }

    // Run with max threads. RAM/threads formula per the docs.
    const ramPerThread = ns.getScriptRam(worker, host);
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    const threads = Math.max(1, Math.floor(free / ramPerThread));

    if (threads < 1) {
      ns.tprint(`FAIL  ${host} (no free RAM: ${free.toFixed(2)} GB)`);
      continue;
    }

    // The worker takes a target as its first arg. We pass the host
    // itself so the worker hacks its own server — that's the simplest
    // and the guide's recommended pattern. You can change this to a
    // single hardcoded target if you want a "swarm" all hitting one.
    const pid = ns.exec(worker, host, threads, host);
    if (pid === 0) {
      ns.tprint(`FAIL  ${host} (exec returned 0)`);
      continue;
    }

    ns.tprint(`OK    ${host}: ${worker} x${threads} (pid ${pid})`);
    deployed++;
  }

  ns.tprint(`done: deployed=${deployed} skipped=${skipped} targets=${targets.length}`);
  // Auto-restart every 5 minutes so newly-nuked servers get workers too.
  // ns.exec(...) on a server that already has the worker running is
  // skipped by the check above, so this is safe.
  await ns.sleep(5 * 60 * 1000);
}
