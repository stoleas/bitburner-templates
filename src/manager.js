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
//   TARGETS              — hardcoded target list. Add/remove freely;
//                          the orchestrator auto-skips servers it
//                          can't root or can't afford to batch.
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
// Usage:
//   run manager.js
//
import { planBatch, listWorkers, findWorkerWithRam } from "/lib/hwgw.js";

const TARGETS = [
  "phantasy",
  "omega-net",
  "max-hardware",
  "silver-helix",
  "netlink",
  "computek",
  "rho-construction",
  "catalyst",
  "I.I.I.I",
];

const MONEY_FRACTION = 0.10;
const TICK_MS = 5_000;
// Per-target stagger: each target's arrivalT is offset by
// ti * BATCH_INTERVAL_MS so the regrow timers don't all bunch
// on the same wall-clock moment. Should be much less than the
// shortest weakenTime; 4 seconds is safe.
const BATCH_INTERVAL_MS = 4_000;

export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");
  ns.tprint(`manager: started, targets=[${TARGETS.join(",")}] tick=${TICK_MS}ms`);

  while (true) {
    const tickStart = Date.now();
    const counters = { planned: 0, launched: 0, "SKIP-ram": 0, "SKIP-root": 0, "SKIP-level": 0, "SKIP-mp": 0, "FAIL-exec": 0 };

    for (let ti = 0; ti < TARGETS.length; ti++) {
      const target = TARGETS[ti];
      const s = ns.getServer(target);
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
    ns.print(`manager: tick ${(elapsed / 1000).toFixed(1)}s ${summary || "(no changes)"}`);

    // Wait until the next tick boundary. We've already burned some
    // time on per-job sleeps, so the residual is small.
    const residual = TICK_MS - (Date.now() - tickStart);
    if (residual > 0) await ns.sleep(residual);
  }
}
