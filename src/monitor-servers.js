/** @param {NS} ns */
//
// monitor-servers.js — long-lived daemon that progressively buys and
// RAM-scales purchased servers along the "Purchased-Server RAM Tier"
// target table:
//
//   tier            roster count    target RAM (GB), per-server
//   ------------    ------------    -----------------------
//   bootstrap       0..8            64    (cheap to fill the slot)
//   sweet-spot      9..20           1024  (1 TB — same as home, useful for fan-out)
//   soft-cap        21..25          4096  (4 TB — only hit via automation)
//
// We don't try to scale one server all the way to the cap before
// moving on. Instead, every tick we pick the CHEAPEST next purchase
// (a new pserv slot at the current tier's target RAM, OR a 2× RAM
// upgrade on an existing under-target server) and apply it. This
// keeps the whole fleet moving in lockstep and stops the per-server
// cost curve (each 2× scales cost by 6×) from outpacing the wallet.
//
// The roster is fixed at the game's 25-server cap (ns.cloud.getServerLimit in 3.0.0).
// Names are pserv-0..pserv-24. We never rename — a 2× upgrade is
// deleteServer + purchaseServer at the new size. The lost scripts
// and tmp data on a delete is a non-issue at this stage of the game
// (the worker scripts get re-fanned by monitor-deploy.js, and the
// orchestrator already lives on home).
//
// "soft-cap" tier only activates at > 20 pservs, and only if cash
// flow supports it. The 4 TB target is the BN-1 game hard-cap on
// the cheap curve (4 TB × $55k/GB ≈ $230B, well past 1 TB home but
// reachable at 1+ TB cash). Hit this tier only when automation is
// keeping the wallet topped up.
//
// Output is QUIET by default — only PSERV-BOUGHT / SCALED / fail
// summary lines print. --verbose re-enables per-tick budget and
// per-server target state. --once runs a single upgrade pass and
// exits (full output).
//
// Usage:
//   run monitor-servers.js                     # loop, every 60s, QUIET
//   run monitor-servers.js --once              # one pass, full output, then exit
//   run monitor-servers.js --interval 30000    # loop, every 30s, QUIET
//   run monitor-servers.js --verbose           # loop, per-tick budget + per-server targets
//   run monitor-servers.js --cap 25            # stop buying new pservs at 25 (default 25, game cap)
//   run monitor-servers.js --rule 0.10         # max 10% of wallet per purchase (default 0.10)
//
// Implements the same "1-to-10 Rule" as monitor-hacknet.js: never
// spend more than 10% of liquid cash on a single purchase (a new
// pserv OR a 2× RAM upgrade). Anything more is treated as
// SKIP-rule10 and we wait for the wallet to grow. This protects
// the main economy — money that should be going to Home RAM
// upgrades, hacking contracts, or augs. Set --rule 0 to disable
// (e.g. for endgame max-out).
//
const USAGE = `Usage:
  run monitor-servers.js                     # loop, every 60s, QUIET
  run monitor-servers.js --once              # one pass, full output, then exit
  run monitor-servers.js --interval 30000    # loop, every 30s, QUIET
  run monitor-servers.js --verbose           # loop, per-tick budget + per-server targets
  run monitor-servers.js --cap 25            # stop buying new pservs at 25 (default 25, game cap)
  run monitor-servers.js --rule 0.10         # max 10% of wallet per purchase (default 0.10)
`;

// Tier table. order matters: the FIRST tier whose roster range
// contains the current count is the active tier. Add a new tier by
// dropping it in at the top of the array.
//
// Cost math: at 64 GB the per-pserv cost is $3.52M (64 × $55k).
// At 1 TB the per-pserv cost is $57.7B. At 4 TB it's $230B. The
// 1-to-10 Rule means we wait for the wallet to grow before each
// step, so the 4 TB tier is only hit when the wallet is ~$2.3T+.
// BN-1 ends well before that, but the soft-cap is reachable with
// patience.
const TIERS = [
  { name: "bootstrap",  minRoster: 0,  maxRoster: 8,  targetGB: 64 },
  { name: "sweet-spot", minRoster: 8,  maxRoster: 20, targetGB: 1024 },
  { name: "soft-cap",   minRoster: 20, maxRoster: 25, targetGB: 4096 },
];

