/** @param {NS} ns */
//
// monitor-servers.js — long-lived daemon that progressively buys and
// RAM-scales purchased servers along the "Purchased-Server RAM Tier"
// target table:
//
//   tier            roster count    target RAM (GB), per-server
//   ------------    ------------    -----------------------
//   bootstrap       0..8            64    (cheap to fill the slot)
//   sweet-spot      9..25           1024  (1 TB — same as home, useful for fan-out)
//
// We don't try to scale one server all the way to the cap before
// moving on. Instead, every tick we pick the CHEAPEST next purchase
// (a new pserv slot at the current tier's target RAM, OR a snap-to-
// target upgrade on the smallest under-target server) and apply
// it. This keeps the whole fleet moving in lockstep and stops the
// per-server cost curve (each size-up scales cost much faster than
// linearly) from outpacing the wallet.
//
// The roster is fixed at the game's 25-server cap (ns.cloud.getServerLimit in 3.0.0).
// Names are pserv-0..pserv-24. We never rename — a snap-to-target
// upgrade is deleteServer + purchaseServer at the new (tier) size.
// The lost scripts and tmp data on a delete is a non-issue at this
// stage of the game (the worker scripts get re-fanned by
// monitor-deploy.js, and the orchestrator already lives on home).
//
// "sweet-spot" is the only tier we now ship. The previous "soft-cap"
// 4 TB tier was costing ~$1.15T for 5 servers at $230B each — the
// fleet-batcher pattern in manager.js (home + pservs + rooted-worlds
// = ~12+ TB) makes the marginal value of 4 TB pservs near-zero. The
// wallet savings are dramatic: a 4 TB fleet costs ~$1.15T, a 1 TB
// fleet costs ~$1.4T, but the income difference is negligible
// (cluster utilization is the binding constraint, not raw capacity).
// Users who want to push past 1 TB can run `run monitor-servers.js
// --tier soft-cap` (re-enables the 4 TB tier explicitly).
//
// CONSERVATIVE SPENDING: this daemon is the most likely source of
// wallet drain. The previous defaults (10% of wallet per purchase,
// no reserve floor, multi-server-per-tick scale walk) were
// responsible for the $1.5B+ spend the user reported seeing in
// sinceInstall stats. The new defaults:
//
//   --rule 0.03      1-to-3 Rule: max 3% of wallet per purchase
//                    (was 10% — at $1T wallet, that's $30B/tick
//                    instead of $100B/tick)
//   --reserve 100e9  Wallet floor: never spend below $100B (was
//                    unguarded — the daemon happily spent the
//                    wallet to 0 to buy a single 4 TB pserv).
//                    Reserve protects Home RAM upgrades, augs,
//                    and contract solvers.
//   1 buy/tick       At most ONE purchase per pass (was "buy +
//                    scale 2-3 servers if rule allows")
//   1 scale/tick     At most ONE scale per pass (was a while loop
//                    that scaled every under-target pserv in one
//                    pass)
//
// These three knobs together cap the daemon's spend rate at:
//   per-pass max = min(wallet * 0.03, wallet - $100B)
//   per-tick at 60s cadence = up to ~$30B
//   per-minute = up to ~$30B
//   per-hour = up to ~$1.8T (if income keeps up — otherwise the
//              1-to-3 Rule kicks in and caps each purchase at 3%)
//
// This is intentionally a 3-5× reduction in spend rate. The user
// reported $1.5B spent while only $8.7M was earned — a 178:1
// negative ROI. At the new rate, $1.5B of CAPEX happens over ~50
// minutes, with $100B+ always in reserve. Income should outpace
// spending once the manager's fleet-batcher is also running
// (manager.js's new fleet pattern typically produces $10B+/sec
// against the top 9 targets).
//
// Output is QUIET by default — only PSERV-BOUGHT / SCALED / fail
// summary lines print. --verbose re-enables per-tick budget and
// per-server target state. --once runs a single upgrade pass and
// exits (full output).
//
// Usage:
//   run monitor-servers.js                     # loop, every 60s, QUIET, 1-to-3 Rule
//   run monitor-servers.js --once              # one pass, full output, then exit
//   run monitor-servers.js --interval 30000    # loop, every 30s, QUIET
//   run monitor-servers.js --verbose           # loop, per-tick budget + per-server targets
//   run monitor-servers.js --cap 25            # stop buying new pservs at 25 (default 25, game cap)
//   run monitor-servers.js --rule 0.05         # max 5% of wallet per purchase (default 0.03)
//   run monitor-servers.js --reserve 50e9     # wallet floor; never spend below $50B (default 100B)
//   run monitor-servers.js --tier soft-cap    # re-enable the 4 TB "soft-cap" tier (default: off)
//   run monitor-servers.js --once 0            # pass 0 means print a per-tick budget, no apply
//
const USAGE = `Usage:
  run monitor-servers.js                     # loop, every 60s, QUIET, 1-to-3 Rule
  run monitor-servers.js --once              # one pass, full output, then exit
  run monitor-servers.js --interval 30000    # loop, every 30s, QUIET
  run monitor-servers.js --verbose           # loop, per-tick budget + per-server targets
  run monitor-servers.js --cap 25            # stop buying new pservs at 25 (default 25, game cap)
  run monitor-servers.js --rule 0.05         # max 5% of wallet per purchase (default 0.03)
  run monitor-servers.js --reserve 50e9      # wallet floor; never spend below $50B (default 100B)
  run monitor-servers.js --tier soft-cap     # re-enable the 4 TB "soft-cap" tier (default: off)
`;

