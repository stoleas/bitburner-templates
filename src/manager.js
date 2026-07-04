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
//   PER_TARGET_COOLDOWN_MS — minimum time between batch launches
//                          against the same target. Default is
//                          the target's own weakenTime + 5s
//                          buffer, so the previous batch has
//                          fully landed (hack/grow/weaken all
//                          returned and security is back at min)
//                          before the next one fires. This is
//                          what fixed the "$0.000 hack" symptom
//                          where re-firing at TICK_MS cadence
//                          hit targets whose grow was still in
//                          flight.
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
          ns.tprint(`manager: ${target} → RECOVERY (drift=${(s.hackDifficulty - s.minDifficulty).toFixed(0)}, ${plan.summary})`);
        }
      } else if (recovering.has(target)) {
        counters["leave-recovery"]++;
        recovering.delete(target);
        ns.tprint(`manager: ${target} → normal HWGW (${plan.summary})`);
      }

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
        batchLaunched++;
        ns.print(`manager: ${job.script} → ${w} target=${target} threads=${job.threads} delay=${jobDelay}ms`);
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
    // Per-tick log line: always goes to the in-game log so verbose
    // users can see every tick.
    ns.print(`manager: tick ${(elapsed / 1000).toFixed(1)}s targets=[${targets.join(",")}] ${summary || "(no changes)"}${cdDetail}`);
    // Decide whether to surface this tick to the terminal.
    //
    // The user wants to see ONLY when something positively
    // happened — a batch launched, a recovery state changed.
    // Steady-state "all targets on cooldown" should be silent,
    // including the first tick after an action where the summary
    // transitions from "launched=N ..." to "SKIP-cooldown=N".
    //
    // Print rules:
    //   1. launched > 0  → always print (a batch fired)
    //   2. enter-recovery or leave-recovery > 0 → always print
    //      (recovery state transitioned, user wants to see it)
    //   3. otherwise → silent
    //
    // We do NOT print on summary-changes-to-quiet, because that's
    // a transition from "something happened" to "nothing happening"
    // — the opposite of what the user wants to be notified about.
    // The change-detection logic is kept simple: just check
    // counters, not the summary string.
    const hadAction = counters.launched > 0
      || counters["enter-recovery"] > 0
      || counters["leave-recovery"] > 0;
    if (hadAction) {
      ns.tprint(`manager: targets=[${targets.join(",") || "(empty)"}] ${summary || "(no changes)"}`);
    }
    // No more lastSummary tracking — we only print on real actions,
    // never on quiet ticks. The previous version tracked lastSummary
    // to detect "first tick of a new quiet state" which the user
    // explicitly does not want to see printed.

    // Wait until the next tick boundary. We've already burned some
    // time on per-job sleeps, so the residual is small.
    const residual = TICK_MS - (Date.now() - tickStart);
    if (residual > 0) await ns.sleep(residual);
  }
}
