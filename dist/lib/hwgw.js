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
    if (!s.hasAdminRights)
        throw new Error(`analyze: no root on ${target}`);
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
    const wantMoneyFraction = opts.moneyFraction ?? 0.10; // steal 10% per batch
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
        { script: "hack.js", threads: hackThreads, delayMs: delay(a.hackTime) },
        { script: "weaken.js", threads: weakenThreads, delayMs: delay(a.weakenTime) },
        { script: "grow.js", threads: growThreads, delayMs: delay(a.growTime) },
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
        if (free > largestFreeRam)
            largestFreeRam = free;
    }
    // The full batch's bottleneck is the LARGEST single job (usually
    // one of the two weakens). If the fleet (per-target share) can
    // carry the WHOLE batch (4 jobs summed), we run a normal HWGW.
    // Otherwise, we drop to recovery mode (weaken-only, sized to
    // the largest single worker).
    const biggestJobRam = Math.max(hackThreads * ramByScript["hack.js"], weakenThreads * ramByScript["weaken.js"], growThreads * ramByScript["grow.js"]);
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
        const recoverThreads = Math.max(1, Math.floor((largestFreeRam * safetyMargin) / ramByScript["weaken.js"]));
        // Reduce drift by recoverThreads * weakenPerThread per batch.
        // With drift=620 and recoverThreads=8000 (1.4 GB free × 5% =
        // 13.3k threads, but free RAM is more like 14 TB on a 15 TB
        // cluster), we drain ~400 sec per batch. Two batches recover
        // iron-gym fully.
        const recoverJobs = [
            { script: "weaken.js", threads: recoverThreads, delayMs: 0 }, // fire immediately
        ];
        const recoverTotalRam = recoverJobs.reduce((sum, j) => sum + ramByScript[j.script] * j.threads, 0);
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
        if (ns.serverExists(name))
            out.push(name);
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
            if (!seen.has(n)) {
                seen.add(n);
                queue.push(n);
            }
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
    const worldHosts = listReachableServers(ns).filter((h) => !pservSet.has(h) && ns.hasRootAccess(h) && ns.getServerMaxRam(h) > 0);
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
        if (remaining <= 0)
            break;
        const free = Math.max(0, ns.getServerMaxRam(h) - ns.getServerUsedRam(h) - r);
        const canFit = Math.floor(free / ram);
        if (canFit <= 0)
            continue;
        const put = Math.min(canFit, remaining);
        if (ns.exec(script, h, put, target, Math.round(delay), id))
            remaining -= put;
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
    const placement = []; // for --verbose: which host got how many threads of which job
    for (const job of plan.jobs) {
        const jobDelay = job.delayMs + targetOffset;
        const placed = allocate(ns, fleet, job.script, job.threads, target, jobDelay, id);
        if (placed < job.threads && minPlaced === Infinity)
            minPlaced = 0; // early-out
        if (placed < minPlaced)
            minPlaced = placed;
        if (verbose)
            placement.push({ script: job.script, threads: placed, of: job.threads, delay: jobDelay });
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
    return plan.jobs.reduce((sum, j) => sum + j.threads * (j.script === "hack.js" ? hackRam : j.script === "weaken.js" ? weakenRam : growRam), 0);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHdndy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9saWIvaHdndy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFLQSxtRUFBbUU7QUFDbkUsa0VBQWtFO0FBQ2xFLHFFQUFxRTtBQUNyRSxxRUFBcUU7QUFDckUsZ0VBQWdFO0FBQ2hFLE1BQU0sY0FBYyxHQUFHLEVBQUUsQ0FBQztBQUUxQixpRUFBaUU7QUFDakUsa0VBQWtFO0FBQ2xFLGlFQUFpRTtBQUNqRSw0REFBNEQ7QUFDNUQsZ0VBQWdFO0FBQ2hFLDhEQUE4RDtBQUM5RCw2REFBNkQ7QUFDN0QsTUFBTSxnQkFBZ0IsR0FBRyxFQUFFLENBQUM7QUFFNUIsaUVBQWlFO0FBQ2pFLGdFQUFnRTtBQUNoRSwyREFBMkQ7QUFDM0QsK0RBQStEO0FBQy9ELG1FQUFtRTtBQUNuRSw0REFBNEQ7QUFDNUQsa0RBQWtEO0FBQ2xELG9EQUFvRDtBQUNwRCxNQUFNLHVCQUF1QixHQUFHLElBQUksQ0FBQztBQUVyQywrREFBK0Q7QUFDL0QsaUVBQWlFO0FBQ2pFLDhEQUE4RDtBQUM5RCw2REFBNkQ7QUFDN0QscUVBQXFFO0FBQ3JFLE1BQU0sZUFBZSxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7QUFFOUI7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLE9BQU8sQ0FBQyxFQUFFLEVBQUUsTUFBTTtJQUNoQyxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQy9CLElBQUksQ0FBQyxDQUFDLENBQUMsY0FBYztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsdUJBQXVCLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDeEUsT0FBTztRQUNMLE1BQU07UUFDTiw2REFBNkQ7UUFDN0QsK0RBQStEO1FBQy9ELHlEQUF5RDtRQUN6RCxtREFBbUQ7UUFDbkQsUUFBUSxFQUFFLEVBQUUsQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDO1FBQ2hDLFFBQVEsRUFBRSxFQUFFLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQztRQUNoQyxVQUFVLEVBQUUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUM7UUFDcEMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFDO1FBQzFDLE9BQU8sRUFBRSxFQUFFLENBQUMscUJBQXFCLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQztRQUM1QyxjQUFjLEVBQUUsQ0FBQyxDQUFDLGNBQWM7UUFDaEMsUUFBUSxFQUFFLENBQUMsQ0FBQyxRQUFRO1FBQ3BCLE1BQU0sRUFBRSxDQUFDLENBQUMsYUFBYTtRQUN2QixNQUFNLEVBQUUsQ0FBQyxDQUFDLGNBQWM7S0FDekIsQ0FBQztBQUNKLENBQUM7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsTUFBTSxVQUFVLFNBQVMsQ0FBQyxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUk7SUFDeEMsTUFBTSxDQUFDLEdBQUcsT0FBTyxDQUFDLEVBQUUsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUM5QixNQUFNLGlCQUFpQixHQUFHLElBQUksQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDLENBQUUsc0JBQXNCO0lBQzdFLE1BQU0sU0FBUyxHQUFHLENBQUMsQ0FBQyxRQUFRLEdBQUcsaUJBQWlCLENBQUM7SUFFakQsZ0VBQWdFO0lBQ2hFLGtFQUFrRTtJQUNsRSwwREFBMEQ7SUFDMUQsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUM7SUFDckUsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsa0JBQWtCLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUVyRixrREFBa0Q7SUFDbEQscUVBQXFFO0lBQ3JFLEVBQUU7SUFDRixrRUFBa0U7SUFDbEUsZ0VBQWdFO0lBQ2hFLGdFQUFnRTtJQUNoRSxrRUFBa0U7SUFDbEUsNkRBQTZEO0lBQzdELDBEQUEwRDtJQUMxRCw4REFBOEQ7SUFDOUQsK0RBQStEO0lBQy9ELHNDQUFzQztJQUN0QyxFQUFFO0lBQ0YsK0RBQStEO0lBQy9ELDREQUE0RDtJQUM1RCx5REFBeUQ7SUFDekQsaUVBQWlFO0lBQ2pFLCtEQUErRDtJQUMvRCwrREFBK0Q7SUFDL0Qsd0RBQXdEO0lBQ3hELHNCQUFzQjtJQUN0QixNQUFNLGNBQWMsR0FBRyxDQUFDLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQztJQUNsRSxNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLGNBQWMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFFeEYsNERBQTREO0lBQzVELCtDQUErQztJQUMvQyxFQUFFO0lBQ0YsaUVBQWlFO0lBQ2pFLGlFQUFpRTtJQUNqRSxtRUFBbUU7SUFDbkUsaUVBQWlFO0lBQ2pFLGtFQUFrRTtJQUNsRSxnRUFBZ0U7SUFDaEUsZ0VBQWdFO0lBQ2hFLDJDQUEyQztJQUMzQyxFQUFFO0lBQ0YsZ0VBQWdFO0lBQ2hFLHlDQUF5QztJQUN6QyxFQUFFO0lBQ0YseUZBQXlGO0lBQ3pGLDZEQUE2RDtJQUM3RCxFQUFFO0lBQ0YsOERBQThEO0lBQzlELDZEQUE2RDtJQUM3RCwyREFBMkQ7SUFDM0QsRUFBRTtJQUNGLG9FQUFvRTtJQUNwRSxxRUFBcUU7SUFDckUsa0VBQWtFO0lBQ2xFLG1FQUFtRTtJQUNuRSxvRUFBb0U7SUFDcEUseUNBQXlDO0lBQ3pDLEVBQUU7SUFDRixpRUFBaUU7SUFDakUsK0RBQStEO0lBQy9ELG1FQUFtRTtJQUNuRSxnRUFBZ0U7SUFDaEUsa0VBQWtFO0lBQ2xFLGlFQUFpRTtJQUNqRSxNQUFNLGVBQWUsR0FBRyxFQUFFLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVDLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2xELE1BQU0sV0FBVyxHQUFHLENBQUMsQ0FBQyxDQUFDLE9BQU8sR0FBRyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLEdBQUcsV0FBVyxDQUFDLENBQUM7SUFDMUUsTUFBTSxnQkFBZ0IsR0FBRyxRQUFRLEdBQUcsV0FBVyxDQUFDO0lBQ2hELE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsZUFBZSxDQUFDLENBQUMsQ0FBQztJQUVqRix3QkFBd0I7SUFDeEIsaUVBQWlFO0lBQ2pFLG1FQUFtRTtJQUNuRSxrRUFBa0U7SUFDbEUsb0VBQW9FO0lBQ3BFLDRDQUE0QztJQUM1QyxFQUFFO0lBQ0Ysc0RBQXNEO0lBQ3RELGtFQUFrRTtJQUNsRSxtREFBbUQ7SUFDbkQsRUFBRTtJQUNGLGlFQUFpRTtJQUNqRSw2REFBNkQ7SUFDN0Qsa0VBQWtFO0lBQ2xFLCtEQUErRDtJQUMvRCxrRUFBa0U7SUFDbEUsOERBQThEO0lBQzlELEVBQUU7SUFDRiwrREFBK0Q7SUFDL0Qsa0VBQWtFO0lBQ2xFLGdFQUFnRTtJQUNoRSwwREFBMEQ7SUFDMUQsRUFBRTtJQUNGLDREQUE0RDtJQUM1RCwyREFBMkQ7SUFDM0QsK0RBQStEO0lBQy9ELGdFQUFnRTtJQUNoRSx1REFBdUQ7SUFDdkQsTUFBTSxXQUFXLEdBQUc7UUFDbEIsU0FBUyxFQUFFLEVBQUUsQ0FBQyxZQUFZLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQztRQUM3QyxXQUFXLEVBQUUsRUFBRSxDQUFDLFlBQVksQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDO1FBQ2pELFNBQVMsRUFBRSxFQUFFLENBQUMsWUFBWSxDQUFDLFNBQVMsRUFBRSxNQUFNLENBQUM7S0FDOUMsQ0FBQztJQUNGLE1BQU0sUUFBUSxHQUFHLENBQUMsQ0FBQyxVQUFVLEdBQUcsY0FBYyxDQUFDO0lBQy9DLE1BQU0sS0FBSyxHQUFHLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxRQUFRLEdBQUcsVUFBVSxDQUFDO0lBQ3BELE1BQU0sSUFBSSxHQUFHO1FBQ1gsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFJLE9BQU8sRUFBRSxXQUFXLEVBQUksT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUk7UUFDN0UsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxhQUFhLEVBQUUsT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEVBQUU7UUFDN0UsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFJLE9BQU8sRUFBRSxXQUFXLEVBQUksT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUk7UUFDN0UsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxhQUFhLEVBQUUsT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEVBQUU7S0FDOUUsQ0FBQztJQUNGLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUcsV0FBVyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBRXJGLG9FQUFvRTtJQUNwRSxnRUFBZ0U7SUFDaEUsK0RBQStEO0lBQy9ELDhEQUE4RDtJQUM5RCw2REFBNkQ7SUFDN0QsOERBQThEO0lBQzlELDRDQUE0QztJQUM1QyxFQUFFO0lBQ0YsdURBQXVEO0lBQ3ZELDREQUE0RDtJQUM1RCwrREFBK0Q7SUFDL0QsK0NBQStDO0lBQy9DLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM3QixNQUFNLGNBQWMsR0FBRyxTQUFTLENBQUMsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzVDLE1BQU0saUJBQWlCLEdBQUcsY0FBYyxHQUFHLGNBQWMsQ0FBQyxlQUFlLENBQUM7SUFDMUUsa0VBQWtFO0lBQ2xFLDREQUE0RDtJQUM1RCw0REFBNEQ7SUFDNUQsaUVBQWlFO0lBQ2pFLDhEQUE4RDtJQUM5RCxnRUFBZ0U7SUFDaEUsMkRBQTJEO0lBQzNELElBQUksY0FBYyxHQUFHLENBQUMsQ0FBQztJQUN2QixLQUFLLE1BQU0sQ0FBQyxJQUFJLFdBQVcsQ0FBQyxFQUFFLENBQUMsRUFBRTtRQUMvQixNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM1RCxJQUFJLElBQUksR0FBRyxjQUFjO1lBQUUsY0FBYyxHQUFHLElBQUksQ0FBQztLQUNsRDtJQUVELGlFQUFpRTtJQUNqRSwrREFBK0Q7SUFDL0QsK0RBQStEO0lBQy9ELDZEQUE2RDtJQUM3RCw4QkFBOEI7SUFDOUIsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FDNUIsV0FBVyxHQUFHLFdBQVcsQ0FBQyxTQUFTLENBQUMsRUFDcEMsYUFBYSxHQUFHLFdBQVcsQ0FBQyxXQUFXLENBQUMsRUFDeEMsV0FBVyxHQUFHLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FDckMsQ0FBQztJQUVGLGdFQUFnRTtJQUNoRSxnRUFBZ0U7SUFDaEUsOERBQThEO0lBQzlELDZEQUE2RDtJQUM3RCw4REFBOEQ7SUFDOUQseURBQXlEO0lBQ3pELHdDQUF3QztJQUN4QyxFQUFFO0lBQ0Ysd0RBQXdEO0lBQ3hELDZEQUE2RDtJQUM3RCwrREFBK0Q7SUFDL0QsNERBQTREO0lBQzVELHlEQUF5RDtJQUN6RCx5REFBeUQ7SUFDekQsNkRBQTZEO0lBQzdELDJEQUEyRDtJQUMzRCx1REFBdUQ7SUFDdkQsRUFBRTtJQUNGLDBEQUEwRDtJQUMxRCwwREFBMEQ7SUFDMUQsbURBQW1EO0lBQ25ELE1BQU0sYUFBYSxHQUFHLFFBQVEsSUFBSSxjQUFjLENBQUM7SUFFakQsSUFBSSxDQUFDLGFBQWEsRUFBRTtRQUNsQixnRUFBZ0U7UUFDaEUsNERBQTREO1FBQzVELDJEQUEyRDtRQUMzRCx5REFBeUQ7UUFDekQsd0RBQXdEO1FBQ3hELG1FQUFtRTtRQUNuRSxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUM7UUFDMUIsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FDN0IsQ0FBQyxFQUNELElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxjQUFjLEdBQUcsWUFBWSxDQUFDLEdBQUcsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQ3ZFLENBQUM7UUFDRiw4REFBOEQ7UUFDOUQsNkRBQTZEO1FBQzdELDREQUE0RDtRQUM1RCw2REFBNkQ7UUFDN0Qsa0JBQWtCO1FBQ2xCLE1BQU0sV0FBVyxHQUFHO1lBQ2xCLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE9BQU8sRUFBRSxDQUFDLEVBQUUsRUFBRyxtQkFBbUI7U0FDbkYsQ0FBQztRQUNGLE1BQU0sZUFBZSxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQ3hDLENBQUMsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQ3ZELENBQUM7UUFDRixPQUFPO1lBQ0wsTUFBTTtZQUNOLFFBQVE7WUFDUixJQUFJLEVBQUUsV0FBVztZQUNqQixRQUFRLEVBQUUsZUFBZTtZQUN6QixZQUFZLEVBQUUsSUFBSTtZQUNsQixPQUFPLEVBQUUsVUFBVSxNQUFNLG1CQUFtQixRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLGNBQWMsUUFBUSxlQUFlLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyw2QkFBNkIsQ0FBQyxhQUFhLEdBQUcsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLO1NBQzdNLENBQUM7S0FDSDtJQUVELE9BQU87UUFDTCxNQUFNO1FBQ04sUUFBUTtRQUNSLElBQUk7UUFDSixRQUFRO1FBQ1IsWUFBWSxFQUFFLEtBQUs7UUFDbkIsT0FBTyxFQUFFLFVBQVUsTUFBTSxTQUFTLFdBQVcsTUFBTSxhQUFhLFNBQVMsV0FBVyxRQUFRLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUk7S0FDcEgsQ0FBQztBQUNKLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsV0FBVyxDQUFDLEVBQUU7SUFDNUIsTUFBTSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNyQixNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO0lBQ3hDLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxFQUFFLEVBQUU7UUFDOUIsTUFBTSxJQUFJLEdBQUcsU0FBUyxDQUFDLEVBQUUsQ0FBQztRQUMxQixJQUFJLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDO1lBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztLQUMzQztJQUNELE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7Ozs7O0dBZ0JHO0FBQ0gsTUFBTSxVQUFVLGlCQUFpQixDQUFDLEVBQUUsRUFBRSxPQUFPLEVBQUUsT0FBTztJQUNwRCxJQUFJLFFBQVEsR0FBRyxJQUFJLENBQUM7SUFDcEIsSUFBSSxPQUFPLEdBQUcsUUFBUSxDQUFDO0lBQ3ZCLEtBQUssTUFBTSxDQUFDLElBQUksT0FBTyxFQUFFO1FBQ3ZCLE1BQU0sR0FBRyxHQUFHLEVBQUUsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEMsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3BDLElBQUksR0FBRyxHQUFHLElBQUksSUFBSSxPQUFPLElBQUksR0FBRyxHQUFHLE9BQU8sRUFBRTtZQUMxQyxRQUFRLEdBQUcsQ0FBQyxDQUFDO1lBQ2IsT0FBTyxHQUFHLEdBQUcsQ0FBQztTQUNmO0tBQ0Y7SUFDRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTJCRztBQUNILE1BQU0sVUFBVSx3QkFBd0IsQ0FBQyxFQUFFLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxlQUFlLEdBQUcsRUFBRTtJQUNqRixJQUFJLFFBQVEsR0FBRyxJQUFJLENBQUM7SUFDcEIsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDbEIsS0FBSyxNQUFNLENBQUMsSUFBSSxPQUFPLEVBQUU7UUFDdkIsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNsQyxNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDcEMsMkRBQTJEO1FBQzNELDhEQUE4RDtRQUM5RCwwREFBMEQ7UUFDMUQseUNBQXlDO1FBQ3pDLE1BQU0sUUFBUSxHQUFHLENBQUMsS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3BELE1BQU0sSUFBSSxHQUFHLEdBQUcsR0FBRyxJQUFJLEdBQUcsUUFBUSxDQUFDO1FBQ25DLElBQUksSUFBSSxJQUFJLE9BQU8sSUFBSSxJQUFJLEdBQUcsUUFBUSxFQUFFO1lBQ3RDLFFBQVEsR0FBRyxDQUFDLENBQUM7WUFDYixRQUFRLEdBQUcsSUFBSSxDQUFDO1NBQ2pCO0tBQ0Y7SUFDRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBRUQsK0VBQStFO0FBQy9FLDBFQUEwRTtBQUMxRSxxRUFBcUU7QUFDckUseUVBQXlFO0FBQ3pFLHNFQUFzRTtBQUN0RSx1RUFBdUU7QUFDdkUsaUNBQWlDO0FBQ2pDLCtFQUErRTtBQUUvRTs7OztHQUlHO0FBQ0gsTUFBTSxVQUFVLG9CQUFvQixDQUFDLEVBQUU7SUFDckMsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3RCLE1BQU0sSUFBSSxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUMvQixNQUFNLEtBQUssR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3ZCLE9BQU8sS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7UUFDdkIsTUFBTSxDQUFDLEdBQUcsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ3hCLEtBQUssTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUMxQixJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRTtnQkFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFBRTtTQUNsRDtLQUNGO0lBQ0QsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEtBQUssTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDdEQsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBQ0gsTUFBTSxVQUFVLFVBQVUsQ0FBQyxFQUFFLEVBQUUsZUFBZSxHQUFHLGdCQUFnQjtJQUMvRCxNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO0lBQ3pDLE1BQU0sUUFBUSxHQUFHLElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2pDLGtFQUFrRTtJQUNsRSxpRUFBaUU7SUFDakUsNkRBQTZEO0lBQzdELGdFQUFnRTtJQUNoRSwyQ0FBMkM7SUFDM0MsTUFBTSxVQUFVLEdBQUcsb0JBQW9CLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUNoRCxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQzVFLENBQUM7SUFDRixPQUFPO1FBQ0wsRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxlQUFlLEVBQUU7UUFDakMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ25DLEdBQUcsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQztLQUN4QyxDQUFDO0FBQ0osQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLFVBQVUsU0FBUyxDQUFDLEVBQUUsRUFBRSxLQUFLO0lBQ2pDLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQztJQUNiLEtBQUssTUFBTSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsSUFBSSxLQUFLLEVBQUU7UUFDNUIsSUFBSSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0tBQ3pFO0lBQ0QsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDO0FBRUQ7Ozs7Ozs7OztHQVNHO0FBQ0gsTUFBTSxVQUFVLFlBQVksQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLE9BQU8sR0FBRyxDQUFDLFNBQVMsRUFBRSxXQUFXLEVBQUUsU0FBUyxDQUFDO0lBQ25GLEtBQUssTUFBTSxFQUFFLENBQUMsRUFBRSxJQUFJLEtBQUssRUFBRTtRQUN6QixLQUFLLE1BQU0sTUFBTSxJQUFJLE9BQU8sRUFBRTtZQUM1QixJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLEVBQUU7Z0JBQzdCLEVBQUUsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQzthQUMzQjtTQUNGO0tBQ0Y7QUFDSCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7R0FVRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQUMsRUFBRSxFQUFFLEtBQUssRUFBRSxlQUFlLEdBQUcsZ0JBQWdCO0lBQzNFLE9BQU8sS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRTtRQUN6QixNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2xDLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNwQyxNQUFNLFFBQVEsR0FBRyxDQUFDLEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNwRCxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxHQUFHLEdBQUcsSUFBSSxHQUFHLFFBQVEsQ0FBQyxFQUFFLENBQUM7SUFDdEQsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FtQkc7QUFDSCxNQUFNLFVBQVUsUUFBUSxDQUFDLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLEVBQUU7SUFDcEUsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNwQyxJQUFJLFNBQVMsR0FBRyxPQUFPLENBQUM7SUFDeEIsS0FBSyxNQUFNLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxJQUFJLEtBQUssRUFBRTtRQUM1QixJQUFJLFNBQVMsSUFBSSxDQUFDO1lBQUUsTUFBTTtRQUMxQixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUM3RSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksR0FBRyxHQUFHLENBQUMsQ0FBQztRQUN0QyxJQUFJLE1BQU0sSUFBSSxDQUFDO1lBQUUsU0FBUztRQUMxQixNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztRQUN4QyxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsTUFBTSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQUUsU0FBUyxJQUFJLEdBQUcsQ0FBQztLQUM5RTtJQUNELE9BQU8sT0FBTyxHQUFHLFNBQVMsQ0FBQztBQUM3QixDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXFCRztBQUNILE1BQU0sVUFBVSxXQUFXLENBQUMsRUFBRSxFQUFFLEtBQUs7SUFDbkMsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsS0FBSyxNQUFNLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxJQUFJLEtBQUssRUFBRTtRQUM1QixLQUFLLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztLQUNqRDtJQUNELE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsZUFBZSxDQUFDLENBQUM7QUFDN0MsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7Ozs7OztHQWlCRztBQUNILE1BQU0sVUFBVSxhQUFhLENBQUMsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLFlBQVksRUFBRSxFQUFFLEVBQUUsT0FBTztJQUM5RSxvREFBb0Q7SUFDcEQsd0RBQXdEO0lBQ3hELDREQUE0RDtJQUM1RCwwREFBMEQ7SUFDMUQsK0NBQStDO0lBQy9DLElBQUksU0FBUyxHQUFHLFFBQVEsQ0FBQztJQUN6QixNQUFNLFNBQVMsR0FBRyxFQUFFLENBQUMsQ0FBRSw4REFBOEQ7SUFDckYsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFO1FBQzNCLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQyxPQUFPLEdBQUcsWUFBWSxDQUFDO1FBQzVDLE1BQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLEdBQUcsQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2xGLElBQUksTUFBTSxHQUFHLEdBQUcsQ0FBQyxPQUFPLElBQUksU0FBUyxLQUFLLFFBQVE7WUFBRSxTQUFTLEdBQUcsQ0FBQyxDQUFDLENBQUUsWUFBWTtRQUNoRixJQUFJLE1BQU0sR0FBRyxTQUFTO1lBQUUsU0FBUyxHQUFHLE1BQU0sQ0FBQztRQUMzQyxJQUFJLE9BQU87WUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLEVBQUUsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFLEVBQUUsR0FBRyxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLENBQUMsQ0FBQztLQUN4RztJQUNELE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLENBQUM7QUFDbEMsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLFVBQVUsU0FBUyxDQUFDLEVBQUUsRUFBRSxNQUFNO0lBQ2xDLE9BQU8sRUFBRSxDQUFDLHNCQUFzQixDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyx5QkFBeUIsQ0FBQyxNQUFNLENBQUMsR0FBRyxJQUFJO1FBQ2hGLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsaUJBQWlCLENBQUMsTUFBTSxDQUFDLEdBQUcsS0FBSyxDQUFDO0FBQ3BGLENBQUM7QUFFRDs7Ozs7Ozs7Ozs7O0dBWUc7QUFDSCxNQUFNLFVBQVUsU0FBUyxDQUFDLEVBQUUsRUFBRSxNQUFNLEVBQUUsWUFBWSxFQUFFLGFBQWEsR0FBRyxHQUFHLEVBQUUsWUFBWSxHQUFHLENBQUM7SUFDdkYsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDLGlCQUFpQixDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzlDLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyx5QkFBeUIsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNwRCxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsdUJBQXVCLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDakQsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLHNCQUFzQixDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzlDLGlFQUFpRTtJQUNqRSxtRUFBbUU7SUFDbkUsZ0RBQWdEO0lBQ2hELE9BQU8sS0FBSyxJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUMsR0FBRyxZQUFZLENBQUMsR0FBRyxhQUFhLElBQUksR0FBRyxJQUFJLE1BQU0sR0FBRyxZQUFZLENBQUM7QUFDaEcsQ0FBQztBQUVEOzs7Ozs7Ozs7O0dBVUc7QUFDSCxNQUFNLFVBQVUsYUFBYSxDQUFDLEVBQUUsRUFBRSxJQUFJO0lBQ3BDLE1BQU0sT0FBTyxHQUFHLEVBQUUsQ0FBQyxZQUFZLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ25ELE1BQU0sU0FBUyxHQUFHLEVBQUUsQ0FBQyxZQUFZLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ3ZELE1BQU0sT0FBTyxHQUFHLEVBQUUsQ0FBQyxZQUFZLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ25ELE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQ3JCLENBQUMsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQ1QsR0FBRyxHQUFHLENBQUMsQ0FBQyxPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLFdBQVcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFDdkcsQ0FBQyxDQUNGLENBQUM7QUFDSixDQUFDO0FBRUQsaUVBQWlFO0FBQ2pFLGtFQUFrRTtBQUNsRSxpRUFBaUU7QUFDakUsZ0RBQWdEO0FBQ2hELE1BQU0sQ0FBQyxNQUFNLGNBQWMsR0FBRztJQUM1QixnQkFBZ0I7SUFDaEIsdUJBQXVCO0lBQ3ZCLGVBQWU7Q0FDaEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIHNyYy9saWIvaHdndy5qc1xuLy8gUHVyZS1tYXRoIGhlbHBlcnMgZm9yIEhXR1cgYmF0Y2hpbmcuIE5vIHNpZGUgZWZmZWN0cywgbm8gbnMuKiBtdXRhdGlvbi5cbi8vIFNhZmUgdG8gaW1wb3J0IGZyb20gYm90aCBydW50aW1lIHNjcmlwdHMgYW5kIG5vZGUgdGVzdCBzY3JpcHRzLlxuaW1wb3J0IHsgTlMgfSBmcm9tIFwiQG5zXCI7XG5cbi8vIFNtYWxsIGJ1ZmZlciBzdWJ0cmFjdGVkIGZyb20gYXJyaXZhbFQgc28gYSBzY3JpcHQgdGhhdCBub21pbmFsbHlcbi8vIGZpbmlzaGVzIGF0IFQgZG9lc24ndCBmaXJlIDBtcyBiZWZvcmUgdGhlIG5leHQgb3BlcmF0aW9uIGxhbmRzLlxuLy8gQml0YnVybmVyJ3MgcnVudGltZXMgYXJlIGRldGVybWluaXN0aWMgYnV0IHRoZSA1MG1zIGhlYWRyb29tIGtlZXBzXG4vLyBIV0dXIHRpbWluZyByb2J1c3QgdW5kZXIgbWlub3IgamFuay4gVGhlIG1hdGggaXMgYWxzbyBjbGFtcGVkIHRvIDBcbi8vIGJlbG93IHNvIGEgZnV0dXJlIGZhc3QgdGFyZ2V0IGNhbid0IHByb2R1Y2UgbmVnYXRpdmUgZGVsYXlNcy5cbmNvbnN0IExBTkVfQlVGRkVSX01TID0gNTA7XG5cbi8vIEdCIG9mIGhvbWUgUkFNIGtlcHQgZnJlZSBmb3Igc3lzdGVtIHNjcmlwdHMgKG1vbml0b3ItbnVrZS5qcydzXG4vLyBudWtlLmpzIGludm9jYXRpb25zLCBtb25pdG9yLWJ1eS5qcydzIHB1cmNoYXNlIHByb2dyYW1zLCBldGMuKS5cbi8vIFdpdGhvdXQgdGhpcywgdGhlIGZsZWV0LWJhdGNoZXIgaGFwcGlseSBjb25zdW1lcyBhbGwgb2YgaG9tZSdzXG4vLyBmcmVlIFJBTSBhbmQgdGhlIG5leHQgbnVrZS5qcyAvIGJ1eS5leGUgbGF1bmNoIGZhaWxzIHdpdGhcbi8vIFwibm90IGVub3VnaCBSQU1cIiDigJQgdGhlIFBpdGZhbGwgMjUgLyBcImhvbWUgaGVhZHJvb20gZm9yIHN5c3RlbVxuLy8gc2NyaXB0c1wiIGlzc3VlLiAzMiBHQiBjb3ZlcnMgYSBzaW5nbGUgbnVrZS5qcyAofjEwIEdCKSBwbHVzXG4vLyBhIGJpdCBvZiBidWZmZXIuIEJ1bXAgdXAgaWYgeW91IGFkZCBsYXJnZXIgc3lzdGVtIHNjcmlwdHMuXG5jb25zdCBIT01FX0hFQURST09NX0dCID0gMzI7XG5cbi8vIEZyYWN0aW9uIG9mIGZsZWV0RnJlZSByZXNlcnZlZCBhcyBhIFwiZnJhZ21lbnRhdGlvbiBidWZmZXJcIiBmb3Jcbi8vIHRoZSBmbGVldC1iYXRjaGVyLiBTb3VyY2VkIGZyb20gc2tlZXNsZXIvYml0YnVybmVyLWNvbW1hbmRlcjpcbi8vIHRoZSA1JSBoZWFkcm9vbSBhYnNvcmJzIHBlci1ob3N0IGZyYWdtZW50YXRpb24gKGZyZWUgUkFNXG4vLyBzY2F0dGVyZWQgaW4gc3ViLXRocmVhZCBzbGl2ZXJzIGFjcm9zcyBwc2VydnMpIHNvIGFsbG9jYXRlKClcbi8vIGNhbiBhbHdheXMgcGxhY2UgZXZlcnkgb3AgZnVsbHkuIFdpdGhvdXQgaXQsIGEgcGFydGlhbCBwbGFjZW1lbnRcbi8vIHByb2R1Y2VzIGEgcGFydGlhbCBiYXRjaCAoaGFjayB3aXRob3V0IGVub3VnaCBncm93KSB3aGljaFxuLy8gZHJhaW5zIHRoZSB0YXJnZXQgd2l0aG91dCByZWZpbGxpbmcgaXQuIFNlZSB0aGVcbi8vIGZsZWV0LWJhdGNoZXItcGF0dGVybiByZWYgaW4gYml0YnVybmVyLWRldiBza2lsbC5cbmNvbnN0IEZMRUVUX0hFQURST09NX0ZSQUNUSU9OID0gMC45NTtcblxuLy8gQ2FwIG9uIGEgc2luZ2xlIHRhcmdldCdzIGZsZWV0IHNoYXJlLiBFbmZvcmNlZCBpbiBtYW5hZ2VyLmpzXG4vLyAocGVyLXRhcmdldCBzaGFyZSBnYXRlLCBzZWUgc2hhcmVSYW1DYXAgaW4gdGhpcyBmaWxlKS4gV2l0aG91dFxuLy8gdGhpcywgdGhlIHRvcC1yYW5rZWQgdGFyZ2V0IGJ5IG1vbmV5TWF4IChwaGFudGFzeSkgY29uc3VtZXNcbi8vIHRoZSB3aG9sZSBjbHVzdGVyIG9uIGV2ZXJ5IHRpY2sgYW5kIHRhcmdldHMgIzIuLiM5IHN0YXJ2ZS5cbi8vIFNvdXJjZWQgZnJvbSBza2Vlc2xlci9iaXRidXJuZXItY29tbWFuZGVyIChNQVhfRkxFRVRfU0hBUkUgPSAxLzMpLlxuY29uc3QgTUFYX0ZMRUVUX1NIQVJFID0gMSAvIDM7XG5cbi8qKlxuICogUHVsbCB0aGUgcGVyLXRhcmdldCB0aW1pbmcgKyBzdGF0ZSB3ZSBuZWVkIHRvIHBsYW4gYSBiYXRjaC5cbiAqIFRocm93cyBpZiB0aGUgdGFyZ2V0IGlzbid0IHJvb3RlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFuYWx5emUobnMsIHRhcmdldCkge1xuICBjb25zdCBzID0gbnMuZ2V0U2VydmVyKHRhcmdldCk7XG4gIGlmICghcy5oYXNBZG1pblJpZ2h0cykgdGhyb3cgbmV3IEVycm9yKGBhbmFseXplOiBubyByb290IG9uICR7dGFyZ2V0fWApO1xuICByZXR1cm4ge1xuICAgIHRhcmdldCxcbiAgICAvLyBCaXRidXJuZXIgMy4wKyBzaWduYXR1cmVzOiBob3N0IGlzIHRoZSBmaXJzdCBhcmcsIHRoZSByZXN0XG4gICAgLy8gb2YgdGhlIGFyZ3MgYXJlIG51bWJlcnMgKHRocmVhZHMgLyBtdWx0aXBsaWVyIC8gaGFja0Ftb3VudCkuXG4gICAgLy8gRE8gTk9UIHBhc3MgaG9zdCBhcyB0aGUgTEFTVCBhcmcg4oCUIHRoYXQgd2FzIHRoZSBsZWdhY3lcbiAgICAvLyBzaWduYXR1cmUgaW4gcHJlLTMuMCBhbmQgaXMgdGhlIHdyb25nIG9yZGVyIG5vdy5cbiAgICBoYWNrVGltZTogbnMuZ2V0SGFja1RpbWUodGFyZ2V0KSxcbiAgICBncm93VGltZTogbnMuZ2V0R3Jvd1RpbWUodGFyZ2V0KSxcbiAgICB3ZWFrZW5UaW1lOiBucy5nZXRXZWFrZW5UaW1lKHRhcmdldCksXG4gICAgaGFja1NlYzogbnMuaGFja0FuYWx5emVTZWN1cml0eSgxLCB0YXJnZXQpLFxuICAgIGdyb3dTZWM6IG5zLmdyb3d0aEFuYWx5emVTZWN1cml0eSgxLCB0YXJnZXQpLFxuICAgIG1vbmV5QXZhaWxhYmxlOiBzLm1vbmV5QXZhaWxhYmxlLFxuICAgIG1vbmV5TWF4OiBzLm1vbmV5TWF4LFxuICAgIG1pblNlYzogcy5taW5EaWZmaWN1bHR5LFxuICAgIGN1clNlYzogcy5oYWNrRGlmZmljdWx0eSxcbiAgfTtcbn1cblxuLyoqXG4gKiBQbGFuIHRoZSBmb3VyIGJhdGNoIGpvYnMgdGhhdCwgd2hlbiBmaXJlZCB3aXRoIHRoZSBnaXZlbiBkZWxheXMsXG4gKiBsYW5kIG9uIGB0YXJnZXRgIGF0IHRoZSBzYW1lIHdhbGwtY2xvY2sgbW9tZW50IHdpdGggdGhlIHNlY3VyaXR5XG4gKiBzcGlrZSBjYW5jZWxsZWQgYnkgdGhlIHR3byB3ZWFrZW5zLlxuICpcbiAqIFJldHVybnM6IHsgdGFyZ2V0LCBhcnJpdmFsVCwgam9icywgdG90YWxSYW0sIHN1bW1hcnkgfVxuICogICBqb2JzOiBbe3NjcmlwdCwgdGhyZWFkcywgZGVsYXlNc30sIC4uLl0gaW4gW2hhY2ssIHdlYWtlbiwgZ3Jvdywgd2Vha2VuXSBvcmRlclxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbkJhdGNoKG5zLCB0YXJnZXQsIG9wdHMpIHtcbiAgY29uc3QgYSA9IGFuYWx5emUobnMsIHRhcmdldCk7XG4gIGNvbnN0IHdhbnRNb25leUZyYWN0aW9uID0gb3B0cy5tb25leUZyYWN0aW9uID8/IDAuMTA7ICAvLyBzdGVhbCAxMCUgcGVyIGJhdGNoXG4gIGNvbnN0IHdhbnRNb25leSA9IGEubW9uZXlNYXggKiB3YW50TW9uZXlGcmFjdGlvbjtcblxuICAvLyBUaHJlYWRzIHRvIHN0ZWFsIGB3YW50TW9uZXlgLiBDbGFtcCB0byB3aGF0J3MgYWN0dWFsbHkgdGhlcmUuXG4gIC8vIEJpdGJ1cm5lciAzLjArIHNpZ25hdHVyZTogaGFja0FuYWx5emVUaHJlYWRzKGhvc3QsIGhhY2tBbW91bnQpLlxuICAvLyBUaGUgZmlyc3QgYXJnIGlzIHRoZSBob3N0LCBzZWNvbmQgaXMgdGhlIGRvbGxhciBhbW91bnQuXG4gIGNvbnN0IG1vbmV5TGVmdCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHdhbnRNb25leSwgYS5tb25leUF2YWlsYWJsZSkpO1xuICBjb25zdCBoYWNrVGhyZWFkcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbChucy5oYWNrQW5hbHl6ZVRocmVhZHModGFyZ2V0LCBtb25leUxlZnQpKSk7XG5cbiAgLy8gVGhyZWFkcyB0byBncm93IGZyb20gY3VycmVudCBzdGF0ZSBiYWNrIHRvIG1heC5cbiAgLy8gQml0YnVybmVyIDMuMCsgc2lnbmF0dXJlOiBncm93dGhBbmFseXplKGhvc3QsIG11bHRpcGxpZXIsIGNvcmVzPykuXG4gIC8vXG4gIC8vIENSSVRJQ0FMOiB0aGUgc2Vjb25kIGFyZyBpcyBhIE1VTFRJUExJQ0FUSVZFIEZBQ1RPUiAoZS5nLiAyIGZvclxuICAvLyBcImdyb3cgYnkgMnhcIiksIE5PVCBhIGRvbGxhciB0YXJnZXQuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mIHRoaXNcbiAgLy8gZnVuY3Rpb24gcGFzc2VkIGBhLm1vbmV5TWF4YCAoJDEuNzVUIGZvciBtYXgtaGFyZHdhcmUpIGFzIHRoZVxuICAvLyBtdWx0aXBsaWVyLCB3aGljaCBCaXRidXJuZXIgaW50ZXJwcmV0ZWQgYXMgXCJncm93IGJ5IGEgZmFjdG9yIG9mXG4gIC8vIDEuNzVlMTJcIiDigJQgYW5kIHJldHVybmVkIDE3LDkwNiB0aHJlYWRzICh0aGUgYWJzdXJkbHktbGFyZ2VcbiAgLy8gdGhyZWFkIGNvdW50IG5lZWRlZCB0byBncm93IGJ5IDEuNzVlMTJ4KS4gVGhvc2UgdGhyZWFkc1xuICAvLyAoMzEsMDAwKyBHQiBvZiBSQU0pIGRpZG4ndCBmaXQgb24gdGhlIGNsdXN0ZXIsIHRoZSBncm93IHdhc1xuICAvLyBzaWxlbnRseSBTS0lQLXJhbSdkIGV2ZXJ5IGJhdGNoLCBtb25leSBuZXZlciByZWdyZXcsIGFuZCB0aGVcbiAgLy8gdGFyZ2V0IGJlY2FtZSBwZXJtYW5lbnRseSBkZXBsZXRlZC5cbiAgLy9cbiAgLy8gVGhlIGNvcnJlY3QgbXVsdGlwbGllciBpcyBgbW9uZXlNYXggLyBtb25leUF2YWlsYWJsZWAg4oCUIFwiaG93XG4gIC8vIG11Y2ggZG8gd2UgbmVlZCB0byBtdWx0aXBseSB0aGUgY3VycmVudCBzdGF0ZSBieSB0byByZWFjaFxuICAvLyBtYXg/XCIgTWF0aGVtYXRpY2FsbHk6IGBjdXJyZW50ICogbXVsdGlwbGllciA9IG1heGAsIHNvXG4gIC8vIGBtdWx0aXBsaWVyID0gbWF4IC8gY3VycmVudGAuIFdoZW4gYGN1cnJlbnQgPSAwYCAoanVzdCBoYWNrZWQpXG4gIC8vIHRoaXMgd291bGQgYmUgaW5maW5pdHksIHNvIHdlIGZsb29yIGBjdXJyZW50YCBhdCAkMSB0byBhdm9pZFxuICAvLyBkaXZpZGUtYnktemVyby4gKFRoZSBgbnMuZ3Jvd2AgQVBJIGFkZHMgJDEgcGVyIHRocmVhZCBiZWZvcmVcbiAgLy8gYXBwbHlpbmcgdGhlIG11bHRpcGxpZXIsIHNvIHRoZSBhYnNvbHV0ZS16ZXJvIGNhc2UgaXNcbiAgLy8gaW1wb3NzaWJsZSBhbnl3YXkuKVxuICBjb25zdCBncm93TXVsdGlwbGllciA9IGEubW9uZXlNYXggLyBNYXRoLm1heCgxLCBhLm1vbmV5QXZhaWxhYmxlKTtcbiAgY29uc3QgZ3Jvd1RocmVhZHMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwobnMuZ3Jvd3RoQW5hbHl6ZSh0YXJnZXQsIGdyb3dNdWx0aXBsaWVyLCAxKSkpO1xuXG4gIC8vIFdlYWtlbiB0aHJlYWRzOiBjYW5jZWwgaGFja1NlYyBhbmQgZ3Jvd1NlYywgQU5EIGJyaW5nIGFueVxuICAvLyBhY2N1bXVsYXRlZCBzZWN1cml0eSBkcmlmdCBiYWNrIGRvd24gdG8gbWluLlxuICAvL1xuICAvLyBUaGUgb3JpZ2luYWwgZm9ybXVsYSBvbmx5IGNhbmNlbGxlZCB0aGUgKm5ldyogc3Bpa2UgKGhhY2tTZWMgKlxuICAvLyBoYWNrVGhyZWFkcyArIGdyb3dTZWMgKiBncm93VGhyZWFkcykuIElmIGEgcHJldmlvdXMgYmF0Y2ggbGVmdFxuICAvLyB0aGUgdGFyZ2V0J3Mgc2VjdXJpdHkgYWJvdmUgbWluIChiZWNhdXNlIGl0cyBncm93IHdhcyBTS0lQLXJhbSdkXG4gIC8vIGFuZCBuZXZlciByYW4sIHNlZSB0aGUgZ3Jvd3RoQW5hbHl6ZSBmaXggYWJvdmUpLCB0aGUgbmV3IGJhdGNoXG4gIC8vIHByZXNlcnZlcyB0aGUgZHJpZnQ6IGN1clNlY19hZnRlciA9IGN1clNlY19iZWZvcmUgKyBuZXdfc3Bpa2UgLVxuICAvLyBuZXdfd2Vha2VuID0gY3VyU2VjX2JlZm9yZSAobW9kdWxvIG5ldyBzcGlrZSkuIFRoZSBuZXh0IGJhdGNoXG4gIC8vIHJlYWRzIHRoZSBzYW1lIGVsZXZhdGVkIGN1clNlYyBhbmQgYWdhaW4gb25seSBjYW5jZWxzIHRoZSBuZXdcbiAgLy8gc3Bpa2UsIHNvIHNlY3VyaXR5IG5ldmVyIHJldHVybnMgdG8gbWluLlxuICAvL1xuICAvLyBUaGUgZml4IGlzIHRvIGNvbXB1dGUgdGhlIHRvdGFsIHNlYyByZWR1Y3Rpb24gbmVlZGVkIHRvIHJlYWNoXG4gIC8vIG1pblNlYywgbm90IGp1c3QgY2FuY2VsIHRoZSBuZXcgc3Bpa2U6XG4gIC8vXG4gIC8vICAgdG90YWxTZWNUb1JlZHVjZSA9IChjdXJTZWMgLSBtaW5TZWMpICsgKGhhY2tTZWMqaGFja1RocmVhZHMpICsgKGdyb3dTZWMqZ3Jvd1RocmVhZHMpXG4gIC8vICAgd2Vha2VuVGhyZWFkcyA9IGNlaWwodG90YWxTZWNUb1JlZHVjZSAvIHdlYWtlblBlclRocmVhZClcbiAgLy9cbiAgLy8gVGhpcyBndWFyYW50ZWVzIHRoZSBiYXRjaCBFTkRTIHdpdGggY3VyU2VjID0gbWluU2VjIChtb2R1bG9cbiAgLy8gcm91bmRpbmcpLCByZWdhcmRsZXNzIG9mIGFjY3VtdWxhdGVkIGRyaWZ0LiBUaGUgdHdvIHdlYWtlblxuICAvLyBzbG90cyBpbiB0aGUgYmF0Y2ggYXJlIGFsd2F5cyBlcXVhbCwgc28gd2UgY29tcHV0ZSBvbmNlLlxuICAvL1xuICAvLyBCaXRidXJuZXIgMy4wKyBzaWduYXR1cmU6IHdlYWtlbkFuYWx5emUodGhyZWFkcywgY29yZXM/KS4gTk8gaG9zdFxuICAvLyBhcmcg4oCUIHRoZSBmdW5jdGlvbiB1c2VzIHRoZSBzY3JpcHQncyBjdXJyZW50IGNvbnRleHQgKHdoaWNoIGlzIHRoZVxuICAvLyBjYWxsaW5nIHNlcnZlciwgTk9UIHRoZSB0YXJnZXQpLiBUbyBhbmFseXplIHRoZSB0YXJnZXQncyB3ZWFrZW5cbiAgLy8gcmF0ZSBjb3JyZWN0bHksIHRoZSBzY3JpcHQgbXVzdCBiZSBydW4gb24gdGhlIHRhcmdldCwgT1Igd2UgbmVlZFxuICAvLyB0byB1c2UgdGhlIGFsdGVybmF0ZSBzaWduYXR1cmUgd2Vha2VuQW5hbHl6ZSh0aHJlYWRzLCBjb3Jlcykgd2l0aFxuICAvLyB0aGUgY29udGV4dCBhbHJlYWR5IHNldCB0byB0aGUgdGFyZ2V0LlxuICAvL1xuICAvLyBJbiBwcmFjdGljZSwgaGFja1NlYy9ncm93U2VjL3dlYWtlblBlclRocmVhZCBhcmUgcHJvcGVydGllcyBvZlxuICAvLyB0aGUgdGFyZ2V0IHNlcnZlci4gVGhlIHJhdGUgb2Ygc2VjdXJpdHkgcmVkdWN0aW9uIHBlciB3ZWFrZW5cbiAgLy8gdGhyZWFkIGlzIGB3ZWFrZW5BbmFseXplKDEpIC8gdGFyZ2V0Lm1pbkRpZmZpY3VsdHlgIOKAlCBpLmUuLCBpdCdzXG4gIC8vIHRoZSBzYW1lIHJlZ2FyZGxlc3Mgb2YgdGhlIGNhbGxpbmcgc2VydmVyLiBXZSBwYXNzIHRoZSB0YXJnZXRcbiAgLy8gYXMgdGhlIGltcGxpY2l0IGNvbnRleHQgYnkgcmVhZGluZyBpdHMgbWluRGlmZmljdWx0eSBzZXBhcmF0ZWx5XG4gIC8vIGFuZCB1c2luZyB0aGUgYWJzb2x1dGUgbnVtYmVyIGZyb20gdGhlIChzZXJ2ZXItYWdub3N0aWMpIGNhbGwuXG4gIGNvbnN0IHdlYWtlblBlclRocmVhZCA9IG5zLndlYWtlbkFuYWx5emUoMSk7XG4gIGNvbnN0IGRyaWZ0U2VjID0gTWF0aC5tYXgoMCwgYS5jdXJTZWMgLSBhLm1pblNlYyk7XG4gIGNvbnN0IG5ld1NwaWtlU2VjID0gKGEuaGFja1NlYyAqIGhhY2tUaHJlYWRzKSArIChhLmdyb3dTZWMgKiBncm93VGhyZWFkcyk7XG4gIGNvbnN0IHRvdGFsU2VjVG9SZWR1Y2UgPSBkcmlmdFNlYyArIG5ld1NwaWtlU2VjO1xuICBjb25zdCB3ZWFrZW5UaHJlYWRzID0gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKHRvdGFsU2VjVG9SZWR1Y2UgLyB3ZWFrZW5QZXJUaHJlYWQpKTtcblxuICAvLyAtLS0gUmVjb3ZlcnkgbW9kZSAtLS1cbiAgLy8gSWYgdGhlIGZ1bGwgYmF0Y2gncyBSQU0gcmVxdWlyZW1lbnQgZXhjZWVkcyB0aGUgbGFyZ2VzdCBzaW5nbGVcbiAgLy8gd29ya2VyJ3MgZnJlZSBSQU0sIHdlIGNhbid0IHJ1biB0aGUgZnVsbCBIV0dXLiBUaGlzIGhhcHBlbnMgd2hlblxuICAvLyBhIHRhcmdldCBoYXMgYWNjdW11bGF0ZWQgc28gbXVjaCBzZWN1cml0eSBkcmlmdCB0aGF0IHRoZSB3ZWFrZW5cbiAgLy8gdGhyZWFkIGNvdW50IGlzIGluIHRoZSB0aG91c2FuZHMgb3IgdGVucyBvZiB0aG91c2FuZHMg4oCUIG1vcmUgdGhhblxuICAvLyBhbnkgc2luZ2xlIHBzZXJ2IChvciBldmVuIGhvbWUpIGNhbiBob2xkLlxuICAvL1xuICAvLyBFeGFtcGxlOiBpcm9uLWd5bSB3aXRoIGN1clNlYz02MzAgKGRyaWZ0PTYyMCkgbmVlZHNcbiAgLy8gY2VpbCg2MjAvMC4wNSkgPSAxMiw0MDAgd2Vha2VuIHRocmVhZHMgw5cgMS43NSBHQiA9IDIxLjcgVEIuIFRoZVxuICAvLyB1c2VyJ3MgY2x1c3RlciBpcyAxNSBUQi4gRnVsbCBiYXRjaCBkb2Vzbid0IGZpdC5cbiAgLy9cbiAgLy8gUmVjb3ZlcnkgbW9kZSByZXR1cm5zIGEgMS1qb2IgcGxhbiAod2Vha2VuIG9ubHksIG5vIGhhY2svZ3JvdylcbiAgLy8gc2l6ZWQgdG8gdGhlIExBUkdFU1Qgc2luZ2xlIHdvcmtlcidzIGZyZWUgUkFNLiBUaGUgbWFuYWdlclxuICAvLyBmaXJlcyBpdCBsaWtlIGFueSBvdGhlciBqb2IuIEVhY2ggcmVjb3ZlcnkgYmF0Y2ggZHJhaW5zIGFzIG11Y2hcbiAgLy8gb2YgdGhlIGRyaWZ0IGFzIGZpdHM7IG92ZXIgYSBmZXcgY3ljbGVzIChnYXRlZCBieSBwZXItdGFyZ2V0XG4gIC8vIGNvb2xkb3duKSwgdGhlIGRyaWZ0IGRyb3BzIHRvIGEgbGV2ZWwgd2hlcmUgdGhlIGZ1bGwgSFdHVyBiYXRjaFxuICAvLyBmaXRzIGFuZCB0aGUgcGxhbiB0cmFuc2l0aW9ucyBiYWNrIHRvIG5vcm1hbCBhdXRvbWF0aWNhbGx5LlxuICAvL1xuICAvLyBUaGUgYHJlY292ZXJ5TW9kZTogdHJ1ZWAgZmxhZyBpbiB0aGUgcmV0dXJuZWQgcGxhbiB0ZWxscyB0aGVcbiAgLy8gbWFuYWdlciB0aGlzIGlzIGEgZGVncmFkZSBvcGVyYXRpb24uIFRoZSBjb29sZG93biBzdGlsbCBhcHBsaWVzXG4gIC8vIHNvIHdlIGRvbid0IHJlLWZpcmUgdG9vIHNvb24uIFRoZSBuZXh0IGVsaWdpYmxlIHRpY2sgcmUtcGxhbnNcbiAgLy8gYWdhaW5zdCB0aGUgKG5vdyBsb3dlcikgY3VyU2VjIGFuZCB0aGUgY3ljbGUgY29udGludWVzLlxuICAvL1xuICAvLyBXZSBkb24ndCB0cnkgdG8gc3BsaXQgYSBzaW5nbGUgd2Vha2VuIGpvYiBhY3Jvc3MgbXVsdGlwbGVcbiAgLy8gd29ya2VycyAobm8gY2xlYW4gQVBJIGZvciB0aGF0IOKAlCBucy5leGVjIHNwYXducyBhIHNpbmdsZVxuICAvLyBwcm9jZXNzKS4gSW5zdGVhZCwgd2UganVzdCB1c2UgdGhlIGxhcmdlc3QgYXZhaWxhYmxlIHdvcmtlcixcbiAgLy8gZXZlbiBpZiBpdCBtZWFucyByZWNvdmVyeSBpcyBncmFkdWFsLiBUaGlzIGlzIGNvcnJlY3QgYmVjYXVzZVxuICAvLyB0aGUgY29vbGRvd24gcHJldmVudHMgcmUtZmlyZSByYWNlcyBkdXJpbmcgcmVjb3ZlcnkuXG4gIGNvbnN0IHJhbUJ5U2NyaXB0ID0ge1xuICAgIFwiaGFjay5qc1wiOiBucy5nZXRTY3JpcHRSYW0oXCJoYWNrLmpzXCIsIFwiaG9tZVwiKSxcbiAgICBcIndlYWtlbi5qc1wiOiBucy5nZXRTY3JpcHRSYW0oXCJ3ZWFrZW4uanNcIiwgXCJob21lXCIpLFxuICAgIFwiZ3Jvdy5qc1wiOiBucy5nZXRTY3JpcHRSYW0oXCJncm93LmpzXCIsIFwiaG9tZVwiKSxcbiAgfTtcbiAgY29uc3QgYXJyaXZhbFQgPSBhLndlYWtlblRpbWUgLSBMQU5FX0JVRkZFUl9NUztcbiAgY29uc3QgZGVsYXkgPSAoc2NyaXB0VGltZSkgPT4gYXJyaXZhbFQgLSBzY3JpcHRUaW1lO1xuICBjb25zdCBqb2JzID0gW1xuICAgIHsgc2NyaXB0OiBcImhhY2suanNcIiwgICB0aHJlYWRzOiBoYWNrVGhyZWFkcywgICBkZWxheU1zOiBkZWxheShhLmhhY2tUaW1lKSAgIH0sXG4gICAgeyBzY3JpcHQ6IFwid2Vha2VuLmpzXCIsIHRocmVhZHM6IHdlYWtlblRocmVhZHMsIGRlbGF5TXM6IGRlbGF5KGEud2Vha2VuVGltZSkgfSxcbiAgICB7IHNjcmlwdDogXCJncm93LmpzXCIsICAgdGhyZWFkczogZ3Jvd1RocmVhZHMsICAgZGVsYXlNczogZGVsYXkoYS5ncm93VGltZSkgICB9LFxuICAgIHsgc2NyaXB0OiBcIndlYWtlbi5qc1wiLCB0aHJlYWRzOiB3ZWFrZW5UaHJlYWRzLCBkZWxheU1zOiBkZWxheShhLndlYWtlblRpbWUpIH0sXG4gIF07XG4gIGNvbnN0IHRvdGFsUmFtID0gam9icy5yZWR1Y2UoKHN1bSwgaikgPT4gc3VtICsgcmFtQnlTY3JpcHRbai5zY3JpcHRdICogai50aHJlYWRzLCAwKTtcblxuICAvLyBCdWlsZCB0aGUgZmxlZXQgYW5kIGNoZWNrIGlmIHRoZSBmbGVldCBjYW4gY2FycnkgdGhlIGJpZ2dlc3Qgam9iLlxuICAvLyBUaGlzIGlzIHRoZSBGTEVFVC1BV0FSRSBjaGVjayDigJQgaXQgYXNrcyBcImNhbiB0aGUgY2x1c3RlciBhcyBhXG4gIC8vIHdob2xlIGZpdCB0aGUgbGFyZ2VzdCBzaW5nbGUgb3A/XCIgaW5zdGVhZCBvZiBcImNhbiBhbnkgc2luZ2xlXG4gIC8vIGhvc3QgZml0IGl0P1wiLiBUaGUgb2xkIHNpbmdsZS1ob3N0IGNoZWNrIHdhcyB0aGUgcmlnaHQgcnVsZVxuICAvLyBiZWZvcmUgdGhlIGZsZWV0LWJhdGNoZXIgZXhpc3RlZDsgd2l0aCB0aGUgZmxlZXQsIGl0J3MgdG9vXG4gIC8vIGNvbnNlcnZhdGl2ZSAoYnVzeSBwc2VydnMgbG9vayBmdWxsIGJ1dCB0aGUgZmxlZXQgaGFzIHNwYXJlXG4gIC8vIGNhcGFjaXR5IGZyb20gcm9vdGVkIHdvcmxkcyArIGlkbGUgaG9tZSkuXG4gIC8vXG4gIC8vIFBlci10YXJnZXQgY2FwOiAxLzMgb2YgdGhlIGZsZWV0LiBNYXRjaGVzIHNrZWVzbGVyJ3NcbiAgLy8gTUFYX0ZMRUVUX1NIQVJFOyBvbmUgdGFyZ2V0J3MgYmlnZ2VzdCBqb2IgbXVzdCBmaXQgaW4gaXRzXG4gIC8vIHNoYXJlIG9mIHRoZSBjbHVzdGVyLiBXaXRob3V0IHRoZSBjYXAsIG9uZSBodWdlIHRhcmdldCBjb3VsZFxuICAvLyBjbGFpbSB0aGUgd2hvbGUgZmxlZXQgYW5kIHN0YXJ2ZSB0aGUgb3RoZXJzLlxuICBjb25zdCBmbGVldCA9IGJ1aWxkRmxlZXQobnMpO1xuICBjb25zdCB0b3RhbEZsZWV0RnJlZSA9IGZsZWV0RnJlZShucywgZmxlZXQpO1xuICBjb25zdCBwZXJUYXJnZXRGbGVldENhcCA9IHRvdGFsRmxlZXRGcmVlICogRkxFRVRfREVGQVVMVFMuTUFYX0ZMRUVUX1NIQVJFO1xuICAvLyBBbHNvIGNvbXB1dGUgdGhlIHNpbmdsZS1ob3N0IGxhcmdlc3QtZnJlZSBhcyBhIGZhbGxiYWNrIGZvciB0aGVcbiAgLy8gcmVjb3ZlcnkgcGxhbidzIFwic2l6ZWQgdG8gdGhlIGJpZ2dlc3Qgc2luZ2xlIGhvc3RcIiBzaXppbmdcbiAgLy8gKHNlZSBiZWxvdykuIFJlY292ZXJ5IHVzZXMgdGhlIHNhbWUgc2luZ2xlLWhvc3Qgc2l6aW5nIGFzXG4gIC8vIGJlZm9yZSBiZWNhdXNlIHRoZSByZWNvdmVyeSB3ZWFrZW4gaXMgYSBzaW5nbGUgb3AsIG5vdCBhIGJhdGNoXG4gIC8vIOKAlCB3ZSBjYW4gZWl0aGVyIHNwcmVhZCBpdCBhY3Jvc3MgdGhlIGZsZWV0IE9SIGZpdCBpdCBvbiBvbmVcbiAgLy8gaG9zdCwgYnV0IHNwcmVhZGluZyBpcyB0aGUgbmV3IHBhdGguIEtlZXAgdGhlIG9sZCBzaW5nbGUtaG9zdFxuICAvLyBzaXppbmcgYXMgYSBwZXItYmF0Y2ggdXBwZXIgYm91bmQgZm9yIHRoZSByZWNvdmVyeSBwbGFuLlxuICBsZXQgbGFyZ2VzdEZyZWVSYW0gPSAwO1xuICBmb3IgKGNvbnN0IHcgb2YgbGlzdFdvcmtlcnMobnMpKSB7XG4gICAgY29uc3QgZnJlZSA9IG5zLmdldFNlcnZlck1heFJhbSh3KSAtIG5zLmdldFNlcnZlclVzZWRSYW0odyk7XG4gICAgaWYgKGZyZWUgPiBsYXJnZXN0RnJlZVJhbSkgbGFyZ2VzdEZyZWVSYW0gPSBmcmVlO1xuICB9XG5cbiAgLy8gVGhlIGZ1bGwgYmF0Y2gncyBib3R0bGVuZWNrIGlzIHRoZSBMQVJHRVNUIHNpbmdsZSBqb2IgKHVzdWFsbHlcbiAgLy8gb25lIG9mIHRoZSB0d28gd2Vha2VucykuIElmIHRoZSBmbGVldCAocGVyLXRhcmdldCBzaGFyZSkgY2FuXG4gIC8vIGNhcnJ5IHRoZSBXSE9MRSBiYXRjaCAoNCBqb2JzIHN1bW1lZCksIHdlIHJ1biBhIG5vcm1hbCBIV0dXLlxuICAvLyBPdGhlcndpc2UsIHdlIGRyb3AgdG8gcmVjb3ZlcnkgbW9kZSAod2Vha2VuLW9ubHksIHNpemVkIHRvXG4gIC8vIHRoZSBsYXJnZXN0IHNpbmdsZSB3b3JrZXIpLlxuICBjb25zdCBiaWdnZXN0Sm9iUmFtID0gTWF0aC5tYXgoXG4gICAgaGFja1RocmVhZHMgKiByYW1CeVNjcmlwdFtcImhhY2suanNcIl0sXG4gICAgd2Vha2VuVGhyZWFkcyAqIHJhbUJ5U2NyaXB0W1wid2Vha2VuLmpzXCJdLFxuICAgIGdyb3dUaHJlYWRzICogcmFtQnlTY3JpcHRbXCJncm93LmpzXCJdLFxuICApO1xuXG4gIC8vIEZsZWV0LWF3YXJlIGNoZWNrOiBjYW4gdGhlIGZsZWV0IChwZXItdGFyZ2V0IHNoYXJlKSBjYXJyeSB0aGVcbiAgLy8gV0hPTEUgYmF0Y2g/IFdlIHVzZSBgdG90YWxSYW1gICh0aGUgNC1qb2Igc3VtKSBiZWNhdXNlIHRoYXQnc1xuICAvLyB3aGF0IHRoZSBtYW5hZ2VyIHdpbGwgYWN0dWFsbHkgcGxhY2Ug4oCUIGBiaWdnZXN0Sm9iUmFtYCBvbmx5XG4gIC8vIHRlbGxzIHVzIHRoZSBzaW5nbGUgbGFyZ2VzdCBvcCwgYnV0IHRoZSBmbGVldCBoYXMgdG8gY2FycnlcbiAgLy8gYWxsIDQgam9icyBpbiBzZXF1ZW5jZS4gVGhlIDUlIGhlYWRyb29tIGlzIGFwcGxpZWQgdXBzdHJlYW1cbiAgLy8gaW4gbWFuYWdlci5qczsgcGxhbkJhdGNoJ3MgY2hlY2sgaXMgYSBjb2Fyc2VyIFwiY2FuIHRoZVxuICAvLyBmbGVldCwgcGVyaW9kLCBmaXQgdGhpcyBiYXRjaD9cIiBnYXRlLlxuICAvL1xuICAvLyBUaGUgcHJldmlvdXMgdmVyc2lvbiBvZiB0aGlzIGNoZWNrIChgYmlnZ2VzdEpvYlJhbSA8PVxuICAvLyBwZXJUYXJnZXRGbGVldENhcCAmJiB0b3RhbEZsZWV0RnJlZSA+PSAyICogYmlnZ2VzdEpvYlJhbWApXG4gIC8vIHdhcyB0b28gc3RyaWN0OiB0aGUgMsOXIHNhZmV0eSBtZWFudCBhIGZsZWV0IHdoZXJlIHBzZXJ2cyBhcmVcbiAgLy8gYnVzeSB3aXRoIHByaW9yLXRpY2sgd29ya2VycyB3b3VsZCBuZXZlciBzZWUgbm9ybWFsIEhXR1csXG4gIC8vIGV2ZW4gd2hlbiB0aGUgYmlnZ2VzdCBqb2IgKHdoaWNoIGlzIHdoYXQgdGhlIG5ldyBmbGVldFxuICAvLyBwYXR0ZXJuIGFjdHVhbGx5IG5lZWRzIHRvIGZpdCkgY29tZm9ydGFibHkgZml0cyBpbiB0aGVcbiAgLy8gdG90YWwgZnJlZSBSQU0uIFRoYXQgZmFsc2UtcG9zaXRpdmUgcmVjb3ZlcnkgbW9kZSBmaXJlZCBvblxuICAvLyBldmVyeSB0aWNrIGluIHRoZSB1c2VyJ3MgZ2FtZSBzdGF0ZSwgbGVhdmluZyB0aGUgdGFyZ2V0c1xuICAvLyBwZXJtYW5lbnRseSBpbiByZWNvdmVyeSBldmVuIHdoZW4gdGhlaXIgZHJpZnQgd2FzIDAuXG4gIC8vXG4gIC8vIENvcnJlY3QgY2hlY2s6IGB0b3RhbFJhbSA8PSB0b3RhbEZsZWV0RnJlZWAg4oCUIHRoZSB3aG9sZVxuICAvLyBiYXRjaCBmaXRzIGluIHRoZSBmbGVldCdzIGZyZWUgUkFNLiBQZXItdGFyZ2V0IHNoYXJlIGlzXG4gIC8vIGVuZm9yY2VkIHVwc3RyZWFtIGluIG1hbmFnZXIuanMgdmlhIHNoYXJlUmFtQ2FwLlxuICBjb25zdCBmbGVldENhbkNhcnJ5ID0gdG90YWxSYW0gPD0gdG90YWxGbGVldEZyZWU7XG5cbiAgaWYgKCFmbGVldENhbkNhcnJ5KSB7XG4gICAgLy8gUmVjb3ZlcnkgbW9kZTogd2Vha2VuLW9ubHksIHNpemVkIHRvIHRoZSBsYXJnZXN0IGZyZWUgd29ya2VyLlxuICAgIC8vIFRoZSByZWNvdmVyeSBzaXppbmcgaXMgdW5jaGFuZ2VkIGZyb20gdGhlIG9sZCBzaW5nbGUtaG9zdFxuICAgIC8vIGxvZ2ljIOKAlCB3ZSB1c2UgdGhlIGxhcmdlc3Qgc2luZ2xlIHdvcmtlcidzIGZyZWUgUkFNIChub3RcbiAgICAvLyB0aGUgZmxlZXQpIGJlY2F1c2UgcmVjb3ZlcnkgaXMgYSBzaW5nbGUgb3AgYW5kIHdlIHdhbnRcbiAgICAvLyBidW5jaGluZyBvbiB0aGUgYmlnZ2VzdCBob3N0IGZvciBmYXN0ZXN0IGRyaWZ0IGRyYWluLlxuICAgIC8vIChQaXRmYWxsIDIzOiBsYXJnZXN0LWZpdCBmb3IgcmVjb3ZlcnksIHNtYWxsZXN0LWZpdCBmb3Igbm9ybWFsLilcbiAgICBjb25zdCBzYWZldHlNYXJnaW4gPSAwLjk1O1xuICAgIGNvbnN0IHJlY292ZXJUaHJlYWRzID0gTWF0aC5tYXgoXG4gICAgICAxLFxuICAgICAgTWF0aC5mbG9vcigobGFyZ2VzdEZyZWVSYW0gKiBzYWZldHlNYXJnaW4pIC8gcmFtQnlTY3JpcHRbXCJ3ZWFrZW4uanNcIl0pXG4gICAgKTtcbiAgICAvLyBSZWR1Y2UgZHJpZnQgYnkgcmVjb3ZlclRocmVhZHMgKiB3ZWFrZW5QZXJUaHJlYWQgcGVyIGJhdGNoLlxuICAgIC8vIFdpdGggZHJpZnQ9NjIwIGFuZCByZWNvdmVyVGhyZWFkcz04MDAwICgxLjQgR0IgZnJlZSDDlyA1JSA9XG4gICAgLy8gMTMuM2sgdGhyZWFkcywgYnV0IGZyZWUgUkFNIGlzIG1vcmUgbGlrZSAxNCBUQiBvbiBhIDE1IFRCXG4gICAgLy8gY2x1c3RlciksIHdlIGRyYWluIH40MDAgc2VjIHBlciBiYXRjaC4gVHdvIGJhdGNoZXMgcmVjb3ZlclxuICAgIC8vIGlyb24tZ3ltIGZ1bGx5LlxuICAgIGNvbnN0IHJlY292ZXJKb2JzID0gW1xuICAgICAgeyBzY3JpcHQ6IFwid2Vha2VuLmpzXCIsIHRocmVhZHM6IHJlY292ZXJUaHJlYWRzLCBkZWxheU1zOiAwIH0sICAvLyBmaXJlIGltbWVkaWF0ZWx5XG4gICAgXTtcbiAgICBjb25zdCByZWNvdmVyVG90YWxSYW0gPSByZWNvdmVySm9icy5yZWR1Y2UoXG4gICAgICAoc3VtLCBqKSA9PiBzdW0gKyByYW1CeVNjcmlwdFtqLnNjcmlwdF0gKiBqLnRocmVhZHMsIDBcbiAgICApO1xuICAgIHJldHVybiB7XG4gICAgICB0YXJnZXQsXG4gICAgICBhcnJpdmFsVCxcbiAgICAgIGpvYnM6IHJlY292ZXJKb2JzLFxuICAgICAgdG90YWxSYW06IHJlY292ZXJUb3RhbFJhbSxcbiAgICAgIHJlY292ZXJ5TW9kZTogdHJ1ZSxcbiAgICAgIHN1bW1hcnk6IGB0YXJnZXQ9JHt0YXJnZXR9IFJFQ09WRVJZIGRyaWZ0PSR7ZHJpZnRTZWMudG9GaXhlZCgwKX0gdz0ke3JlY292ZXJUaHJlYWRzfSByYW09JHtyZWNvdmVyVG90YWxSYW0udG9GaXhlZCgxKX1HQiAoZnVsbCBiYXRjaCB3b3VsZCBuZWVkICR7KHdlYWtlblRocmVhZHMgKiByYW1CeVNjcmlwdFtcIndlYWtlbi5qc1wiXSkudG9GaXhlZCgwKX1HQilgLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHRhcmdldCxcbiAgICBhcnJpdmFsVCxcbiAgICBqb2JzLFxuICAgIHRvdGFsUmFtLFxuICAgIHJlY292ZXJ5TW9kZTogZmFsc2UsXG4gICAgc3VtbWFyeTogYHRhcmdldD0ke3RhcmdldH0gaGFjaz0ke2hhY2tUaHJlYWRzfSB3PSR7d2Vha2VuVGhyZWFkc30gZ3Jvdz0ke2dyb3dUaHJlYWRzfSByYW09JHt0b3RhbFJhbS50b0ZpeGVkKDEpfUdCYCxcbiAgfTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgd29ya2VyIHBvb2w6IGhvbWUgKyBldmVyeSBwdXJjaGFzZWQgc2VydmVyIHNsb3QuXG4gKiBUaGUgb3JjaGVzdHJhdG9yIHdpbGwgcGljayBhIHdvcmtlciBwZXIgam9iLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdFdvcmtlcnMobnMpIHtcbiAgY29uc3Qgb3V0ID0gW1wiaG9tZVwiXTtcbiAgY29uc3QgbGltaXQgPSBucy5jbG91ZC5nZXRTZXJ2ZXJMaW1pdCgpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbWl0OyBpKyspIHtcbiAgICBjb25zdCBuYW1lID0gYHBzZXJ2LSR7aX1gO1xuICAgIGlmIChucy5zZXJ2ZXJFeGlzdHMobmFtZSkpIG91dC5wdXNoKG5hbWUpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogRmluZCBhIHdvcmtlciB0aGF0IGhhcyBhdCBsZWFzdCBgbmVlZFJhbWAgR0Igb2YgZnJlZSBSQU0gYW5kIHJldHVyblxuICogaXRzIG5hbWUsIG9yIG51bGwgaWYgbm8gd29ya2VyIHF1YWxpZmllcy5cbiAqXG4gKiBMb2FkLWJhbGFuY2luZyBydWxlOiBwaWNrIHRoZSBTTUFMTEVTVCB3b3JrZXIgdGhhdCBmaXRzLiBUaGlzXG4gKiBsZWF2ZXMgdGhlIGJpZ2dlc3Qgd29ya2VycyAodHlwaWNhbGx5IGhvbWUsIHdpdGggMSsgVEIpIGZyZWUgZm9yXG4gKiB0aGUgbGFyZ2VzdCBiYXRjaGVzICh3aGljaCBuZWVkIG1hbnkgdGhyZWFkcyDDlyB3b3JrZXIgUkFNKSwgYW5kXG4gKiBzcHJlYWRzIHNtYWxsZXIgYmF0Y2hlcyBhY3Jvc3MgdGhlIHBzZXJ2IGZsZWV0LiBXaXRob3V0IHRoaXNcbiAqIHJ1bGUsIGBmaW5kV29ya2VyV2l0aFJhbWAgd291bGQgYWx3YXlzIHJldHVybiBob21lIGZpcnN0IChpdCdzXG4gKiBmaXJzdCBpbiBgd29ya2Vyc2AgYW5kIGFsd2F5cyBoYXMgZnJlZSBSQU0pLCBhbmQgdGhlIHBzZXJ2c1xuICogd291bGQgc2l0IGlkbGUgd2hpbGUgaG9tZSBiZWNhbWUgYSBob3Qgc3BvdC5cbiAqXG4gKiBXZSBhY2hpZXZlIFwic21hbGxlc3QgZml0XCIgYnkgdHJhY2tpbmcgdGhlIG1pbmltdW0tbWF4IGNhbmRpZGF0ZVxuICogb24gdGhlIGZseS4gQ29zdCBpcyBPKE4pIHBlciBjYWxsIHdoZXJlIE4gPSBudW1iZXIgb2Ygd29ya2Vyc1xuICogKHR5cGljYWxseSAxICsgdXAtdG8tMjUgcHNlcnZzID0gMjYsIHNvIHRoaXMgaXMgY2hlYXAg4oCUIGZld2VyXG4gKiB0aGFuIDEwMCBzaW1wbGUgYXJpdGhtZXRpYyBvcHMgcGVyIGJhdGNoKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRXb3JrZXJXaXRoUmFtKG5zLCB3b3JrZXJzLCBuZWVkUmFtKSB7XG4gIGxldCBiZXN0TmFtZSA9IG51bGw7XG4gIGxldCBiZXN0TWF4ID0gSW5maW5pdHk7XG4gIGZvciAoY29uc3QgdyBvZiB3b3JrZXJzKSB7XG4gICAgY29uc3QgbWF4ID0gbnMuZ2V0U2VydmVyTWF4UmFtKHcpO1xuICAgIGNvbnN0IHVzZWQgPSBucy5nZXRTZXJ2ZXJVc2VkUmFtKHcpO1xuICAgIGlmIChtYXggLSB1c2VkID49IG5lZWRSYW0gJiYgbWF4IDwgYmVzdE1heCkge1xuICAgICAgYmVzdE5hbWUgPSB3O1xuICAgICAgYmVzdE1heCA9IG1heDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGJlc3ROYW1lO1xufVxuXG4vKipcbiAqIEZpbmQgdGhlIExBUkdFU1Qgd29ya2VyIHdpdGggYXQgbGVhc3QgYG5lZWRSYW1gIHVzYWJsZSBmcmVlIFJBTS5cbiAqXG4gKiBNaXJyb3IgaW1hZ2Ugb2YgYGZpbmRXb3JrZXJXaXRoUmFtYDogd2hlcmUgdGhlIHNtYWxsZXN0LWZpdFxuICogcnVsZSBzcHJlYWRzIHNtYWxsIGJhdGNoZXMgYWNyb3NzIHRoZSBwc2VydiBmbGVldCwgdGhlXG4gKiBsYXJnZXN0LWZpdCBydWxlIGlzIHVzZWQgYnkgcmVjb3ZlcnkgbW9kZSBpbiBgcGxhbkJhdGNoYCDigJRcbiAqIHJlY292ZXJ5IG1vZGUgd2FudHMgdG8gZHJhaW4gc2VjdXJpdHkgZHJpZnQgYXMgZmFzdCBhc1xuICogcG9zc2libGUsIHNvIGl0IHBpY2tzIHRoZSBiaWdnZXN0IGZyZWUgd29ya2VyICh0eXBpY2FsbHlcbiAqIGhvbWUgd2l0aCAxKyBUQikgYW5kIHVzZXMgYXMgbXVjaCBvZiBpdHMgZnJlZSBSQU0gYXMgaXQgY2FuLlxuICpcbiAqIFdpdGhvdXQgdGhpcyBoZWxwZXIsIHJlY292ZXJ5IG1vZGUgd291bGQgbGFuZCBpdHMgd2Vha2VuXG4gKiBqb2Igb24gd2hhdGV2ZXIgMS44IEdCIHBzZXJ2IGhhcHBlbmVkIHRvIGJlIHRoZSBzbWFsbGVzdCBmaXQsXG4gKiBkcmFpbmluZyBkcmlmdCBhdCAwLjA1IHNlYyBwZXIgYmF0Y2ggKHdvdWxkIHRha2UgdGhvdXNhbmRzXG4gKiBvZiBiYXRjaGVzIHRvIGNsZWFyIHR5cGljYWwgbWlkLWdhbWUgZHJpZnQpLiBXaXRoIGl0LCB0aGVcbiAqIHJlY292ZXJ5IHdlYWtlbiBsYW5kcyBvbiB0aGUgYmlnZ2VzdCBmcmVlIHdvcmtlciBhbmQgZHJhaW5zXG4gKiBodW5kcmVkcyBvZiBzZWMgcGVyIGJhdGNoLlxuICpcbiAqIGBob21lSGVhZHJvb21SYW1gIGlzIHRoZSBhbW91bnQgb2YgaG9tZSdzIGZyZWUgUkFNIHRvIGV4Y2x1ZGVcbiAqIGZyb20gY29uc2lkZXJhdGlvbi4gRGVmYXVsdCAzMiBHQi4gVGhpcyBpcyB0byBsZWF2ZSByb29tIGZvclxuICogYG51a2UuanNgIGFuZCBvdGhlciBvbmUtc2hvdCBob21lIHNjcmlwdHMgdGhhdCB0aGUgbW9uaXRvcnNcbiAqIGZpcmUgKGVhY2ggfjUtMTAgR0IpLiBXaXRob3V0IHRoaXMgaGVhZHJvb20sIHJlY292ZXJ5IG1vZGVcbiAqIGNvbnN1bWVzIGFsbCBvZiBob21lJ3MgZnJlZSBSQU0gYW5kIHRoZSBuZXh0IG51a2UuanMgaW52b2NhdGlvblxuICogZmFpbHMgd2l0aCBcIm5vdCBlbm91Z2ggUkFNXCIgdW50aWwgdGhlIG5leHQgcmVjb3ZlcnkgY29vbGRvd25cbiAqIGV4cGlyZXMuIFdlIHJlc2VydmUgaGVhZHJvb20gb25seSBvbiBob21lOyBwc2VydnMgYXJlXG4gKiB1bmFmZmVjdGVkIChvdGhlciBzeXN0ZW0gc2NyaXB0cyBkb24ndCBydW4gb24gcHNlcnZzKS5cbiAqXG4gKiBDb3N0IGlzIGFsc28gTyhOKSBwZXIgY2FsbCwgc2FtZSBhcyBmaW5kV29ya2VyV2l0aFJhbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRMYXJnZXN0V29ya2VyV2l0aFJhbShucywgd29ya2VycywgbmVlZFJhbSwgaG9tZUhlYWRyb29tUmFtID0gMzIpIHtcbiAgbGV0IGJlc3ROYW1lID0gbnVsbDtcbiAgbGV0IGJlc3RGcmVlID0gLTE7XG4gIGZvciAoY29uc3QgdyBvZiB3b3JrZXJzKSB7XG4gICAgY29uc3QgbWF4ID0gbnMuZ2V0U2VydmVyTWF4UmFtKHcpO1xuICAgIGNvbnN0IHVzZWQgPSBucy5nZXRTZXJ2ZXJVc2VkUmFtKHcpO1xuICAgIC8vIFJlc2VydmUgaGVhZHJvb20gb24gaG9tZSBvbmx5IOKAlCBzeXN0ZW0gc2NyaXB0cyAobnVrZS5qcyxcbiAgICAvLyBidXkgcHJvZ3JhbXMsIGV0Yy4pIHJ1biBvbiBob21lIGFuZCBuZWVkIGZyZWUgUkFNIHRvIHN0YXJ0LlxuICAgIC8vIFdpdGhvdXQgdGhpcywgcmVjb3ZlcnkgbW9kZSBob2dzIGFsbCBvZiBob21lJ3MgZnJlZSBSQU1cbiAgICAvLyBhbmQgdGhlIG5leHQgbnVrZS5qcyBpbnZvY2F0aW9uIGZhaWxzLlxuICAgIGNvbnN0IGhlYWRyb29tID0gdyA9PT0gXCJob21lXCIgPyBob21lSGVhZHJvb21SYW0gOiAwO1xuICAgIGNvbnN0IGZyZWUgPSBtYXggLSB1c2VkIC0gaGVhZHJvb207XG4gICAgaWYgKGZyZWUgPj0gbmVlZFJhbSAmJiBmcmVlID4gYmVzdEZyZWUpIHtcbiAgICAgIGJlc3ROYW1lID0gdztcbiAgICAgIGJlc3RGcmVlID0gZnJlZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGJlc3ROYW1lO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBGbGVldC1iYXRjaGVyIGhlbHBlcnMg4oCUIGRpc3RyaWJ1dGUgb25lIGJhdGNoJ3MgdGhyZWFkcyBhY3Jvc3MgdGhlIHdob2xlXG4vLyBjbHVzdGVyIChob21lICsgcHNlcnZzICsgcm9vdGVkIHdvcmxkIHNlcnZlcnMpLCBub3QganVzdCBvbmUgaG9zdC5cbi8vIFNvdXJjZWQgZnJvbSBza2Vlc2xlci9iaXRidXJuZXItY29tbWFuZGVyL2ZsZWV0LWJhdGNoZXIuanMgKE1JVC1zdHlsZSxcbi8vIHB1YmxpYyBkb21haW4pLiBUaGUgc2luZ2xlIGJpZ2dlc3QgQk4xIG1pZC1nYW1lIHdpbjogdHVybnMgMTUgVEIgb2Zcbi8vIGZsZWV0IGNhcGFjaXR5IGludG8gYSB1c2FibGUgdGFyZ2V0IGZvciBiYXRjaGVzIHRoYXQgd291bGQgb3RoZXJ3aXNlXG4vLyBuZWVkIDEwMCsgVEIgb24gYSBzaW5nbGUgaG9zdC5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBCRlMgdGhlIG5ldHdvcmsgZnJvbSBob21lLiBSZXR1cm5zIHRoZSBzb3J0ZWQgbGlzdCBvZiBldmVyeVxuICogcmVhY2hhYmxlIGhvc3RuYW1lIEVYQ0VQVCBob21lLiBVc2VkIGJ5IGJ1aWxkRmxlZXQoKSB0byBmaW5kXG4gKiByb290ZWQgd29ybGQgc2VydmVycyB0aGF0IGNhbiBob3N0IHdvcmtlcnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0UmVhY2hhYmxlU2VydmVycyhucykge1xuICBjb25zdCBTT1VSQ0UgPSBcImhvbWVcIjtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoW1NPVVJDRV0pO1xuICBjb25zdCBxdWV1ZSA9IFtTT1VSQ0VdO1xuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGggPSBxdWV1ZS5zaGlmdCgpO1xuICAgIGZvciAoY29uc3QgbiBvZiBucy5zY2FuKGgpKSB7XG4gICAgICBpZiAoIXNlZW4uaGFzKG4pKSB7IHNlZW4uYWRkKG4pOyBxdWV1ZS5wdXNoKG4pOyB9XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4uc2Vlbl0uZmlsdGVyKChoKSA9PiBoICE9PSBTT1VSQ0UpLnNvcnQoKTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZmxlZXQgcG9vbDogaG9tZSArIGV2ZXJ5IHB1cmNoYXNlZCBzZXJ2ZXIgKyBldmVyeSByb290ZWRcbiAqIHdvcmxkIHNlcnZlciB3aXRoIHVzYWJsZSBSQU0uXG4gKlxuICogQSB3b3JsZCBzZXJ2ZXIgY2FuIGJlIGEgd29ya2VyIGhvc3QgZm9yIG9uZSBmbGVldCBhbmQgYSBoYWNrIHRhcmdldFxuICogb2YgYW5vdGhlciBhdCB0aGUgc2FtZSB0aW1lIOKAlCB0aGUgdHdvIHJvbGVzIGRvbid0IGludGVyZmVyZS4gVGhpc1xuICogaXMgdGhlIGtleSBpbnNpZ2h0IHRoYXQgbWFrZXMgdGhlIGZsZWV0LWJhdGNoZXIgd29yazogNTAgR0Igb2YgQ1NFQ1xuICogKyAzMiBHQiBvZiBmb29kbnN0dWZmICsgMTYgR0Igb2Ygam9lc2d1bnMgKyAxMSBwc2VydnMgw5cgMSBUQiArXG4gKiBob21lIDEgVEIgPSAxMisgVEIgb2YgdXNhYmxlIGZsZWV0IHdoZXJlIGJlZm9yZSB0aGVyZSB3YXMganVzdFxuICogaG9tZSArIDExIHBzZXJ2cy5cbiAqXG4gKiBFYWNoIGVudHJ5IGlzIGB7aCwgcn1gIHdoZXJlIGggaXMgdGhlIGhvc3RuYW1lIGFuZCByIGlzIHRoZSBHQiB0b1xuICoga2VlcCBmcmVlIG9uIHRoYXQgaG9zdCAoaGVhZHJvb20gZm9yIHN5c3RlbSBzY3JpcHRzOyBvbmx5IGhvbWVcbiAqIGdldHMgYSByZWFsIHZhbHVlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRmxlZXQobnMsIGhvbWVIZWFkcm9vbVJhbSA9IEhPTUVfSEVBRFJPT01fR0IpIHtcbiAgY29uc3QgcHNlcnZzID0gbnMuY2xvdWQuZ2V0U2VydmVyTmFtZXMoKTtcbiAgY29uc3QgcHNlcnZTZXQgPSBuZXcgU2V0KHBzZXJ2cyk7XG4gIC8vIFJvb3RlZCB3b3JsZCBzZXJ2ZXJzIChDU0VDLCBmb29kbnN0dWZmLCBqb2VzZ3VucywgZXRjLikg4oCUIGV2ZXJ5XG4gIC8vIHNlcnZlciB3aXRoIGFkbWluIHJpZ2h0cyBhbmQgYSBub24temVybyBtYXggUkFNLiBFeGNsdWRlZCBmcm9tXG4gIC8vIHRoZSBoYWNrLXRhcmdldCBsaXN0IGJ5IHBpY2tUYXJnZXRzKCk7IHRoZXkgY2FuIGJlIHdvcmtlcnNcbiAgLy8gZm9yIE9USEVSIHRhcmdldHMgZnJlZWx5LiBBIHBzZXJ2LTAgd2l0aCAxIFRCIGFuZCBhIENTRUMgd2l0aFxuICAvLyA1MCBHQiBib3RoIGNvbnRyaWJ1dGUgdG8gdGhlIHNhbWUgZmxlZXQuXG4gIGNvbnN0IHdvcmxkSG9zdHMgPSBsaXN0UmVhY2hhYmxlU2VydmVycyhucykuZmlsdGVyKFxuICAgIChoKSA9PiAhcHNlcnZTZXQuaGFzKGgpICYmIG5zLmhhc1Jvb3RBY2Nlc3MoaCkgJiYgbnMuZ2V0U2VydmVyTWF4UmFtKGgpID4gMFxuICApO1xuICByZXR1cm4gW1xuICAgIHsgaDogXCJob21lXCIsIHI6IGhvbWVIZWFkcm9vbVJhbSB9LFxuICAgIC4uLnBzZXJ2cy5tYXAoKGgpID0+ICh7IGgsIHI6IDAgfSkpLFxuICAgIC4uLndvcmxkSG9zdHMubWFwKChoKSA9PiAoeyBoLCByOiAwIH0pKSxcbiAgXTtcbn1cblxuLyoqXG4gKiBUb3RhbCBmcmVlIFJBTSBhY3Jvc3MgdGhlIGZsZWV0LCBpbiBHQi4gU3VtcyBgbWF4IC0gdXNlZCAtIHJlc2VydmVgXG4gKiBmb3IgZXZlcnkgZmxlZXQgbWVtYmVyLiBVc2VkIGJ5IHRoZSA1JSBoZWFkcm9vbSBydWxlIHRvIGdhdGUgYmF0Y2hcbiAqIGxhdW5jaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmxlZXRGcmVlKG5zLCBmbGVldCkge1xuICBsZXQgZnJlZSA9IDA7XG4gIGZvciAoY29uc3QgeyBoLCByIH0gb2YgZmxlZXQpIHtcbiAgICBmcmVlICs9IE1hdGgubWF4KDAsIG5zLmdldFNlcnZlck1heFJhbShoKSAtIG5zLmdldFNlcnZlclVzZWRSYW0oaCkgLSByKTtcbiAgfVxuICByZXR1cm4gZnJlZTtcbn1cblxuLyoqXG4gKiBTdGFnZSB0aGUgd29ya2VyIHNjcmlwdHMgKGhhY2suanMsIHdlYWtlbi5qcywgZ3Jvdy5qcykgdG8gZXZlcnlcbiAqIGhvc3QgaW4gdGhlIGZsZWV0LiBJZGVtcG90ZW50IOKAlCBpZiB0aGUgc2NyaXB0cyBhcmUgYWxyZWFkeSBvblxuICogdGhlIGhvc3QsIG5zLnNjcCBpcyBhIG5vLW9wLiBVc2VkIGJ5IHRoZSBtYW5hZ2VyIHRvIHN0YWdlIG9uY2VcbiAqIHBlciB0aWNrIGluc3RlYWQgb2Ygb25jZSBwZXIgYWxsb2NhdGVCYXRjaCBjYWxsLlxuICpcbiAqIENvc3Q6IE8oZmxlZXQuc2l6ZSDDlyAzKSBucy5zY3AgY2FsbHMuIFdpdGggYSAzOS1ob3N0IGZsZWV0LFxuICogdGhhdCdzIDExNyBjYWxscyBwZXIgdGljay4gbnMuc2NwIHJldHVybnMgaW1tZWRpYXRlbHkgaWYgdGhlXG4gKiBmaWxlIGlzIGFscmVhZHkgb24gdGhlIGhvc3QsIHNvIHN1YnNlcXVlbnQgdGlja3MgYXJlIGNoZWFwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhZ2VXb3JrZXJzKG5zLCBmbGVldCwgc2NyaXB0cyA9IFtcImhhY2suanNcIiwgXCJ3ZWFrZW4uanNcIiwgXCJncm93LmpzXCJdKSB7XG4gIGZvciAoY29uc3QgeyBoIH0gb2YgZmxlZXQpIHtcbiAgICBmb3IgKGNvbnN0IHNjcmlwdCBvZiBzY3JpcHRzKSB7XG4gICAgICBpZiAoIW5zLmZpbGVFeGlzdHMoc2NyaXB0LCBoKSkge1xuICAgICAgICBucy5zY3Aoc2NyaXB0LCBoLCBcImhvbWVcIik7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogUmVmcmVzaCB0aGUgcGVyLWhvc3QgZnJlZS1SQU0gZmllbGQgb2YgYSBjYWNoZWQgZmxlZXQgd2l0aG91dFxuICogcmUtcnVubmluZyBsaXN0UmVhY2hhYmxlU2VydmVycycgQkZTLiBSZXR1cm5zIGEgTkVXIGZsZWV0IG9iamVjdFxuICogd2l0aCB1cGRhdGVkIGByYCAodGhlIGhlYWRyb29tKSByZWZsZWN0aW5nIHRoZSBsYXRlc3QgZnJlZSBSQU1cbiAqIHBlciBob3N0LlxuICpcbiAqIFRoZSBmbGVldCdzIGhvc3QgbGlzdCBpcyBzdGFibGUgZm9yIHRoZSB3aG9sZSB0aWNrOyBvbmx5IHRoZVxuICogcGVyLWhvc3QgZnJlZSBSQU0gY2hhbmdlcyBhcyB3b3JrZXJzIGFyZSBwbGFjZWQuIFJlLXJ1bm5pbmdcbiAqIGJ1aWxkRmxlZXQoKSBwZXIgam9iIHdhcyBkb2luZyB+NzAgbnMuc2NhbiBjYWxscyBwZXIgY2FsbCxcbiAqIHdoaWNoIGh1bmcgdGhlIGJyb3dzZXIgYXQgNDUgY2FsbHMgcGVyIHRpY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNoZWNrRmxlZXRSYW0obnMsIGZsZWV0LCBob21lSGVhZHJvb21SYW0gPSBIT01FX0hFQURST09NX0dCKSB7XG4gIHJldHVybiBmbGVldC5tYXAoKHsgaCB9KSA9PiB7XG4gICAgY29uc3QgbWF4ID0gbnMuZ2V0U2VydmVyTWF4UmFtKGgpO1xuICAgIGNvbnN0IHVzZWQgPSBucy5nZXRTZXJ2ZXJVc2VkUmFtKGgpO1xuICAgIGNvbnN0IGhlYWRyb29tID0gaCA9PT0gXCJob21lXCIgPyBob21lSGVhZHJvb21SYW0gOiAwO1xuICAgIHJldHVybiB7IGgsIHI6IE1hdGgubWF4KDAsIG1heCAtIHVzZWQgLSBoZWFkcm9vbSkgfTtcbiAgfSk7XG59XG5cbi8qKlxuICogQmluLXBhY2sgYHRocmVhZHNgIG9mIGBzY3JpcHRgIGFjcm9zcyB0aGUgZmxlZXQncyBmcmVlIFJBTSwgYWxsXG4gKiB0aHJlYWRzIGZpcmVkIHdpdGggdGhlIHNhbWUgYHRhcmdldGAsIGBkZWxheWAsIGFuZCBgaWRgIHNvIHRoZVxuICogZWZmZWN0cyBzdW0gb24gdGhlIHRhcmdldCAoYSBzaW5nbGUgb3AgbWF5IHNwYW4gc2V2ZXJhbCBob3N0cykuXG4gKlxuICogUmV0dXJucyB0aGUgbnVtYmVyIG9mIHRocmVhZHMgYWN0dWFsbHkgcGxhY2VkICh0aHJlYWRzIC0gcmVtYWluaW5nKS5cbiAqIEEgcmV0dXJuIHZhbHVlIDwgdGhyZWFkcyBpcyBhIFBBUlRJQUwgcGxhY2VtZW50IOKAlCB0aGUgbWFuYWdlclxuICogdHJlYXRzIHRoaXMgYXMgYSBiYXRjaCBmYWlsdXJlIChQaXRmYWxsIDIyLXN0eWxlOiBkb24ndCBzdGFtcFxuICogbGFzdEZpcmVNcywgbGV0IHRoZSBuZXh0IHRpY2sgcmUtYXR0ZW1wdCB0aGUgZnVsbCBiYXRjaCkuXG4gKlxuICogVGhlIDUlIGhlYWRyb29tIHJ1bGUgaW4gdGhlIG1hbmFnZXIgKGBpZiAodG90YWxCYXRjaFJhbShiKSA8PVxuICogZmxlZXRGcmVlICogRkxFRVRfSEVBRFJPT01fRlJBQ1RJT04pYCkgaXMgd2hhdCBwcmV2ZW50cyBwYXJ0aWFsXG4gKiBwbGFjZW1lbnRzIGZyb20gaGFwcGVuaW5nIGluIHByYWN0aWNlLiBUaGUgZnVuY3Rpb24gaXRzZWxmIHdpbGxcbiAqIGhhcHBpbHkgcGxhY2UgcGFydGlhbCBiYXRjaGVzOyB0aGUgZ2F0ZSBpcyB1cHN0cmVhbS5cbiAqXG4gKiBDb3N0OiBPKGZsZWV0LnNpemUpIHBlciBjYWxsLiBmbGVldCBpcyB0eXBpY2FsbHkgfjE1LTUwIG1lbWJlcnNcbiAqICgxIGhvbWUgKyAyNSBwc2VydnMgbWF4ICsgfjIwIHJvb3RlZCB3b3JsZCBzZXJ2ZXJzKSwgc28gYSBmZXdcbiAqIGh1bmRyZWQgc2ltcGxlIGFyaXRobWV0aWMgb3BzIHBlciBqb2Igw5cgNCBqb2JzIHBlciBiYXRjaCA9XG4gKiB+MjAwMCBvcHMgcGVyIGJhdGNoIGRpc3BhdGNoLiBOZWdsaWdpYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYWxsb2NhdGUobnMsIGZsZWV0LCBzY3JpcHQsIHRocmVhZHMsIHRhcmdldCwgZGVsYXksIGlkKSB7XG4gIGNvbnN0IHJhbSA9IG5zLmdldFNjcmlwdFJhbShzY3JpcHQpO1xuICBsZXQgcmVtYWluaW5nID0gdGhyZWFkcztcbiAgZm9yIChjb25zdCB7IGgsIHIgfSBvZiBmbGVldCkge1xuICAgIGlmIChyZW1haW5pbmcgPD0gMCkgYnJlYWs7XG4gICAgY29uc3QgZnJlZSA9IE1hdGgubWF4KDAsIG5zLmdldFNlcnZlck1heFJhbShoKSAtIG5zLmdldFNlcnZlclVzZWRSYW0oaCkgLSByKTtcbiAgICBjb25zdCBjYW5GaXQgPSBNYXRoLmZsb29yKGZyZWUgLyByYW0pO1xuICAgIGlmIChjYW5GaXQgPD0gMCkgY29udGludWU7XG4gICAgY29uc3QgcHV0ID0gTWF0aC5taW4oY2FuRml0LCByZW1haW5pbmcpO1xuICAgIGlmIChucy5leGVjKHNjcmlwdCwgaCwgcHV0LCB0YXJnZXQsIE1hdGgucm91bmQoZGVsYXkpLCBpZCkpIHJlbWFpbmluZyAtPSBwdXQ7XG4gIH1cbiAgcmV0dXJuIHRocmVhZHMgLSByZW1haW5pbmc7XG59XG5cbi8qKlxuICogTWF4aW11bSBSQU0gKGluIEdCKSBhIHNpbmdsZSB0YXJnZXQncyBiYXRjaCBjYW4gY2xhaW0gZnJvbSB0aGVcbiAqIGZsZWV0LCBwZXIgdGhlIE1BWF9GTEVFVF9TSEFSRSBjYXAuIFRoZSBjYXAgaXMgdGhlIHBlci10YXJnZXRcbiAqIHNoYXJlIG9mIHRoZSBmbGVldCdzIFRPVEFMIG1heCBSQU0gKG5vdCBmcmVlIOKAlCB0b3RhbCksIHNvIGFcbiAqIHNpbmdsZSB0YXJnZXQgY2FuJ3QgaG9nIG1vcmUgdGhhbiAxLzMgb2YgdGhlIGNsdXN0ZXIncyBjYXBhY2l0eVxuICogZm9yIG9uZSBiYXRjaC5cbiAqXG4gKiBTb3VyY2VkIGZyb20gc2tlZXNsZXIvYml0YnVybmVyLWNvbW1hbmRlcjogdGhlaXJcbiAqIE1BWF9GTEVFVF9TSEFSRSA9IDEvMyBwcmV2ZW50cyB0aGUgdG9wLXJhbmtlZCB0YXJnZXQgZnJvbVxuICogdGFraW5nIHRoZSB3aG9sZSBjbHVzdGVyIGFuZCBzdGFydmluZyAjMi4uIzkuIFdpdGhvdXQgdGhpc1xuICogY2FwLCBgcGlja1RhcmdldHMoKWAncyBcImZpcnN0IDkgYnkgbW9uZXlNYXhcIiBvcmRlcmluZyBtZWFuc1xuICogcGhhbnRhc3kgYWxvbmUgY29uc3VtZXMgdGhlIHdob2xlIGZsZWV0IG9uIGV2ZXJ5IHRpY2suXG4gKlxuICogVGhlIGZsZWV0J3MgdG90YWwgPSBzdW0gb2YgKG1heCAtIHJlc2VydmUpIGFjcm9zcyBtZW1iZXJzLlxuICogYHJlc2VydmVgIGlzIHRoZSBwZXItaG9zdCBzeXN0ZW0gaGVhZHJvb20gKDMyIEdCIG9uIGhvbWUsIDAgb25cbiAqIHBzZXJ2cy9yb290ZWQgd29ybGRzKS4gVXNpbmcgbWF4IC0gcmVzZXJ2ZSAobm90IG1heCkgbWVhbnNcbiAqIHRoZSBjYXAgaXMgXCJ0aGUgZmxlZXQncyB1c2FibGUgY2FwYWNpdHlcIiBub3QgXCJyYXcgaW5zdGFsbGVkXG4gKiBSQU1cIiwgd2hpY2ggbWF0Y2hlcyB3aGF0IHRoZSBtYW5hZ2VyIGFjdHVhbGx5IGNvbXBldGVzIGZvci5cbiAqXG4gKiBDb3N0OiBPKGZsZWV0LnNpemUpIHBlciBjYWxsLiBOZWdsaWdpYmxlIOKAlCB0aGlzIGlzIGNhbGxlZFxuICogb25jZSBwZXIgdGFyZ2V0IHBlciB0aWNrLCBub3QgcGVyIGpvYi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoYXJlUmFtQ2FwKG5zLCBmbGVldCkge1xuICBsZXQgdG90YWwgPSAwO1xuICBmb3IgKGNvbnN0IHsgaCwgciB9IG9mIGZsZWV0KSB7XG4gICAgdG90YWwgKz0gTWF0aC5tYXgoMCwgbnMuZ2V0U2VydmVyTWF4UmFtKGgpIC0gcik7XG4gIH1cbiAgcmV0dXJuIE1hdGguZmxvb3IodG90YWwgKiBNQVhfRkxFRVRfU0hBUkUpO1xufVxuXG4vKipcbiAqIERpc3RyaWJ1dGUgYWxsIDQgam9icyBvZiBhIHBsYW4gYWNyb3NzIHRoZSBmbGVldCwgcmV0dXJuaW5nIHRoZVxuICogbWluaW11bSB0aHJlYWRzLXBsYWNlZCBhY3Jvc3MgdGhlIDQgam9icyAoMCBpZiBhbnkgam9iIHBhcnRpYWwpLlxuICogVGhlIGNhbGxlciB0cmVhdHMgbWluPT09MCBhcyBcImJhdGNoIGZhaWxlZCwgZG9uJ3Qgc3RhbXAgY29vbGRvd25cIlxuICogYW5kIHRyZWF0cyBtaW49PT1qb2JzLmxlbmd0aCBhcyBcImJhdGNoIGZ1bGx5IHBsYWNlZCwgc3RhbXAgY29vbGRvd24uXCJcbiAqXG4gKiBUaGUgY2FsbGVyIGlzIHJlc3BvbnNpYmxlIGZvciBzaGFyZS1jYXAgKE1BWF9GTEVFVF9TSEFSRSkgYW5kXG4gKiBmbGVldC1maXQgKDUlIGhlYWRyb29tKSBnYXRlcyBCRUZPUkUgY2FsbGluZyBhbGxvY2F0ZUJhdGNoLlxuICogYWxsb2NhdGVCYXRjaCBpcyBhIGxvdy1sZXZlbCBiaW4tcGFja2VyOyBpdCBkb2VzIHdoYXQgaXQncyB0b2xkXG4gKiB3aXRoaW4gdGhlIGZsZWV0J3MgY3VycmVudCBmcmVlIFJBTS4gRG9pbmcgdGhlIGhpZ2hlci1sZXZlbFxuICogZ2F0ZXMgdXBzdHJlYW0gbWVhbnMgdGhlIG1hbmFnZXIgY2FuIGNhbGwgYWxsb2NhdGVCYXRjaCBmb3JcbiAqIHRoZSBXSE9MRSBiYXRjaCAoNCBqb2JzIGluIG9uZSBjYWxsKSBvciBmb3IgYSBzaW5nbGUgam9iIChwZXItXG4gKiBqb2Igc2xlZXAgcGF0dGVybiwgbWFuYWdlci5qczo0NDQtNDgyKSB3aXRoIHRoZSBzYW1lIEFQSS5cbiAqXG4gKiBXb3JrZXJzIGFyZSBwdXNoZWQgdG8gdGhlIGZsZWV0IGhvc3RzIHZpYSBucy5zY3AgZmlyc3Qgc28gdGhlXG4gKiBgU2NyaXB0IDxuYW1lPiBkb2VzIG5vdCBleGlzdCBvbiBob3N0YCBmYWlsdXJlIG1vZGUgKFBpdGZhbGwgMjIpXG4gKiBkb2Vzbid0IGZpcmUgb24gdGhlIGZpcnN0IGJhdGNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYWxsb2NhdGVCYXRjaChucywgZmxlZXQsIHBsYW4sIHRhcmdldCwgdGFyZ2V0T2Zmc2V0LCBpZCwgdmVyYm9zZSkge1xuICAvLyBXb3JrZXJzIGFyZSBzdGFnZWQgb25jZSBwZXIgdGljayBieSB0aGUgbWFuYWdlcidzXG4gIC8vIHN0YWdlV29ya2VycygpIGNhbGwgYXQgdGhlIHRvcCBvZiB0aGUgb3V0ZXIgbG9vcC4gVGhlXG4gIC8vIHByZXZpb3VzIHBlci1jYWxsIHNjcCB3YXMgMTE3IGNhbGxzIMOXIDM2IGNhbGxzIHBlciB0aWNrID1cbiAgLy8gNDIxMiBucy5zY3Agcm91bmQtdHJpcHMgcGVyIHRpY2ssIHdoaWNoIHdhcyBoYW5naW5nIHRoZVxuICAvLyBicm93c2VyLiBJZGVtcG90ZW50IG5vLW9wIGlmIGFscmVhZHkgc3RhZ2VkLlxuICBsZXQgbWluUGxhY2VkID0gSW5maW5pdHk7XG4gIGNvbnN0IHBsYWNlbWVudCA9IFtdOyAgLy8gZm9yIC0tdmVyYm9zZTogd2hpY2ggaG9zdCBnb3QgaG93IG1hbnkgdGhyZWFkcyBvZiB3aGljaCBqb2JcbiAgZm9yIChjb25zdCBqb2Igb2YgcGxhbi5qb2JzKSB7XG4gICAgY29uc3Qgam9iRGVsYXkgPSBqb2IuZGVsYXlNcyArIHRhcmdldE9mZnNldDtcbiAgICBjb25zdCBwbGFjZWQgPSBhbGxvY2F0ZShucywgZmxlZXQsIGpvYi5zY3JpcHQsIGpvYi50aHJlYWRzLCB0YXJnZXQsIGpvYkRlbGF5LCBpZCk7XG4gICAgaWYgKHBsYWNlZCA8IGpvYi50aHJlYWRzICYmIG1pblBsYWNlZCA9PT0gSW5maW5pdHkpIG1pblBsYWNlZCA9IDA7ICAvLyBlYXJseS1vdXRcbiAgICBpZiAocGxhY2VkIDwgbWluUGxhY2VkKSBtaW5QbGFjZWQgPSBwbGFjZWQ7XG4gICAgaWYgKHZlcmJvc2UpIHBsYWNlbWVudC5wdXNoKHsgc2NyaXB0OiBqb2Iuc2NyaXB0LCB0aHJlYWRzOiBwbGFjZWQsIG9mOiBqb2IudGhyZWFkcywgZGVsYXk6IGpvYkRlbGF5IH0pO1xuICB9XG4gIHJldHVybiB7IG1pblBsYWNlZCwgcGxhY2VtZW50IH07XG59XG5cbi8qKlxuICogU3RyaWN0IHByZXAgY2hlY2s6IHRhcmdldCBpcyBhdCBtaW4gc2VjdXJpdHkgQU5EIG1heCBtb25leS4gVXNlZFxuICogYXQgdGhlIGJvdW5kYXJ5IGJldHdlZW4gcHJlcCgpIGFuZCB0aGUgbWFpbiBsb29wIHRvIGtub3cgd2hlblxuICogcHJlcCBpcyBmaW5pc2hlZC4gTk9UIGEgcGVyLXRpY2sgZ2F0ZSDigJQgYSBydW5uaW5nIGJhdGNoZXInc1xuICogbW9uZXkgZGlwcyBhbmQgcmVjb3ZlcnMgYnkgZGVzaWduLCBzbyBhIHBlci10aWNrIGlzUHJlcHBlZCgpXG4gKiBjaGVjayB3b3VsZCBzYXkgXCJOT1QgUFJFUFBFRFwiIGV2ZXJ5IG1pZC1jeWNsZSB0aWNrIGFuZCB0cmlnZ2VyXG4gKiB3YXN0ZWZ1bCByZS1wcmVwIHdvcmsuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ByZXBwZWQobnMsIHRhcmdldCkge1xuICByZXR1cm4gbnMuZ2V0U2VydmVyU2VjdXJpdHlMZXZlbCh0YXJnZXQpIDw9IG5zLmdldFNlcnZlck1pblNlY3VyaXR5TGV2ZWwodGFyZ2V0KSArIDAuMDEgJiZcbiAgICAgICAgIG5zLmdldFNlcnZlck1vbmV5QXZhaWxhYmxlKHRhcmdldCkgPj0gbnMuZ2V0U2VydmVyTWF4TW9uZXkodGFyZ2V0KSAqIDAuOTk5O1xufVxuXG4vKipcbiAqIFRvbGVyYW50IGhlYWx0aCBjaGVjazogdGFyZ2V0IGlzIHJvdWdobHkgcHJlcHBlZC4gVHJ1ZSB0aHJvdWdob3V0XG4gKiBub3JtYWwgYmF0Y2ggb3NjaWxsYXRpb24sIGZhbHNlIG9ubHkgb24gcmVhbCBkZXN5bmMgKG1vbmV5IGNyYXNoZWRcbiAqIG9yIHNlY3VyaXR5IHNwaWtlZCBmYXIgYWJvdmUgbWluKS4gVXNlIHRoaXMgaW4gdGhlIG1haW4gbG9vcCBhc1xuICogdGhlIHJlY292ZXJ5LW1vZGUgdHJpZ2dlcjsgdGhlIGN1cmUgaXMgYSBmZXcgcHJlcCB3ZWFrZW5zLCBub3RcbiAqIHdhaXRpbmcgZm9yIGlzUHJlcHBlZCdzIHN0cmljdCBib3VuZGFyeS5cbiAqXG4gKiBoYWNrRnJhY3Rpb24gaXMgdGhlIHBlci1iYXRjaCBzdGVhbCBmcmFjdGlvbiAobWF0Y2hlcyBtYW5hZ2VyJ3NcbiAqIE1PTkVZX0ZSQUNUSU9OKS4gQSBydW5uaW5nIGJhdGNoZXIgc2hvdWxkIG9zY2lsbGF0ZSBiZXR3ZWVuXG4gKiAoMSAtIGhhY2tGcmFjdGlvbikgYW5kIDEuMCBvZiBtb25leU1heDsgaWYgaXQncyBiZWxvdyA1MCUgb2ZcbiAqICgxIC0gaGFja0ZyYWN0aW9uKSwgdGhlIGdyb3cgaXNuJ3Qga2VlcGluZyB1cCBhbmQgdGhlIHRhcmdldFxuICogaXMgZGVzeW5jZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0hlYWx0aHkobnMsIHRhcmdldCwgaGFja0ZyYWN0aW9uLCBtb25leUZyYWN0aW9uID0gMC41LCBzZWNUb2xlcmFuY2UgPSA1KSB7XG4gIGNvbnN0IG1heE1vbmV5ID0gbnMuZ2V0U2VydmVyTWF4TW9uZXkodGFyZ2V0KTtcbiAgY29uc3QgbWluU2VjID0gbnMuZ2V0U2VydmVyTWluU2VjdXJpdHlMZXZlbCh0YXJnZXQpO1xuICBjb25zdCBtb25leSA9IG5zLmdldFNlcnZlck1vbmV5QXZhaWxhYmxlKHRhcmdldCk7XG4gIGNvbnN0IHNlYyA9IG5zLmdldFNlcnZlclNlY3VyaXR5TGV2ZWwodGFyZ2V0KTtcbiAgLy8gc2tlZXNsZXIgZGVmYXVsdDogbW9uZXkgPj0gNTAlIMOXICgxIC0gaGFja0ZyYWN0aW9uKSDDlyBtYXhNb25leVxuICAvLyBBTkQgY3VyU2VjIDw9IG1pblNlYyArIDUuIENhbGxlciBjYW4gb3ZlcnJpZGUgdGhlIG1vbmV5IGZyYWN0aW9uXG4gIC8vIChlLmcuIGEgc3RyaWN0ZXIgY2hlY2spIG9yIHRoZSBzZWMgdG9sZXJhbmNlLlxuICByZXR1cm4gbW9uZXkgPj0gbWF4TW9uZXkgKiAoMSAtIGhhY2tGcmFjdGlvbikgKiBtb25leUZyYWN0aW9uICYmIHNlYyA8PSBtaW5TZWMgKyBzZWNUb2xlcmFuY2U7XG59XG5cbi8qKlxuICogVG90YWwgUkFNIGEgcGxhbiB3aWxsIHVzZSBhY3Jvc3MgdGhlIGZsZWV0LiBVc2VkIGJ5IHRoZSA1JSBoZWFkcm9vbVxuICogcnVsZSB0byBnYXRlIGxhdW5jaGVzOiBvbmx5IGZpcmUgaWYgYHRvdGFsQmF0Y2hSYW0ocGxhbikgPD1cbiAqIGZsZWV0RnJlZShmbGVldCkgKiBGTEVFVF9IRUFEUk9PTV9GUkFDVElPTmAuXG4gKlxuICogVGhlIGNhcCBvbiBwZXItdGhyZWFkIFJBTSBpcyBgbnMuZ2V0U2NyaXB0UmFtKHNjcmlwdCwgXCJob21lXCIpYCDigJRcbiAqIHNjcmlwdHMgaGF2ZSBhIGNvbnN0YW50IFJBTSBjb3N0IHJlZ2FyZGxlc3Mgb2Ygd2hlcmUgdGhleSBydW4sIHNvXG4gKiB0aGUgc2NyaXB0J3MgaG9tZSBpcyBhIHZhbGlkIHJlZmVyZW5jZS4gV29ya2VyIHNjcmlwdHMgYXJlXG4gKiBkZXBsb3llZCB0byBldmVyeSBmbGVldCBob3N0IHZpYSBhbGxvY2F0ZUJhdGNoJ3Mgc2NwIGxvb3AsIHNvIHRoZVxuICogXCJSQU0gY29zdCBvbiB0aGUgaG9zdFwiIHF1ZXN0aW9uIGlzIHNldHRsZWQgYmVmb3JlIHRoZSBjYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdG90YWxCYXRjaFJhbShucywgcGxhbikge1xuICBjb25zdCBoYWNrUmFtID0gbnMuZ2V0U2NyaXB0UmFtKFwiaGFjay5qc1wiLCBcImhvbWVcIik7XG4gIGNvbnN0IHdlYWtlblJhbSA9IG5zLmdldFNjcmlwdFJhbShcIndlYWtlbi5qc1wiLCBcImhvbWVcIik7XG4gIGNvbnN0IGdyb3dSYW0gPSBucy5nZXRTY3JpcHRSYW0oXCJncm93LmpzXCIsIFwiaG9tZVwiKTtcbiAgcmV0dXJuIHBsYW4uam9icy5yZWR1Y2UoXG4gICAgKHN1bSwgaikgPT5cbiAgICAgIHN1bSArIGoudGhyZWFkcyAqIChqLnNjcmlwdCA9PT0gXCJoYWNrLmpzXCIgPyBoYWNrUmFtIDogai5zY3JpcHQgPT09IFwid2Vha2VuLmpzXCIgPyB3ZWFrZW5SYW0gOiBncm93UmFtKSxcbiAgICAwXG4gICk7XG59XG5cbi8vIFJlLWV4cG9ydCB0aGUgY29uc3RhbnRzIGZvciBjYWxsZXJzIHRoYXQgd2FudCB0byByZWFkIHRoZSBzYW1lXG4vLyBudW1iZXJzIChlLmcuIG1hbmFnZXIuanMncyBwZXItdGFyZ2V0IGZsZWV0IHNoYXJlIGNhcCwgZHJ5cnVuJ3Ncbi8vIFwid291bGQgdGhpcyBiYXRjaCBmaXQ/XCIgY2hlY2spLiBEZWZhdWx0czogMzIgR0IgaG9tZSBoZWFkcm9vbSxcbi8vIDk1JSBmbGVldCBoZWFkcm9vbSwgMS8zIHBlci10YXJnZXQgc2hhcmUgY2FwLlxuZXhwb3J0IGNvbnN0IEZMRUVUX0RFRkFVTFRTID0ge1xuICBIT01FX0hFQURST09NX0dCLFxuICBGTEVFVF9IRUFEUk9PTV9GUkFDVElPTixcbiAgTUFYX0ZMRUVUX1NIQVJFLFxufTtcbiJdfQ==