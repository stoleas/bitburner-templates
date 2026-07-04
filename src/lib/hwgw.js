/** @param {NS} ns */
// src/lib/hwgw.js
// Pure-math helpers for HWGW batching. No side effects, no ns.* mutation.
// Safe to import from both runtime scripts and node test scripts.
import { NS } from "@ns";

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
    hackAnalyze: ns.hackAnalyze,        // bound function
    growthAnalyze: ns.growthAnalyze,    // bound, 1 thread
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
  // to the larger of the two so either spike is fully covered.
  const weakenPerThread = ns.weakenAnalyze(1, target);
  const weakenForHack = Math.ceil((a.hackSec * hackThreads) / weakenPerThread);
  const weakenForGrow = Math.ceil((a.growSec * growThreads) / weakenPerThread);
  const weakenThreads1 = Math.max(weakenForHack, weakenForGrow);
  const weakenThreads2 = Math.max(weakenForHack, weakenForGrow);

  // Arrive at T = weakenTime - 50 (small buffer keeps the script from
  // finishing early). Each job's delay is set so its own runtime carries
  // it to T.
  const arrivalT = a.weakenTime - 50;

  const jobs = [
    { script: "hack.js",   threads: hackThreads,    delayMs: arrivalT - a.hackTime   },
    { script: "weaken.js", threads: weakenThreads1, delayMs: arrivalT - a.weakenTime },
    { script: "grow.js",   threads: growThreads,    delayMs: arrivalT - a.growTime   },
    { script: "weaken.js", threads: weakenThreads2, delayMs: arrivalT - a.weakenTime },
  ];

  // RAM cost (querying from "home" — the orchestrator's home of record).
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
    summary: `target=${target} hack=${hackThreads} w1=${weakenThreads1} grow=${growThreads} w2=${weakenThreads2} ram=${totalRam.toFixed(1)}GB`,
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