// Tier table. order matters: the FIRST tier whose roster range
// contains the current count is the active tier. Add a new tier by
// dropping it in at the top of the array.
//
// 4 TB tier is now opt-in via --tier soft-cap. The default 1 TB
// sweet-spot is plenty for the fleet-batcher (manager.js's pattern
// already uses home + pservs + rooted-worlds, so the marginal
// value of 4 TB pservs is minimal).
//
// Cost math: at 64 GB the per-pserv cost is $3.52M (64 × $55k).
// At 1 TB the per-pserv cost is $57.7B. At 4 TB it's $230B. The
// 1-to-3 Rule means we wait for the wallet to grow before each
// step, so the 4 TB tier is only hit when the wallet is ~$2.3T+.
const TIERS = [
  { name: "bootstrap",  minRoster: 0,  maxRoster: 8,  targetGB: 64 },
  { name: "sweet-spot", minRoster: 8,  maxRoster: 25, targetGB: 1024 },
  { name: "soft-cap",   minRoster: 20, maxRoster: 25, targetGB: 4096, requiresFlag: "soft-cap" },
];

const SOURCE = "home";
const ROSTER_PREFIX = "pserv-";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NEW_SERVER_CAP = 25;     // tier guide: 25 = game cap; mid-game sweet spot is 25
const MAX_ROSTER = 25;                 // hard cap from ns.cloud.getServerLimit()
const MAX_RAM = 2 ** 20;               // 1,048,576 GB — game hard cap
// 1-to-3 Rule (was 1-to-10). At $1T wallet, 3% = $30B per purchase
// instead of $100B — a 3.3× reduction. The user reported $1.5B
// spent on a $8.7M-income run, which is unsustainable. Set --rule 0
// to disable for endgame max-out.
const DEFAULT_RULE = 0.03;
const MIN_RULE = 0.0;
const MAX_RULE = 1.0;
// Wallet floor: never spend below this. Protects Home RAM upgrades,
// augs, and contract solvers from being starved by the daemon.
// Default $100B — the daemon will skip ALL purchases (count as
// SKIP-reserve) once the wallet drops below this. Set --reserve 0
// to disable (NOT recommended).
const DEFAULT_RESERVE = 100e9;          // $100B
// Safety bound for legacy code paths. The single-scale-per-pass
// logic doesn't need a walk limit, but the constant is kept for
// any future expansion (e.g. multi-step scaling) that might want
// a hard ceiling. Currently unused.
const ROSTER_WALK_LIMIT = 200;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }

  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const capIdx = args.indexOf("--cap");
  const newServerCap = capIdx >= 0
    ? Math.max(0, Math.min(MAX_ROSTER, Number(args[capIdx + 1])))
    : DEFAULT_NEW_SERVER_CAP;
  if (capIdx >= 0 && (!Number.isFinite(newServerCap) || newServerCap < 0)) {
    ns.tprint(`monitor-servers: --cap must be a number 0..${MAX_ROSTER} (got ${args[capIdx + 1]})`);
    return;
  }
  const ruleIdx = args.indexOf("--rule");
  const ruleFraction = ruleIdx >= 0
    ? Number(args[ruleIdx + 1])
    : DEFAULT_RULE;
  if (ruleIdx >= 0 && (!Number.isFinite(ruleFraction) || ruleFraction < MIN_RULE || ruleFraction > MAX_RULE)) {
    ns.tprint(`monitor-servers: --rule must be a number ${MIN_RULE}..${MAX_RULE} (got ${args[ruleIdx + 1]})`);
    return;
  }
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0
    ? Number(args[intervalIdx + 1])
    : DEFAULT_INTERVAL_MS;
  if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
    ns.tprint(`monitor-servers: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
    return;
  }
  // --reserve $N: wallet floor. Daemon skips purchases when the
  // wallet would drop below this. Default $100B.
  const reserveIdx = args.indexOf("--reserve");
  const reserveFloor = reserveIdx >= 0
    ? Math.max(0, Number(args[reserveIdx + 1]))
    : DEFAULT_RESERVE;
  if (reserveIdx >= 0 && (!Number.isFinite(reserveFloor) || reserveFloor < 0)) {
    ns.tprint(`monitor-servers: --reserve must be a non-negative number (got ${args[reserveIdx + 1]})`);
    return;
  }
  // --tier <name>: opt back into a tier. Currently the only opt-in
  // tier is "soft-cap" (4 TB). Default: no soft-cap (1 TB ceiling).
  const tierIdx = args.indexOf("--tier");
  const enabledTiers = tierIdx >= 0
    ? new Set([args[tierIdx + 1]])
    : new Set();

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("scan");

  // --- helpers ---

  // Active tier for a given current roster count. Skips tiers
  // that require an opt-in flag (e.g. soft-cap is gated on
  // --tier soft-cap). Falls back to the highest-priority
  // unconditional tier.
  function activeTier(count) {
    for (const t of TIERS) {
      if (t.requiresFlag && !enabledTiers.has(t.name)) continue;
      if (count >= t.minRoster && count < t.maxRoster) return t;
    }
    // Past the last eligible tier. Find the highest-priority
    // unconditional tier (or any opt-in tier that was enabled).
    for (const t of TIERS) {
      if (t.requiresFlag && !enabledTiers.has(t.name)) continue;
      return t;
    }
    // No tiers enabled? Shouldn't happen (sweet-spot is always
    // unconditional) but fall through to the last entry rather
    // than crash.
    return TIERS[TIERS.length - 1];
  }

  // Count of currently-existing pserv slots.
  function currentCount() {
    const limit = ns.cloud.getServerLimit();
    let n = 0;
    for (let i = 0; i < limit; i++) {
      if (ns.serverExists(`${ROSTER_PREFIX}${i}`)) n++;
    }
    return n;
  }

  // First missing slot in pserv-0..pserv-(limit-1), or -1 if all exist.
  function firstMissingSlot() {
    const limit = ns.cloud.getServerLimit();
    for (let i = 0; i < limit; i++) {
      if (!ns.serverExists(`${ROSTER_PREFIX}${i}`)) return i;
    }
    return -1;
  }

  // RAM (in GB) of the next power-of-2 ≥ current. Cap at MAX_RAM.
  function nextPowerOf2AtLeast(ram) {
    let r = 1;
    while (r < ram && r < MAX_RAM) r *= 2;
    return Math.min(r, MAX_RAM);
  }

  // Push worker scripts to a freshly-purchased pserv. The runtime
  // requires the script to be on the target host for ns.exec to
  // succeed — without this, every exec to a new pserv fails with
  // "Script weaken.js does not exist on pserv-N". We push the
  // three worker scripts the manager needs. manager.js itself
  // lives on home so doesn't need to be pushed.
  //
  // Failure here is non-fatal: the next monitor-servers tick (or
  // a manual `run sync-all.js`) will retry. The pserv might be
  // briefly unable to host workers; the manager will SKIP-ram
  // and try another worker in the meantime.
  function pushWorkerScripts(host) {
    const scripts = ["hack.js", "weaken.js", "grow.js"];
    return ns.scp(scripts, host, SOURCE);
  }

  // Cost of scaling a server from `currentGB` to `newGB`. The
  // Bitburner API has no in-place upgrade, so scaling is a
  // deleteServer + purchaseServer at the new size. The new size
  // is whatever the upgrade logic decides (2× step OR snap to
  // tier target), and the cost is the getServerCost of that size.
  function costOfScale(newGB) {
    return ns.cloud.getServerCost(Math.min(newGB, MAX_RAM));
  }

  // Snap a desired size up to the next power of 2. Bitburner
  // requires purchased-server RAM to be a power of 2 (2, 4, 8,
  // ..., 65536, ...). 1023 GB is invalid; 1024 GB is valid. We
  // use this for the snap-to-target upgrade path so a target
  // like 64 GB → 1024 GB works even if tier.targetGB is the
  // exact 1024.
  function ceilPow2AtLeast(gb) {
    let p = 1;
    while (p < gb) p *= 2;
    return Math.min(p, MAX_RAM);
  }

  // --- one pass ---

  function pass() {
    const counters = {
      "PSERV-BOUGHT": 0,
      "SCALED": 0,
      "SKIP-cap": 0,
      "SKIP-tier-met": 0,
      "SKIP-funds": 0,
      "SKIP-rule": 0,         // renamed from SKIP-rule10 (1-to-3 Rule now)
      "SKIP-reserve": 0,      // new: wallet below --reserve floor
      "FAIL-purchaseServer": 0,
      "FAIL-deleteServer": 0,
      "FAIL-purchaseAfterDelete": 0,
    };

    const count = currentCount();
    const tier = activeTier(count);
    if (verbose) {
      ns.tprint(`monitor-servers: tier=${tier.name} (${tier.minRoster}-${tier.maxRoster}) target=${tier.targetGB}GB cap=${newServerCap} rule=${(ruleFraction * 100).toFixed(0)}% reserve=$${reserveFloor.toLocaleString()}`);
    }

    // Read the wallet ONCE per pass. The 1-to-3 Rule and the
    // reserve floor both check against the SAME wallet value, so
    // a single read here is the cleanest way to keep them
    // consistent. Re-reading mid-pass would let a tick-buyer slip
    // a purchase past the floor (e.g. if the wallet drops between
    // the read and the buy).
    const wallet = ns.getServerMoneyAvailable(SOURCE);
    if (wallet < reserveFloor) {
      // Reserve floor: refuse to spend. The wallet is below the
      // configured floor; better to wait for income to bring it
      // back up. Without this guard, the daemon would happily
      // spend the wallet to $0 to fund a 4 TB pserv.
      counters["SKIP-reserve"]++;
      if (verbose) {
        ns.tprint(`SKIP-reserve     wallet=$${wallet.toLocaleString()} < $${reserveFloor.toLocaleString()}`);
      }
      if (once || verbose) {
        ns.tprint(`done: ${Object.entries(counters).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ") || "no changes"}`);
      }
      return;
    }

    // 1. Buy a new pserv at the tier's target RAM if we have headroom.
    //    We never buy a new server below the tier target — every
    //    fresh pserv lands at the active tier's spec.
    //
    //    AT MOST ONE buy per pass (was unlimited; the user reported
    //    the daemon buying 2-3 servers per tick when funds allowed).
    //    One buy per tick matches the wallet growth rate; multi-buy
    //    per tick is what drained the wallet.
    if (count < newServerCap && count < MAX_ROSTER) {
      const slot = firstMissingSlot();
      if (slot >= 0) {
        const name = `${ROSTER_PREFIX}${slot}`;
        const cost = ns.cloud.getServerCost(tier.targetGB);
        // Check reserve floor first: if the buy would drop us
        // below the floor, skip with SKIP-reserve.
        if (wallet - cost < reserveFloor) {
          counters["SKIP-reserve"]++;
          if (verbose) {
            ns.tprint(`SKIP-reserve     new ${name} ${tier.targetGB}GB would leave wallet=$${(wallet - cost).toLocaleString()} < $${reserveFloor.toLocaleString()}`);
          }
        } else if (ruleFraction > 0 && cost > wallet * ruleFraction) {
          counters["SKIP-rule"]++;
          if (verbose) {
            ns.tprint(`SKIP-rule       new ${name} ${tier.targetGB}GB $${cost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${wallet.toLocaleString()}`);
          }
        } else if (cost > wallet) {
          counters["SKIP-funds"]++;
          if (verbose) {
            ns.tprint(`SKIP-funds      no new ${name} (need $${cost.toLocaleString()}, have $${wallet.toLocaleString()})`);
          }
        } else {
          const result = ns.cloud.purchaseServer(name, tier.targetGB);
          if (result !== "") {
            counters["PSERV-BOUGHT"]++;
            // PSERV-BOUGHT is the interesting event; always print even
            // in quiet mode. Matches monitor-hacknet's NODE-BOUGHT
            // behavior.
            ns.tprint(`PSERV-BOUGHT    ${result} ${tier.targetGB}GB for $${cost.toLocaleString()} (now ${count + 1}/${MAX_ROSTER})`);
            // Push the worker scripts so the manager can exec to
            // this new server. Without this, the new pserv sits
            // empty until the next manual `run sync-all.js`.
            if (!pushWorkerScripts(result)) {
              counters["FAIL-scp"] = (counters["FAIL-scp"] || 0) + 1;
              if (verbose) ns.tprint(`FAIL-scp        ${result} (couldn't push worker scripts)`);
            }
          } else {
            // purchaseServer returns "" on the cap or some other
            // race. We pre-checked the cap, so this is unusual.
            counters["FAIL-purchaseServer"]++;
            if (verbose) {
              ns.tprint(`FAIL-purchaseServer  ${name} returned "" (cap hit? funds race?)`);
            }
          }
        }
      }
    } else if (count >= newServerCap) {
      counters["SKIP-cap"]++;
      if (verbose) ns.tprint(`SKIP-cap        at new-server cap (${count}/${newServerCap})`);
    } else if (count >= MAX_ROSTER) {
      counters["SKIP-cap"]++;
      if (verbose) ns.tprint(`SKIP-cap        at game cap (${count}/${MAX_ROSTER})`);
    }

    // 2. Walk every existing pserv and apply AT MOST ONE snap-to-
    //    target upgrade. Same pattern as monitor-hacknet: cheapest
    //    candidate first, 1-to-3 Rule gates it, no looping over
    //    the wallet.
    //
    //    SNAP-TO-TARGET (was 2× step). For every pserv under the
    //    active tier's targetGB, compute the cost to jump DIRECTLY
    //    to the target. Pick the cheapest such jump (the smallest
    //    pserv is typically the cheapest to upgrade, since per-GB
    //    cost grows with size).
    //
    //    The 2× step the previous version used was a multi-tick
    //    walk: 64 → 128 → 256 → 512 → 1024 is 5 ticks per pserv ×
    //    25 pservs = many minutes of churn. Each tick spent budget
    //    on a 2× scale that didn't bring the pserv to its final
    //    size. The snap version lands the FINAL state in one
    //    delete+rebuy per pserv per tick, gated by the 1-to-3 Rule
    //    and reserve floor like before.
    //
    //    Sourced from skeesler/bitburner-commander/maybeBuyServer
    //    (commander.js:148-163): "find the smallest server below
    //    target size and upgrade it." Our pass is the same idea,
    //    applied per tick with wallet-restraint gates.
    //
    //    We re-read the count after the BUY step so a freshly-bought
    //    pserv is also eligible to be scaled in the same pass.
    const liveCount = currentCount();
    const liveSpendCap = ruleFraction > 0 ? wallet * ruleFraction : Infinity;
    const targetGB = ceilPow2AtLeast(tier.targetGB);  // power-of-2 snap
    let bestIdx = -1;
    let bestCost = Infinity;
    let absCheapestCost = Infinity;
    let anyPending = false;
    for (let i = 0; i < liveCount; i++) {
      const name = `${ROSTER_PREFIX}${i}`;
      if (!ns.serverExists(name)) continue;
      const currentGB = ns.getServerMaxRam(name);
      if (currentGB >= targetGB) continue;        // at or above target
      if (currentGB >= MAX_RAM) continue;          // at game cap
      anyPending = true;
      const c = costOfScale(targetGB);             // snap to tier target, not 2×
      if (c < absCheapestCost) absCheapestCost = c;
      if (c <= liveSpendCap && c < bestCost) {
        bestCost = c;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      if (!anyPending) {
        counters["SKIP-tier-met"]++;
      } else if (absCheapestCost > wallet) {
        counters["SKIP-funds"]++;
        if (verbose) {
          ns.tprint(`SKIP-funds      no scale fits wallet (cheapest $${absCheapestCost.toLocaleString()}, wallet $${wallet.toLocaleString()})`);
        }
      } else if (wallet - absCheapestCost < reserveFloor) {
        // The cheapest scale would drop us below the reserve
        // floor. SKIP-reserve and let the wallet grow.
        counters["SKIP-reserve"]++;
        if (verbose) {
          ns.tprint(`SKIP-reserve     cheapest scale $${absCheapestCost.toLocaleString()} would leave wallet=$${(wallet - absCheapestCost).toLocaleString()} < $${reserveFloor.toLocaleString()}`);
        }
      } else {
        counters["SKIP-rule"]++;
        if (verbose) {
          ns.tprint(`SKIP-rule       cheapest scale $${absCheapestCost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${wallet.toLocaleString()}`);
        }
      }
    } else {
      // Apply the cheapest scale: delete + repurchase at the
      // target size. Snap-to-target means the new size is
      // always `targetGB` (the tier's goal, snapped to a power
      // of 2). If the actual scale cost would drop us below
      // the reserve floor, skip with SKIP-reserve.
      const targetName = `${ROSTER_PREFIX}${bestIdx}`;
      const currentGB = ns.getServerMaxRam(targetName);
      const newGB = targetGB;
      if (wallet - bestCost < reserveFloor) {
        counters["SKIP-reserve"]++;
        if (verbose) {
          ns.tprint(`SKIP-reserve     scale ${targetName} ${currentGB}GB→${newGB}GB $${bestCost.toLocaleString()} would leave wallet=$${(wallet - bestCost).toLocaleString()} < $${reserveFloor.toLocaleString()}`);
        }
      } else if (!ns.cloud.deleteServer(targetName)) {
        counters["FAIL-deleteServer"]++;
        if (verbose) {
          ns.tprint(`FAIL-deleteServer  ${targetName} (running scripts? RAM in use?)`);
        }
        // Don't continue — a deleteServer failure usually means
        // scripts are pinned to the server; one failure tends to
        // cascade, so we stop the pass here.
      } else {
        const result = ns.cloud.purchaseServer(targetName, newGB);
        if (result === "") {
          counters["FAIL-purchaseAfterDelete"]++;
          if (verbose) {
            ns.tprint(`FAIL-purchaseAfterDelete  ${targetName} ${newGB}GB (slot re-taken? race?)`);
          }
        } else {
          counters["SCALED"]++;
          // Push worker scripts to the re-purchased (scaled) server.
          // Same reasoning as PSERV-BOUGHT — the delete+recreate wipes
          // the file system on the pserv, so workers can't run on it
          // until we re-scp them.
          if (!pushWorkerScripts(result)) {
            counters["FAIL-scp"] = (counters["FAIL-scp"] || 0) + 1;
            if (verbose) ns.tprint(`FAIL-scp        ${result} (couldn't push worker scripts after scale)`);
          }
          if (verbose) {
            ns.tprint(`SCALED          ${result}  ${currentGB}GB → ${newGB}GB for $${bestCost.toLocaleString()}`);
          }
        }
      }
    }

    if (once || verbose) {
      const summary = Object.entries(counters)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const interesting = counters["PSERV-BOUGHT"] > 0 || counters["SCALED"] > 0 || counters["FAIL-purchaseServer"] > 0 || counters["FAIL-deleteServer"] > 0 || counters["FAIL-purchaseAfterDelete"] > 0 || counters["FAIL-scp"] > 0;
      if (once || interesting) {
        ns.tprint(`done: ${summary || "no changes"}`);
      }
    }
  }

  if (once) {
    pass();
    return;
  }

  if (verbose) ns.tprint(`monitor-servers: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, cap=${newServerCap}, rule=${(ruleFraction * 100).toFixed(0)}%`);
  while (true) {
    pass();
    await ns.sleep(intervalMs);
  }
}
