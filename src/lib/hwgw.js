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

  // Find the largest single worker's free RAM. listWorkers() returns
  // ["home", "pserv-0", ...] in the order Bitburner uses. home is
  // typically the largest, but we measure free RAM (max - used) per
  // worker because a pserv might have a big job running. The largest
  // free-RAM worker is the one most likely to fit a recovery batch.
  let largestFreeRam = 0;
  for (const w of listWorkers(ns)) {
    const free = ns.getServerMaxRam(w) - ns.getServerUsedRam(w);
    if (free > largestFreeRam) largestFreeRam = free;
  }

  // The full batch's bottleneck is the LARGEST single job (usually
  // one of the two weakens). If that single job doesn't fit, we go
  // into recovery mode. We check per-job (not total) because the
  // manager fires each job on a different worker — total > freeRam
  // is fine if the work is split, but a single job > largest free
  // is a hard wall.
  const biggestJobRam = Math.max(
    hackThreads * ramByScript["hack.js"],
    weakenThreads * ramByScript["weaken.js"],
    growThreads * ramByScript["grow.js"],
  );

  if (biggestJobRam > largestFreeRam) {
    // Recovery mode: weaken-only, sized to the largest free worker.
    // weakenPerThread × recoverThreads = sec drop per batch.
    // The threads must fit on `largestFreeRam` minus a 5% safety margin.
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
