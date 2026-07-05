// src/lib/hwgw.js
// Pure-math helpers for HWGW batching. No side effects, no ns.* mutation.
// Safe to import from both runtime scripts and node test scripts.
import { NS } from "@ns";

// Small buffer subtracted from arrivalT so a script that nominally
// finishes at T doesn't fire 0ms before the next operation lands.
// Bitburner's runtimes are deterministic but the 50ms headroom keeps
// HWGW timing robust under minor jank. The math is also clamped to 0
// below so a future fast target can't produce negative delayMs.
const LANE_BUFFER_MS = 50;

// GB of home RAM kept free for system scripts (monitor-nuke.js's
// nuke.js invocations, monitor-buy.js's purchase programs, etc.).
// Without this, the fleet-batcher happily consumes all of home's
// free RAM and the next nuke.js / buy.exe launch fails with
// "not enough RAM" — the Pitfall 25 / "home headroom for system
// scripts" issue. 32 GB covers a single nuke.js (~10 GB) plus
// a bit of buffer. Bump up if you add larger system scripts.
const HOME_HEADROOM_GB = 32;

// Fraction of fleetFree reserved as a "fragmentation buffer" for
// the fleet-batcher. Sourced from skeesler/bitburner-commander:
// the 5% headroom absorbs per-host fragmentation (free RAM
// scattered in sub-thread slivers across pservs) so allocate()
// can always place every op fully. Without it, a partial placement
// produces a partial batch (hack without enough grow) which
// drains the target without refilling it. See the
// fleet-batcher-pattern ref in bitburner-dev skill.
const FLEET_HEADROOM_FRACTION = 0.95;

// Cap on a single target's fleet share. Enforced in manager.js
// (per-target share gate, see shareRamCap in this file). Without
// this, the top-ranked target by moneyMax (phantasy) consumes
// the whole cluster on every tick and targets #2..#9 starve.
// Sourced from skeesler/bitburner-commander (MAX_FLEET_SHARE = 1/3).
const MAX_FLEET_SHARE = 1 / 3;

/**
 * Pull the per-target timing + state we need to plan a batch.
 * Throws if the target isn't rooted.
 */
export function analyze(ns, target) {
  const s = ns.getServer(target);
  if (!s.hasAdminRights) throw new Error(`analyze: no root on ${target}`);
  return {
    target,
    // Bitburner 3.0+ signatures: host is the first arg, the rest
    // of the args are numbers (threads / multiplier / hackAmount).
    // DO NOT pass host as the LAST arg — that was the legacy
    // signature in pre-3.0 and is the wrong order now.
    hackTime: ns.getHackTime(target),
    growTime: ns.getGrowTime(target),
    weakenTime: ns.getWeakenTime(target),
    hackSec: ns.hackAnalyzeSecurity(1, target),
    growSec: ns.growthAnalyzeSecurity(1, target),
    moneyAvailable: s.moneyAvailable,
    moneyMax: s.moneyMax,
    minSec: s.minDifficulty,
    curSec: s.hackDifficulty,
  };
}

/**
 * Plan the four batch jobs that, when fired with the given delays,
 * land on `target` at the same wall-clock moment with the security
 * spike cancelled by the two weakens.
 *
 * Returns: { target, arrivalT, jobs, totalRam, summary }
 *   jobs: [{script, threads, delayMs}, ...] in [hack, weaken, grow, weaken] order
 */
