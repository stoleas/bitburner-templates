/** @param {NS} ns */
//
// manager.js — centralized HWGW orchestrator (fleet-batcher edition,
// skeesler-aligned pacing).
//
// Runs forever on home. Each iteration of the outer loop:
//
//   1. For each target in the top MAX_TARGETS pickTargets() returns,
//      call planBatch() to get the 4-job plan with timing offsets.
//
//   2. isHealthy gate (skeesler pattern, fleet-batcher.js:131-137):
//      refuse to fire HWGW unless the target is at >= 50% × (1 -
//      hackFrac) × maxMoney AND curSec <= minSec + 5. If not
//      healthy, fall back to drain (weaken-only) until the next
//      attempt. Without this gate, a drained target (moneyAvailable
//      near $0) gets fired on again, hack.js steals $0, grow.js
//      runs the full regrow, and the income stream is a fraction
//      of what it would be with a healthy target.
//
//   3. Per-target share cap (MAX_FLEET_SHARE = 1/3): the batch's
//      total RAM must fit in 1/3 of the fleet's total max RAM.
//      Prevents one target from hogging the cluster.
//
//   4. 5% headroom rule: only fire the batch if its total RAM fits
//      in the fleet's free RAM with 5% headroom. If it doesn't,
//      SKIP-ram and try the next target (or wait a tick).
//
//   5. Fire the 4 jobs of the batch with their correct delays via
//      allocateBatch() — the fleet-batcher spreads each job's threads
//      across home + pservs + rooted-world-servers so the whole
//      batch's RAM doesn't need to fit on any single host. The
//      per-job delays are computed against the batch's arrivalT
//      and the per-target stagger (ti * BATCH_STAGGER_MS).
//
//   6. Multi-target staggering: each target's arrivalT is offset by
//      `ti * BATCH_STAGGER_MS` so the regrow timers don't all
//      bunch on the same wall-clock moment.
//
//   7. The orchestrator's own RAM footprint is small (~5 GB for the
//      ns object + script RAM). It does NOT do any hacking itself —
//      the workers do.
//
//   8. Per-target cooldown: re-firing a target whose previous batch
//      is still in flight produces $0.000 hacks. Gate each tick's
//      planBatch() on a per-target lastFireMs + (weakenTime + 5s).
//
//   9. Outer loop pace: the per-target stagger and the per-job
//      sleeps set the pace naturally. No fixed TICK_MS residual —
//      the cooldown gate is what throttles re-fire.
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
//   BATCH_GAP_MS         — wall-clock pace between batch starts.
//                          Default 800ms (skeesler/bitburner-
//                          commander pattern). The previous
//                          TICK_MS=5000 is obsolete; the per-
//                          target cooldown (weakenTime + buffer)
//                          is what gates re-fire, not the outer
//                          loop's pace.
//   BATCH_STAGGER_MS     — per-target stagger. Default 4000 (4s).
//                          Each target's arrivalT is offset by
//                          ti * BATCH_STAGGER_MS so the regrow
//                          timers don't all bunch on the same
//                          wall-clock moment. Should be < (shortest
//                          weakenTime / 2).
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
import { planBatch, listWorkers, findLargestWorkerWithRam, listReachableServers, isHealthy, 
// Fleet-batcher helpers — the new pattern that spreads one job's
// threads across home + pservs + rooted-world-servers instead of
// cramming it onto a single host. The 5% headroom rule (use
// FLEET_HEADROOM_FRACTION, not 1.0) prevents partial placements.
// (findWorkerWithRam is no longer used in normal-mode dispatch —
// the fleet batcher replaces it — but kept exported from
// lib/hwgw.js for any one-shot tool that still needs single-host
// dispatch.)
buildFleet, recheckFleetRam, stageWorkers, allocateBatch, fleetFree, shareRamCap, totalBatchRam, FLEET_DEFAULTS, } from "/lib/hwgw.js";
const MAX_TARGETS = 9;
// Default 0.10, NOT 0.50. Skeesler/bitburner-commander defaults
// to 10% for a reason: at 50% the regrow threads get so large
// that the matching grow can't refill before the next hack, the
// target oscillates between $0 and moneyMax, and the income
// stream drops to a residual $M figure instead of the expected
// $B+. The 10% fraction is the proven sweet spot for fleets up
// to ~50 TB; at higher fleet sizes, raise MONEY_FRACTION toward
// 0.30 (still well under the 0.50 oscillation point).
//
// Sourced from skeesler/bitburner-commander/commander.js:47
// (`const hackFraction = flags._[1] !== undefined ? Number(...)
//  : 0.10;`).
const MONEY_FRACTION = 0.10;
// Outer-loop pacing. skeesler uses 800ms between batch starts;
// the per-target cooldown is still weakenTime + buffer (Pitfall
// 4: re-firing before the regrow timer is a wasted batch), but
// the loop's wall-clock pace is this constant. The default 5s
// was the pre-fleet value when batches were 1×/5s/target; with
// the fleet pattern, batches are < 1s apart and 800ms is the
// sweet spot (faster than the 5s default but slow enough that
// the fleet has time to free up RAM as workers complete).
//
// Note: the previous TICK_MS=5000 is now obsolete — the
// per-target cooldown (weakenTime + buffer, typically 95s for
// phantasy) is what gates re-fire, not the outer loop's pace.
const BATCH_GAP_MS = 800;
// Per-target stagger: each target's arrivalT is offset by
// ti * BATCH_STAGGER_MS so the regrow timers don't all bunch
// on the same wall-clock moment. 4s is safe (weakenTime ~90s
// gives plenty of headroom for the stagger to spread out).
const BATCH_STAGGER_MS = 4_000;
// Safety buffer added on top of a target's weakenTime to derive
// the per-target cooldown. 5s covers worker overhead, ns.exec
// scheduling jitter, and a small margin for the regrow timer to
// start clean. The actual cooldown is per-target: weakenTime
// varies 5x across the network (fast servers ~10s, mid-game
// ~50-90s), so a fixed value would be wrong.
const COOLDOWN_BUFFER_MS = 5_000;
// isHealthy() tolerance. The skeesler pattern uses a STRICT
// check: refuse to fire HWGW unless the target is at >= 50%
// × (1 - hackFrac) × maxMoney AND curSec <= minSec + 5. Without
// this gate, a drained target (moneyAvailable = $0 after a
// bad batch) gets fired on again, hack.js steals $0, grow.js
// runs the full regrow, the target spends a full weakenTime
// recovering, and the income stream is a fraction of what it
// would be with a healthy target.
const HEALTH_MONEY_FRACTION = 0.5;
const HEALTH_SEC_TOLERANCE = 5;
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
        if (s.purchasedByPlayer)
            continue;
        if (!s.hasAdminRights)
            continue;
        if (!s.moneyMax || s.moneyMax <= 0)
            continue;
        if (s.requiredHackingSkill > myHack)
            continue;
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
        ns.tprint(`manager: started, MAX_TARGETS=${MAX_TARGETS} batchGap=${BATCH_GAP_MS}ms, output=verbose`);
    }
    while (true) {
        const tickStart = Date.now();
        const counters = { planned: 0, launched: 0, "SKIP-ram": 0, "SKIP-root": 0, "SKIP-level": 0, "SKIP-mp": 0, "SKIP-cooldown": 0, "recovery-firing": 0, "enter-recovery": 0, "leave-recovery": 0, "FAIL-exec": 0 };
        const targets = pickTargets(ns);
        const cooldownRemaining = new Map(); // for --verbose: how many ms until each target is eligible
        // Build the fleet ONCE per tick and share it across all targets.
        // The fleet (home + pservs + rooted-world-servers) is the
        // worker pool for normal-mode batches. It's rebuilt per-job
        // inside the per-target loop (Pitfall 6: stale worker lists
        // produce FAIL-exec after sleeps), but the initial build here
        // Build the fleet ONCE per tick. The BFS scan in
        // listReachableServers is ~70 ns.scan calls; calling it 45
        // times per tick (9 targets × 5 in the per-target +
        // per-job loops) is what was hanging the browser. The
        // fleet's MEMBERSHIP (which servers are workers) is stable
        // for the whole tick; only the per-host free RAM changes as
        // we place workers. The per-job `recheckFleetRam()` call
        // re-reads max/used for the cached host list without
        // re-running the BFS.
        const fleet = buildFleet(ns);
        if (verbose) {
            ns.print(`manager: fleet built: ${fleet.length} hosts, free=${fleetFree(ns, fleet).toFixed(1)}GB`);
        }
        // Stage worker scripts to the whole fleet ONCE per tick.
        // allocateBatch used to do this per call, which meant 36
        // scp passes per tick × 39 hosts × 3 scripts = 4212 scp
        // calls per tick. ns.scp is idempotent but each call is a
        // WebSocket round-trip; staging once cuts that to 117.
        stageWorkers(ns, fleet);
        for (let ti = 0; ti < targets.length; ti++) {
            const target = targets[ti];
            const s = ns.getServer(target);
            // pickTargets() already filtered, but be defensive — the
            // world can change between ticks.
            if (!s.hasAdminRights) {
                counters["SKIP-root"]++;
                continue;
            }
            if (s.requiredHackingSkill > ns.getPlayer().skills.hacking) {
                counters["SKIP-level"]++;
                continue;
            }
            if (!s.moneyMax || s.moneyMax <= 0) {
                counters["SKIP-mp"]++;
                continue;
            }
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
            }
            catch (e) {
                counters["SKIP-cooldown"]++;
                continue;
            }
            const lastFire = lastFireMs.get(target);
            if (typeof lastFire === "number") {
                const elapsed = Date.now() - lastFire;
                if (elapsed < cooldownMs) {
                    counters["SKIP-cooldown"]++;
                    if (verbose)
                        cooldownRemaining.set(target, Math.round((cooldownMs - elapsed) / 1000));
                    continue;
                }
            }
            // isHealthy gate (skeesler pattern, fleet-batcher.js:131-137).
            // The skeesler pattern refuses to fire HWGW unless the
            // target is at >= 50% × (1 - hackFrac) × maxMoney AND
            // curSec <= minSec + 5. Without this gate, a drained target
            // (moneyAvailable = $0 after a bad batch) gets fired on
            // again, hack.js steals $0, grow.js runs the full regrow,
            // the target spends a full weakenTime recovering, and the
            // income stream is a fraction of what it would be with a
            // healthy target.
            //
            // The user's earlier symptom — $1.549B spent, $8.7M earned
            // — was caused by exactly this. With MONEY_FRACTION=0.50
            // and no isHealthy gate, the manager was firing HWGW on
            // targets that had been drained, getting $0 back, running
            // the full regrow, and repeating. The income was a residual
            // from a brief window when the targets happened to be
            // healthy.
            //
            // Sourced from skeesler/bitburner-commander/fleet-batcher.js.
            // isHealthy is the TOLERANT check (curSec <= minSec + 5,
            // money >= 50% × (1 - hackFrac) × maxMoney). The stricter
            // isPrepped (curSec <= minSec + 0.01, money >= 99.9% ×
            // maxMoney) is used inside the prep() function for bringing
            // a target back from a fully-drained state.
            if (!isHealthy(ns, target, MONEY_FRACTION, HEALTH_MONEY_FRACTION, HEALTH_SEC_TOLERANCE)) {
                counters["SKIP-unhealthy"]++;
                if (verbose) {
                    ns.print(`manager: SKIP-unhealthy target=${target} curMoney=$${ns.getServerMoneyAvailable(target).toLocaleString()} maxMoney=$${ns.getServerMaxMoney(target).toLocaleString()} curSec=${ns.getServerSecurityLevel(target).toFixed(2)} minSec=${ns.getServerMinSecurityLevel(target).toFixed(2)}`);
                }
                // Two cases when isHealthy returns false:
                //
                //  (A) curSec > minSec + 5  (security drifted) — fire a
                //      drain to bring sec back down. This is the original
                //      skeesler pattern.
                //
                //  (B) money < 50% × (1 - hackFrac) × maxMoney (drained
                //      money, sec already at min) — the target is waiting
                //      for the natural regrow timer. The drain is a NO-OP
                //      because secToDrop = 0, and firing a 1-thread weaken
                //      every tick is just wasting RAM (the previous version
                //      of this code generated 1408+ weaken.js processes
                //      across the pservs in ~2 minutes, see commit
                //      1f2f38c).
                //
                // For (B) we just `continue` — wait for the regrow timer
                // to refill the target, then the next tick's isHealthy
                // check will return true and the normal HWGW path fires.
                // This is the correct behavior: don't try to "drain" money
                // out of a drained target, the regrow is automatic.
                const curSec = ns.getServerSecurityLevel(target);
                const minSec = ns.getServerMinSecurityLevel(target);
                const secToDrop = Math.max(0, curSec - minSec - HEALTH_SEC_TOLERANCE);
                if (secToDrop <= 0) {
                    // Case (B): drained money, sec is fine. Skip — let
                    // the natural regrow finish. Don't fire a no-op weaken.
                    continue;
                }
                // Case (A): security drifted. Fire a single drain on the
                // biggest free worker. threads = ceil(secToDrop / 0.05)
                // because each weaken thread drops 0.05 security.
                const weakenRam = ns.getScriptRam("weaken.js", "home");
                const workers = listWorkers(ns);
                const biggestWorker = workers.reduce((best, w) => {
                    const free = ns.getServerMaxRam(w) - ns.getServerUsedRam(w);
                    return free > best.free ? { h: w, free } : best;
                }, { h: null, free: 0 });
                if (biggestWorker.h && biggestWorker.free >= weakenRam) {
                    const threads = Math.ceil(secToDrop / 0.05);
                    if (ns.exec("weaken.js", biggestWorker.h, threads, target) > 0) {
                        counters["draining"] = (counters["draining"] || 0) + 1;
                        if (verbose) {
                            ns.print(`manager: DRAIN ${biggestWorker.h} ${threads} weaken threads target=${target} (curSec=${curSec.toFixed(2)}, minSec=${minSec.toFixed(2)}, secToDrop=${secToDrop.toFixed(2)})`);
                        }
                    }
                }
                continue;
            }
            let plan;
            try {
                plan = planBatch(ns, target, { moneyFraction: MONEY_FRACTION });
            }
            catch (e) {
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
                    what = `threw: ${e}`; // literally "threw: null" or "threw: undefined"
                }
                else if (typeof e === "object" && e.message) {
                    what = e.message;
                }
                else if (typeof e === "object") {
                    try {
                        what = `threw object: ${JSON.stringify(e).slice(0, 200)}`;
                    }
                    catch {
                        what = `threw object: <not serializable>`;
                    }
                }
                else {
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
                }
                catch { /* ignore */ }
                counters["FAIL-plan"] = (counters["FAIL-plan"] || 0) + 1;
                ns.tprint(`manager: planBatch(${target}) failed: ${what}${ctx}`);
                continue;
            }
            counters.planned++;
            // Stagger the arrival by ti * BATCH_STAGGER_MS so targets
            // process in a rolling wave, not all at once.
            const targetOffset = ti * BATCH_STAGGER_MS;
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
            }
            else if (recovering.has(target)) {
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
                if (!w) {
                    counters["SKIP-ram"]++;
                    continue;
                }
                const pid = ns.exec(job.script, w, job.threads, target);
                if (pid === 0) {
                    counters["FAIL-exec"]++;
                    continue;
                }
                counters.launched++;
                batchLaunched = 1;
                if (verbose) {
                    ns.print(`manager: RECOVERY ${job.script} → ${w} target=${target} threads=${job.threads} delay=${jobDelay}ms`);
                }
            }
            else {
                // Per-target share cap (MAX_FLEET_SHARE = 1/3): no single
                // target can claim more than 1/3 of the fleet's total
                // capacity for one batch. Without this gate, the top-
                // ranked target by moneyMax (phantasy) consumes the whole
                // cluster on every tick and targets #2..#9 starve. The
                // cap is evaluated against the BATCH (4 jobs summed),
                // not per-job — a single big weaken is fine as long as
                // the total batch stays under the share. Sourced from
                // skeesler/bitburner-commander.
                //
                // Check FIRST (more restrictive than 5% headroom, which
                // only reserves 5% of free RAM as a safety buffer).
                // Sharing is the higher-order concern: even if the fleet
                // has 95% free, no single target should claim > 1/3.
                const batchRam = totalBatchRam(ns, plan);
                const shareCap = shareRamCap(ns, fleet);
                if (batchRam > shareCap) {
                    counters["SKIP-share"] = (counters["SKIP-share"] || 0) + 1;
                    if (verbose) {
                        ns.print(`manager: SKIP-share target=${target} batch=${batchRam.toFixed(0)}GB cap=${shareCap.toFixed(0)}GB (MAX_FLEET_SHARE=${FLEET_DEFAULTS.MAX_FLEET_SHARE})`);
                    }
                    continue;
                }
                // 5% headroom gate: the fleet-batcher *will* partially
                // place a batch that's too big, leaving a partial hack
                // without a matching grow — the target would drain to $0
                // and never refill. The gate rejects any batch whose
                // total RAM doesn't fit in the fleet's 95% free window,
                // so partial placements never happen in practice.
                // (Sourced from skeesler/bitburner-commander.)
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
                    // Recheck fleet free RAM right before exec (Pitfall 6:
                    // stale worker list → stale "yes this has room" answers).
                    // The fleet's host list is stable for the whole tick; only
                    // per-host free RAM changes as we place workers. We refresh
                    // RAM with recheckFleetRam() instead of rebuild the fleet
                    // (avoids ~70 ns.scan calls × 36 calls per tick = 2520
                    // scans/sec, which was hanging the browser).
                    const freshFleet = recheckFleetRam(ns, fleet);
                    const placed = allocateBatch(ns, freshFleet, 
                    // Wrap the single job in a 1-element plan so we can
                    // reuse allocateBatch's logic. (allocateBatch fires
                    // all 4 jobs in one call; we use it per-job here
                    // so the per-job sleep lands at the right moment.)
                    { jobs: [job], totalRam: job.threads * ns.getScriptRam(job.script, "home") }, target, 0 /* targetOffset already in jobDelay */, Date.now(), // id = wall-clock ms; distinguishes this batch from previous
                    verbose);
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
        // CRITICAL: pace the outer loop. The per-target loop above
        // does its own pacing (per-job sleeps, per-target stagger,
        // per-target cooldown), but the OUTER loop has no natural
        // delay between iterations. Without a sleep here, the loop
        // spins at max rate (~1000 iterations/sec) calling
        // pickTargets (BFS scan of 50+ servers) and re-checking
        // cooldowns. At that rate, the Web Worker hosting this
        // script saturates the renderer's event loop and the game
        // tab becomes unresponsive — what the user observed as
        // "the game crashed". (The save state is fine; the tab
        // just hangs until the worker is killed.)
        //
        // 1s is the right value: it paces the outer loop without
        // throttling the income stream. The per-target cooldown
        // (weakenTime + buffer, typically 95s for phantasy) is
        // what actually gates re-fire; the 1s outer residual just
        // keeps the loop from spinning. skeesler uses BATCH_GAP=800ms
        // between batch starts inside a single-target fleet-batcher
        // process, but the manager is a single multi-target process
        // and 1s between full-tick sweeps is the right call.
        await ns.sleep(1_000);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFuYWdlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9tYW5hZ2VyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YscUVBQXFFO0FBQ3JFLDRCQUE0QjtBQUM1QixFQUFFO0FBQ0YsMERBQTBEO0FBQzFELEVBQUU7QUFDRixxRUFBcUU7QUFDckUsbUVBQW1FO0FBQ25FLEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsaUVBQWlFO0FBQ2pFLDZEQUE2RDtBQUM3RCxnRUFBZ0U7QUFDaEUsb0VBQW9FO0FBQ3BFLGdFQUFnRTtBQUNoRSxpRUFBaUU7QUFDakUsa0RBQWtEO0FBQ2xELEVBQUU7QUFDRixpRUFBaUU7QUFDakUsK0RBQStEO0FBQy9ELHFEQUFxRDtBQUNyRCxFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSwwREFBMEQ7QUFDMUQsRUFBRTtBQUNGLGtFQUFrRTtBQUNsRSxzRUFBc0U7QUFDdEUsZ0VBQWdFO0FBQ2hFLCtEQUErRDtBQUMvRCxnRUFBZ0U7QUFDaEUsMkRBQTJEO0FBQzNELEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsOERBQThEO0FBQzlELDRDQUE0QztBQUM1QyxFQUFFO0FBQ0Ysb0VBQW9FO0FBQ3BFLG9FQUFvRTtBQUNwRSx1QkFBdUI7QUFDdkIsRUFBRTtBQUNGLG9FQUFvRTtBQUNwRSxrRUFBa0U7QUFDbEUsbUVBQW1FO0FBQ25FLEVBQUU7QUFDRiwrREFBK0Q7QUFDL0Qsa0VBQWtFO0FBQ2xFLG9EQUFvRDtBQUNwRCxFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLGtFQUFrRTtBQUNsRSwrREFBK0Q7QUFDL0Qsc0VBQXNFO0FBQ3RFLGlFQUFpRTtBQUNqRSwyQkFBMkI7QUFDM0IsRUFBRTtBQUNGLGdFQUFnRTtBQUNoRSxtRUFBbUU7QUFDbkUsdUNBQXVDO0FBQ3ZDLEVBQUU7QUFDRixVQUFVO0FBQ1YsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxpRUFBaUU7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QUEwRDtRQUMxRCw4REFBOEQ7UUFDOUQsNERBQTREO1FBQzVELDREQUE0RDtRQUM1RCxxREFBcUQ7UUFDckQsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO0tBQ3ZCO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIG1hbmFnZXIuanMg4oCUIGNlbnRyYWxpemVkIEhXR1cgb3JjaGVzdHJhdG9yIChmbGVldC1iYXRjaGVyIGVkaXRpb24sXG4vLyBza2Vlc2xlci1hbGlnbmVkIHBhY2luZykuXG4vL1xuLy8gUnVucyBmb3JldmVyIG9uIGhvbWUuIEVhY2ggaXRlcmF0aW9uIG9mIHRoZSBvdXRlciBsb29wOlxuLy9cbi8vICAgMS4gRm9yIGVhY2ggdGFyZ2V0IGluIHRoZSB0b3AgTUFYX1RBUkdFVFMgcGlja1RhcmdldHMoKSByZXR1cm5zLFxuLy8gICAgICBjYWxsIHBsYW5CYXRjaCgpIHRvIGdldCB0aGUgNC1qb2IgcGxhbiB3aXRoIHRpbWluZyBvZmZzZXRzLlxuLy9cbi8vICAgMi4gaXNIZWFsdGh5IGdhdGUgKHNrZWVzbGVyIHBhdHRlcm4sIGZsZWV0LWJhdGNoZXIuanM6MTMxLTEzNyk6XG4vLyAgICAgIHJlZnVzZSB0byBmaXJlIEhXR1cgdW5sZXNzIHRoZSB0YXJnZXQgaXMgYXQgPj0gNTAlIMOXICgxIC1cbi8vICAgICAgaGFja0ZyYWMpIMOXIG1heE1vbmV5IEFORCBjdXJTZWMgPD0gbWluU2VjICsgNS4gSWYgbm90XG4vLyAgICAgIGhlYWx0aHksIGZhbGwgYmFjayB0byBkcmFpbiAod2Vha2VuLW9ubHkpIHVudGlsIHRoZSBuZXh0XG4vLyAgICAgIGF0dGVtcHQuIFdpdGhvdXQgdGhpcyBnYXRlLCBhIGRyYWluZWQgdGFyZ2V0IChtb25leUF2YWlsYWJsZVxuLy8gICAgICBuZWFyICQwKSBnZXRzIGZpcmVkIG9uIGFnYWluLCBoYWNrLmpzIHN0ZWFscyAkMCwgZ3Jvdy5qc1xuLy8gICAgICBydW5zIHRoZSBmdWxsIHJlZ3JvdywgYW5kIHRoZSBpbmNvbWUgc3RyZWFtIGlzIGEgZnJhY3Rpb25cbi8vICAgICAgb2Ygd2hhdCBpdCB3b3VsZCBiZSB3aXRoIGEgaGVhbHRoeSB0YXJnZXQuXG4vL1xuLy8gICAzLiBQZXItdGFyZ2V0IHNoYXJlIGNhcCAoTUFYX0ZMRUVUX1NIQVJFID0gMS8zKTogdGhlIGJhdGNoJ3Ncbi8vICAgICAgdG90YWwgUkFNIG11c3QgZml0IGluIDEvMyBvZiB0aGUgZmxlZXQncyB0b3RhbCBtYXggUkFNLlxuLy8gICAgICBQcmV2ZW50cyBvbmUgdGFyZ2V0IGZyb20gaG9nZ2luZyB0aGUgY2x1c3Rlci5cbi8vXG4vLyAgIDQuIDUlIGhlYWRyb29tIHJ1bGU6IG9ubHkgZmlyZSB0aGUgYmF0Y2ggaWYgaXRzIHRvdGFsIFJBTSBmaXRzXG4vLyAgICAgIGluIHRoZSBmbGVldCdzIGZyZWUgUkFNIHdpdGggNSUgaGVhZHJvb20uIElmIGl0IGRvZXNuJ3QsXG4vLyAgICAgIFNLSVAtcmFtIGFuZCB0cnkgdGhlIG5leHQgdGFyZ2V0IChvciB3YWl0IGEgdGljaykuXG4vL1xuLy8gICA1LiBGaXJlIHRoZSA0IGpvYnMgb2YgdGhlIGJhdGNoIHdpdGggdGhlaXIgY29ycmVjdCBkZWxheXMgdmlhXG4vLyAgICAgIGFsbG9jYXRlQmF0Y2goKSDigJQgdGhlIGZsZWV0LWJhdGNoZXIgc3ByZWFkcyBlYWNoIGpvYidzIHRocmVhZHNcbi8vICAgICAgYWNyb3NzIGhvbWUgKyBwc2VydnMgKyByb290ZWQtd29ybGQtc2VydmVycyBzbyB0aGUgd2hvbGVcbi8vICAgICAgYmF0Y2gncyBSQU0gZG9lc24ndCBuZWVkIHRvIGZpdCBvbiBhbnkgc2luZ2xlIGhvc3QuIFRoZVxuLy8gICAgICBwZXItam9iIGRlbGF5cyBhcmUgY29tcHV0ZWQgYWdhaW5zdCB0aGUgYmF0Y2gncyBhcnJpdmFsVFxuLy8gICAgICBhbmQgdGhlIHBlci10YXJnZXQgc3RhZ2dlciAodGkgKiBCQVRDSF9TVEFHR0VSX01TKS5cbi8vXG4vLyAgIDYuIE11bHRpLXRhcmdldCBzdGFnZ2VyaW5nOiBlYWNoIHRhcmdldCdzIGFycml2YWxUIGlzIG9mZnNldCBieVxuLy8gICAgICBgdGkgKiBCQVRDSF9TVEFHR0VSX01TYCBzbyB0aGUgcmVncm93IHRpbWVycyBkb24ndCBhbGxcbi8vICAgICAgYnVuY2ggb24gdGhlIHNhbWUgd2FsbC1jbG9jayBtb21lbnQuXG4vL1xuLy8gICA3LiBUaGUgb3JjaGVzdHJhdG9yJ3Mgb3duIFJBTSBmb290cHJpbnQgaXMgc21hbGwgKH41IEdCIGZvciB0aGVcbi8vICAgICAgbnMgb2JqZWN0ICsgc2NyaXB0IFJBTSkuIEl0IGRvZXMgTk9UIGRvIGFueSBoYWNraW5nIGl0c2VsZiDigJRcbi8vICAgICAgdGhlIHdvcmtlcnMgZG8uXG4vL1xuLy8gICA4LiBQZXItdGFyZ2V0IGNvb2xkb3duOiByZS1maXJpbmcgYSB0YXJnZXQgd2hvc2UgcHJldmlvdXMgYmF0Y2hcbi8vICAgICAgaXMgc3RpbGwgaW4gZmxpZ2h0IHByb2R1Y2VzICQwLjAwMCBoYWNrcy4gR2F0ZSBlYWNoIHRpY2snc1xuLy8gICAgICBwbGFuQmF0Y2goKSBvbiBhIHBlci10YXJnZXQgbGFzdEZpcmVNcyArICh3ZWFrZW5UaW1lICsgNXMpLlxuLy9cbi8vICAgOS4gT3V0ZXIgbG9vcCBwYWNlOiB0aGUgcGVyLXRhcmdldCBzdGFnZ2VyIGFuZCB0aGUgcGVyLWpvYlxuLy8gICAgICBzbGVlcHMgc2V0IHRoZSBwYWNlIG5hdHVyYWxseS4gTm8gZml4ZWQgVElDS19NUyByZXNpZHVhbCDigJRcbi8vICAgICAgdGhlIGNvb2xkb3duIGdhdGUgaXMgd2hhdCB0aHJvdHRsZXMgcmUtZmlyZS5cbi8vXG4vLyAgIDcuIFJlY292ZXJ5IG1vZGU6IHdoZW4gdGhlIHBlci1iYXRjaCB3ZWFrZW4gdGhyZWFkIGNvdW50IGlzIHNvXG4vLyAgICAgIGxhcmdlIGl0IGRvZXNuJ3QgZml0IG9uIGEgc2luZ2xlIGhvc3QsIHBsYW5CYXRjaCByZXR1cm5zIGFcbi8vICAgICAgMS1qb2Igd2Vha2VuLW9ubHkgcGxhbiBzaXplZCB0byB0aGUgbGFyZ2VzdCBmcmVlIHdvcmtlclxuLy8gICAgICAoUGl0ZmFsbCAyMzogbGFyZ2VzdC1maXQsIG5vdCBzbWFsbGVzdC1maXQpLiBUaGlzIGRyYWlucyBkcmlmdFxuLy8gICAgICBvdmVyIGEgZmV3IGN5Y2xlcyBhbmQgdGhlIHBsYW4gdHJhbnNpdGlvbnMgYmFjayB0byBub3JtYWxcbi8vICAgICAgSFdHVyBhdXRvbWF0aWNhbGx5LlxuLy9cbi8vICAgOC4gUXVpZXQgYnkgZGVmYXVsdCDigJQgdGhlIHBlci10aWNrIHN1bW1hcnkgb25seSBnb2VzIHRvIHRoZVxuLy8gICAgICB0ZXJtaW5hbCB3aGVuIGFuIGVycm9yIGZpcmVzLiAtLXZlcmJvc2UgcmUtZW5hYmxlcyBwZXItdGlja1xuLy8gICAgICBkZXRhaWwgdG8gdGhlIGluLWdhbWUgbG9nIGZpbGUuXG4vL1xuLy8gVHVuaW5nOlxuLy9cbi8vICAgTUFYX1RBUkdFVFMgICAgICAgICAgIOKAlCB1cHBlciBib3VuZCBvbiB0aGUgcGVyLXRpY2sgdGFyZ2V0IGxpc3QuXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgOSBpcyB0aGUgcmVjb21tZW5kZWQgc3dlZXQgc3BvdDsgbW9yZVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHRoYW4gfjEyIHN0YXJ0cyB0byBmcmFnbWVudCB0aGUgY2x1c3Rlci5cbi8vICAgTU9ORVlfRlJBQ1RJT04gICAgICAg4oCUIHdoYXQgJSBvZiBtb25leU1heCB0byBzdGVhbCBwZXIgY3ljbGUuXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgMC41MCAoNTAlKSBpcyB0aGUgbWlkLWdhbWUgc3dlZXQgc3BvdDpcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBmZXdlciBiYXRjaGVzIHBlciB0YXJnZXQgbWVhbnMgdGhlXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgcGVyLXRhcmdldCBjb29sZG93biAoc2VlIFBFUl9UQVJHRVRfQ09PTERPV05fTVMpXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgaXMgdGhlIGRvbWluYW50IHBhY2luZyBjb25zdHJhaW50LCBub3Rcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICB0aGUgb3JjaGVzdHJhdG9yJ3Mgb3duIGxvb3AuIFN0ZWFsIDI1JVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIGZvciB2ZXJ5IGZhc3QtcmVncm93IHNlcnZlcnMsIDc1JSBmb3Jcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBzbG93IG9uZXMuIFByZS1jb29sZG93biB0aGUgdmFsdWUgd2FzXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgMC4xMCB3aGljaCBwcm9kdWNlZCAxMCBiYXRjaGVzIHBlclxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIGRyYWluIGFuZCAoYmVjYXVzZSB0aGUgbWFuYWdlciByZS1maXJlZFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHRoZSBzYW1lIHRhcmdldCBldmVyeSA1cykgb3ZlcmxhcCByYWNlc1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHdoZXJlIHRoZSBuZXcgaGFjayBoaXQgYSB0YXJnZXQgd2hvc2Vcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBwcmV2aW91cyBncm93IGhhZG4ndCByZWZpbGxlZCBpdC4gVGhhdFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHJhY2UgaXMgd2hhdCBtYWRlIGhhY2suanMgcmV0dXJuICQwLjAwMFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIG9uIG90aGVyd2lzZS1zYW5lIHRhcmdldHMuXG4vLyAgIEJBVENIX0dBUF9NUyAgICAgICAgIOKAlCB3YWxsLWNsb2NrIHBhY2UgYmV0d2VlbiBiYXRjaCBzdGFydHMuXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgRGVmYXVsdCA4MDBtcyAoc2tlZXNsZXIvYml0YnVybmVyLVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmRlciBwYXR0ZXJuKS4gVGhlIHByZXZpb3VzXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgVElDS19NUz01MDAwIGlzIG9ic29sZXRlOyB0aGUgcGVyLVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldCBjb29sZG93biAod2Vha2VuVGltZSArIGJ1ZmZlcilcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBpcyB3aGF0IGdhdGVzIHJlLWZpcmUsIG5vdCB0aGUgb3V0ZXJcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBsb29wJ3MgcGFjZS5cbi8vICAgQkFUQ0hfU1RBR0dFUl9NUyAgICAg4oCUIHBlci10YXJnZXQgc3RhZ2dlci4gRGVmYXVsdCA0MDAwICg0cykuXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgRWFjaCB0YXJnZXQncyBhcnJpdmFsVCBpcyBvZmZzZXQgYnlcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICB0aSAqIEJBVENIX1NUQUdHRVJfTVMgc28gdGhlIHJlZ3Jvd1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHRpbWVycyBkb24ndCBhbGwgYnVuY2ggb24gdGhlIHNhbWVcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICB3YWxsLWNsb2NrIG1vbWVudC4gU2hvdWxkIGJlIDwgKHNob3J0ZXN0XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgd2Vha2VuVGltZSAvIDIpLlxuLy8gICBDT09MRE9XTl9CVUZGRVJfTVMgICDigJQgc2FmZXR5IGJ1ZmZlciBhZGRlZCBvbiB0b3Agb2YgYSB0YXJnZXQnc1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHdlYWtlblRpbWUgdG8gZGVyaXZlIHRoZSBwZXItdGFyZ2V0XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgY29vbGRvd24uIDVzIGNvdmVycyB3b3JrZXIgb3ZlcmhlYWQsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgbnMuZXhlYyBzY2hlZHVsaW5nIGppdHRlciwgYW5kIGEgc21hbGxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBtYXJnaW4gZm9yIHRoZSByZWdyb3cgdGltZXIgdG8gc3RhcnRcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICBjbGVhbi4gVGhlIGFjdHVhbCBjb29sZG93biBpcyBwZXItdGFyZ2V0OlxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIHdlYWtlblRpbWUgdmFyaWVzIDV4IGFjcm9zcyB0aGUgbmV0d29ya1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgIChmYXN0IHNlcnZlcnMgfjEwcywgbWlkLWdhbWUgfjUwLTkwcyksXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgc28gYSBmaXhlZCB2YWx1ZSB3b3VsZCBiZSB3cm9uZy5cbi8vXG4vLyBXaHkgdGhlIGZsZWV0ICh2cy4gc2luZ2xlLWhvc3QgZml0KTpcbi8vXG4vLyAgIEJlZm9yZSB0aGUgZmxlZXQsIGV2ZXJ5IGpvYiBpbiBhIDQtam9iIGJhdGNoIGhhZCB0byBmaXQgb24gYVxuLy8gICBzaW5nbGUgaG9zdC4gRm9yIGEgdHlwaWNhbCBCTjEgbWlkLWdhbWUgdGFyZ2V0IChwaGFudGFzeSwgbWF4LVxuLy8gICBoYXJkd2FyZSksIHRoZSBiYXRjaCBuZWVkcyB+NSwwMDAgZ3JvdyB0aHJlYWRzIMOXIDEuNzUgR0IgPSA4Ljc1XG4vLyAgIFRCIHBsdXMgfjcwLDAwMCB3ZWFrZW4gw5cgMS43NSBHQiA9IDEyMiBUQi4gTm8gc2luZ2xlIHBzZXJ2ICgxXG4vLyAgIFRCKSBvciBldmVuIGhvbWUgKDEgVEIpIGZpdHMgdGhlIDEyMiBUQiB3ZWFrZW4uIFJlc3VsdDogaG9tZVxuLy8gICBob3N0cyB0aGUgZW50aXJlIGJhdGNoLCBwc2VydnMgc2l0IGlkbGUsIGFuZCAxMjIgVEIgb2YgZmxlZXRcbi8vICAgY2FwYWNpdHkgaXMgd2FzdGVkLlxuLy9cbi8vICAgV2l0aCB0aGUgZmxlZXQsIGVhY2ggam9iIGlzIGJpbi1wYWNrZWQgYWNyb3NzIGhvbWUgKyBldmVyeVxuLy8gICBwc2VydiArIGV2ZXJ5IHJvb3RlZCB3b3JsZCBzZXJ2ZXIgKENTRUMsIGZvb2Ruc3R1ZmYsIGV0Yy4sIH41MFxuLy8gICBHQiB0b3RhbCkuIFRoZSAxMjIgVEIgd2Vha2VuIGJlY29tZXMgXCIxLDAwMCB0aHJlYWRzIG9uIGhvbWUgK1xuLy8gICA2OSwwMDAgc3ByZWFkIGFjcm9zcyAxMSBwc2VydnNcIiDigJQgdHJpdmlhbGx5IGZpdHMsIHRoZSB3aG9sZVxuLy8gICBjbHVzdGVyIGlzIGVuZ2FnZWQuIFRoaXMgaXMgdGhlIHNpbmdsZSBiaWdnZXN0IEJOMSBtaWQtZ2FtZVxuLy8gICBwZXJmb3JtYW5jZSBjaGFuZ2UuIFBhdHRlcm4gc291cmNlZCBmcm9tXG4vLyAgIHNrZWVzbGVyL2JpdGJ1cm5lci1jb21tYW5kZXIvZmxlZXQtYmF0Y2hlci5qcyAocHVibGljIGRvbWFpbikuXG4vL1xuLy8gVGFyZ2V0IHNlbGVjdGlvbjogdGhlIG1hbmFnZXIgZHluYW1pY2FsbHkgcGlja3MgTUFYX1RBUkdFVFMgc2VydmVyc1xuLy8gcGVyIHRpY2sgcmF0aGVyIHRoYW4gdXNpbmcgYSBoYXJkY29kZWQgbGlzdC4gVGhlIHNlbGVjdGlvbiBydWxlOlxuLy9cbi8vICAgMS4gQkZTIHRoZSBuZXR3b3JrIGZyb20gaG9tZSAoZXhjbHVkZXMgaG9tZSBhbmQgcHNlcnYtKikuXG4vLyAgIDIuIEZpbHRlciB0bzogaGFzQWRtaW5SaWdodHMgJiYgbW9uZXlNYXggPiAwICYmXG4vLyAgICAgIHJlcXVpcmVkSGFja2luZ1NraWxsIDw9IG15SGFjay5cbi8vICAgMy4gU29ydCBieSBtb25leU1heCBkZXNjZW5kaW5nLlxuLy8gICA0LiBUYWtlIHRoZSB0b3AgTUFYX1RBUkdFVFMuXG4vL1xuLy8gVGhpcyBhdXRvLWFkYXB0cyBhcyBuZXcgc2VydmVycyBnZXQgbnVrZWQsIGhhY2sgbGV2ZWwgY2xpbWJzLCBhbmRcbi8vIHBzZXJ2cyBsYW5kLiBUaGUgcHJldmlvdXMgaGFyZGNvZGVkIGxpc3Qgb2YgbWlkLWdhbWUgc2VydmVyc1xuLy8gKHBoYW50YXN5LCBvbWVnYS1uZXQsIGV0Yy4pIHdhcyB1c2VsZXNzIGVhcmx5LWdhbWUgd2hlbiBtb3N0IG9mXG4vLyB0aGVtIHdlcmUgU0tJUC1yb290IG9yIFNLSVAtbGV2ZWwsIGFuZCB0aGUgbWFuYWdlciBoYWQgbm90aGluZ1xuLy8gdG8gZG8gb24gc21hbGwgc2VydmVycyBsaWtlIG4wMGRsZXMvZm9vZG5zdHVmZiB0aGF0IGl0IHNob3VsZFxuLy8gYWxzbyBiZSBkcmFpbmluZy5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIG1hbmFnZXIuanNcbi8vICAgcnVuIG1hbmFnZXIuanMgLS12ZXJib3NlICAgICMgcGVyLXRpY2sgZGV0YWlsIGluIHRoZSBpbi1nYW1lIGxvZ1xuLy9cbmltcG9ydCB7XG4gIHBsYW5CYXRjaCxcbiAgbGlzdFdvcmtlcnMsXG4gIGZpbmRMYXJnZXN0V29ya2VyV2l0aFJhbSxcbiAgbGlzdFJlYWNoYWJsZVNlcnZlcnMsXG4gIGlzSGVhbHRoeSxcbiAgLy8gRmxlZXQtYmF0Y2hlciBoZWxwZXJzIOKAlCB0aGUgbmV3IHBhdHRlcm4gdGhhdCBzcHJlYWRzIG9uZSBqb2Inc1xuICAvLyB0aHJlYWRzIGFjcm9zcyBob21lICsgcHNlcnZzICsgcm9vdGVkLXdvcmxkLXNlcnZlcnMgaW5zdGVhZCBvZlxuICAvLyBjcmFtbWluZyBpdCBvbnRvIGEgc2luZ2xlIGhvc3QuIFRoZSA1JSBoZWFkcm9vbSBydWxlICh1c2VcbiAgLy8gRkxFRVRfSEVBRFJPT01fRlJBQ1RJT04sIG5vdCAxLjApIHByZXZlbnRzIHBhcnRpYWwgcGxhY2VtZW50cy5cbiAgLy8gKGZpbmRXb3JrZXJXaXRoUmFtIGlzIG5vIGxvbmdlciB1c2VkIGluIG5vcm1hbC1tb2RlIGRpc3BhdGNoIOKAlFxuICAvLyB0aGUgZmxlZXQgYmF0Y2hlciByZXBsYWNlcyBpdCDigJQgYnV0IGtlcHQgZXhwb3J0ZWQgZnJvbVxuICAvLyBsaWIvaHdndy5qcyBmb3IgYW55IG9uZS1zaG90IHRvb2wgdGhhdCBzdGlsbCBuZWVkcyBzaW5nbGUtaG9zdFxuICAvLyBkaXNwYXRjaC4pXG4gIGJ1aWxkRmxlZXQsXG4gIHJlY2hlY2tGbGVldFJhbSxcbiAgc3RhZ2VXb3JrZXJzLFxuICBhbGxvY2F0ZUJhdGNoLFxuICBmbGVldEZyZWUsXG4gIHNoYXJlUmFtQ2FwLFxuICB0b3RhbEJhdGNoUmFtLFxuICBGTEVFVF9ERUZBVUxUUyxcbn0gZnJvbSBcIi9saWIvaHdndy5qc1wiO1xuXG5jb25zdCBNQVhfVEFSR0VUUyA9IDk7XG4vLyBEZWZhdWx0IDAuMTAsIE5PVCAwLjUwLiBTa2Vlc2xlci9iaXRidXJuZXItY29tbWFuZGVyIGRlZmF1bHRzXG4vLyB0byAxMCUgZm9yIGEgcmVhc29uOiBhdCA1MCUgdGhlIHJlZ3JvdyB0aHJlYWRzIGdldCBzbyBsYXJnZVxuLy8gdGhhdCB0aGUgbWF0Y2hpbmcgZ3JvdyBjYW4ndCByZWZpbGwgYmVmb3JlIHRoZSBuZXh0IGhhY2ssIHRoZVxuLy8gdGFyZ2V0IG9zY2lsbGF0ZXMgYmV0d2VlbiAkMCBhbmQgbW9uZXlNYXgsIGFuZCB0aGUgaW5jb21lXG4vLyBzdHJlYW0gZHJvcHMgdG8gYSByZXNpZHVhbCAkTSBmaWd1cmUgaW5zdGVhZCBvZiB0aGUgZXhwZWN0ZWRcbi8vICRCKy4gVGhlIDEwJSBmcmFjdGlvbiBpcyB0aGUgcHJvdmVuIHN3ZWV0IHNwb3QgZm9yIGZsZWV0cyB1cFxuLy8gdG8gfjUwIFRCOyBhdCBoaWdoZXIgZmxlZXQgc2l6ZXMsIHJhaXNlIE1PTkVZX0ZSQUNUSU9OIHRvd2FyZFxuLy8gMC4zMCAoc3RpbGwgd2VsbCB1bmRlciB0aGUgMC41MCBvc2NpbGxhdGlvbiBwb2ludCkuXG4vL1xuLy8gU291cmNlZCBmcm9tIHNrZWVzbGVyL2JpdGJ1cm5lci1jb21tYW5kZXIvY29tbWFuZGVyLmpzOjQ3XG4vLyAoYGNvbnN0IGhhY2tGcmFjdGlvbiA9IGZsYWdzLl9bMV0gIT09IHVuZGVmaW5lZCA/IE51bWJlciguLi4pXG4vLyAgOiAwLjEwO2ApLlxuY29uc3QgTU9ORVlfRlJBQ1RJT04gPSAwLjEwO1xuLy8gT3V0ZXItbG9vcCBwYWNpbmcuIHNrZWVzbGVyIHVzZXMgODAwbXMgYmV0d2VlbiBiYXRjaCBzdGFydHM7XG4vLyB0aGUgcGVyLXRhcmdldCBjb29sZG93biBpcyBzdGlsbCB3ZWFrZW5UaW1lICsgYnVmZmVyIChQaXRmYWxsXG4vLyA0OiByZS1maXJpbmcgYmVmb3JlIHRoZSByZWdyb3cgdGltZXIgaXMgYSB3YXN0ZWQgYmF0Y2gpLCBidXRcbi8vIHRoZSBsb29wJ3Mgd2FsbC1jbG9jayBwYWNlIGlzIHRoaXMgY29uc3RhbnQuIFRoZSBkZWZhdWx0IDVzXG4vLyB3YXMgdGhlIHByZS1mbGVldCB2YWx1ZSB3aGVuIGJhdGNoZXMgd2VyZSAxw5cvNXMvdGFyZ2V0OyB3aXRoXG4vLyB0aGUgZmxlZXQgcGF0dGVybiwgYmF0Y2hlcyBhcmUgPCAxcyBhcGFydCBhbmQgODAwbXMgaXMgdGhlXG4vLyBzd2VldCBzcG90IChmYXN0ZXIgdGhhbiB0aGUgNXMgZGVmYXVsdCBidXQgc2xvdyBlbm91Z2ggdGhhdFxuLy8gdGhlIGZsZWV0IGhhcyB0aW1lIHRvIGZyZWUgdXAgUkFNIGFzIHdvcmtlcnMgY29tcGxldGUpLlxuLy9cbi8vIE5vdGU6IHRoZSBwcmV2aW91cyBUSUNLX01TPTUwMDAgaXMgbm93IG9ic29sZXRlIOKAlCB0aGVcbi8vIHBlci10YXJnZXQgY29vbGRvd24gKHdlYWtlblRpbWUgKyBidWZmZXIsIHR5cGljYWxseSA5NXMgZm9yXG4vLyBwaGFudGFzeSkgaXMgd2hhdCBnYXRlcyByZS1maXJlLCBub3QgdGhlIG91dGVyIGxvb3AncyBwYWNlLlxuY29uc3QgQkFUQ0hfR0FQX01TID0gODAwO1xuLy8gUGVyLXRhcmdldCBzdGFnZ2VyOiBlYWNoIHRhcmdldCdzIGFycml2YWxUIGlzIG9mZnNldCBieVxuLy8gdGkgKiBCQVRDSF9TVEFHR0VSX01TIHNvIHRoZSByZWdyb3cgdGltZXJzIGRvbid0IGFsbCBidW5jaFxuLy8gb24gdGhlIHNhbWUgd2FsbC1jbG9jayBtb21lbnQuIDRzIGlzIHNhZmUgKHdlYWtlblRpbWUgfjkwc1xuLy8gZ2l2ZXMgcGxlbnR5IG9mIGhlYWRyb29tIGZvciB0aGUgc3RhZ2dlciB0byBzcHJlYWQgb3V0KS5cbmNvbnN0IEJBVENIX1NUQUdHRVJfTVMgPSA0XzAwMDtcbi8vIFNhZmV0eSBidWZmZXIgYWRkZWQgb24gdG9wIG9mIGEgdGFyZ2V0J3Mgd2Vha2VuVGltZSB0byBkZXJpdmVcbi8vIHRoZSBwZXItdGFyZ2V0IGNvb2xkb3duLiA1cyBjb3ZlcnMgd29ya2VyIG92ZXJoZWFkLCBucy5leGVjXG4vLyBzY2hlZHVsaW5nIGppdHRlciwgYW5kIGEgc21hbGwgbWFyZ2luIGZvciB0aGUgcmVncm93IHRpbWVyIHRvXG4vLyBzdGFydCBjbGVhbi4gVGhlIGFjdHVhbCBjb29sZG93biBpcyBwZXItdGFyZ2V0OiB3ZWFrZW5UaW1lXG4vLyB2YXJpZXMgNXggYWNyb3NzIHRoZSBuZXR3b3JrIChmYXN0IHNlcnZlcnMgfjEwcywgbWlkLWdhbWVcbi8vIH41MC05MHMpLCBzbyBhIGZpeGVkIHZhbHVlIHdvdWxkIGJlIHdyb25nLlxuY29uc3QgQ09PTERPV05fQlVGRkVSX01TID0gNV8wMDA7XG4vLyBpc0hlYWx0aHkoKSB0b2xlcmFuY2UuIFRoZSBza2Vlc2xlciBwYXR0ZXJuIHVzZXMgYSBTVFJJQ1Rcbi8vIGNoZWNrOiByZWZ1c2UgdG8gZmlyZSBIV0dXIHVubGVzcyB0aGUgdGFyZ2V0IGlzIGF0ID49IDUwJVxuLy8gw5cgKDEgLSBoYWNrRnJhYykgw5cgbWF4TW9uZXkgQU5EIGN1clNlYyA8PSBtaW5TZWMgKyA1LiBXaXRob3V0XG4vLyB0aGlzIGdhdGUsIGEgZHJhaW5lZCB0YXJnZXQgKG1vbmV5QXZhaWxhYmxlID0gJDAgYWZ0ZXIgYVxuLy8gYmFkIGJhdGNoKSBnZXRzIGZpcmVkIG9uIGFnYWluLCBoYWNrLmpzIHN0ZWFscyAkMCwgZ3Jvdy5qc1xuLy8gcnVucyB0aGUgZnVsbCByZWdyb3csIHRoZSB0YXJnZXQgc3BlbmRzIGEgZnVsbCB3ZWFrZW5UaW1lXG4vLyByZWNvdmVyaW5nLCBhbmQgdGhlIGluY29tZSBzdHJlYW0gaXMgYSBmcmFjdGlvbiBvZiB3aGF0IGl0XG4vLyB3b3VsZCBiZSB3aXRoIGEgaGVhbHRoeSB0YXJnZXQuXG5jb25zdCBIRUFMVEhfTU9ORVlfRlJBQ1RJT04gPSAwLjU7XG5jb25zdCBIRUFMVEhfU0VDX1RPTEVSQU5DRSA9IDU7XG5cbi8vIFBpY2sgdGhlIHRvcCBNQVhfVEFSR0VUUyBzZXJ2ZXJzIHdlIGNhbiBhY3R1YWxseSBiYXRjaDogcm9vdGVkLFxuLy8gaGF2ZSBtb25leSwgYW5kIHdpdGhpbiBoYWNrIGxldmVsLiBTb3J0ZWQgYnkgbW9uZXlNYXggZGVzY2VuZGluZ1xuLy8gc28gdGhlIGJpZ2dlc3Qgc2VydmVycyBnZXQgZmlyc3QgZGlicyBvbiB0aGUgY2x1c3Rlci4gUHVyY2hhc2VkXG4vLyBzZXJ2ZXJzIChwc2Vydi0qKSBhcmUgZXhjbHVkZWQg4oCUIHRoZXkgaGF2ZSBubyBtb25leSB0byBzdGVhbC5cbmZ1bmN0aW9uIHBpY2tUYXJnZXRzKG5zKSB7XG4gIGNvbnN0IG1lID0gbnMuZ2V0UGxheWVyKCk7XG4gIGNvbnN0IG15SGFjayA9IG1lLnNraWxscy5oYWNraW5nO1xuICBjb25zdCBjYW5kaWRhdGVzID0gW107XG4gIGZvciAoY29uc3QgaG9zdCBvZiBsaXN0UmVhY2hhYmxlU2VydmVycyhucykpIHtcbiAgICBjb25zdCBzID0gbnMuZ2V0U2VydmVyKGhvc3QpO1xuICAgIGlmIChzLnB1cmNoYXNlZEJ5UGxheWVyKSBjb250aW51ZTtcbiAgICBpZiAoIXMuaGFzQWRtaW5SaWdodHMpIGNvbnRpbnVlO1xuICAgIGlmICghcy5tb25leU1heCB8fCBzLm1vbmV5TWF4IDw9IDApIGNvbnRpbnVlO1xuICAgIGlmIChzLnJlcXVpcmVkSGFja2luZ1NraWxsID4gbXlIYWNrKSBjb250aW51ZTtcbiAgICBjYW5kaWRhdGVzLnB1c2goeyBob3N0LCBtb25leU1heDogcy5tb25leU1heCB9KTtcbiAgfVxuICBjYW5kaWRhdGVzLnNvcnQoKGEsIGIpID0+IGIubW9uZXlNYXggLSBhLm1vbmV5TWF4KTtcbiAgcmV0dXJuIGNhbmRpZGF0ZXMuc2xpY2UoMCwgTUFYX1RBUkdFVFMpLm1hcCgoYykgPT4gYy5ob3N0KTtcbn1cblxuLy8gUGVyLXRhcmdldCBjb29sZG93biB0cmFja2VyLiBNYXBzIGhvc3RuYW1lIOKGkiB3YWxsLWNsb2NrIG1zIG9mIHRoZVxuLy8gbGFzdCBmdWxseS1sYXVuY2hlZCBiYXRjaCBhZ2FpbnN0IHRoYXQgdGFyZ2V0LiBXZSBnYXRlIGVhY2ggdGljaydzXG4vLyBwbGFuQmF0Y2goKSBvbiB0aGlzIHNvIHdlIG5ldmVyIHJlLWZpcmUgYSB0YXJnZXQgd2hvc2UgcHJldmlvdXNcbi8vIGJhdGNoIGlzIHN0aWxsIGluIGZsaWdodC4gU3RhdGUgaXMgbW9kdWxlLXNjb3BlZDogaXQgc3Vydml2ZXNcbi8vIGFjcm9zcyB0aWNrcyBidXQgaXMgd2lwZWQgb24gbWFuYWdlciByZXN0YXJ0ICh3aGljaCBpcyBjb3JyZWN0IOKAlFxuLy8gYWZ0ZXIgYW4gYXVnLCB3ZSBXQU5UIGEgZnJlc2ggY3ljbGUpLlxuLy9cbi8vIFNldCBpcyBrZXllZCBieSBob3N0bmFtZSwgbm90IGJ5IHNvbWUgZGVyaXZlZCBpZCwgYmVjYXVzZSBwaWNrVGFyZ2V0c1xuLy8gZ2l2ZXMgdXMgaG9zdG5hbWVzIGRpcmVjdGx5IGFuZCB0aGVyZSdzIG5vIGFtYmlndWl0eS5cbi8vXG4vLyBXZSB1c2UgYSBNYXAgKG5vdCBhIHBsYWluIG9iamVjdCkgYmVjYXVzZSBNYXBzIHByZXNlcnZlIGluc2VydGlvblxuLy8gb3JkZXIsIHdoaWNoIG1ha2VzIHRoZSBwZXItdGljayBkZWJ1ZyBsb2cgc2xpZ2h0bHkgbW9yZSByZWFkYWJsZVxuLy8gd2hlbiB3ZSBldmVudHVhbGx5IHN1cmZhY2UgaXQuIChXZSBkb24ndCB0b2RheSwgYnV0IGl0J3MgZnJlZS4pXG5jb25zdCBsYXN0RmlyZU1zID0gbmV3IE1hcCgpO1xuXG4vLyBTZXQgb2YgdGFyZ2V0cyBjdXJyZW50bHkgaW4gcmVjb3ZlcnkgbW9kZSAoaS5lLiBwbGFuQmF0Y2ggcmV0dXJuZWRcbi8vIHJlY292ZXJ5TW9kZTogdHJ1ZSBmb3IgdGhlbSBvbiB0aGUgbW9zdCByZWNlbnQgZmlyaW5nKS4gVXNlZCB0b1xuLy8gc3VyZmFjZSBlbnRlci9sZWF2ZSB0cmFuc2l0aW9ucyB0byB0aGUgdXNlciB2aWEgdHByaW50LiBTdXJ2aXZlc1xuLy8gYWNyb3NzIHRpY2tzIChwYXJhbGxlbCB0byBsYXN0RmlyZU1zKSBhbmQgaXMgd2lwZWQgb24gbWFuYWdlclxuLy8gcmVzdGFydCwgd2hpY2ggaXMgY29ycmVjdC5cbmNvbnN0IHJlY292ZXJpbmcgPSBuZXcgU2V0KCk7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIG5zLmRpc2FibGVMb2coXCJzbGVlcFwiKTtcbiAgLy8gZ2V0U2VydmVyTWF4UmFtIGFuZCBnZXRTZXJ2ZXJVc2VkUmFtIGFyZSBjYWxsZWQgZm9yIEVWRVJZXG4gIC8vIHdvcmtlciBpbiBsaXN0V29ya2VycygpIG9uIEVWRVJZIGJhdGNoIGRpc3BhdGNoIChzbWFsbGVzdC1maXRcbiAgLy8gbG9hZC1iYWxhbmNpbmcg4oCUIHNlZSBsaWIvaHdndy5qcykuIFdpdGggMTkgd29ya2VycyBhbmQgNCBqb2JzXG4gIC8vIHBlciBiYXRjaCwgdGhhdCdzIDE5KjIqNCA9IDE1MiBsb2cgbGluZXMgcGVyIHRpY2ssIGRyb3duaW5nIG91dFxuICAvLyB0aGUgcGVyLXRpY2sgc3VtbWFyeSBhbmQgdGhlICgtLXZlcmJvc2UpIGNvb2xkb3duIGRldGFpbC4gVGhlXG4gIC8vIHZhbHVlcyBhcmUgc3RhdGljIChtYXgpIGFuZCBlYXNpbHktcmVhZGFibGUgKHVzZWQpLCBzbyBkaXNhYmxpbmdcbiAgLy8gdGhlIGxvZyBpcyBzYWZlIGFuZCB0aGUgcmlnaHQgbW92ZS5cbiAgbnMuZGlzYWJsZUxvZyhcImdldFNlcnZlck1heFJhbVwiKTtcbiAgbnMuZGlzYWJsZUxvZyhcImdldFNlcnZlclVzZWRSYW1cIik7XG4gIC8vIG5zLnNjYW4oKSBpcyBjYWxsZWQgYnkgbGlzdFJlYWNoYWJsZVNlcnZlcnMoKSBpbiBwaWNrVGFyZ2V0cygpXG4gIC8vIOKAlCBvbmNlIHBlciByZWFjaGFibGUgc2VydmVyLCBwZXIgdGljay4gV2l0aCB+NTAgcmVhY2hhYmxlXG4gIC8vIHNlcnZlcnMsIHRoYXQncyA1MCBgc2NhbjogcmV0dXJuZWQgTiBjb25uZWN0aW9uc2AgbGluZXMgcGVyXG4gIC8vIHRpY2ssIGRyb3duaW5nIHRoZSB0ZXJtaW5hbC4gVGhlIHJldHVybiB2YWx1ZSBpcyBzdHJ1Y3R1cmFsXG4gIC8vICh1c2VkIGZvciBCRlMpLCBub3QgaW50ZXJlc3RpbmcgdG8gdGhlIHVzZXIuXG4gIG5zLmRpc2FibGVMb2coXCJzY2FuXCIpO1xuICAvLyBNYW5hZ2VyIGlzIGF1dG8tcXVpZXQgYnkgZGVmYXVsdCDigJQgaXQgcnVucyBldmVyeSA2MHMgYW5kIHRoZVxuICAvLyBwZXItdGljayBzdW1tYXJ5IG9ubHkgZ29lcyB0byB0aGUgdGVybWluYWwgd2hlbiBzb21ldGhpbmdcbiAgLy8gaW50ZXJlc3RpbmcgaGFwcGVuZWQgKGEgYmF0Y2ggbGF1bmNoZWQsIG9yIHRoZSB0YXJnZXQgbGlzdFxuICAvLyBiZWNhbWUgZW1wdHkpLiBGb3IgZmlyc3QtdGltZSBzZXR1cCBvciBkZWJ1Z2dpbmcsIHJ1biB3aXRoXG4gIC8vIC0tdmVyYm9zZSB0byBzZWUgZXZlcnkgdGljay5cbiAgY29uc3QgdmVyYm9zZSA9IG5zLmFyZ3MuaW5jbHVkZXMoXCItLXZlcmJvc2VcIik7XG4gIGlmICh2ZXJib3NlKSB7XG4gICAgbnMudHByaW50KGBtYW5hZ2VyOiBzdGFydGVkLCBNQVhfVEFSR0VUUz0ke01BWF9UQVJHRVRTfSBiYXRjaEdhcD0ke0JBVENIX0dBUF9NU31tcywgb3V0cHV0PXZlcmJvc2VgKTtcbiAgfVxuXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3QgdGlja1N0YXJ0ID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBjb3VudGVycyA9IHsgcGxhbm5lZDogMCwgbGF1bmNoZWQ6IDAsIFwiU0tJUC1yYW1cIjogMCwgXCJTS0lQLXJvb3RcIjogMCwgXCJTS0lQLWxldmVsXCI6IDAsIFwiU0tJUC1tcFwiOiAwLCBcIlNLSVAtY29vbGRvd25cIjogMCwgXCJyZWNvdmVyeS1maXJpbmdcIjogMCwgXCJlbnRlci1yZWNvdmVyeVwiOiAwLCBcImxlYXZlLXJlY292ZXJ5XCI6IDAsIFwiRkFJTC1leGVjXCI6IDAgfTtcbiAgICBjb25zdCB0YXJnZXRzID0gcGlja1RhcmdldHMobnMpO1xuICAgIGNvbnN0IGNvb2xkb3duUmVtYWluaW5nID0gbmV3IE1hcCgpOyAgLy8gZm9yIC0tdmVyYm9zZTogaG93IG1hbnkgbXMgdW50aWwgZWFjaCB0YXJnZXQgaXMgZWxpZ2libGVcblxuICAgIC8vIEJ1aWxkIHRoZSBmbGVldCBPTkNFIHBlciB0aWNrIGFuZCBzaGFyZSBpdCBhY3Jvc3MgYWxsIHRhcmdldHMuXG4gICAgLy8gVGhlIGZsZWV0IChob21lICsgcHNlcnZzICsgcm9vdGVkLXdvcmxkLXNlcnZlcnMpIGlzIHRoZVxuICAgIC8vIHdvcmtlciBwb29sIGZvciBub3JtYWwtbW9kZSBiYXRjaGVzLiBJdCdzIHJlYnVpbHQgcGVyLWpvYlxuICAgIC8vIGluc2lkZSB0aGUgcGVyLXRhcmdldCBsb29wIChQaXRmYWxsIDY6IHN0YWxlIHdvcmtlciBsaXN0c1xuICAgIC8vIHByb2R1Y2UgRkFJTC1leGVjIGFmdGVyIHNsZWVwcyksIGJ1dCB0aGUgaW5pdGlhbCBidWlsZCBoZXJlXG4gICAgLy8gQnVpbGQgdGhlIGZsZWV0IE9OQ0UgcGVyIHRpY2suIFRoZSBCRlMgc2NhbiBpblxuICAgIC8vIGxpc3RSZWFjaGFibGVTZXJ2ZXJzIGlzIH43MCBucy5zY2FuIGNhbGxzOyBjYWxsaW5nIGl0IDQ1XG4gICAgLy8gdGltZXMgcGVyIHRpY2sgKDkgdGFyZ2V0cyDDlyA1IGluIHRoZSBwZXItdGFyZ2V0ICtcbiAgICAvLyBwZXItam9iIGxvb3BzKSBpcyB3aGF0IHdhcyBoYW5naW5nIHRoZSBicm93c2VyLiBUaGVcbiAgICAvLyBmbGVldCdzIE1FTUJFUlNISVAgKHdoaWNoIHNlcnZlcnMgYXJlIHdvcmtlcnMpIGlzIHN0YWJsZVxuICAgIC8vIGZvciB0aGUgd2hvbGUgdGljazsgb25seSB0aGUgcGVyLWhvc3QgZnJlZSBSQU0gY2hhbmdlcyBhc1xuICAgIC8vIHdlIHBsYWNlIHdvcmtlcnMuIFRoZSBwZXItam9iIGByZWNoZWNrRmxlZXRSYW0oKWAgY2FsbFxuICAgIC8vIHJlLXJlYWRzIG1heC91c2VkIGZvciB0aGUgY2FjaGVkIGhvc3QgbGlzdCB3aXRob3V0XG4gICAgLy8gcmUtcnVubmluZyB0aGUgQkZTLlxuICAgIGNvbnN0IGZsZWV0ID0gYnVpbGRGbGVldChucyk7XG4gICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgIG5zLnByaW50KGBtYW5hZ2VyOiBmbGVldCBidWlsdDogJHtmbGVldC5sZW5ndGh9IGhvc3RzLCBmcmVlPSR7ZmxlZXRGcmVlKG5zLCBmbGVldCkudG9GaXhlZCgxKX1HQmApO1xuICAgIH1cbiAgICAvLyBTdGFnZSB3b3JrZXIgc2NyaXB0cyB0byB0aGUgd2hvbGUgZmxlZXQgT05DRSBwZXIgdGljay5cbiAgICAvLyBhbGxvY2F0ZUJhdGNoIHVzZWQgdG8gZG8gdGhpcyBwZXIgY2FsbCwgd2hpY2ggbWVhbnQgMzZcbiAgICAvLyBzY3AgcGFzc2VzIHBlciB0aWNrIMOXIDM5IGhvc3RzIMOXIDMgc2NyaXB0cyA9IDQyMTIgc2NwXG4gICAgLy8gY2FsbHMgcGVyIHRpY2suIG5zLnNjcCBpcyBpZGVtcG90ZW50IGJ1dCBlYWNoIGNhbGwgaXMgYVxuICAgIC8vIFdlYlNvY2tldCByb3VuZC10cmlwOyBzdGFnaW5nIG9uY2UgY3V0cyB0aGF0IHRvIDExNy5cbiAgICBzdGFnZVdvcmtlcnMobnMsIGZsZWV0KTtcblxuICAgIGZvciAobGV0IHRpID0gMDsgdGkgPCB0YXJnZXRzLmxlbmd0aDsgdGkrKykge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gdGFyZ2V0c1t0aV07XG4gICAgICBjb25zdCBzID0gbnMuZ2V0U2VydmVyKHRhcmdldCk7XG4gICAgICAvLyBwaWNrVGFyZ2V0cygpIGFscmVhZHkgZmlsdGVyZWQsIGJ1dCBiZSBkZWZlbnNpdmUg4oCUIHRoZVxuICAgICAgLy8gd29ybGQgY2FuIGNoYW5nZSBiZXR3ZWVuIHRpY2tzLlxuICAgICAgaWYgKCFzLmhhc0FkbWluUmlnaHRzKSB7IGNvdW50ZXJzW1wiU0tJUC1yb290XCJdKys7IGNvbnRpbnVlOyB9XG4gICAgICBpZiAocy5yZXF1aXJlZEhhY2tpbmdTa2lsbCA+IG5zLmdldFBsYXllcigpLnNraWxscy5oYWNraW5nKSB7IGNvdW50ZXJzW1wiU0tJUC1sZXZlbFwiXSsrOyBjb250aW51ZTsgfVxuICAgICAgaWYgKCFzLm1vbmV5TWF4IHx8IHMubW9uZXlNYXggPD0gMCkgeyBjb3VudGVyc1tcIlNLSVAtbXBcIl0rKzsgY29udGludWU7IH1cblxuICAgICAgLy8gUGVyLXRhcmdldCBjb29sZG93bjogaWYgd2UgZmlyZWQgYSBiYXRjaCBhZ2FpbnN0IHRoaXNcbiAgICAgIC8vIHRhcmdldCBsZXNzIHRoYW4gKHdlYWtlblRpbWUgKyBidWZmZXIpIGFnbywgc2tpcC4gVGhlXG4gICAgICAvLyBwcmV2aW91cyBiYXRjaCdzIHdlYWtlbiBoYXNuJ3QgbGFuZGVkIHlldCwgc28gc2VjdXJpdHlcbiAgICAgIC8vIGlzIHN0aWxsIGFib3ZlIG1pbiBhbmQgbW9uZXlBdmFpbGFibGUgaXMgbWlkLXJlZ3Jvdy5cbiAgICAgIC8vIEZpcmluZyBub3cgbWVhbnM6IGhhY2suanMgZ2V0cyAkMCAodGhlIHJlZ3JvdyBpcyBwYXJ0aWFsKSxcbiAgICAgIC8vIHRoZSBiYXRjaCdzIHBsYW5CYXRjaCBpcyBzaXplZCBvZmYgc3RhbGUgc2VydmVyIHN0YXRlLCBhbmRcbiAgICAgIC8vIHRoZSBjbHVzdGVyIGJ1cm5zIHRocmVhZHMgZm9yIG5vdGhpbmcuXG4gICAgICAvL1xuICAgICAgLy8gVGhlIGNvb2xkb3duIGlzIHBlci10YXJnZXQgYmVjYXVzZSB3ZWFrZW5UaW1lIHZhcmllcyA1LTEweFxuICAgICAgLy8gYWNyb3NzIHRoZSBuZXR3b3JrLiBBIHNpbmdsZSBmaXhlZCBjb29sZG93biB3b3VsZCBlaXRoZXJcbiAgICAgIC8vIGJlIHRvbyBzaG9ydCBmb3IgdGhlIHNsb3cgdGFyZ2V0cyBvciB3YXN0ZSBjeWNsZXMgb24gdGhlXG4gICAgICAvLyBmYXN0IG9uZXMuXG4gICAgICAvL1xuICAgICAgLy8gV2UgcmVhZCB0aGUgdGFyZ2V0J3Mgd2Vha2VuVGltZSBmcm9tIHRoZSBzZXJ2ZXIgb2JqZWN0XG4gICAgICAvLyBkaXJlY3RseSAobm8gbmVlZCB0byBjYWxsIHBsYW5CYXRjaCBmb3IgdGhlIGdhdGUpLiBJZiB3ZVxuICAgICAgLy8gY2FuJ3QgcmVhZCBpdCAodGFyZ2V0IGRpc2FwcGVhcmVkIGJldHdlZW4gcGlja1RhcmdldHMgYW5kXG4gICAgICAvLyBoZXJlKSwgdHJlYXQgYXMgb24tY29vbGRvd24g4oCUIGJldHRlciBzYWZlIHRoYW4gcmFjaW5nXG4gICAgICAvLyBhZ2FpbnN0IGEgc2VydmVyIHdlIGNhbid0IGludHJvc3BlY3QuXG4gICAgICBsZXQgY29vbGRvd25NcztcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvb2xkb3duTXMgPSBucy5nZXRXZWFrZW5UaW1lKHRhcmdldCkgKyBDT09MRE9XTl9CVUZGRVJfTVM7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvdW50ZXJzW1wiU0tJUC1jb29sZG93blwiXSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxhc3RGaXJlID0gbGFzdEZpcmVNcy5nZXQodGFyZ2V0KTtcbiAgICAgIGlmICh0eXBlb2YgbGFzdEZpcmUgPT09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgY29uc3QgZWxhcHNlZCA9IERhdGUubm93KCkgLSBsYXN0RmlyZTtcbiAgICAgICAgaWYgKGVsYXBzZWQgPCBjb29sZG93bk1zKSB7XG4gICAgICAgICAgY291bnRlcnNbXCJTS0lQLWNvb2xkb3duXCJdKys7XG4gICAgICAgICAgaWYgKHZlcmJvc2UpIGNvb2xkb3duUmVtYWluaW5nLnNldCh0YXJnZXQsIE1hdGgucm91bmQoKGNvb2xkb3duTXMgLSBlbGFwc2VkKSAvIDEwMDApKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBpc0hlYWx0aHkgZ2F0ZSAoc2tlZXNsZXIgcGF0dGVybiwgZmxlZXQtYmF0Y2hlci5qczoxMzEtMTM3KS5cbiAgICAgIC8vIFRoZSBza2Vlc2xlciBwYXR0ZXJuIHJlZnVzZXMgdG8gZmlyZSBIV0dXIHVubGVzcyB0aGVcbiAgICAgIC8vIHRhcmdldCBpcyBhdCA+PSA1MCUgw5cgKDEgLSBoYWNrRnJhYykgw5cgbWF4TW9uZXkgQU5EXG4gICAgICAvLyBjdXJTZWMgPD0gbWluU2VjICsgNS4gV2l0aG91dCB0aGlzIGdhdGUsIGEgZHJhaW5lZCB0YXJnZXRcbiAgICAgIC8vIChtb25leUF2YWlsYWJsZSA9ICQwIGFmdGVyIGEgYmFkIGJhdGNoKSBnZXRzIGZpcmVkIG9uXG4gICAgICAvLyBhZ2FpbiwgaGFjay5qcyBzdGVhbHMgJDAsIGdyb3cuanMgcnVucyB0aGUgZnVsbCByZWdyb3csXG4gICAgICAvLyB0aGUgdGFyZ2V0IHNwZW5kcyBhIGZ1bGwgd2Vha2VuVGltZSByZWNvdmVyaW5nLCBhbmQgdGhlXG4gICAgICAvLyBpbmNvbWUgc3RyZWFtIGlzIGEgZnJhY3Rpb24gb2Ygd2hhdCBpdCB3b3VsZCBiZSB3aXRoIGFcbiAgICAgIC8vIGhlYWx0aHkgdGFyZ2V0LlxuICAgICAgLy9cbiAgICAgIC8vIFRoZSB1c2VyJ3MgZWFybGllciBzeW1wdG9tIOKAlCAkMS41NDlCIHNwZW50LCAkOC43TSBlYXJuZWRcbiAgICAgIC8vIOKAlCB3YXMgY2F1c2VkIGJ5IGV4YWN0bHkgdGhpcy4gV2l0aCBNT05FWV9GUkFDVElPTj0wLjUwXG4gICAgICAvLyBhbmQgbm8gaXNIZWFsdGh5IGdhdGUsIHRoZSBtYW5hZ2VyIHdhcyBmaXJpbmcgSFdHVyBvblxuICAgICAgLy8gdGFyZ2V0cyB0aGF0IGhhZCBiZWVuIGRyYWluZWQsIGdldHRpbmcgJDAgYmFjaywgcnVubmluZ1xuICAgICAgLy8gdGhlIGZ1bGwgcmVncm93LCBhbmQgcmVwZWF0aW5nLiBUaGUgaW5jb21lIHdhcyBhIHJlc2lkdWFsXG4gICAgICAvLyBmcm9tIGEgYnJpZWYgd2luZG93IHdoZW4gdGhlIHRhcmdldHMgaGFwcGVuZWQgdG8gYmVcbiAgICAgIC8vIGhlYWx0aHkuXG4gICAgICAvL1xuICAgICAgLy8gU291cmNlZCBmcm9tIHNrZWVzbGVyL2JpdGJ1cm5lci1jb21tYW5kZXIvZmxlZXQtYmF0Y2hlci5qcy5cbiAgICAgIC8vIGlzSGVhbHRoeSBpcyB0aGUgVE9MRVJBTlQgY2hlY2sgKGN1clNlYyA8PSBtaW5TZWMgKyA1LFxuICAgICAgLy8gbW9uZXkgPj0gNTAlIMOXICgxIC0gaGFja0ZyYWMpIMOXIG1heE1vbmV5KS4gVGhlIHN0cmljdGVyXG4gICAgICAvLyBpc1ByZXBwZWQgKGN1clNlYyA8PSBtaW5TZWMgKyAwLjAxLCBtb25leSA+PSA5OS45JSDDl1xuICAgICAgLy8gbWF4TW9uZXkpIGlzIHVzZWQgaW5zaWRlIHRoZSBwcmVwKCkgZnVuY3Rpb24gZm9yIGJyaW5naW5nXG4gICAgICAvLyBhIHRhcmdldCBiYWNrIGZyb20gYSBmdWxseS1kcmFpbmVkIHN0YXRlLlxuICAgICAgaWYgKCFpc0hlYWx0aHkobnMsIHRhcmdldCwgTU9ORVlfRlJBQ1RJT04sIEhFQUxUSF9NT05FWV9GUkFDVElPTiwgSEVBTFRIX1NFQ19UT0xFUkFOQ0UpKSB7XG4gICAgICAgIGNvdW50ZXJzW1wiU0tJUC11bmhlYWx0aHlcIl0rKztcbiAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICBucy5wcmludChgbWFuYWdlcjogU0tJUC11bmhlYWx0aHkgdGFyZ2V0PSR7dGFyZ2V0fSBjdXJNb25leT0kJHtucy5nZXRTZXJ2ZXJNb25leUF2YWlsYWJsZSh0YXJnZXQpLnRvTG9jYWxlU3RyaW5nKCl9IG1heE1vbmV5PSQke25zLmdldFNlcnZlck1heE1vbmV5KHRhcmdldCkudG9Mb2NhbGVTdHJpbmcoKX0gY3VyU2VjPSR7bnMuZ2V0U2VydmVyU2VjdXJpdHlMZXZlbCh0YXJnZXQpLnRvRml4ZWQoMil9IG1pblNlYz0ke25zLmdldFNlcnZlck1pblNlY3VyaXR5TGV2ZWwodGFyZ2V0KS50b0ZpeGVkKDIpfWApO1xuICAgICAgICB9XG4gICAgICAgIC8vIFR3byBjYXNlcyB3aGVuIGlzSGVhbHRoeSByZXR1cm5zIGZhbHNlOlxuICAgICAgICAvL1xuICAgICAgICAvLyAgKEEpIGN1clNlYyA+IG1pblNlYyArIDUgIChzZWN1cml0eSBkcmlmdGVkKSDigJQgZmlyZSBhXG4gICAgICAgIC8vICAgICAgZHJhaW4gdG8gYnJpbmcgc2VjIGJhY2sgZG93bi4gVGhpcyBpcyB0aGUgb3JpZ2luYWxcbiAgICAgICAgLy8gICAgICBza2Vlc2xlciBwYXR0ZXJuLlxuICAgICAgICAvL1xuICAgICAgICAvLyAgKEIpIG1vbmV5IDwgNTAlIMOXICgxIC0gaGFja0ZyYWMpIMOXIG1heE1vbmV5IChkcmFpbmVkXG4gICAgICAgIC8vICAgICAgbW9uZXksIHNlYyBhbHJlYWR5IGF0IG1pbikg4oCUIHRoZSB0YXJnZXQgaXMgd2FpdGluZ1xuICAgICAgICAvLyAgICAgIGZvciB0aGUgbmF0dXJhbCByZWdyb3cgdGltZXIuIFRoZSBkcmFpbiBpcyBhIE5PLU9QXG4gICAgICAgIC8vICAgICAgYmVjYXVzZSBzZWNUb0Ryb3AgPSAwLCBhbmQgZmlyaW5nIGEgMS10aHJlYWQgd2Vha2VuXG4gICAgICAgIC8vICAgICAgZXZlcnkgdGljayBpcyBqdXN0IHdhc3RpbmcgUkFNICh0aGUgcHJldmlvdXMgdmVyc2lvblxuICAgICAgICAvLyAgICAgIG9mIHRoaXMgY29kZSBnZW5lcmF0ZWQgMTQwOCsgd2Vha2VuLmpzIHByb2Nlc3Nlc1xuICAgICAgICAvLyAgICAgIGFjcm9zcyB0aGUgcHNlcnZzIGluIH4yIG1pbnV0ZXMsIHNlZSBjb21taXRcbiAgICAgICAgLy8gICAgICAxZjJmMzhjKS5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gRm9yIChCKSB3ZSBqdXN0IGBjb250aW51ZWAg4oCUIHdhaXQgZm9yIHRoZSByZWdyb3cgdGltZXJcbiAgICAgICAgLy8gdG8gcmVmaWxsIHRoZSB0YXJnZXQsIHRoZW4gdGhlIG5leHQgdGljaydzIGlzSGVhbHRoeVxuICAgICAgICAvLyBjaGVjayB3aWxsIHJldHVybiB0cnVlIGFuZCB0aGUgbm9ybWFsIEhXR1cgcGF0aCBmaXJlcy5cbiAgICAgICAgLy8gVGhpcyBpcyB0aGUgY29ycmVjdCBiZWhhdmlvcjogZG9uJ3QgdHJ5IHRvIFwiZHJhaW5cIiBtb25leVxuICAgICAgICAvLyBvdXQgb2YgYSBkcmFpbmVkIHRhcmdldCwgdGhlIHJlZ3JvdyBpcyBhdXRvbWF0aWMuXG4gICAgICAgIGNvbnN0IGN1clNlYyA9IG5zLmdldFNlcnZlclNlY3VyaXR5TGV2ZWwodGFyZ2V0KTtcbiAgICAgICAgY29uc3QgbWluU2VjID0gbnMuZ2V0U2VydmVyTWluU2VjdXJpdHlMZXZlbCh0YXJnZXQpO1xuICAgICAgICBjb25zdCBzZWNUb0Ryb3AgPSBNYXRoLm1heCgwLCBjdXJTZWMgLSBtaW5TZWMgLSBIRUFMVEhfU0VDX1RPTEVSQU5DRSk7XG4gICAgICAgIGlmIChzZWNUb0Ryb3AgPD0gMCkge1xuICAgICAgICAgIC8vIENhc2UgKEIpOiBkcmFpbmVkIG1vbmV5LCBzZWMgaXMgZmluZS4gU2tpcCDigJQgbGV0XG4gICAgICAgICAgLy8gdGhlIG5hdHVyYWwgcmVncm93IGZpbmlzaC4gRG9uJ3QgZmlyZSBhIG5vLW9wIHdlYWtlbi5cbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBDYXNlIChBKTogc2VjdXJpdHkgZHJpZnRlZC4gRmlyZSBhIHNpbmdsZSBkcmFpbiBvbiB0aGVcbiAgICAgICAgLy8gYmlnZ2VzdCBmcmVlIHdvcmtlci4gdGhyZWFkcyA9IGNlaWwoc2VjVG9Ecm9wIC8gMC4wNSlcbiAgICAgICAgLy8gYmVjYXVzZSBlYWNoIHdlYWtlbiB0aHJlYWQgZHJvcHMgMC4wNSBzZWN1cml0eS5cbiAgICAgICAgY29uc3Qgd2Vha2VuUmFtID0gbnMuZ2V0U2NyaXB0UmFtKFwid2Vha2VuLmpzXCIsIFwiaG9tZVwiKTtcbiAgICAgICAgY29uc3Qgd29ya2VycyA9IGxpc3RXb3JrZXJzKG5zKTtcbiAgICAgICAgY29uc3QgYmlnZ2VzdFdvcmtlciA9IHdvcmtlcnMucmVkdWNlKChiZXN0LCB3KSA9PiB7XG4gICAgICAgICAgY29uc3QgZnJlZSA9IG5zLmdldFNlcnZlck1heFJhbSh3KSAtIG5zLmdldFNlcnZlclVzZWRSYW0odyk7XG4gICAgICAgICAgcmV0dXJuIGZyZWUgPiBiZXN0LmZyZWUgPyB7IGg6IHcsIGZyZWUgfSA6IGJlc3Q7XG4gICAgICAgIH0sIHsgaDogbnVsbCwgZnJlZTogMCB9KTtcbiAgICAgICAgaWYgKGJpZ2dlc3RXb3JrZXIuaCAmJiBiaWdnZXN0V29ya2VyLmZyZWUgPj0gd2Vha2VuUmFtKSB7XG4gICAgICAgICAgY29uc3QgdGhyZWFkcyA9IE1hdGguY2VpbChzZWNUb0Ryb3AgLyAwLjA1KTtcbiAgICAgICAgICBpZiAobnMuZXhlYyhcIndlYWtlbi5qc1wiLCBiaWdnZXN0V29ya2VyLmgsIHRocmVhZHMsIHRhcmdldCkgPiAwKSB7XG4gICAgICAgICAgICBjb3VudGVyc1tcImRyYWluaW5nXCJdID0gKGNvdW50ZXJzW1wiZHJhaW5pbmdcIl0gfHwgMCkgKyAxO1xuICAgICAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICAgICAgbnMucHJpbnQoYG1hbmFnZXI6IERSQUlOICR7YmlnZ2VzdFdvcmtlci5ofSAke3RocmVhZHN9IHdlYWtlbiB0aHJlYWRzIHRhcmdldD0ke3RhcmdldH0gKGN1clNlYz0ke2N1clNlYy50b0ZpeGVkKDIpfSwgbWluU2VjPSR7bWluU2VjLnRvRml4ZWQoMil9LCBzZWNUb0Ryb3A9JHtzZWNUb0Ryb3AudG9GaXhlZCgyKX0pYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBsZXQgcGxhbjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHBsYW4gPSBwbGFuQmF0Y2gobnMsIHRhcmdldCwgeyBtb25leUZyYWN0aW9uOiBNT05FWV9GUkFDVElPTiB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gU3VyZmFjZSBwbGFuQmF0Y2ggZmFpbHVyZXMgdG8gdGhlIHRlcm1pbmFsIHNvIHRoZSB1c2VyXG4gICAgICAgIC8vIGNhbiBzZWUgV0hZIGJhdGNoZXMgYXJlbid0IGxhdW5jaGluZy4gV2l0aG91dCB0aGlzLFxuICAgICAgICAvLyB0aGUgcGVyLXRpY2sgc3VtbWFyeSBwcmludHMgXCIobm8gY2hhbmdlcylcIiBhbmQgdGhlXG4gICAgICAgIC8vIGVycm9yIGlzIGJ1cmllZCBpbiB0aGUgaW4tZ2FtZSBsb2cuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIEJpdGJ1cm5lciAzLnggc29tZXRpbWVzIHRocm93cyBub24tRXJyb3IgdmFsdWVzIHdoZXJlXG4gICAgICAgIC8vIC5tZXNzYWdlIGlzIHVuZGVmaW5lZC4gV2UgY29lcmNlIHNhZmVseTpcbiAgICAgICAgLy8gICAtIEVycm9yIGluc3RhbmNlOiAgdXNlIGUubWVzc2FnZVxuICAgICAgICAvLyAgIC0gc3RyaW5nL251bWJlcjogICB1c2UgU3RyaW5nKGUpXG4gICAgICAgIC8vICAgLSBudWxsL3VuZGVmaW5lZDogIHVzZSBcInRocmV3OiA8dmFsdWU+XCJcbiAgICAgICAgLy8gICAtIG9iamVjdDogICAgICAgICAgSlNPTi5zdHJpbmdpZnkgdGhlIHZhbHVlICh0cnVuY2F0ZWQpXG4gICAgICAgIGxldCB3aGF0O1xuICAgICAgICBpZiAoZSA9PSBudWxsKSB7XG4gICAgICAgICAgd2hhdCA9IGB0aHJldzogJHtlfWA7ICAvLyBsaXRlcmFsbHkgXCJ0aHJldzogbnVsbFwiIG9yIFwidGhyZXc6IHVuZGVmaW5lZFwiXG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgZS5tZXNzYWdlKSB7XG4gICAgICAgICAgd2hhdCA9IGUubWVzc2FnZTtcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgIHRyeSB7IHdoYXQgPSBgdGhyZXcgb2JqZWN0OiAke0pTT04uc3RyaW5naWZ5KGUpLnNsaWNlKDAsIDIwMCl9YDsgfVxuICAgICAgICAgIGNhdGNoIHsgd2hhdCA9IGB0aHJldyBvYmplY3Q6IDxub3Qgc2VyaWFsaXphYmxlPmA7IH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB3aGF0ID0gU3RyaW5nKGUpO1xuICAgICAgICB9XG4gICAgICAgIC8vIElmIHdlIGhhdmUgc2VydmVyIHN0YXRlLCBzdXJmYWNlIGl0IGlubGluZSBzbyB0aGUgdXNlclxuICAgICAgICAvLyBkb2Vzbid0IGhhdmUgdG8gZ3JlcCB0aHJvdWdoIGxvZ3MgdG8gdW5kZXJzdGFuZCB0aGVcbiAgICAgICAgLy8gY29udGV4dC4gVGhpcyBpcyB0aGUgbW9zdCB1c2VmdWwgcGllY2Ugb2YgaW5mby5cbiAgICAgICAgbGV0IGN0eCA9IFwiXCI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgc3MgPSBucy5nZXRTZXJ2ZXIodGFyZ2V0KTtcbiAgICAgICAgICBjdHggPSBgIFttb25leU1heD0ke3NzLm1vbmV5TWF4fSBtb25leUF2YWlsYWJsZT0ke3NzLm1vbmV5QXZhaWxhYmxlfSBgICtcbiAgICAgICAgICAgICAgICBgbWluU2VjPSR7c3MubWluRGlmZmljdWx0eX0gY3VyU2VjPSR7c3MuaGFja0RpZmZpY3VsdHl9IGAgK1xuICAgICAgICAgICAgICAgIGByZXFIYWNrPSR7c3MucmVxdWlyZWRIYWNraW5nU2tpbGx9IGhhc1Jvb3Q9JHtzcy5oYXNBZG1pblJpZ2h0c31dYDtcbiAgICAgICAgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgICAgIGNvdW50ZXJzW1wiRkFJTC1wbGFuXCJdID0gKGNvdW50ZXJzW1wiRkFJTC1wbGFuXCJdIHx8IDApICsgMTtcbiAgICAgICAgbnMudHByaW50KGBtYW5hZ2VyOiBwbGFuQmF0Y2goJHt0YXJnZXR9KSBmYWlsZWQ6ICR7d2hhdH0ke2N0eH1gKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb3VudGVycy5wbGFubmVkKys7XG5cbiAgICAgIC8vIFN0YWdnZXIgdGhlIGFycml2YWwgYnkgdGkgKiBCQVRDSF9TVEFHR0VSX01TIHNvIHRhcmdldHNcbiAgICAgIC8vIHByb2Nlc3MgaW4gYSByb2xsaW5nIHdhdmUsIG5vdCBhbGwgYXQgb25jZS5cbiAgICAgIGNvbnN0IHRhcmdldE9mZnNldCA9IHRpICogQkFUQ0hfU1RBR0dFUl9NUztcbiAgICAgIC8vIENvdW50IGhvdyBtYW55IG9mIHRoaXMgdGFyZ2V0J3MgNCBqb2JzIHN1Y2Nlc3NmdWxseVxuICAgICAgLy8gbGF1bmNoZWQuIE9ubHkgcmVjb3JkIGxhc3RGaXJlTXNbdGFyZ2V0XSBpZiBBTEwgNCBtYWRlIGl0XG4gICAgICAvLyDigJQgYSBwYXJ0aWFsIGJhdGNoIChlLmcuIGhhY2sgbGF1bmNoZWQgYnV0IHdlYWtlbiBTS0lQLXJhbSdkKVxuICAgICAgLy8gbGVhdmVzIHRoZSB0YXJnZXQgaW4gYW4gaW5jb25zaXN0ZW50IHN0YXRlIGFuZCB3ZSBzaG91bGRcbiAgICAgIC8vIE5PVCBwdXNoIHRoZSBjb29sZG93biBmb3J3YXJkLCBiZWNhdXNlIHRoZSBuZXh0IHRpY2snc1xuICAgICAgLy8gcGxhbkJhdGNoIHdpbGwgc2VlIHRoZSBwYXJ0aWFsLXN0YXRlIGFuZCByZS1maXJlXG4gICAgICAvLyBpbW1lZGlhdGVseSB0byBjbGVhbiB1cC4gUmVjb3JkaW5nIGEgY29vbGRvd24gb24gYVxuICAgICAgLy8gcGFydGlhbCBiYXRjaCB3b3VsZCBtZWFuIHRoZSBwYXJ0aWFsIHN0YXRlIGxpbmdlcnMgZm9yXG4gICAgICAvLyBhIGZ1bGwgd2Vha2VuVGltZSBiZWZvcmUgcmUtYXR0ZW1wdC5cbiAgICAgIC8vXG4gICAgICAvLyBFWENFUFRJT046IGluIHJlY292ZXJ5IG1vZGUsIHRoZSBwbGFuIGhhcyAxIGpvYiAod2Vha2VuXG4gICAgICAvLyBvbmx5KS4gYmF0Y2hMYXVuY2hlZCA9PT0gMSA9PT0gcGxhbi5qb2JzLmxlbmd0aCB3b3JrcyB0aGVcbiAgICAgIC8vIHNhbWUgd2F5LiBUaGUgY29vbGRvd24gc3RpbGwgYXBwbGllcyBzbyB3ZSBkb24ndCByZS1maXJlXG4gICAgICAvLyB0aGUgcmVjb3Zlcnkgd2Vha2VuIHRvbyBzb29uLlxuICAgICAgLy9cbiAgICAgIC8vIEZvciBub3JtYWwtbW9kZSBiYXRjaGVzLCBiYXRjaExhdW5jaGVkID09PSA0IChvbmUgcGVyIGpvYikuXG4gICAgICAvLyBUaGUgZmxlZXQtYmF0Y2hlciBwYXR0ZXJuIChhbGxvY2F0ZUJhdGNoKSBwbGFjZXMgdGhyZWFkc1xuICAgICAgLy8gYWNyb3NzIGhvbWUgKyBwc2VydnMgKyByb290ZWQtd29ybGRzOyB0aGUgXCJjb3VudFwiIGlzIHRoZVxuICAgICAgLy8gcGVyLWpvYiBwbGFjZWQgY291bnQsIHN1bW1lZCB1cC4gSWYgYW55IGpvYiBpcyBwYXJ0aWFsLFxuICAgICAgLy8gd2UgdHJlYXQgdGhlIHdob2xlIGJhdGNoIGFzIGZhaWxlZC5cbiAgICAgIGxldCBiYXRjaExhdW5jaGVkID0gMDtcblxuICAgICAgLy8gVHJhY2sgcmVjb3Zlcnkgc3RhdGUgcGVyIHRhcmdldC4gV2Ugb25seSB0cHJpbnQgb25cbiAgICAgIC8vIHRyYW5zaXRpb25zIChlbnRlcmluZyBvciBsZWF2aW5nIHJlY292ZXJ5IG1vZGUpIHNvIHRoZVxuICAgICAgLy8gdXNlciBzZWVzIFwiaXJvbi1neW06IG5vdyBpbiByZWNvdmVyeSAoZHJpZnQ9NjIwLCAyLTNcbiAgICAgIC8vIGJhdGNoZXMgdG8gY2xlYXIpXCIgb25jZSwgdGhlbiBub3RoaW5nIHVudGlsIGl0IHRyYW5zaXRpb25zXG4gICAgICAvLyBiYWNrIHRvIG5vcm1hbCBIV0dXLiBUaGUgY3VycmVudCBzdGF0ZSBpcyBhbHNvIHZpc2libGUgaW5cbiAgICAgIC8vIHRoZSBwZXItdGljayBzdW1tYXJ5IGlmIC0tdmVyYm9zZSBpcyBzZXQuXG4gICAgICBpZiAocGxhbi5yZWNvdmVyeU1vZGUpIHtcbiAgICAgICAgY291bnRlcnNbXCJyZWNvdmVyeS1maXJpbmdcIl0rKztcbiAgICAgICAgaWYgKCFyZWNvdmVyaW5nLmhhcyh0YXJnZXQpKSB7XG4gICAgICAgICAgY291bnRlcnNbXCJlbnRlci1yZWNvdmVyeVwiXSsrO1xuICAgICAgICAgIHJlY292ZXJpbmcuYWRkKHRhcmdldCk7XG4gICAgICAgICAgLy8gU2lsZW50IOKAlCByZWNvdmVyeSB0cmFuc2l0aW9ucyBhcmUgbm93IFwid29ya2luZyBhc1xuICAgICAgICAgIC8vIGV4cGVjdGVkXCIgZXZlbnRzLiBUaGUgcmVjb3Zlcnkgc3RhdGUgaXMgb2JzZXJ2YWJsZVxuICAgICAgICAgIC8vIGluIHRoZSBjb3VudGVycyAod2hpY2ggc3VyZmFjZSBhcyBwYXJ0IG9mIHRoZVxuICAgICAgICAgIC8vIGVycm9yLW9ubHkgdHByaW50IGFib3ZlIHdoZW4gc29tZXRoaW5nIGVsc2UgZ29lc1xuICAgICAgICAgIC8vIHdyb25nKSBhbmQgaW4gdGhlIHBlci10aWNrIG5zLnByaW50ICh2ZXJib3NlIG1vZGUpLlxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHJlY292ZXJpbmcuaGFzKHRhcmdldCkpIHtcbiAgICAgICAgY291bnRlcnNbXCJsZWF2ZS1yZWNvdmVyeVwiXSsrO1xuICAgICAgICByZWNvdmVyaW5nLmRlbGV0ZSh0YXJnZXQpO1xuICAgICAgICAvLyBTaWxlbnQg4oCUIHNhbWUgcmVhc29uaW5nIGFzIGVudGVyLXJlY292ZXJ5IGFib3ZlLlxuICAgICAgfVxuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAvLyBEaXNwYXRjaDogc3BsaXQgcGVyIGJyYW5jaC5cbiAgICAgIC8vXG4gICAgICAvLyBOb3JtYWwgbW9kZSDihpIgZmxlZXQtYmF0Y2hlciAoYWxsb2NhdGVCYXRjaCkuIFRoZSBmbGVldFxuICAgICAgLy8gaXMgYnVpbHQgb25jZSBwZXIgdGljayAoYWJvdmUgdGhlIHRhcmdldHMgbG9vcCkgYW5kIHNoYXJlZFxuICAgICAgLy8gYWNyb3NzIGFsbCB0YXJnZXRzLiBFYWNoIGpvYidzIHRocmVhZHMgYXJlIGJpbi1wYWNrZWRcbiAgICAgIC8vIGFjcm9zcyB0aGUgd2hvbGUgY2x1c3Rlci4gVGhlIDUlIGhlYWRyb29tIHJ1bGUgKGdhdGVcbiAgICAgIC8vIGJlbG93KSBwcmV2ZW50cyBwYXJ0aWFsIHBsYWNlbWVudHMuXG4gICAgICAvL1xuICAgICAgLy8gUmVjb3ZlcnkgbW9kZSDihpIgc2luZ2xlLWhvc3QgbGFyZ2VzdC1maXRcbiAgICAgIC8vIChmaW5kTGFyZ2VzdFdvcmtlcldpdGhSYW0pLiBSZWNvdmVyeSBpcyB3ZWFrZW4tb25seSB3aXRoXG4gICAgICAvLyBhIHRocmVhZCBjb3VudCB0aGF0IGZpdHMgdGhlIGxhcmdlc3QgZnJlZSB3b3JrZXI7IHRoZVxuICAgICAgLy8gcG9pbnQgaXMgdG8gZHJhaW4gZHJpZnQgYXMgZmFzdCBhcyBwb3NzaWJsZSwgTk9UIHRvXG4gICAgICAvLyBzcHJlYWQgYWNyb3NzIHRoZSBmbGVldC4gU3ByZWFkaW5nIGEgODAwMC10aHJlYWQgd2Vha2VuXG4gICAgICAvLyBhY3Jvc3MgMTEgcHNlcnZzIHdvdWxkIHB1dCA3MjcgdGhyZWFkcyBvbiBlYWNoIDEgVEJcbiAgICAgIC8vIHBzZXJ2LCBidXQgdGhlIGNsdXN0ZXIgY291bGQgZml0IGEgc2luZ2xlIDgwMDAtdGhyZWFkXG4gICAgICAvLyB3ZWFrZW4gb24gaG9tZSAoMSsgVEIgZnJlZSksIGRyYWluaW5nIDjDlyB0aGUgZHJpZnQgcGVyXG4gICAgICAvLyBiYXRjaC4gU2VlIFBpdGZhbGwgMjMuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICBpZiAocGxhbi5yZWNvdmVyeU1vZGUpIHtcbiAgICAgICAgLy8gUmVjb3Zlcnk6IHNhbWUgc2luZ2xlLWhvc3QtbGFyZ2VzdC1maXQgbG9naWMgYXMgYmVmb3JlLlxuICAgICAgICAvLyBTbGVlcCB0aGUgZnVsbCBqb2JEZWxheSAobm8gTWF0aC5taW4gY2FwKSBzbyB0aGVcbiAgICAgICAgLy8gcmVjb3Zlcnkgd2Vha2VuIGxhbmRzIGF0IGl0cyBwbGFubmVkIHRpbWUsIGV2ZW4gb25cbiAgICAgICAgLy8gc2xvdyB0YXJnZXRzICh3ZWFrZW5UaW1lIHVwIHRvIDkwcyArIHRoZSB0YXJnZXRPZmZzZXRcbiAgICAgICAgLy8gc3RhZ2dlcikuIFRoZSBNYXRoLm1pbiBjYXAgd2FzIHRoZSBQaXRmYWxsIDEgYnVnLlxuICAgICAgICBjb25zdCBqb2IgPSBwbGFuLmpvYnNbMF07XG4gICAgICAgIGNvbnN0IGpvYkRlbGF5ID0gam9iLmRlbGF5TXMgKyB0YXJnZXRPZmZzZXQ7XG4gICAgICAgIGlmIChqb2JEZWxheSA+IDApIHtcbiAgICAgICAgICBhd2FpdCBucy5zbGVlcChqb2JEZWxheSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgd29ya2VycyA9IGxpc3RXb3JrZXJzKG5zKTtcbiAgICAgICAgY29uc3QgcmFtUGVyVGhyZWFkID0gbnMuZ2V0U2NyaXB0UmFtKGpvYi5zY3JpcHQsIFwiaG9tZVwiKTtcbiAgICAgICAgY29uc3QgbmVlZCA9IGpvYi50aHJlYWRzICogcmFtUGVyVGhyZWFkO1xuICAgICAgICBjb25zdCB3ID0gZmluZExhcmdlc3RXb3JrZXJXaXRoUmFtKG5zLCB3b3JrZXJzLCBuZWVkKTtcbiAgICAgICAgaWYgKCF3KSB7IGNvdW50ZXJzW1wiU0tJUC1yYW1cIl0rKzsgY29udGludWU7IH1cbiAgICAgICAgY29uc3QgcGlkID0gbnMuZXhlYyhqb2Iuc2NyaXB0LCB3LCBqb2IudGhyZWFkcywgdGFyZ2V0KTtcbiAgICAgICAgaWYgKHBpZCA9PT0gMCkgeyBjb3VudGVyc1tcIkZBSUwtZXhlY1wiXSsrOyBjb250aW51ZTsgfVxuICAgICAgICBjb3VudGVycy5sYXVuY2hlZCsrO1xuICAgICAgICBiYXRjaExhdW5jaGVkID0gMTtcbiAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICBucy5wcmludChgbWFuYWdlcjogUkVDT1ZFUlkgJHtqb2Iuc2NyaXB0fSDihpIgJHt3fSB0YXJnZXQ9JHt0YXJnZXR9IHRocmVhZHM9JHtqb2IudGhyZWFkc30gZGVsYXk9JHtqb2JEZWxheX1tc2ApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBQZXItdGFyZ2V0IHNoYXJlIGNhcCAoTUFYX0ZMRUVUX1NIQVJFID0gMS8zKTogbm8gc2luZ2xlXG4gICAgICAgIC8vIHRhcmdldCBjYW4gY2xhaW0gbW9yZSB0aGFuIDEvMyBvZiB0aGUgZmxlZXQncyB0b3RhbFxuICAgICAgICAvLyBjYXBhY2l0eSBmb3Igb25lIGJhdGNoLiBXaXRob3V0IHRoaXMgZ2F0ZSwgdGhlIHRvcC1cbiAgICAgICAgLy8gcmFua2VkIHRhcmdldCBieSBtb25leU1heCAocGhhbnRhc3kpIGNvbnN1bWVzIHRoZSB3aG9sZVxuICAgICAgICAvLyBjbHVzdGVyIG9uIGV2ZXJ5IHRpY2sgYW5kIHRhcmdldHMgIzIuLiM5IHN0YXJ2ZS4gVGhlXG4gICAgICAgIC8vIGNhcCBpcyBldmFsdWF0ZWQgYWdhaW5zdCB0aGUgQkFUQ0ggKDQgam9icyBzdW1tZWQpLFxuICAgICAgICAvLyBub3QgcGVyLWpvYiDigJQgYSBzaW5nbGUgYmlnIHdlYWtlbiBpcyBmaW5lIGFzIGxvbmcgYXNcbiAgICAgICAgLy8gdGhlIHRvdGFsIGJhdGNoIHN0YXlzIHVuZGVyIHRoZSBzaGFyZS4gU291cmNlZCBmcm9tXG4gICAgICAgIC8vIHNrZWVzbGVyL2JpdGJ1cm5lci1jb21tYW5kZXIuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIENoZWNrIEZJUlNUIChtb3JlIHJlc3RyaWN0aXZlIHRoYW4gNSUgaGVhZHJvb20sIHdoaWNoXG4gICAgICAgIC8vIG9ubHkgcmVzZXJ2ZXMgNSUgb2YgZnJlZSBSQU0gYXMgYSBzYWZldHkgYnVmZmVyKS5cbiAgICAgICAgLy8gU2hhcmluZyBpcyB0aGUgaGlnaGVyLW9yZGVyIGNvbmNlcm46IGV2ZW4gaWYgdGhlIGZsZWV0XG4gICAgICAgIC8vIGhhcyA5NSUgZnJlZSwgbm8gc2luZ2xlIHRhcmdldCBzaG91bGQgY2xhaW0gPiAxLzMuXG4gICAgICAgIGNvbnN0IGJhdGNoUmFtID0gdG90YWxCYXRjaFJhbShucywgcGxhbik7XG4gICAgICAgIGNvbnN0IHNoYXJlQ2FwID0gc2hhcmVSYW1DYXAobnMsIGZsZWV0KTtcbiAgICAgICAgaWYgKGJhdGNoUmFtID4gc2hhcmVDYXApIHtcbiAgICAgICAgICBjb3VudGVyc1tcIlNLSVAtc2hhcmVcIl0gPSAoY291bnRlcnNbXCJTS0lQLXNoYXJlXCJdIHx8IDApICsgMTtcbiAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgbnMucHJpbnQoYG1hbmFnZXI6IFNLSVAtc2hhcmUgdGFyZ2V0PSR7dGFyZ2V0fSBiYXRjaD0ke2JhdGNoUmFtLnRvRml4ZWQoMCl9R0IgY2FwPSR7c2hhcmVDYXAudG9GaXhlZCgwKX1HQiAoTUFYX0ZMRUVUX1NIQVJFPSR7RkxFRVRfREVGQVVMVFMuTUFYX0ZMRUVUX1NIQVJFfSlgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgLy8gNSUgaGVhZHJvb20gZ2F0ZTogdGhlIGZsZWV0LWJhdGNoZXIgKndpbGwqIHBhcnRpYWxseVxuICAgICAgICAvLyBwbGFjZSBhIGJhdGNoIHRoYXQncyB0b28gYmlnLCBsZWF2aW5nIGEgcGFydGlhbCBoYWNrXG4gICAgICAgIC8vIHdpdGhvdXQgYSBtYXRjaGluZyBncm93IOKAlCB0aGUgdGFyZ2V0IHdvdWxkIGRyYWluIHRvICQwXG4gICAgICAgIC8vIGFuZCBuZXZlciByZWZpbGwuIFRoZSBnYXRlIHJlamVjdHMgYW55IGJhdGNoIHdob3NlXG4gICAgICAgIC8vIHRvdGFsIFJBTSBkb2Vzbid0IGZpdCBpbiB0aGUgZmxlZXQncyA5NSUgZnJlZSB3aW5kb3csXG4gICAgICAgIC8vIHNvIHBhcnRpYWwgcGxhY2VtZW50cyBuZXZlciBoYXBwZW4gaW4gcHJhY3RpY2UuXG4gICAgICAgIC8vIChTb3VyY2VkIGZyb20gc2tlZXNsZXIvYml0YnVybmVyLWNvbW1hbmRlci4pXG4gICAgICAgIGNvbnN0IGZyZWUgPSBmbGVldEZyZWUobnMsIGZsZWV0KTtcbiAgICAgICAgaWYgKGJhdGNoUmFtID4gZnJlZSAqIEZMRUVUX0RFRkFVTFRTLkZMRUVUX0hFQURST09NX0ZSQUNUSU9OKSB7XG4gICAgICAgICAgLy8gVGhlIGJhdGNoIHdvdWxkIHBhcnRpYWwtcGxhY2UuIFNLSVAtcmFtIGFuZCBsZXQgdGhlXG4gICAgICAgICAgLy8gbmV4dCB0aWNrIHRyeSBhZ2FpbiAodGhlIGZsZWV0IG1heSBoYXZlIG1vcmUgZnJlZVxuICAgICAgICAgIC8vIFJBTSBhZnRlciB0aGUgcHJldmlvdXMgdGljaydzIHdvcmtlcnMgcmV0dXJuZWQpLlxuICAgICAgICAgIGNvdW50ZXJzW1wiU0tJUC1yYW1cIl0rKztcbiAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgbnMucHJpbnQoYG1hbmFnZXI6IFNLSVAtZmxlZXQtZml0IHRhcmdldD0ke3RhcmdldH0gYmF0Y2g9JHtiYXRjaFJhbS50b0ZpeGVkKDApfUdCIGZsZWV0RnJlZT0ke2ZyZWUudG9GaXhlZCgwKX1HQmApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBGaXJlIHRoZSA0IGpvYnMgYmFjay10by1iYWNrIHZpYSB0aGUgZmxlZXQuIFBlci1qb2JcbiAgICAgICAgLy8gc2xlZXBzIGFyZSBjb21wdXRlZCBpbnNpZGUgYWxsb2NhdGVCYXRjaCAoaXQgYWRkc1xuICAgICAgICAvLyB0YXJnZXRPZmZzZXQgdG8gZWFjaCBqb2IncyBkZWxheU1zKSDigJQgYWN0dWFsbHkgbm8sXG4gICAgICAgIC8vIGFsbG9jYXRlQmF0Y2ggZG9lcyBOT1Qgc2xlZXA7IGl0IGp1c3QgY2FsbHMgbnMuZXhlY1xuICAgICAgICAvLyBmb3IgZWFjaCBqb2IgaW4gb3JkZXIuIFRoZSBzbGVlcHMgYXJlIGRvbmUgSEVSRSBzbyB0aGVcbiAgICAgICAgLy8gdGltaW5nIGludmFyaWFudCAoXCJhbGwgNCBqb2JzIGxhbmQgYXQgYXJyaXZhbFRcIikgaXNcbiAgICAgICAgLy8gcHJlc2VydmVkLiBTbGVlcCB0aGUgRlVMTCBqb2JEZWxheSAobm8gTWF0aC5taW4gY2FwLFxuICAgICAgICAvLyB0aGUgUGl0ZmFsbCAxIGZpeCkuXG4gICAgICAgIGZvciAoY29uc3Qgam9iIG9mIHBsYW4uam9icykge1xuICAgICAgICAgIGNvbnN0IGpvYkRlbGF5ID0gam9iLmRlbGF5TXMgKyB0YXJnZXRPZmZzZXQ7XG4gICAgICAgICAgaWYgKGpvYkRlbGF5ID4gMCkge1xuICAgICAgICAgICAgYXdhaXQgbnMuc2xlZXAoam9iRGVsYXkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBSZWNoZWNrIGZsZWV0IGZyZWUgUkFNIHJpZ2h0IGJlZm9yZSBleGVjIChQaXRmYWxsIDY6XG4gICAgICAgICAgLy8gc3RhbGUgd29ya2VyIGxpc3Qg4oaSIHN0YWxlIFwieWVzIHRoaXMgaGFzIHJvb21cIiBhbnN3ZXJzKS5cbiAgICAgICAgICAvLyBUaGUgZmxlZXQncyBob3N0IGxpc3QgaXMgc3RhYmxlIGZvciB0aGUgd2hvbGUgdGljazsgb25seVxuICAgICAgICAgIC8vIHBlci1ob3N0IGZyZWUgUkFNIGNoYW5nZXMgYXMgd2UgcGxhY2Ugd29ya2Vycy4gV2UgcmVmcmVzaFxuICAgICAgICAgIC8vIFJBTSB3aXRoIHJlY2hlY2tGbGVldFJhbSgpIGluc3RlYWQgb2YgcmVidWlsZCB0aGUgZmxlZXRcbiAgICAgICAgICAvLyAoYXZvaWRzIH43MCBucy5zY2FuIGNhbGxzIMOXIDM2IGNhbGxzIHBlciB0aWNrID0gMjUyMFxuICAgICAgICAgIC8vIHNjYW5zL3NlYywgd2hpY2ggd2FzIGhhbmdpbmcgdGhlIGJyb3dzZXIpLlxuICAgICAgICAgIGNvbnN0IGZyZXNoRmxlZXQgPSByZWNoZWNrRmxlZXRSYW0obnMsIGZsZWV0KTtcbiAgICAgICAgICBjb25zdCBwbGFjZWQgPSBhbGxvY2F0ZUJhdGNoKFxuICAgICAgICAgICAgbnMsIGZyZXNoRmxlZXQsXG4gICAgICAgICAgICAvLyBXcmFwIHRoZSBzaW5nbGUgam9iIGluIGEgMS1lbGVtZW50IHBsYW4gc28gd2UgY2FuXG4gICAgICAgICAgICAvLyByZXVzZSBhbGxvY2F0ZUJhdGNoJ3MgbG9naWMuIChhbGxvY2F0ZUJhdGNoIGZpcmVzXG4gICAgICAgICAgICAvLyBhbGwgNCBqb2JzIGluIG9uZSBjYWxsOyB3ZSB1c2UgaXQgcGVyLWpvYiBoZXJlXG4gICAgICAgICAgICAvLyBzbyB0aGUgcGVyLWpvYiBzbGVlcCBsYW5kcyBhdCB0aGUgcmlnaHQgbW9tZW50LilcbiAgICAgICAgICAgIHsgam9iczogW2pvYl0sIHRvdGFsUmFtOiBqb2IudGhyZWFkcyAqIG5zLmdldFNjcmlwdFJhbShqb2Iuc2NyaXB0LCBcImhvbWVcIikgfSxcbiAgICAgICAgICAgIHRhcmdldCwgMCAvKiB0YXJnZXRPZmZzZXQgYWxyZWFkeSBpbiBqb2JEZWxheSAqLyxcbiAgICAgICAgICAgIERhdGUubm93KCksICAvLyBpZCA9IHdhbGwtY2xvY2sgbXM7IGRpc3Rpbmd1aXNoZXMgdGhpcyBiYXRjaCBmcm9tIHByZXZpb3VzXG4gICAgICAgICAgICB2ZXJib3NlXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAocGxhY2VkLm1pblBsYWNlZCA8IGpvYi50aHJlYWRzKSB7XG4gICAgICAgICAgICAvLyBQYXJ0aWFsIHBsYWNlbWVudCAoc2hvdWxkbid0IGhhcHBlbiB3aXRoIHRoZSA1JVxuICAgICAgICAgICAgLy8gZ2F0ZSBhYm92ZSwgYnV0IGRlZmVuc2l2ZSkuXG4gICAgICAgICAgICBjb25zdCBzaG9ydCA9IGpvYi50aHJlYWRzIC0gcGxhY2VkLm1pblBsYWNlZDtcbiAgICAgICAgICAgIGNvdW50ZXJzW1wiU0tJUC1yYW1cIl0gKz0gc2hvcnQ7XG4gICAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgICBucy5wcmludChgbWFuYWdlcjogU0tJUC1mbGVldC1wYXJ0aWFsIHRhcmdldD0ke3RhcmdldH0gJHtqb2Iuc2NyaXB0fSBwbGFjZWQ9JHtwbGFjZWQubWluUGxhY2VkfS8ke2pvYi50aHJlYWRzfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvdW50ZXJzLmxhdW5jaGVkKys7XG4gICAgICAgICAgYmF0Y2hMYXVuY2hlZCsrO1xuICAgICAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgICAgICBucy5wcmludChgbWFuYWdlcjogJHtqb2Iuc2NyaXB0fSDihpIgZmxlZXQgdGFyZ2V0PSR7dGFyZ2V0fSB0aHJlYWRzPSR7am9iLnRocmVhZHN9IGRlbGF5PSR7am9iRGVsYXl9bXNgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gT25seSBzdGFtcCB0aGUgY29vbGRvd24gaWYgdGhlIGZ1bGwgYmF0Y2ggbGFuZGVkLlxuICAgICAgLy8gU2VlIGNvbW1lbnQgYWJvdmUgdGhlIGJhdGNoTGF1bmNoZWQgZGVjbGFyYXRpb24gZm9yIHdoeVxuICAgICAgLy8gYSBwYXJ0aWFsIGJhdGNoIGlzIHRyZWF0ZWQgYXMgXCJubyBiYXRjaCBoYXBwZW5lZFwiLlxuICAgICAgaWYgKGJhdGNoTGF1bmNoZWQgPT09IHBsYW4uam9icy5sZW5ndGgpIHtcbiAgICAgICAgbGFzdEZpcmVNcy5zZXQodGFyZ2V0LCBEYXRlLm5vdygpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gT2JqZWN0LmVudHJpZXMoY291bnRlcnMpXG4gICAgICAuZmlsdGVyKChbXywgdl0pID0+IHYgPiAwKVxuICAgICAgLm1hcCgoW2ssIHZdKSA9PiBgJHtrfT0ke3Z9YClcbiAgICAgIC5qb2luKFwiIFwiKTtcbiAgICBjb25zdCBlbGFwc2VkID0gRGF0ZS5ub3coKSAtIHRpY2tTdGFydDtcbiAgICAvLyBDb29sZG93biBkZXRhaWwgc3RyaW5nIGZvciAtLXZlcmJvc2UuIExpc3RzIHdoaWNoIHRhcmdldHNcbiAgICAvLyB3ZSBza2lwcGVkIHRoaXMgdGljayBiZWNhdXNlIHRoZXkncmUgc3RpbGwgb24gY29vbGRvd24sXG4gICAgLy8gYW5kIGhvdyBtYW55IHNlY29uZHMgcmVtYWluIGJlZm9yZSBlYWNoIGJlY29tZXMgZWxpZ2libGUuXG4gICAgLy8gQ2hlYXAgdG8gY29tcHV0ZSAoYWxyZWFkeSBpbiB0aGUgTWFwIGZyb20gdGhlIGxvb3ApLCBhbmRcbiAgICAvLyBpdCdzIHRoZSBvbmx5IHdheSB0byB2ZXJpZnkgdGhlIGNvb2xkb3duIGlzIGFjdHVhbGx5IGRvaW5nXG4gICAgLy8gaXRzIGpvYiB3aXRob3V0IHdhdGNoaW5nIHRoZSB3YWxsZXQuXG4gICAgY29uc3QgY2REZXRhaWwgPSB2ZXJib3NlICYmIGNvb2xkb3duUmVtYWluaW5nLnNpemUgPiAwXG4gICAgICA/IGAgY29vbGRvd25zPVske1suLi5jb29sZG93blJlbWFpbmluZy5lbnRyaWVzKCldLm1hcCgoW3QsIHNdKSA9PiBgJHt0fToke3N9c2ApLmpvaW4oXCIsXCIpfV1gXG4gICAgICA6IFwiXCI7XG4gICAgLy8gUGVyLXRpY2sgbG9nIGxpbmU6IG9ubHkgdW5kZXIgLS12ZXJib3NlLCBzaW5jZSB0aGlzXG4gICAgLy8gc2hvd3MgaW4gdGhlIGluLWdhbWUgdGVybWluYWwgdGFpbC4gVGhlIHVzZXIgd2FudHMgdGhlXG4gICAgLy8gdGVybWluYWwgdG8gYmUgc2lsZW50IHdoZW4gZXZlcnl0aGluZyBpcyB3b3JraW5nLiBUaGVcbiAgICAvLyBlcnJvci1vbmx5IHRwcmludCBiZWxvdyBoYW5kbGVzIHRoZSBlcnJvciBjYXNlLiBVbmRlclxuICAgIC8vIC0tdmVyYm9zZSwgdGhpcyBsaW5lIHNob3dzIHRoZSBmdWxsIHBlci10aWNrIGRldGFpbFxuICAgIC8vIChjb3VudGVycywgY29vbGRvd25zKSBmb3IgZGVidWdnaW5nLlxuICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICBucy5wcmludChgbWFuYWdlcjogdGljayAkeyhlbGFwc2VkIC8gMTAwMCkudG9GaXhlZCgxKX1zIHRhcmdldHM9WyR7dGFyZ2V0cy5qb2luKFwiLFwiKX1dICR7c3VtbWFyeSB8fCBcIihubyBjaGFuZ2VzKVwifSR7Y2REZXRhaWx9YCk7XG4gICAgfVxuICAgIC8vIERlY2lkZSB3aGV0aGVyIHRvIHN1cmZhY2UgdGhpcyB0aWNrIHRvIHRoZSB0ZXJtaW5hbC5cbiAgICAvL1xuICAgIC8vIFF1aWV0LWJ5LWRlZmF1bHQgd2l0aCB0aGUgc3RyaWN0ZXN0IHJ1bGU6IE9OTFkgcHJpbnQgb25cbiAgICAvLyBlcnJvcnMuIE5vcm1hbCBsYXVuY2hlcywgcmVjb3ZlcnkgdHJhbnNpdGlvbnMsIGFuZFxuICAgIC8vIFNLSVAtY29vbGRvd24vU0tJUC1yYW0gYXJlIGFsbCBzaWxlbnQuIFRoZSB1c2VyIHdhbnRzXG4gICAgLy8gdGhlIHRlcm1pbmFsIHRvIHJlZmxlY3QgXCJldmVyeXRoaW5nIGlzIHdvcmtpbmcgYXNcbiAgICAvLyBleHBlY3RlZFwiIGJ5IGJlaW5nIGNvbXBsZXRlbHkgZW1wdHkgZHVyaW5nIG5vcm1hbFxuICAgIC8vIG9wZXJhdGlvbi4gQW55dGhpbmcgcHJpbnRlZCBpcyBhIHByb2JsZW0gd29ydGggc2VlaW5nLlxuICAgIC8vXG4gICAgLy8gV2hhdCBjb3VudHMgYXMgYW4gZXJyb3Igd29ydGggcHJpbnRpbmc6XG4gICAgLy8gICAtIEZBSUwtZXhlYyA+IDAgICAobnMuZXhlYyByZXR1cm5lZCAwIOKAlCBzY3JpcHQgbWlzc2luZ1xuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICBvbiB0aGUgdGFyZ2V0IGhvc3QsIG9yIFJBTSByYWNlKVxuICAgIC8vICAgLSBTS0lQLXJhbSA+IDAgICAgKHJlY292ZXJ5IG9yIG5vcm1hbCBiYXRjaCBjb3VsZG4ndFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICBmaW5kIGEgd29ya2VyIHdpdGggZW5vdWdoIGZyZWUgUkFNKVxuICAgIC8vICAgLSBTS0lQLWxldmVsID4gMCAgKHRhcmdldCdzIGhhY2sgbGV2ZWwgdG9vIGhpZ2gg4oCUIHNob3VsZFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICBub3QgaGFwcGVuIGF0IHRoaXMgcG9pbnQsIGJ1dCBhIHNpZ25hbFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICB0aGF0IHBpY2tUYXJnZXRzKCkgaXMgYnJva2VuKVxuICAgIC8vICAgLSBTS0lQLW1wID4gMCAgICAgKHRhcmdldCdzIG1vbmV5IDwgbWluIHRocmVzaG9sZCDigJQgYWxzb1xuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICB1bmV4cGVjdGVkLCBpbmRpY2F0ZXMgYSBtYXRoIGJ1ZylcbiAgICAvLyAgIC0gU0tJUC1yb290ID4gMCAgICh0YXJnZXQgbm90IHJvb3RlZCDigJQgbnVrZSBtb25pdG9yIGlzXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgIGJyb2tlbiBvciBoYXNuJ3QgY2F1Z2h0IHVwKVxuICAgIC8vXG4gICAgLy8gV2hhdCBpcyBOT1QgcHJpbnRlZCAoc2lsZW50LCB3b3JraW5nIGFzIGV4cGVjdGVkKTpcbiAgICAvLyAgIC0gbGF1bmNoZWQgPiAwICAgICAgICAgICAgICAgIChhIGJhdGNoIGZpcmVkIHN1Y2Nlc3NmdWxseSlcbiAgICAvLyAgIC0gZW50ZXItcmVjb3ZlcnkgPiAwICAgICAgICAgICh0YXJnZXQgZW50ZXJlZCByZWNvdmVyeSlcbiAgICAvLyAgIC0gbGVhdmUtcmVjb3ZlcnkgPiAwICAgICAgICAgICh0YXJnZXQgbGVmdCByZWNvdmVyeSlcbiAgICAvLyAgIC0gU0tJUC1jb29sZG93biA+IDAgICAgICAgICAgICh0YXJnZXQgc3RpbGwgb24gY29vbGRvd24pXG4gICAgLy8gICAtIFNLSVAtcmFtID4gMCAgICAgICAgICAgICAgICAoY2x1c3RlciBoYXMgbm8gcm9vbSBmb3IgdGhlXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGxhbm5lZCBiYXRjaCDigJQgaGFwcGVuc1xuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV2ZXJ5IHRpY2sgZHVyaW5nIHJlY292ZXJ5XG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbW9kZSB3aGVuIHRoZSBmaXJzdCBiYXRjaFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN1bWVzIGFsbCB0aGUgZnJlZSBSQU0uXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgV29ya2luZyBhcyBleHBlY3RlZC4gVGhlXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdXNlciBleHBsaWNpdGx5IGRvZXMgbm90XG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2FudCB0byBzZWUgdGhpcy4pXG4gICAgLy8gICAtIFNLSVAtbGV2ZWwgPiAwICAgICAgICAgICAgICAod291bGQgYmUgYSByZWFsIGJ1ZywgYnV0XG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZG9lc24ndCBmaXJlIGluIHByYWN0aWNlKVxuICAgIC8vICAgLSBTS0lQLW1wID4gMCAgICAgICAgICAgICAgICAgKHdvdWxkIGJlIGEgcmVhbCBidWcsIGJ1dFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRvZXNuJ3QgZmlyZSBpbiBwcmFjdGljZSlcbiAgICAvLyAgIC0gU0tJUC1yb290ID4gMCAgICAgICAgICAgICAgICh0YXJnZXQgbm90IHJvb3RlZCB5ZXQg4oCUXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVrZS5qcyBpcyBoYW5kbGluZyBpdClcbiAgICAvLyAgIC0gcGxhbm5lZCA+IDAgICAgICAgICAgICAgICAgICh3ZSBwbGFubmVkIGEgYmF0Y2gpXG4gICAgLy9cbiAgICAvLyBPbmx5IHByaW50IG9uIGFjdHVhbCBleGVjIGZhaWx1cmVzIChGQUlMLWV4ZWMpIOKAlCB0aG9zZVxuICAgIC8vIGluZGljYXRlIGEgcmVhbCBwcm9ibGVtIChzY3JpcHQgbWlzc2luZyBvbiBob3N0LCBSQU0gcmFjZVxuICAgIC8vIGNhdWdodCBieSB0aGUgcnVudGltZSwgZXRjLikgdGhhdCB0aGUgdXNlciBuZWVkcyB0byBzZWUuXG4gICAgLy9cbiAgICAvLyBGb3IgcGVyLXRpY2sgdmlzaWJpbGl0eSBpbnRvIHRoZSB3b3JraW5nLWFzLWV4cGVjdGVkIGNhc2UsXG4gICAgLy8gdXNlIGBydW4gbWFuYWdlci5qcyAtLXZlcmJvc2VgIHdoaWNoIG5zLnByaW50cyBldmVyeSB0aWNrXG4gICAgLy8gdG8gdGhlIGluLWdhbWUgbG9nIGZpbGUuIFRoZSB0ZXJtaW5hbCBzdGF5cyBjbGVhbi5cbiAgICBpZiAoY291bnRlcnNbXCJGQUlMLWV4ZWNcIl0gPiAwKSB7XG4gICAgICBucy50cHJpbnQoYG1hbmFnZXI6IHRhcmdldHM9WyR7dGFyZ2V0cy5qb2luKFwiLFwiKSB8fCBcIihlbXB0eSlcIn1dICR7c3VtbWFyeSB8fCBcIihubyBzdW1tYXJ5KVwifWApO1xuICAgIH1cblxuICAgIC8vIENSSVRJQ0FMOiBwYWNlIHRoZSBvdXRlciBsb29wLiBUaGUgcGVyLXRhcmdldCBsb29wIGFib3ZlXG4gICAgLy8gZG9lcyBpdHMgb3duIHBhY2luZyAocGVyLWpvYiBzbGVlcHMsIHBlci10YXJnZXQgc3RhZ2dlcixcbiAgICAvLyBwZXItdGFyZ2V0IGNvb2xkb3duKSwgYnV0IHRoZSBPVVRFUiBsb29wIGhhcyBubyBuYXR1cmFsXG4gICAgLy8gZGVsYXkgYmV0d2VlbiBpdGVyYXRpb25zLiBXaXRob3V0IGEgc2xlZXAgaGVyZSwgdGhlIGxvb3BcbiAgICAvLyBzcGlucyBhdCBtYXggcmF0ZSAofjEwMDAgaXRlcmF0aW9ucy9zZWMpIGNhbGxpbmdcbiAgICAvLyBwaWNrVGFyZ2V0cyAoQkZTIHNjYW4gb2YgNTArIHNlcnZlcnMpIGFuZCByZS1jaGVja2luZ1xuICAgIC8vIGNvb2xkb3ducy4gQXQgdGhhdCByYXRlLCB0aGUgV2ViIFdvcmtlciBob3N0aW5nIHRoaXNcbiAgICAvLyBzY3JpcHQgc2F0dXJhdGVzIHRoZSByZW5kZXJlcidzIGV2ZW50IGxvb3AgYW5kIHRoZSBnYW1lXG4gICAgLy8gdGFiIGJlY29tZXMgdW5yZXNwb25zaXZlIOKAlCB3aGF0IHRoZSB1c2VyIG9ic2VydmVkIGFzXG4gICAgLy8gXCJ0aGUgZ2FtZSBjcmFzaGVkXCIuIChUaGUgc2F2ZSBzdGF0ZSBpcyBmaW5lOyB0aGUgdGFiXG4gICAgLy8ganVzdCBoYW5ncyB1bnRpbCB0aGUgd29ya2VyIGlzIGtpbGxlZC4pXG4gICAgLy9cbiAgICAvLyAxcyBpcyB0aGUgcmlnaHQgdmFsdWU6IGl0IHBhY2VzIHRoZSBvdXRlciBsb29wIHdpdGhvdXRcbiAgICAvLyB0aHJvdHRsaW5nIHRoZSBpbmNvbWUgc3RyZWFtLiBUaGUgcGVyLXRhcmdldCBjb29sZG93blxuICAgIC8vICh3ZWFrZW5UaW1lICsgYnVmZmVyLCB0eXBpY2FsbHkgOTVzIGZvciBwaGFudGFzeSkgaXNcbiAgICAvLyB3aGF0IGFjdHVhbGx5IGdhdGVzIHJlLWZpcmU7IHRoZSAxcyBvdXRlciByZXNpZHVhbCBqdXN0XG4gICAgLy8ga2VlcHMgdGhlIGxvb3AgZnJvbSBzcGlubmluZy4gc2tlZXNsZXIgdXNlcyBCQVRDSF9HQVA9ODAwbXNcbiAgICAvLyBiZXR3ZWVuIGJhdGNoIHN0YXJ0cyBpbnNpZGUgYSBzaW5nbGUtdGFyZ2V0IGZsZWV0LWJhdGNoZXJcbiAgICAvLyBwcm9jZXNzLCBidXQgdGhlIG1hbmFnZXIgaXMgYSBzaW5nbGUgbXVsdGktdGFyZ2V0IHByb2Nlc3NcbiAgICAvLyBhbmQgMXMgYmV0d2VlbiBmdWxsLXRpY2sgc3dlZXBzIGlzIHRoZSByaWdodCBjYWxsLlxuICAgIGF3YWl0IG5zLnNsZWVwKDFfMDAwKTtcbiAgfVxufVxuXG4iXX0=