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
//                          0.10 (10%) is the sweet spot for most
//                          targets; raise to 0.25 for fast-regrow
//                          servers, lower to 0.05 for slow ones.
//   TICK_MS              — main loop period. 5000 (5s) is the
//                          default; 1000 for high-throughput late
//                          game.
//   BATCH_INTERVAL_MS    — per-target stagger. Default 4000 (4s).
//                          Should be < (shortest weakenTime / 2).
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
const MONEY_FRACTION = 0.10;
const TICK_MS = 5_000;
// Per-target stagger: each target's arrivalT is offset by
// ti * BATCH_INTERVAL_MS so the regrow timers don't all bunch
// on the same wall-clock moment. Should be much less than the
// shortest weakenTime; 4 seconds is safe.
const BATCH_INTERVAL_MS = 4_000;

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

export async function main(ns) {
  ns.disableLog("sleep");
  // Manager is auto-quiet by default — it runs every 60s and the
  // per-tick summary only goes to the terminal when something
  // interesting happened (a batch launched, or the target list
  // became empty). For first-time setup or debugging, run with
  // --verbose to see every tick.
  const verbose = ns.args.includes("--verbose");
  if (verbose) {
    ns.tprint(`manager: started, MAX_TARGETS=${MAX_TARGETS} tick=${TICK_MS}ms, output=verbose`);
  }

  // Track the last summary string we tprint'ed. We only tprint
  // when the summary CHANGES from a non-empty value to "" (or
  // vice versa) — repeating the same "(no changes)" line every
  // tick is noise, but the first tick that goes quiet is a
  // signal (something just changed).
  let lastSummary;

  while (true) {
    const tickStart = Date.now();
    const counters = { planned: 0, launched: 0, "SKIP-ram": 0, "SKIP-root": 0, "SKIP-level": 0, "SKIP-mp": 0, "FAIL-exec": 0 };
    const targets = pickTargets(ns);

    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      const s = ns.getServer(target);
      // pickTargets() already filtered, but be defensive — the
      // world can change between ticks.
      if (!s.hasAdminRights) { counters["SKIP-root"]++; continue; }
      if (s.requiredHackingSkill > ns.getPlayer().skills.hacking) { counters["SKIP-level"]++; continue; }
      if (!s.moneyMax || s.moneyMax <= 0) { counters["SKIP-mp"]++; continue; }

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
    // Per-tick log line: always goes to the in-game log so verbose
    // users can see every tick.
    ns.print(`manager: tick ${(elapsed / 1000).toFixed(1)}s targets=[${targets.join(",")}] ${summary || "(no changes)"}`);
    // Surface interesting state to the terminal. Track the last
    // summary printed so we only fire when it CHANGES — otherwise
    // a long quiet stretch of (no changes) lines floods the
    // terminal every 5s. The user wanted "only see these messages
    // when something positively changed"; the first time we have
    // 0 changes is a positive signal (it just changed from N
    // changes to 0), but the second consecutive quiet tick is
    // not. Skip until something happens.
    if (typeof lastSummary !== "undefined" && lastSummary === summary && (summary === "" || summary === undefined)) {
      // Suppress repeated "(no changes)" — same quiet state.
    } else {
      // Either we have a non-empty summary (something happened),
      // OR this is the first time we've gone quiet (transition
      // from "had changes" to "quiet"). Either way, print it.
      ns.tprint(`manager: targets=[${targets.join(",") || "(empty)"}] ${summary || "(no changes — check logs if unexpected)"}`);
    }
    lastSummary = summary;

    // Wait until the next tick boundary. We've already burned some
    // time on per-job sleeps, so the residual is small.
    const residual = TICK_MS - (Date.now() - tickStart);
    if (residual > 0) await ns.sleep(residual);
  }
}