export function planBatch(ns, target, opts) {
  const a = analyze(ns, target);
  const wantMoneyFraction = opts.moneyFraction ?? 0.10;  // steal 10% per batch
  const wantMoney = a.moneyMax * wantMoneyFraction;

  // Threads to steal `wantMoney`. Clamp to what's actually there.
  // Bitburner 3.0+ signature: hackAnalyzeThreads(host, hackAmount).
  // The first arg is the host, second is the dollar amount.
  const moneyLeft = Math.max(0, Math.min(wantMoney, a.moneyAvailable));
  const hackThreads = Math.max(1, Math.ceil(ns.hackAnalyzeThreads(target, moneyLeft)));

  // Threads to grow from current state back to max.
  // Bitburner 3.0+ signature: growthAnalyze(host, multiplier, cores?).
  //
  // CRITICAL: the second arg is a MULTIPLICATIVE FACTOR (e.g. 2 for
  // "grow by 2x"), NOT a dollar target. The first version of this
  // function passed `a.moneyMax` ($1.75T for max-hardware) as the
  // multiplier, which Bitburner interpreted as "grow by a factor of
  // 1.75e12" — and returned 17,906 threads (the absurdly-large
  // thread count needed to grow by 1.75e12x). Those threads
  // (31,000+ GB of RAM) didn't fit on the cluster, the grow was
  // silently SKIP-ram'd every batch, money never regrew, and the
  // target became permanently depleted.
  //
  // The correct multiplier is `moneyMax / moneyAvailable` — "how
  // much do we need to multiply the current state by to reach
  // max?" Mathematically: `current * multiplier = max`, so
  // `multiplier = max / current`. When `current = 0` (just hacked)
  // this would be infinity, so we floor `current` at $1 to avoid
  // divide-by-zero. (The `ns.grow` API adds $1 per thread before
  // applying the multiplier, so the absolute-zero case is
  // impossible anyway.)
  const growMultiplier = a.moneyMax / Math.max(1, a.moneyAvailable);
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growMultiplier, 1)));

  // Weaken threads: cancel hackSec and growSec, AND bring any
  // accumulated security drift back down to min.
  //
  // The original formula only cancelled the *new* spike (hackSec *
  // hackThreads + growSec * growThreads). If a previous batch left
  // the target's security above min (because its grow was SKIP-ram'd
  // and never ran, see the growthAnalyze fix above), the new batch
  // preserves the drift: curSec_after = curSec_before + new_spike -
  // new_weaken = curSec_before (modulo new spike). The next batch
  // reads the same elevated curSec and again only cancels the new
  // spike, so security never returns to min.
  //
  // The fix is to compute the total sec reduction needed to reach
  // minSec, not just cancel the new spike:
  //
  //   totalSecToReduce = (curSec - minSec) + (hackSec*hackThreads) + (growSec*growThreads)
  //   weakenThreads = ceil(totalSecToReduce / weakenPerThread)
  //
  // This guarantees the batch ENDS with curSec = minSec (modulo
  // rounding), regardless of accumulated drift. The two weaken
  // slots in the batch are always equal, so we compute once.
  //
  // Bitburner 3.0+ signature: weakenAnalyze(threads, cores?). NO host
  // arg — the function uses the script's current context (which is the
  // calling server, NOT the target). To analyze the target's weaken
  // rate correctly, the script must be run on the target, OR we need
  // to use the alternate signature weakenAnalyze(threads, cores) with
  // the context already set to the target.
  //
  // In practice, hackSec/growSec/weakenPerThread are properties of
  // the target server. The rate of security reduction per weaken
  // thread is `weakenAnalyze(1) / target.minDifficulty` — i.e., it's
  // the same regardless of the calling server. We pass the target
  // as the implicit context by reading its minDifficulty separately
  // and using the absolute number from the (server-agnostic) call.
  const weakenPerThread = ns.weakenAnalyze(1);
  const driftSec = Math.max(0, a.curSec - a.minSec);
  const newSpikeSec = (a.hackSec * hackThreads) + (a.growSec * growThreads);
  const totalSecToReduce = driftSec + newSpikeSec;
  const weakenThreads = Math.max(1, Math.ceil(totalSecToReduce / weakenPerThread));

  // --- Recovery mode ---
  // If the full batch's RAM requirement exceeds the largest single
  // worker's free RAM, we can't run the full HWGW. This happens when
  // a target has accumulated so much security drift that the weaken
  // thread count is in the thousands or tens of thousands — more than
  // any single pserv (or even home) can hold.
  //
  // Example: iron-gym with curSec=630 (drift=620) needs
  // ceil(620/0.05) = 12,400 weaken threads × 1.75 GB = 21.7 TB. The
  // user's cluster is 15 TB. Full batch doesn't fit.
  //
  // Recovery mode returns a 1-job plan (weaken only, no hack/grow)
  // sized to the LARGEST single worker's free RAM. The manager
  // fires it like any other job. Each recovery batch drains as much
  // of the drift as fits; over a few cycles (gated by per-target
  // cooldown), the drift drops to a level where the full HWGW batch
  // fits and the plan transitions back to normal automatically.
  //
  // The `recoveryMode: true` flag in the returned plan tells the
  // manager this is a degrade operation. The cooldown still applies
  // so we don't re-fire too soon. The next eligible tick re-plans
  // against the (now lower) curSec and the cycle continues.
  //
  // We don't try to split a single weaken job across multiple
  // workers (no clean API for that — ns.exec spawns a single
  // process). Instead, we just use the largest available worker,
  // even if it means recovery is gradual. This is correct because
  // the cooldown prevents re-fire races during recovery.
  const ramByScript = {
    "hack.js": ns.getScriptRam("hack.js", "home"),
    "weaken.js": ns.getScriptRam("weaken.js", "home"),
    "grow.js": ns.getScriptRam("grow.js", "home"),
  };
  const arrivalT = a.weakenTime - LANE_BUFFER_MS;
  const delay = (scriptTime) => arrivalT - scriptTime;
  const jobs = [
    { script: "hack.js",   threads: hackThreads,   delayMs: delay(a.hackTime)   },
    { script: "weaken.js", threads: weakenThreads, delayMs: delay(a.weakenTime) },
    { script: "grow.js",   threads: growThreads,   delayMs: delay(a.growTime)   },
    { script: "weaken.js", threads: weakenThreads, delayMs: delay(a.weakenTime) },
  ];
  const totalRam = jobs.reduce((sum, j) => sum + ramByScript[j.script] * j.threads, 0);

  // Build the fleet and check if the fleet can carry the biggest job.
  // This is the FLEET-AWARE check — it asks "can the cluster as a
  // whole fit the largest single op?" instead of "can any single
  // host fit it?". The old single-host check was the right rule
  // before the fleet-batcher existed; with the fleet, it's too
  // conservative (busy pservs look full but the fleet has spare
  // capacity from rooted worlds + idle home).
  //
  // Per-target cap: 1/3 of the fleet. Matches skeesler's
  // MAX_FLEET_SHARE; one target's biggest job must fit in its
  // share of the cluster. Without the cap, one huge target could
  // claim the whole fleet and starve the others.
  const fleet = buildFleet(ns);
  const totalFleetFree = fleetFree(ns, fleet);
  const perTargetFleetCap = totalFleetFree * FLEET_DEFAULTS.MAX_FLEET_SHARE;
  // Also compute the single-host largest-free as a fallback for the
  // recovery plan's "sized to the biggest single host" sizing
  // (see below). Recovery uses the same single-host sizing as
  // before because the recovery weaken is a single op, not a batch
  // — we can either spread it across the fleet OR fit it on one
  // host, but spreading is the new path. Keep the old single-host
  // sizing as a per-batch upper bound for the recovery plan.
  let largestFreeRam = 0;
  for (const w of listWorkers(ns)) {
    const free = ns.getServerMaxRam(w) - ns.getServerUsedRam(w);
    if (free > largestFreeRam) largestFreeRam = free;
  }

  // The full batch's bottleneck is the LARGEST single job (usually
  // one of the two weakens). If the fleet (per-target share) can
  // carry the WHOLE batch (4 jobs summed), we run a normal HWGW.
  // Otherwise, we drop to recovery mode (weaken-only, sized to
  // the largest single worker).
  const biggestJobRam = Math.max(
    hackThreads * ramByScript["hack.js"],
    weakenThreads * ramByScript["weaken.js"],
    growThreads * ramByScript["grow.js"],
  );

  // Fleet-aware check: can the fleet (per-target share) carry the
  // WHOLE batch? We use `totalRam` (the 4-job sum) because that's
  // what the manager will actually place — `biggestJobRam` only
  // tells us the single largest op, but the fleet has to carry
  // all 4 jobs in sequence. The 5% headroom is applied upstream
  // in manager.js; planBatch's check is a coarser "can the
  // fleet, period, fit this batch?" gate.
  //
  // The previous version of this check (`biggestJobRam <=
  // perTargetFleetCap && totalFleetFree >= 2 * biggestJobRam`)
  // was too strict: the 2× safety meant a fleet where pservs are
  // busy with prior-tick workers would never see normal HWGW,
  // even when the biggest job (which is what the new fleet
  // pattern actually needs to fit) comfortably fits in the
  // total free RAM. That false-positive recovery mode fired on
  // every tick in the user's game state, leaving the targets
  // permanently in recovery even when their drift was 0.
  //
  // Correct check: `totalRam <= totalFleetFree` — the whole
  // batch fits in the fleet's free RAM. Per-target share is
  // enforced upstream in manager.js via shareRamCap.
  const fleetCanCarry = totalRam <= totalFleetFree;

  if (!fleetCanCarry) {
    // Recovery mode: weaken-only, sized to the largest free worker.
    // The recovery sizing is unchanged from the old single-host
    // logic — we use the largest single worker's free RAM (not
    // the fleet) because recovery is a single op and we want
    // bunching on the biggest host for fastest drift drain.
    // (Pitfall 23: largest-fit for recovery, smallest-fit for normal.)
    const safetyMargin = 0.95;
    const recoverThreads = Math.max(
      1,
      Math.floor((largestFreeRam * safetyMargin) / ramByScript["weaken.js"])
    );
    // Reduce drift by recoverThreads * weakenPerThread per batch.
    // With drift=620 and recoverThreads=8000 (1.4 GB free × 5% =
    // 13.3k threads, but free RAM is more like 14 TB on a 15 TB
    // cluster), we drain ~400 sec per batch. Two batches recover
    // iron-gym fully.
    const recoverJobs = [
      { script: "weaken.js", threads: recoverThreads, delayMs: 0 },  // fire immediately
    ];
    const recoverTotalRam = recoverJobs.reduce(
      (sum, j) => sum + ramByScript[j.script] * j.threads, 0
    );
    return {
      target,
      arrivalT,
      jobs: recoverJobs,
      totalRam: recoverTotalRam,
      recoveryMode: true,
      summary: `target=${target} RECOVERY drift=${driftSec.toFixed(0)} w=${recoverThreads} ram=${recoverTotalRam.toFixed(1)}GB (full batch would need ${(weakenThreads * ramByScript["weaken.js"]).toFixed(0)}GB)`,
    };
  }

  return {
    target,
    arrivalT,
    jobs,
    totalRam,
    recoveryMode: false,
    summary: `target=${target} hack=${hackThreads} w=${weakenThreads} grow=${growThreads} ram=${totalRam.toFixed(1)}GB`,
  };
}