const SOURCE = "home";
const ROSTER_PREFIX = "pserv-";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NEW_SERVER_CAP = 25;     // tier guide: 25 = game cap; mid-game sweet spot is 25
const MAX_ROSTER = 25;                 // hard cap from ns.cloud.getServerLimit()
const MAX_RAM = 2 ** 20;               // 1,048,576 GB — game hard cap
const DEFAULT_RULE = 0.10;             // 1-to-10 Rule
const MIN_RULE = 0.0;
const MAX_RULE = 1.0;
const ROSTER_WALK_LIMIT = 200;         // safety bound; one pass shouldn't loop forever

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

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("scan");

  // --- helpers ---

  // Active tier for a given current roster count.
  function activeTier(count) {
    for (const t of TIERS) {
      if (count >= t.minRoster && count < t.maxRoster) return t;
    }
    // Past the last tier (the game cap is 25 which is exactly
    // soft-cap's maxRoster, so we fall through to the last entry).
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

  // Cost of scaling a server from `currentGB` to 2× currentGB.
  // deleteServer + purchaseServer (the API has no in-place upgrade).
  function costOfDouble(currentGB) {
    return ns.cloud.getServerCost(Math.min(currentGB * 2, MAX_RAM));
  }

  // --- one pass ---

  function pass() {
    const counters = {
      "PSERV-BOUGHT": 0,
      "SCALED": 0,
      "SKIP-cap": 0,
      "SKIP-tier-met": 0,
      "SKIP-funds": 0,
      "SKIP-rule10": 0,
      "FAIL-purchaseServer": 0,
      "FAIL-deleteServer": 0,
      "FAIL-purchaseAfterDelete": 0,
    };

    const count = currentCount();
    const tier = activeTier(count);
    if (verbose) {
      ns.tprint(`monitor-servers: tier=${tier.name} (${tier.minRoster}-${tier.maxRoster}) target=${tier.targetGB}GB cap=${newServerCap} rule=${(ruleFraction * 100).toFixed(0)}%`);
    }

    // 1. Buy a new pserv at the tier's target RAM if we have headroom.
    //    We never buy a new server below the tier target — every
    //    fresh pserv lands at the active tier's spec.
    if (count < newServerCap && count < MAX_ROSTER) {
      const slot = firstMissingSlot();
      if (slot >= 0) {
        const name = `${ROSTER_PREFIX}${slot}`;
        const cost = ns.cloud.getServerCost(tier.targetGB);
        const money = ns.getServerMoneyAvailable(SOURCE);
        const cap10 = money * ruleFraction;
        if (ruleFraction > 0 && cost > cap10) {
          counters["SKIP-rule10"]++;
          if (verbose) {
            ns.tprint(`SKIP-rule10     new ${name} ${tier.targetGB}GB $${cost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${money.toLocaleString()}`);
          }
        } else if (cost > money) {
          counters["SKIP-funds"]++;
          if (verbose) {
            ns.tprint(`SKIP-funds      no new ${name} (need $${cost.toLocaleString()}, have $${money.toLocaleString()})`);
          }
        } else {
          const result = ns.cloud.purchaseServer(name, tier.targetGB);
          if (result !== "") {
            counters["PSERV-BOUGHT"]++;
            // PSERV-BOUGHT is the interesting event; always print even
            // in quiet mode. Matches monitor-hacknet's NODE-BOUGHT
            // behavior.
            ns.tprint(`PSERV-BOUGHT    ${result} ${tier.targetGB}GB for $${cost.toLocaleString()} (now ${count + 1}/${MAX_ROSTER})`);
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

    // 2. Walk every existing pserv and apply the cheapest pending
    //    2× upgrade. Same pattern as monitor-hacknet: cheapest
    //    candidate first, 1-to-10 Rule gates it, no looping over
    //    the wallet.
    //
    //    We re-read the count after the BUY step so a freshly-bought
    //    pserv is also eligible to be scaled in the same pass.
    const liveCount = currentCount();
    const spendCap = ruleFraction > 0 ? ns.getServerMoneyAvailable(SOURCE) * ruleFraction : Infinity;
    const moneyNow = ns.getServerMoneyAvailable(SOURCE);

    for (let step = 0; step < ROSTER_WALK_LIMIT; step++) {
      const money = ns.getServerMoneyAvailable(SOURCE);
      const liveSpendCap = ruleFraction > 0 ? money * ruleFraction : Infinity;
      let bestIdx = -1;
      let bestCost = Infinity;
      let absCheapestCost = Infinity;
      let anyPending = false;
      for (let i = 0; i < liveCount; i++) {
        const name = `${ROSTER_PREFIX}${i}`;
        if (!ns.serverExists(name)) continue;
        const currentGB = ns.getServerMaxRam(name);
        if (currentGB >= tier.targetGB) continue;     // at or above target
        if (currentGB >= MAX_RAM) continue;            // at game cap
        anyPending = true;
        const c = costOfDouble(currentGB);
        if (c < absCheapestCost) absCheapestCost = c;
        if (c <= liveSpendCap && c < bestCost) {
          bestCost = c;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        if (!anyPending) {
          counters["SKIP-tier-met"]++;
        } else if (absCheapestCost > money) {
          counters["SKIP-funds"]++;
          if (verbose) {
            ns.tprint(`SKIP-funds      no scale fits wallet (cheapest $${absCheapestCost.toLocaleString()}, wallet $${money.toLocaleString()})`);
          }
        } else {
          counters["SKIP-rule10"]++;
          if (verbose) {
            ns.tprint(`SKIP-rule10     cheapest scale $${absCheapestCost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${money.toLocaleString()}`);
          }
        }
        break;
      }
      // Apply the cheapest scale: delete + repurchase at 2× RAM.
      const targetName = `${ROSTER_PREFIX}${bestIdx}`;
      const currentGB = ns.getServerMaxRam(targetName);
      const newGB = Math.min(currentGB * 2, MAX_RAM);
      if (!ns.cloud.deleteServer(targetName)) {
        counters["FAIL-deleteServer"]++;
        if (verbose) {
          ns.tprint(`FAIL-deleteServer  ${targetName} (running scripts? RAM in use?)`);
        }
        // Don't break — try the next candidate. But a deleteServer
        // failure usually means scripts are pinned to the server;
        // one failure tends to cascade, so we break to be safe.
        break;
      }
      const result = ns.cloud.purchaseServer(targetName, newGB);
      if (result === "") {
        counters["FAIL-purchaseAfterDelete"]++;
        if (verbose) {
          ns.tprint(`FAIL-purchaseAfterDelete  ${targetName} ${newGB}GB (slot re-taken? race?)`);
        }
        // We've already lost the old server; bail and let the next
        // tick re-evaluate. No point continuing to spend a wallet
        // that just lost a server's worth of value.
        break;
      }
      counters["SCALED"]++;
      if (verbose) {
        ns.tprint(`SCALED          ${result}  ${currentGB}GB → ${newGB}GB for $${bestCost.toLocaleString()}`);
      }
    }

    if (once || verbose) {
      const summary = Object.entries(counters)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const interesting = counters["PSERV-BOUGHT"] > 0 || counters["SCALED"] > 0 || counters["FAIL-purchaseServer"] > 0 || counters["FAIL-deleteServer"] > 0 || counters["FAIL-purchaseAfterDelete"] > 0;
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
