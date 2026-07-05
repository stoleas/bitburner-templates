/** @param {NS} ns */
//
// manager.js — centralized HWGW orchestrator (fleet-batcher edition).
//
// Runs forever on home. Every TICK_MS:
//
//   1. For each target in the top MAX_TARGETS pickTargets() returns,
//      call planBatch() to get the 4-job plan with timing offsets.
//
//   2. Check the 5% headroom rule: only fire the batch if its total
//      RAM fits in the fleet's free RAM with 5% headroom. If it
//      doesn't, SKIP-ram and try the next target (or wait a tick).
//
//   3. Fire the 4 jobs of the batch with their correct delays via
//      allocate() — the fleet-batcher spreads each job's threads
//      across home + pservs + rooted-world-servers so the whole
//      batch's RAM doesn't need to fit on any single host. The
//      per-job delays are computed against the batch's arrivalT
//      and the per-target stagger (ti * BATCH_INTERVAL_MS).
//
//   4. Multi-target staggering: each target's arrivalT is offset by
//      `ti * BATCH_INTERVAL_MS` so the regrow timers don't all
//      bunch on the same wall-clock moment.
//
//   5. The orchestrator's own RAM footprint is small (~5 GB for the
//      ns object + script RAM). It does NOT do any hacking itself —
//      the workers do.
//
//   6. Per-target cooldown: re-firing a target whose previous batch
//      is still in flight produces $0.000 hacks. Gate each tick's
//      planBatch() on a per-target lastFireMs + (weakenTime + 5s).
//
//   7. Recovery mode: when the per-batch weaken thread count is so
//      large it doesn't fit on a single host, planBatch returns a
//      1-job weaken-only plan sized to the largest free worker
//      (Pitfall 23: largest-fit, not smallest-fit). This drains drift
//      over a few cycles and the plan transitions back to normal
//      HWGW automatically.
//
//   8. Quiet by default — the per-tick summary only goes to the
//      terminal when an error fires. --verbose re-enables per-tick
//      detail to the in-game log file.
//
// Tuning:
//
//   MAX_TARGETS           — upper bound on the per-tick target list.
//                          9 is the recommended sweet spot; more
//                          than ~12 starts to fragment the cluster.
//   MONEY_FRACTION       — what % of moneyMax to steal per cycle.
//                          0.50 (50%) is the mid-game sweet spot:
//                          fewer batches per target means the
//                          per-target cooldown (see PER_TARGET_COOLDOWN_MS)
//                          is the dominant pacing constraint, not
//                          the orchestrator's own loop. Steal 25%
//                          for very fast-regrow servers, 75% for
//                          slow ones. Pre-cooldown the value was
//                          0.10 which produced 10 batches per
//                          drain and (because the manager re-fired
//                          the same target every 5s) overlap races
//                          where the new hack hit a target whose
//                          previous grow hadn't refilled it. That
//                          race is what made hack.js return $0.000
//                          on otherwise-sane targets.
//   TICK_MS              — main loop period. 5000 (5s) is the
//                          default; 1000 for high-throughput late
//                          game.
//   BATCH_INTERVAL_MS    — per-target stagger. Default 4000 (4s).
//                          Should be < (shortest weakenTime / 2).
//   COOLDOWN_BUFFER_MS   — safety buffer added on top of a target's
//                          weakenTime to derive the per-target
//                          cooldown. 5s covers worker overhead,
//                          ns.exec scheduling jitter, and a small
//                          margin for the regrow timer to start
//                          clean. The actual cooldown is per-target:
//                          weakenTime varies 5x across the network
//                          (fast servers ~10s, mid-game ~50-90s),
//                          so a fixed value would be wrong.
//
// Why the fleet (vs. single-host fit):
//
//   Before the fleet, every job in a 4-job batch had to fit on a
//   single host. For a typical BN1 mid-game target (phantasy, max-
//   hardware), the batch needs ~5,000 grow threads × 1.75 GB = 8.75
//   TB plus ~70,000 weaken × 1.75 GB = 122 TB. No single pserv (1
//   TB) or even home (1 TB) fits the 122 TB weaken. Result: home
//   hosts the entire batch, pservs sit idle, and 122 TB of fleet
//   capacity is wasted.
//
//   With the fleet, each job is bin-packed across home + every
//   pserv + every rooted world server (CSEC, foodnstuff, etc., ~50
//   GB total). The 122 TB weaken becomes "1,000 threads on home +
//   69,000 spread across 11 pservs" — trivially fits, the whole
//   cluster is engaged. This is the single biggest BN1 mid-game
//   performance change. Pattern sourced from
//   skeesler/bitburner-commander/fleet-batcher.js (public domain).
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
//   run manager.js --verbose    # per-tick detail in the in-game log
//
import {
  planBatch,
  listWorkers,
  findLargestWorkerWithRam,
  listReachableServers,
  // Fleet-batcher helpers — the new pattern that spreads one job's
  // threads across home + pservs + rooted-world-servers instead of
  // cramming it onto a single host. The 5% headroom rule (use
  // FLEET_HEADROOM_FRACTION, not 1.0) prevents partial placements.
  // (findWorkerWithRam is no longer used in normal-mode dispatch —
  // the fleet batcher replaces it — but kept exported from
  // lib/hwgw.js for any one-shot tool that still needs single-host
  // dispatch.)
  buildFleet,
  allocateBatch,
  fleetFree,
  shareRamCap,
  totalBatchRam,
  FLEET_DEFAULTS,
} from "/lib/hwgw.js";