/**
 * Build the worker pool: home + every purchased server slot.
 * The orchestrator will pick a worker per job.
 */
export function listWorkers(ns) {
  const out = ["home"];
  const limit = ns.cloud.getServerLimit();
  for (let i = 0; i < limit; i++) {
    const name = `pserv-${i}`;
    if (ns.serverExists(name)) out.push(name);
  }
  return out;
}

/**
 * Find a worker that has at least `needRam` GB of free RAM and return
 * its name, or null if no worker qualifies.
 *
 * Load-balancing rule: pick the SMALLEST worker that fits. This
 * leaves the biggest workers (typically home, with 1+ TB) free for
 * the largest batches (which need many threads × worker RAM), and
 * spreads smaller batches across the pserv fleet. Without this
 * rule, `findWorkerWithRam` would always return home first (it's
 * first in `workers` and always has free RAM), and the pservs
 * would sit idle while home became a hot spot.
 *
 * We achieve "smallest fit" by tracking the minimum-max candidate
 * on the fly. Cost is O(N) per call where N = number of workers
 * (typically 1 + up-to-25 pservs = 26, so this is cheap — fewer
 * than 100 simple arithmetic ops per batch).
 */
export function findWorkerWithRam(ns, workers, needRam) {
  let bestName = null;
  let bestMax = Infinity;
  for (const w of workers) {
    const max = ns.getServerMaxRam(w);
    const used = ns.getServerUsedRam(w);
    if (max - used >= needRam && max < bestMax) {
      bestName = w;
      bestMax = max;
    }
  }
  return bestName;
}

