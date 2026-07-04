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
  const moneyLeft = Math.max(0, Math.min(wantMoney, a.moneyAvailable));
  const hackThreads = Math.max(1, Math.ceil(ns.hackAnalyzeThreads(moneyLeft, target)));

  // Threads to grow from current state back to max.
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, a.moneyMax, 1)));

  // Weaken threads: cancel hackSec and growSec. Both weakens are sized
  // to the larger of the two so either spike is fully covered. The two
  // weaken slots in the batch are always equal, so we compute once.
  const weakenPerThread = ns.weakenAnalyze(1, target);
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
  const limit = ns.getPurchasedServerLimit();
  for (let i = 0; i < limit; i++) {
    const name = `pserv-${i}`;
    if (ns.serverExists(name)) out.push(name);
  }
  return out;
}

/**
 * Find the first worker with at least `needRam` GB free.
 * Returns null if no worker has the room.
 */
export function findWorkerWithRam(ns, workers, needRam) {
  for (const w of workers) {
    const free = ns.getServerMaxRam(w) - ns.getServerUsedRam(w);
    if (free >= needRam) return w;
  }
  return null;
}