const MAX_TARGETS = 9;
const MONEY_FRACTION = 0.50;
const TICK_MS = 5_000;
// Per-target stagger: each target's arrivalT is offset by
// ti * BATCH_INTERVAL_MS so the regrow timers don't all bunch
// on the same wall-clock moment. Should be much less than the
// shortest weakenTime; 4 seconds is safe.
const BATCH_INTERVAL_MS = 4_000;
// Safety buffer added on top of a target's weakenTime to derive
// the per-target cooldown. 5s covers worker overhead, ns.exec
// scheduling jitter, and a small margin for the regrow timer to
// start clean. The actual cooldown is per-target: weakenTime
// varies 5x across the network (fast servers ~10s, mid-game
// ~50-90s), so a fixed value would be wrong.
const COOLDOWN_BUFFER_MS = 5_000;

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

// Per-target cooldown tracker. Maps hostname → wall-clock ms of the
// last fully-launched batch against that target. We gate each tick's
// planBatch() on this so we never re-fire a target whose previous
// batch is still in flight. State is module-scoped: it survives
// across ticks but is wiped on manager restart (which is correct —
// after an aug, we WANT a fresh cycle).
//
// Set is keyed by hostname, not by some derived id, because pickTargets
// gives us hostnames directly and there's no ambiguity.
//
// We use a Map (not a plain object) because Maps preserve insertion
// order, which makes the per-tick debug log slightly more readable
// when we eventually surface it. (We don't today, but it's free.)
const lastFireMs = new Map();

// Set of targets currently in recovery mode (i.e. planBatch returned
// recoveryMode: true for them on the most recent firing). Used to
// surface enter/leave transitions to the user via tprint. Survives
// across ticks (parallel to lastFireMs) and is wiped on manager
// restart, which is correct.
const recovering = new Set();