/**
 * Find the LARGEST worker with at least `needRam` usable free RAM.
 *
 * Mirror image of `findWorkerWithRam`: where the smallest-fit
 * rule spreads small batches across the pserv fleet, the
 * largest-fit rule is used by recovery mode in `planBatch` —
 * recovery mode wants to drain security drift as fast as
 * possible, so it picks the biggest free worker (typically
 * home with 1+ TB) and uses as much of its free RAM as it can.
 *
 * Without this helper, recovery mode would land its weaken
 * job on whatever 1.8 GB pserv happened to be the smallest fit,
 * draining drift at 0.05 sec per batch (would take thousands
 * of batches to clear typical mid-game drift). With it, the
 * recovery weaken lands on the biggest free worker and drains
 * hundreds of sec per batch.
 *
 * `homeHeadroomRam` is the amount of home's free RAM to exclude
 * from consideration. Default 32 GB. This is to leave room for
 * `nuke.js` and other one-shot home scripts that the monitors
 * fire (each ~5-10 GB). Without this headroom, recovery mode
 * consumes all of home's free RAM and the next nuke.js invocation
 * fails with "not enough RAM" until the next recovery cooldown
 * expires. We reserve headroom only on home; pservs are
 * unaffected (other system scripts don't run on pservs).
 *
 * Cost is also O(N) per call, same as findWorkerWithRam.
 */
