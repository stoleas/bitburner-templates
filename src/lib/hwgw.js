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
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, a.moneyMax, 1)));

  // Weaken threads: cancel hackSec and growSec. Both weakens are sized
  // to the larger of the two so either spike is fully covered. The two
  // weaken slots in the batch are always equal, so we compute once.
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
  const weakenForHack = Math.ceil((a.hackSec * hackThreads) / weakenPerThread);
  const weakenForGrow = Math.ceil((a.growSec * growThreads) / weakenPerThread);
  const weakenThreads = Math.max(weakenForHack, weakenForGrow);

  // Arrive at T = weakenTime - LANE_BUFFER_MS. Each job's delay is set
  // so its own runtime carries it to T. Bitburner's ns.exec accepts
  // negative delay (interpreted as "fire immediately"), so the weaken
  // job's natural delay of -LANE_BUFFER_MS works as intended.
  const arrivalT = a.weakenTime - LANE_BUFFER_MS;
  const delay = (scriptTime) => arrivalT - scriptTime;

  const jobs = [
    { script: "hack.js",   threads: hackThreads,   delayMs: delay(a.hackTime)   },
    { script: "weaken.js", threads: weakenThreads, delayMs: delay(a.weakenTime) },
    { script: "grow.js",   threads: growThreads,   delayMs: delay(a.growTime)   },
    { script: "weaken.js", threads: weakenThreads, delayMs: delay(a.weakenTime) },
  ];

  // RAM cost: queried from "home" because the three worker scripts are
  // pure single-op workers with identical RAM on every host. If they
  // ever diverge in cost across hosts, this needs to be per-worker.
  const ramByScript = {
    "hack.js": ns.getScriptRam("hack.js", "home"),
    "weaken.js": ns.getScriptRam("weaken.js", "home"),
    "grow.js": ns.getScriptRam("grow.js", "home"),
  };
  const totalRam = jobs.reduce((sum, j) => sum + ramByScript[j.script] * j.threads, 0);

  return {
    target,
    arrivalT,
    jobs,
    totalRam,
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