export async function main(ns) {
  ns.disableLog("sleep");
  // getServerMaxRam and getServerUsedRam are called for EVERY
  // worker in listWorkers() on EVERY batch dispatch (smallest-fit
  // load-balancing — see lib/hwgw.js). With 19 workers and 4 jobs
  // per batch, that's 19*2*4 = 152 log lines per tick, drowning out
  // the per-tick summary and the (--verbose) cooldown detail. The
  // values are static (max) and easily-readable (used), so disabling
  // the log is safe and the right move.
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");
  // ns.scan() is called by listReachableServers() in pickTargets()
  // — once per reachable server, per tick. With ~50 reachable
  // servers, that's 50 `scan: returned N connections` lines per
  // tick, drowning the terminal. The return value is structural
  // (used for BFS), not interesting to the user.
  ns.disableLog("scan");
  // Manager is auto-quiet by default — it runs every 60s and the
  // per-tick summary only goes to the terminal when something
  // interesting happened (a batch launched, or the target list
  // became empty). For first-time setup or debugging, run with
  // --verbose to see every tick.
  const verbose = ns.args.includes("--verbose");
  if (verbose) {
    ns.tprint(`manager: started, MAX_TARGETS=${MAX_TARGETS} tick=${TICK_MS}ms, output=verbose`);
  }

  while (true) {
    const tickStart = Date.now();
    const counters = { planned: 0, launched: 0, "SKIP-ram": 0, "SKIP-root": 0, "SKIP-level": 0, "SKIP-mp": 0, "SKIP-cooldown": 0, "recovery-firing": 0, "enter-recovery": 0, "leave-recovery": 0, "FAIL-exec": 0 };
    const targets = pickTargets(ns);
    const cooldownRemaining = new Map();  // for --verbose: how many ms until each target is eligible

    // Build the fleet ONCE per tick and share it across all targets.
    // The fleet (home + pservs + rooted-world-servers) is the
    // worker pool for normal-mode batches. It's rebuilt per-job
    // inside the per-target loop (Pitfall 6: stale worker lists
    // produce FAIL-exec after sleeps), but the initial build here
    // gives us the per-tick "fleetFree()" number for the 5%
    // headroom gate.
    //
    // The fleet is sized off the CURRENT RAM state. As workers
    // are placed, the fleet's free RAM shrinks. The per-job
    // buildFleet() inside the loop reads the latest values.
    const fleet = buildFleet(ns);

    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      const s = ns.getServer(target);
      // pickTargets() already filtered, but be defensive — the
      // world can change between ticks.
      if (!s.hasAdminRights) { counters["SKIP-root"]++; continue; }
      if (s.requiredHackingSkill > ns.getPlayer().skills.hacking) { counters["SKIP-level"]++; continue; }
      if (!s.moneyMax || s.moneyMax <= 0) { counters["SKIP-mp"]++; continue; }

      // Per-target cooldown: if we fired a batch against this
      // target less than (weakenTime + buffer) ago, skip. The
      // previous batch's weaken hasn't landed yet, so security
      // is still above min and moneyAvailable is mid-regrow.
      // Firing now means: hack.js gets $0 (the regrow is partial),
      // the batch's planBatch is sized off stale server state, and
      // the cluster burns threads for nothing.
      //
      // The cooldown is per-target because weakenTime varies 5-10x
      // across the network. A single fixed cooldown would either
      // be too short for the slow targets or waste cycles on the
      // fast ones.
      //
      // We read the target's weakenTime from the server object
      // directly (no need to call planBatch for the gate). If we
      // can't read it (target disappeared between pickTargets and
      // here), treat as on-cooldown — better safe than racing
      // against a server we can't introspect.
      let cooldownMs;
      try {
        cooldownMs = ns.getWeakenTime(target) + COOLDOWN_BUFFER_MS;
      } catch (e) {
        counters["SKIP-cooldown"]++;
        continue;
      }
      const lastFire = lastFireMs.get(target);
      if (typeof lastFire === "number") {
        const elapsed = Date.now() - lastFire;
        if (elapsed < cooldownMs) {
          counters["SKIP-cooldown"]++;
          if (verbose) cooldownRemaining.set(target, Math.round((cooldownMs - elapsed) / 1000));
          continue;
        }
      }

      let plan;
      try {
        plan = planBatch(ns, target, { moneyFraction: MONEY_FRACTION });
      } catch (e) {
        // Surface planBatch failures to the terminal so the user
        // can see WHY batches aren't launching. Without this,
        // the per-tick summary prints "(no changes)" and the
        // error is buried in the in-game log.
        //
        // Bitburner 3.x sometimes throws non-Error values where
        // .message is undefined. We coerce safely:
        //   - Error instance:  use e.message
        //   - string/number:   use String(e)
        //   - null/undefined:  use "threw: <value>"
        //   - object:          JSON.stringify the value (truncated)
        let what;
        if (e == null) {
          what = `threw: ${e}`;  // literally "threw: null" or "threw: undefined"
        } else if (typeof e === "object" && e.message) {
          what = e.message;
        } else if (typeof e === "object") {
          try { what = `threw object: ${JSON.stringify(e).slice(0, 200)}`; }
          catch { what = `threw object: <not serializable>`; }
        } else {
          what = String(e);
        }
        // If we have server state, surface it inline so the user
        // doesn't have to grep through logs to understand the
        // context. This is the most useful piece of info.
        let ctx = "";
        try {
          const ss = ns.getServer(target);
          ctx = ` [moneyMax=${ss.moneyMax} moneyAvailable=${ss.moneyAvailable} ` +
                `minSec=${ss.minDifficulty} curSec=${ss.hackDifficulty} ` +
                `reqHack=${ss.requiredHackingSkill} hasRoot=${ss.hasAdminRights}]`;
        } catch { /* ignore */ }
        counters["FAIL-plan"] = (counters["FAIL-plan"] || 0) + 1;
        ns.tprint(`manager: planBatch(${target}) failed: ${what}${ctx}`);
        continue;
      }
      counters.planned++;

      // Stagger the arrival by ti * BATCH_INTERVAL_MS so targets
      // don't all regrow at the same instant.
      const targetOffset = ti * BATCH_INTERVAL_MS;
      // Count how many of this target's 4 jobs successfully
      // launched. Only record lastFireMs[target] if ALL 4 made it
      // — a partial batch (e.g. hack launched but weaken SKIP-ram'd)
      // leaves the target in an inconsistent state and we should
      // NOT push the cooldown forward, because the next tick's
      // planBatch will see the partial-state and re-fire
      // immediately to clean up. Recording a cooldown on a
      // partial batch would mean the partial state lingers for
      // a full weakenTime before re-attempt.
      //
      // EXCEPTION: in recovery mode, the plan has 1 job (weaken
      // only). batchLaunched === 1 === plan.jobs.length works the
      // same way. The cooldown still applies so we don't re-fire
      // the recovery weaken too soon.
      //
      // For normal-mode batches, batchLaunched === 4 (one per job).
      // The fleet-batcher pattern (allocateBatch) places threads
      // across home + pservs + rooted-worlds; the "count" is the
      // per-job placed count, summed up. If any job is partial,
      // we treat the whole batch as failed.
      let batchLaunched = 0;

      // Track recovery state per target. We only tprint on
      // transitions (entering or leaving recovery mode) so the
      // user sees "iron-gym: now in recovery (drift=620, 2-3
      // batches to clear)" once, then nothing until it transitions
      // back to normal HWGW. The current state is also visible in
      // the per-tick summary if --verbose is set.
      if (plan.recoveryMode) {
        counters["recovery-firing"]++;
        if (!recovering.has(target)) {
          counters["enter-recovery"]++;
          recovering.add(target);
          // Silent — recovery transitions are now "working as
          // expected" events. The recovery state is observable
          // in the counters (which surface as part of the
          // error-only tprint above when something else goes
          // wrong) and in the per-tick ns.print (verbose mode).
        }
      } else if (recovering.has(target)) {
        counters["leave-recovery"]++;
        recovering.delete(target);
        // Silent — same reasoning as enter-recovery above.
      }

      // ----------------------------------------------------------------
      // Dispatch: split per branch.
      //
      // Normal mode → fleet-batcher (allocateBatch). The fleet
      // is built once per tick (above the targets loop) and shared
      // across all targets. Each job's threads are bin-packed
      // across the whole cluster. The 5% headroom rule (gate
      // below) prevents partial placements.
      //
      // Recovery mode → single-host largest-fit
      // (findLargestWorkerWithRam). Recovery is weaken-only with
      // a thread count that fits the largest free worker; the
      // point is to drain drift as fast as possible, NOT to
      // spread across the fleet. Spreading a 8000-thread weaken
      // across 11 pservs would put 727 threads on each 1 TB
      // pserv, but the cluster could fit a single 8000-thread
      // weaken on home (1+ TB free), draining 8× the drift per
      // batch. See Pitfall 23.
      // ----------------------------------------------------------------
      if (plan.recoveryMode) {
        // Recovery: same single-host-largest-fit logic as before.
        // Sleep the full jobDelay (no Math.min cap) so the
        // recovery weaken lands at its planned time, even on
        // slow targets (weakenTime up to 90s + the targetOffset
        // stagger). The Math.min cap was the Pitfall 1 bug.
        const job = plan.jobs[0];
        const jobDelay = job.delayMs + targetOffset;
        if (jobDelay > 0) {
          await ns.sleep(jobDelay);
        }
        const workers = listWorkers(ns);
        const ramPerThread = ns.getScriptRam(job.script, "home");
        const need = job.threads * ramPerThread;
        const w = findLargestWorkerWithRam(ns, workers, need);
        if (!w) { counters["SKIP-ram"]++; continue; }
        const pid = ns.exec(job.script, w, job.threads, target);
        if (pid === 0) { counters["FAIL-exec"]++; continue; }
        counters.launched++;
        batchLaunched = 1;
        if (verbose) {
          ns.print(`manager: RECOVERY ${job.script} → ${w} target=${target} threads=${job.threads} delay=${jobDelay}ms`);
        }
      } else {
        // Normal mode: 5% headroom gate. The fleet-batcher
        // *will* partially place a batch that's too big, leaving
        // a partial hack without a matching grow — the target
        // would drain to $0 and never refill. The gate rejects
        // any batch whose total RAM doesn't fit in the fleet's
        // 95% free window, so partial placements never happen
        // in practice. (Sourced from skeesler/bitburner-commander.)
        const batchRam = totalBatchRam(ns, plan);
        const free = fleetFree(ns, fleet);
        if (batchRam > free * FLEET_DEFAULTS.FLEET_HEADROOM_FRACTION) {
          // The batch would partial-place. SKIP-ram and let the
          // next tick try again (the fleet may have more free
          // RAM after the previous tick's workers returned).
          counters["SKIP-ram"]++;
          if (verbose) {
            ns.print(`manager: SKIP-fleet-fit target=${target} batch=${batchRam.toFixed(0)}GB fleetFree=${free.toFixed(0)}GB`);
          }
          continue;
        }
        // Per-target share cap (MAX_FLEET_SHARE = 1/3): no single
        // target can claim more than 1/3 of the fleet's total
        // capacity for one batch. Without this gate, the top-
        // ranked target by moneyMax (phantasy) consumes the whole
        // cluster on every tick and targets #2..#9 starve. The
        // cap is evaluated against the BATCH (4 jobs summed),
        // not per-job — a single big weaken is fine as long as
        // the total batch stays under the share. Sourced from
        // skeesler/bitburner-commander.
        const shareCap = shareRamCap(ns, fleet);
        if (batchRam > shareCap) {
          counters["SKIP-share"] = (counters["SKIP-share"] || 0) + 1;
          if (verbose) {
            ns.print(`manager: SKIP-share target=${target} batch=${batchRam.toFixed(0)}GB cap=${shareCap.toFixed(0)}GB (MAX_FLEET_SHARE=${FLEET_DEFAULTS.MAX_FLEET_SHARE})`);
          }
          continue;
        }
        // Fire the 4 jobs back-to-back via the fleet. Per-job
        // sleeps are computed inside allocateBatch (it adds
        // targetOffset to each job's delayMs) — actually no,
        // allocateBatch does NOT sleep; it just calls ns.exec
        // for each job in order. The sleeps are done HERE so the
        // timing invariant ("all 4 jobs land at arrivalT") is
        // preserved. Sleep the FULL jobDelay (no Math.min cap,
        // the Pitfall 1 fix).
        for (const job of plan.jobs) {
          const jobDelay = job.delayMs + targetOffset;
          if (jobDelay > 0) {
            await ns.sleep(jobDelay);
          }
          // Recheck fleet right before exec (Pitfall 6: stale
          // worker list → stale "yes this has room" answers).
          // We rebuild the fleet rather than relying on the
          // cached one from the top of the tick — another
          // monitor may have claimed RAM during our sleeps.
          const freshFleet = buildFleet(ns);
          const placed = allocateBatch(
            ns, freshFleet,
            // Wrap the single job in a 1-element plan so we can
            // reuse allocateBatch's logic. (allocateBatch fires
            // all 4 jobs in one call; we use it per-job here
            // so the per-job sleep lands at the right moment.)
            { jobs: [job], totalRam: job.threads * ns.getScriptRam(job.script, "home") },
            target, 0 /* targetOffset already in jobDelay */,
            Date.now(),  // id = wall-clock ms; distinguishes this batch from previous
            verbose
          );
          if (placed.minPlaced < job.threads) {
            // Partial placement (shouldn't happen with the 5%
            // gate above, but defensive).
            const short = job.threads - placed.minPlaced;
            counters["SKIP-ram"] += short;
            if (verbose) {
              ns.print(`manager: SKIP-fleet-partial target=${target} ${job.script} placed=${placed.minPlaced}/${job.threads}`);
            }
            continue;
          }
          counters.launched++;
          batchLaunched++;
          if (verbose) {
            ns.print(`manager: ${job.script} → fleet target=${target} threads=${job.threads} delay=${jobDelay}ms`);
          }
        }
      }

      // Only stamp the cooldown if the full batch landed.
      // See comment above the batchLaunched declaration for why
      // a partial batch is treated as "no batch happened".
      if (batchLaunched === plan.jobs.length) {
        lastFireMs.set(target, Date.now());
      }
    }

    const summary = Object.entries(counters)
      .filter(([_, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const elapsed = Date.now() - tickStart;
    // Cooldown detail string for --verbose. Lists which targets
    // we skipped this tick because they're still on cooldown,
    // and how many seconds remain before each becomes eligible.
    // Cheap to compute (already in the Map from the loop), and
    // it's the only way to verify the cooldown is actually doing
    // its job without watching the wallet.
    const cdDetail = verbose && cooldownRemaining.size > 0
      ? ` cooldowns=[${[...cooldownRemaining.entries()].map(([t, s]) => `${t}:${s}s`).join(",")}]`
      : "";
    // Per-tick log line: only under --verbose, since this
    // shows in the in-game terminal tail. The user wants the
    // terminal to be silent when everything is working. The
    // error-only tprint below handles the error case. Under
    // --verbose, this line shows the full per-tick detail
    // (counters, cooldowns) for debugging.
    if (verbose) {
      ns.print(`manager: tick ${(elapsed / 1000).toFixed(1)}s targets=[${targets.join(",")}] ${summary || "(no changes)"}${cdDetail}`);
    }
    // Decide whether to surface this tick to the terminal.
    //
    // Quiet-by-default with the strictest rule: ONLY print on
    // errors. Normal launches, recovery transitions, and
    // SKIP-cooldown/SKIP-ram are all silent. The user wants
    // the terminal to reflect "everything is working as
    // expected" by being completely empty during normal
    // operation. Anything printed is a problem worth seeing.
    //
    // What counts as an error worth printing:
    //   - FAIL-exec > 0   (ns.exec returned 0 — script missing
    //                       on the target host, or RAM race)
    //   - SKIP-ram > 0    (recovery or normal batch couldn't
    //                       find a worker with enough free RAM)
    //   - SKIP-level > 0  (target's hack level too high — should
    //                       not happen at this point, but a signal
    //                       that pickTargets() is broken)
    //   - SKIP-mp > 0     (target's money < min threshold — also
    //                       unexpected, indicates a math bug)
    //   - SKIP-root > 0   (target not rooted — nuke monitor is
    //                       broken or hasn't caught up)
    //
    // What is NOT printed (silent, working as expected):
    //   - launched > 0                (a batch fired successfully)
    //   - enter-recovery > 0          (target entered recovery)
    //   - leave-recovery > 0          (target left recovery)
    //   - SKIP-cooldown > 0           (target still on cooldown)
    //   - SKIP-ram > 0                (cluster has no room for the
    //                                  planned batch — happens
    //                                  every tick during recovery
    //                                  mode when the first batch
    //                                  consumes all the free RAM.
    //                                  Working as expected. The
    //                                  user explicitly does not
    //                                  want to see this.)
    //   - SKIP-level > 0              (would be a real bug, but
    //                                  doesn't fire in practice)
    //   - SKIP-mp > 0                 (would be a real bug, but
    //                                  doesn't fire in practice)
    //   - SKIP-root > 0               (target not rooted yet —
    //                                  nuke.js is handling it)
    //   - planned > 0                 (we planned a batch)
    //
    // Only print on actual exec failures (FAIL-exec) — those
    // indicate a real problem (script missing on host, RAM race
    // caught by the runtime, etc.) that the user needs to see.
    //
    // For per-tick visibility into the working-as-expected case,
    // use `run manager.js --verbose` which ns.prints every tick
    // to the in-game log file. The terminal stays clean.
    if (counters["FAIL-exec"] > 0) {
      ns.tprint(`manager: targets=[${targets.join(",") || "(empty)"}] ${summary || "(no summary)"}`);
    }

    // Wait until the next tick boundary. We've already burned some
    // time on per-job sleeps, so the residual is small.
    const residual = TICK_MS - (Date.now() - tickStart);
    if (residual > 0) await ns.sleep(residual);
  }
}