export function findLargestWorkerWithRam(ns, workers, needRam, homeHeadroomRam = 32) {
  let bestName = null;
  let bestFree = -1;
  for (const w of workers) {
    const max = ns.getServerMaxRam(w);
    const used = ns.getServerUsedRam(w);
    // Reserve headroom on home only — system scripts (nuke.js,
    // buy programs, etc.) run on home and need free RAM to start.
    // Without this, recovery mode hogs all of home's free RAM
    // and the next nuke.js invocation fails.
    const headroom = w === "home" ? homeHeadroomRam : 0;
    const free = max - used - headroom;
    if (free >= needRam && free > bestFree) {
      bestName = w;
      bestFree = free;
    }
  }
  return bestName;
}

// ============================================================================
// Fleet-batcher helpers — distribute one batch's threads across the whole
// cluster (home + pservs + rooted world servers), not just one host.
// Sourced from skeesler/bitburner-commander/fleet-batcher.js (MIT-style,
// public domain). The single biggest BN1 mid-game win: turns 15 TB of
// fleet capacity into a usable target for batches that would otherwise
// need 100+ TB on a single host.
// ============================================================================

/**
 * BFS the network from home. Returns the sorted list of every
 * reachable hostname EXCEPT home. Used by buildFleet() to find
 * rooted world servers that can host workers.
 */
