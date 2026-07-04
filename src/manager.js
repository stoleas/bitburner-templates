/** @param {NS} ns */
//
// manager.js — centralized HWGW orchestrator.
//
// Runs forever on home. Every TICK_MS:
//
//   1. For each target in TARGETS (in order), call planBatch() to get
//      the 4-job plan with timing offsets.
//
//   2. For each of the 4 jobs, find a worker with enough free RAM via
//      findWorkerWithRam() and ns.exec() the corresponding single-op
//      script with the right thread count and delay. Skip the job if
//      no worker has room (we'll retry next tick).
//
//   3. Multi-target staggering: each target's arrivalT is offset by
//      `target_index * batchInterval` so the regrow timers don't all
//      bunch on the same wall-clock moment.
//
//   4. The orchestrator's own RAM footprint is small (~5 GB for the
//      ns object + script RAM). It does NOT do any hacking itself —
//      the workers do.
//
// Tuning:
//
//   MAX_TARGETS           — upper bound on the per-tick target list.
//                          9 is the recommended sweet spot; more
//                          than ~12 starts to fragment the cluster.
//   MONEY_FRACTION       — what % of moneyMax to steal per cycle.
//                          0.10 (10%) is the sweet spot for most
//                          targets; raise to 0.25 for fast-regrow
//                          servers, lower to 0.05 for slow ones.
//   TICK_MS              — main loop period. 5000 (5s) is the
//                          default; 1000 for high-throughput late
//                          game.
//   BATCH_INTERVAL_MS    — per-target stagger. Default 4000 (4s).
//                          Should be < (shortest weakenTime / 2).
//
// Target selection: the manager dynamically picks MAX_TARGETS servers
// per tick rather than using a hardcoded list. The selection rule:
//
//   1. BFS the network from home (excludes home and pserv-*).
//   2. Filter to: hasAdminRights && moneyMax > 0 &&
//      requiredHackingSkill <= myHack.
//   3. Sort by moneyMax descending.
//   4. Take the top MAX_TARGETS.
//
// This auto-adapts as new servers get nuked, hack level climbs, and
// pservs land. The previous hardcoded list of mid-game servers
// (phantasy, omega-net, etc.) was useless early-game when most of
// them were SKIP-root or SKIP-level, and the manager had nothing
// to do on small servers like n00dles/foodnstuff that it should
// also be draining.
//
// Usage:
//   run manager.js
//
import { planBatch, listWorkers, findWorkerWithRam } from "/lib/hwgw.js";

const MAX_TARGETS = 9;
const MONEY_FRACTION = 0.10;
const TICK_MS = 5_000;
// Per-target stagger: each target's arrivalT is offset by
// ti * BATCH_INTERVAL_MS so the regrow timers don't all bunch
// on the same wall-clock moment. Should be much less than the
// shortest weakenTime; 4 seconds is safe.
const BATCH_INTERVAL_MS = 4_000;

// BFS the network from home. Returns the sorted list of all
// reachable hostnames (excluding home). Used by pickTargets() to
// enumerate candidates. We scan every tick because newly-nuked
// servers should become available immediately.
function listReachableServers(ns) {
  const SOURCE = "home";
  const seen = new Set([SOURCE]);
  const queue = [SOURCE];
  while (queue.length > 0) {
    const h = queue.shift();
    for (const n of ns.scan(h)) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return [...seen].filter((h) => h !== SOURCE).sort();
}

// Pick the top MAX_TARGETS servers we can actually batch: rooted,
// have money, and within hack level. Sorted by moneyMax descending
// so the biggest servers get first dibs on the cluster. Purchased
// servers (pserv-*) are excluded — they have no money to steal.
function pickTargets(ns) {
  const me = ns.getPlayer();
  const myHack = me.skills.hacking;
  const candidates = [];
  for (const host of listReachableServers(ns)) {
    const s = ns.getServer(host);
    if (s.purchasedByPlayer) continue;
    if (!s.hasAdminRights) continue;
    if (!s.moneyMax || s.moneyMax <= 0) continue;
    if (s.requiredHackingSkill > myHack) continue;
    candidates.push({ host, moneyMax: s.moneyMax });
  }
  candidates.sort((a, b) => b.moneyMax - a.moneyMax);
  return candidates.slice(0, MAX_TARGETS).map((c) => c.host);
}

export async function main(ns) {
  ns.disableLog("sleep");
  ns.tprint(`manager: started, MAX_TARGETS=${MAX_TARGETS} tick=${TICK_MS}ms`);

  while (true) {
    const tickStart = Date.now();
    const counters = { planned: 0, launched: 0, "SKIP-ram": 0, "SKIP-root": 0, "SKIP-level": 0, "SKIP-mp": 0, "FAIL-exec": 0 };
    const targets = pickTargets(ns);

    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      const s = ns.getServer(target);
      // pickTargets() already filtered, but be defensive — the
      // world can change between ticks.
      if (!s.hasAdminRights) { counters["SKIP-root"]++; continue; }
      if (s.requiredHackingSkill > ns.getPlayer().skills.hacking) { counters["SKIP-level"]++; continue; }
      if (!s.moneyMax || s.moneyMax <= 0) { counters["SKIP-mp"]++; continue; }

      let plan;
      try {
        plan = planBatch(ns, target, { moneyFraction: MONEY_FRACTION });
      } catch (e) {
        ns.print(`manager: planBatch(${target}) failed: ${e.message}`);
        continue;
      }
      counters.planned++;

      // Stagger the arrival by ti * BATCH_INTERVAL_MS so targets
      // don't all regrow at the same instant.
      const targetOffset = ti * BATCH_INTERVAL_MS;

      for (const job of plan.jobs) {
        const jobDelay = job.delayMs + targetOffset;
        // Sleep until it's time to launch THIS job. We cap the
        // sleep at TICK_MS so we always re-check the world state
        // at the next tick boundary.
        if (jobDelay > 0) {
          await ns.sleep(Math.min(jobDelay, TICK_MS));
        }
        // Recheck workers after sleep (state may have changed).
        const workers = listWorkers(ns);
        const ramPerThread = ns.getScriptRam(job.script, "home");
        const need = job.threads * ramPerThread;
        const w = findWorkerWithRam(ns, workers, need);
        if (!w) { counters["SKIP-ram"]++; continue; }
        const pid = ns.exec(job.script, w, job.threads, target);
        if (pid === 0) { counters["FAIL-exec"]++; continue; }
        counters.launched++;
        ns.print(`manager: ${job.script} → ${w} target=${target} threads=${job.threads} delay=${jobDelay}ms`);
      }
    }

    const summary = Object.entries(counters)
      .filter(([_, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const elapsed = Date.now() - tickStart;
    ns.print(`manager: tick ${(elapsed / 1000).toFixed(1)}s targets=[${targets.join(",")}] ${summary || "(no changes)"}`);

    // Wait until the next tick boundary. We've already burned some
    // time on per-job sleeps, so the residual is small.
    const residual = TICK_MS - (Date.now() - tickStart);
    if (residual > 0) await ns.sleep(residual);
  }
}