export function listReachableServers(ns) {
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

/**
 * Build the fleet pool: home + every purchased server + every rooted
 * world server with usable RAM.
 *
 * A world server can be a worker host for one fleet and a hack target
 * of another at the same time — the two roles don't interfere. This
 * is the key insight that makes the fleet-batcher work: 50 GB of CSEC
 * + 32 GB of foodnstuff + 16 GB of joesguns + 11 pservs × 1 TB +
 * home 1 TB = 12+ TB of usable fleet where before there was just
 * home + 11 pservs.
 *
 * Each entry is `{h, r}` where h is the hostname and r is the GB to
 * keep free on that host (headroom for system scripts; only home
 * gets a real value).
 */
export function buildFleet(ns, homeHeadroomRam = HOME_HEADROOM_GB) {
  const pservs = ns.cloud.getServerNames();
  const pservSet = new Set(pservs);
  // Rooted world servers (CSEC, foodnstuff, joesguns, etc.) — every
  // server with admin rights and a non-zero max RAM. Excluded from
  // the hack-target list by pickTargets(); they can be workers
  // for OTHER targets freely. A pserv-0 with 1 TB and a CSEC with
  // 50 GB both contribute to the same fleet.
  const worldHosts = listReachableServers(ns).filter(
    (h) => !pservSet.has(h) && ns.hasRootAccess(h) && ns.getServerMaxRam(h) > 0
  );
  return [
    { h: "home", r: homeHeadroomRam },
    ...pservs.map((h) => ({ h, r: 0 })),
    ...worldHosts.map((h) => ({ h, r: 0 })),
  ];
}

/**
 * Total free RAM across the fleet, in GB. Sums `max - used - reserve`
 * for every fleet member. Used by the 5% headroom rule to gate batch
 * launches.
 */
export function fleetFree(ns, fleet) {
  let free = 0;
  for (const { h, r } of fleet) {
    free += Math.max(0, ns.getServerMaxRam(h) - ns.getServerUsedRam(h) - r);
  }
  return free;
}

/**
 * Stage the worker scripts (hack.js, weaken.js, grow.js) to every
 * host in the fleet. Idempotent — if the scripts are already on
 * the host, ns.scp is a no-op. Used by the manager to stage once
 * per tick instead of once per allocateBatch call.
 *
 * Cost: O(fleet.size × 3) ns.scp calls. With a 39-host fleet,
 * that's 117 calls per tick. ns.scp returns immediately if the
 * file is already on the host, so subsequent ticks are cheap.
 */
export function stageWorkers(ns, fleet, scripts = ["hack.js", "weaken.js", "grow.js"]) {
  for (const { h } of fleet) {
    for (const script of scripts) {
      if (!ns.fileExists(script, h)) {
        ns.scp(script, h, "home");
      }
    }
  }
}

/**
 * Refresh the per-host free-RAM field of a cached fleet without
 * re-running listReachableServers' BFS. Returns a NEW fleet object
 * with updated `r` (the headroom) reflecting the latest free RAM
 * per host.
 *
 * The fleet's host list is stable for the whole tick; only the
 * per-host free RAM changes as workers are placed. Re-running
 * buildFleet() per job was doing ~70 ns.scan calls per call,
 * which hung the browser at 45 calls per tick.
 */
export function recheckFleetRam(ns, fleet, homeHeadroomRam = HOME_HEADROOM_GB) {
  return fleet.map(({ h }) => {
    const max = ns.getServerMaxRam(h);
    const used = ns.getServerUsedRam(h);
    const headroom = h === "home" ? homeHeadroomRam : 0;
    return { h, r: Math.max(0, max - used - headroom) };
  });
}

/**
 * Bin-pack `threads` of `script` across the fleet's free RAM, all
 * threads fired with the same `target`, `delay`, and `id` so the
 * effects sum on the target (a single op may span several hosts).
 *
 * Returns the number of threads actually placed (threads - remaining).
 * A return value < threads is a PARTIAL placement — the manager
 * treats this as a batch failure (Pitfall 22-style: don't stamp
 * lastFireMs, let the next tick re-attempt the full batch).
 *
 * The 5% headroom rule in the manager (`if (totalBatchRam(b) <=
 * fleetFree * FLEET_HEADROOM_FRACTION)`) is what prevents partial
 * placements from happening in practice. The function itself will
 * happily place partial batches; the gate is upstream.
 *
 * Cost: O(fleet.size) per call. fleet is typically ~15-50 members
 * (1 home + 25 pservs max + ~20 rooted world servers), so a few
 * hundred simple arithmetic ops per job × 4 jobs per batch =
 * ~2000 ops per batch dispatch. Negligible.
 */
export function allocate(ns, fleet, script, threads, target, delay, id) {
  const ram = ns.getScriptRam(script);
  let remaining = threads;
  for (const { h, r } of fleet) {
    if (remaining <= 0) break;
    const free = Math.max(0, ns.getServerMaxRam(h) - ns.getServerUsedRam(h) - r);
    const canFit = Math.floor(free / ram);
    if (canFit <= 0) continue;
    const put = Math.min(canFit, remaining);
    if (ns.exec(script, h, put, target, Math.round(delay), id)) remaining -= put;
  }
  return threads - remaining;
}

/**
 * Maximum RAM (in GB) a single target's batch can claim from the
 * fleet, per the MAX_FLEET_SHARE cap. The cap is the per-target
 * share of the fleet's TOTAL max RAM (not free — total), so a
 * single target can't hog more than 1/3 of the cluster's capacity
 * for one batch.
 *
 * Sourced from skeesler/bitburner-commander: their
 * MAX_FLEET_SHARE = 1/3 prevents the top-ranked target from
 * taking the whole cluster and starving #2..#9. Without this
 * cap, `pickTargets()`'s "first 9 by moneyMax" ordering means
 * phantasy alone consumes the whole fleet on every tick.
 *
 * The fleet's total = sum of (max - reserve) across members.
 * `reserve` is the per-host system headroom (32 GB on home, 0 on
 * pservs/rooted worlds). Using max - reserve (not max) means
 * the cap is "the fleet's usable capacity" not "raw installed
 * RAM", which matches what the manager actually competes for.
 *
 * Cost: O(fleet.size) per call. Negligible — this is called
 * once per target per tick, not per job.
 */
export function shareRamCap(ns, fleet) {
  let total = 0;
  for (const { h, r } of fleet) {
    total += Math.max(0, ns.getServerMaxRam(h) - r);
  }
  return Math.floor(total * MAX_FLEET_SHARE);
}

/**
 * Distribute all 4 jobs of a plan across the fleet, returning the
 * minimum threads-placed across the 4 jobs (0 if any job partial).
 * The caller treats min===0 as "batch failed, don't stamp cooldown"
 * and treats min===jobs.length as "batch fully placed, stamp cooldown."
 *
 * The caller is responsible for share-cap (MAX_FLEET_SHARE) and
 * fleet-fit (5% headroom) gates BEFORE calling allocateBatch.
 * allocateBatch is a low-level bin-packer; it does what it's told
 * within the fleet's current free RAM. Doing the higher-level
 * gates upstream means the manager can call allocateBatch for
 * the WHOLE batch (4 jobs in one call) or for a single job (per-
 * job sleep pattern, manager.js:444-482) with the same API.
 *
 * Workers are pushed to the fleet hosts via ns.scp first so the
 * `Script <name> does not exist on host` failure mode (Pitfall 22)
 * doesn't fire on the first batch.
 */
export function allocateBatch(ns, fleet, plan, target, targetOffset, id, verbose) {
  // Workers are staged once per tick by the manager's
  // stageWorkers() call at the top of the outer loop. The
  // previous per-call scp was 117 calls × 36 calls per tick =
  // 4212 ns.scp round-trips per tick, which was hanging the
  // browser. Idempotent no-op if already staged.
  let minPlaced = Infinity;
  const placement = [];  // for --verbose: which host got how many threads of which job
  for (const job of plan.jobs) {
    const jobDelay = job.delayMs + targetOffset;
    const placed = allocate(ns, fleet, job.script, job.threads, target, jobDelay, id);
    if (placed < job.threads && minPlaced === Infinity) minPlaced = 0;  // early-out
    if (placed < minPlaced) minPlaced = placed;
    if (verbose) placement.push({ script: job.script, threads: placed, of: job.threads, delay: jobDelay });
  }
  return { minPlaced, placement };
}

/**
 * Strict prep check: target is at min security AND max money. Used
 * at the boundary between prep() and the main loop to know when
 * prep is finished. NOT a per-tick gate — a running batcher's
 * money dips and recovers by design, so a per-tick isPrepped()
 * check would say "NOT PREPPED" every mid-cycle tick and trigger
 * wasteful re-prep work.
 */
export function isPrepped(ns, target) {
  return ns.getServerSecurityLevel(target) <= ns.getServerMinSecurityLevel(target) + 0.01 &&
         ns.getServerMoneyAvailable(target) >= ns.getServerMaxMoney(target) * 0.999;
}

/**
 * Tolerant health check: target is roughly prepped. True throughout
 * normal batch oscillation, false only on real desync (money crashed
 * or security spiked far above min). Use this in the main loop as
 * the recovery-mode trigger; the cure is a few prep weakens, not
 * waiting for isPrepped's strict boundary.
 *
 * hackFraction is the per-batch steal fraction (matches manager's
 * MONEY_FRACTION). A running batcher should oscillate between
 * (1 - hackFraction) and 1.0 of moneyMax; if it's below 50% of
 * (1 - hackFraction), the grow isn't keeping up and the target
 * is desynced.
 */
export function isHealthy(ns, target, hackFraction, moneyFraction = 0.5, secTolerance = 5) {
  const maxMoney = ns.getServerMaxMoney(target);
  const minSec = ns.getServerMinSecurityLevel(target);
  const money = ns.getServerMoneyAvailable(target);
  const sec = ns.getServerSecurityLevel(target);
  // skeesler default: money >= 50% × (1 - hackFraction) × maxMoney
  // AND curSec <= minSec + 5. Caller can override the money fraction
  // (e.g. a stricter check) or the sec tolerance.
  return money >= maxMoney * (1 - hackFraction) * moneyFraction && sec <= minSec + secTolerance;
}

/**
 * Total RAM a plan will use across the fleet. Used by the 5% headroom
 * rule to gate launches: only fire if `totalBatchRam(plan) <=
 * fleetFree(fleet) * FLEET_HEADROOM_FRACTION`.
 *
 * The cap on per-thread RAM is `ns.getScriptRam(script, "home")` —
 * scripts have a constant RAM cost regardless of where they run, so
 * the script's home is a valid reference. Worker scripts are
 * deployed to every fleet host via allocateBatch's scp loop, so the
 * "RAM cost on the host" question is settled before the call.
 */
export function totalBatchRam(ns, plan) {
  const hackRam = ns.getScriptRam("hack.js", "home");
  const weakenRam = ns.getScriptRam("weaken.js", "home");
  const growRam = ns.getScriptRam("grow.js", "home");
  return plan.jobs.reduce(
    (sum, j) =>
      sum + j.threads * (j.script === "hack.js" ? hackRam : j.script === "weaken.js" ? weakenRam : growRam),
    0
  );
}

// Re-export the constants for callers that want to read the same
// numbers (e.g. manager.js's per-target fleet share cap, dryrun's
// "would this batch fit?" check). Defaults: 32 GB home headroom,
// 95% fleet headroom, 1/3 per-target share cap.
export const FLEET_DEFAULTS = {
  HOME_HEADROOM_GB,
  FLEET_HEADROOM_FRACTION,
  MAX_FLEET_SHARE,
};
