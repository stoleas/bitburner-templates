/** @param {NS} ns */
//
// Long-lived daemon that progressively upgrades Hacknet Nodes along
// the "Hacking Tier" target table:
//
//   tier            numNodes range    target (level, ram GB, cores)
//   ------------    --------------    ---------------------------
//   bootstrap       1..8              50, 8, 2
//   sweet-spot      9..20             100, 64, 4
//   soft-cap        21..30            150, 64, 4  (only hit via automation)
//
// We don't try to push one node all the way to the cap before moving
// on. Instead, every tick we pick the CHEAPEST next upgrade across
// all nodes (subject to the 1-to-10 Rule below) and apply it. This
// keeps the whole fleet moving in lockstep and stops the per-node
// cost curve from ever outpacing your wallet.
//
// RAM is uncapped below the 64 GB game hard-cap on purpose: 64 GB
// unlocks the full set of hash upgrades and is a major production
// boost. Bootstrap stays at 8 GB so the early-game economy isn't
// blown on RAM before the wallet can afford it.
//
// The "soft cap" tier only activates at numNodes > 20, and even then
// the targets are the same as sweet-spot — 150/64/4 — so the script
// never tries to push a single node into 5-figure levels. The reason
// to own 21-30 nodes at all is the production multiplier from having
// more nodes, not per-node level. Hit this tier only when automation
// is keeping the wallet topped up.
//
// Endgame (BN-9): after destroying BitNode-9, Hacknet Nodes become
// "Hacknet Servers" that produce hashes, not money. The upgrade API
// (ns.hacknet.upgrade*) is unchanged but the cost/benefit inverts.
// This script does NOT automate hash upgrades — the strategy then
// is to push EVERY server to its caps, not to spread upgrades across
// the fleet. Treat this script as a BN-1..8 tool and rewrite or
// disable it once BN-9 unlocks.
//
// Output is QUIET by default — only upgrade-purchased / node-bought
// / fail-summary lines print. --verbose re-enables per-tick budget
// and per-node target state. --once runs a single upgrade pass and
// exits (full output).
//
// Usage:
//   run monitor-hacknet.js                     # loop, every 60s, QUIET
//   run monitor-hacknet.js --once              # one pass, full output, then exit
//   run monitor-hacknet.js --interval 30000    # loop, every 30s, QUIET
//   run monitor-hacknet.js --verbose           # loop, per-tick budget + per-node targets
//   run monitor-hacknet.js --cap 30            # stop buying new nodes at 30 (default 15)
//   run monitor-hacknet.js --rule 0.10         # max 10% of wallet per purchase (default 0.10)
//
// Implements the "1-to-10 Rule" from the tier guide: never spend more
// than 10% of liquid cash on a single Hacknet purchase (a new node OR
// one upgrade). Anything more is treated as SKIP-rule10 and we wait
// for the wallet to grow. This protects the main economy — money
// that should be going to Home RAM / hacking infrastructure. Set
// --rule 0 to disable the rule (e.g. for endgame max-out).
//
const USAGE = `Usage:
  run monitor-hacknet.js                     # loop, every 60s, QUIET
  run monitor-hacknet.js --once              # one pass, full output, then exit
  run monitor-hacknet.js --interval 30000    # loop, every 30s, QUIET
  run monitor-hacknet.js --verbose           # loop, per-tick budget + per-node targets
  run monitor-hacknet.js --cap 30            # stop buying new nodes at 30 (default 15)
  run monitor-hacknet.js --rule 0.10         # max 10% of wallet per purchase (default 0.10)
`;

// Tier table. order matters: the FIRST tier whose numNodes range
// contains the current count is the active tier. Add a new tier by
// dropping it in at the top of the array — the script picks it up
// automatically.
//
// Per the spec: bootstrap = L50, 8GB, 2 cores. sweet-spot = L100-150,
// 16-32GB, 4 cores. We pick the MIDDLE of the "100-150" range (100)
// and the UPPER end of the RAM ranges (32GB) so each upgrade is
// meaningful and we don't burn money climbing a level just to drop
// the same wallet on the next node.
//
// No RAM softcap: 64GB unlocks the full set of hash upgrades
// (Company Buyback, Reduce Minimum Security, etc.) and is a huge
// production boost, so the script always targets the next power of 2
// up to 64GB. The game hard-caps Hacknet Node RAM at 64GB.
const TIERS = [
  { name: "bootstrap",  minNodes: 0,  maxNodes: 8,  level: 50,  ramGB: 8,  cores: 2 },
  { name: "sweet-spot", minNodes: 8,  maxNodes: 20, level: 100, ramGB: 64, cores: 4 },
  { name: "soft-cap",   minNodes: 20, maxNodes: 30, level: 150, ramGB: 64, cores: 4 },
];

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NEW_NODE_CAP = 15;  // tier guide: "keep it around 15 nodes" for early/mid game
const MAX_NODE_INDEX = 30; // hard cap from ns.hacknet.maxNumNodes()
const DEFAULT_RULE = 0.10;  // 1-to-10 Rule: max 10% of wallet per single purchase
const MIN_RULE = 0.0;       // 0 = disabled (only check absolute affordability)
const MAX_RULE = 1.0;       // 1 = "no rule, spend whatever"; sane upper bound

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }

  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const capIdx = args.indexOf("--cap");
  const newNodeCap = capIdx >= 0
    ? Math.max(0, Math.min(MAX_NODE_INDEX, Number(args[capIdx + 1])))
    : DEFAULT_NEW_NODE_CAP;
  if (capIdx >= 0 && (!Number.isFinite(newNodeCap) || newNodeCap < 0)) {
    ns.tprint(`monitor-hacknet: --cap must be a number 0..${MAX_NODE_INDEX} (got ${args[capIdx + 1]})`);
    return;
  }
  const ruleIdx = args.indexOf("--rule");
  const ruleFraction = ruleIdx >= 0
    ? Number(args[ruleIdx + 1])
    : DEFAULT_RULE;
  if (ruleIdx >= 0 && (!Number.isFinite(ruleFraction) || ruleFraction < MIN_RULE || ruleFraction > MAX_RULE)) {
    ns.tprint(`monitor-hacknet: --rule must be a number ${MIN_RULE}..${MAX_RULE} (got ${args[ruleIdx + 1]})`);
    return;
  }
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0
    ? Number(args[intervalIdx + 1])
    : DEFAULT_INTERVAL_MS;
  if (intervalIdx >= 0 && (!Number.isFinite(intervalMs) || intervalMs < 0)) {
    ns.tprint(`monitor-hacknet: --interval must be a non-negative number (got ${args[intervalIdx + 1]})`);
    return;
  }

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("scan");

  // One upgrade pass: buy a new node if we're under the tier's
  // preferred count, then walk every node once and apply the cheapest
  // pending upgrade. Stops when the wallet can't cover the next
  // purchase (we'd just spam FAIL-funds lines otherwise).
  function pass() {
    const counters = {
      "NODE-BOUGHT": 0,
      "BOUGHT": 0,
      "BOUGHT-level": 0,
      "BOUGHT-ram": 0,
      "BOUGHT-core": 0,
      "SKIP-cap": 0,
      "SKIP-tier-met": 0,
      "SKIP-funds": 0,
      "SKIP-rule10": 0,
      "FAIL-purchaseNode": 0,
      "FAIL-upgrade": 0,
    };

    const tier = activeTier();
    if (verbose) {
      ns.tprint(`monitor-hacknet: tier=${tier.name} (${tier.minNodes}-${tier.maxNodes}) target=L${tier.level}/R${tier.ramGB}GB/C${tier.cores} cap=${newNodeCap} rule=${(ruleFraction * 100).toFixed(0)}%`);
    }

    // 1. Buy a new node if we have headroom.
    const numNodes = ns.hacknet.numNodes();
    const maxNodes = ns.hacknet.maxNumNodes();
    if (numNodes < newNodeCap && numNodes < maxNodes) {
      const cost = ns.hacknet.getPurchaseNodeCost();
      const money = ns.getServerMoneyAvailable("home");
      // 1-to-10 Rule: per-purchase cap as a fraction of liquid cash.
      // Distinct from SKIP-funds (wallet literally < cost) — here the
      // wallet CAN afford it, but spending that much would starve the
      // main economy. We wait for the wallet to grow.
      const cap10 = money * ruleFraction;
      if (ruleFraction > 0 && cost > cap10) {
        counters["SKIP-rule10"]++;
        if (verbose) {
          ns.tprint(`SKIP-rule10     new node $${cost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${money.toLocaleString()} (would leave $${(money - cost).toLocaleString()})`);
        }
      } else if (ns.hacknet.purchaseNode() !== -1) {
        counters["NODE-BOUGHT"]++;
        // NODE-BOUGHT is the interesting event; always print even in
        // quiet mode. The cost is reported for context.
        ns.tprint(`NODE-BOUGHT     new node for $${cost.toLocaleString()} (now ${numNodes + 1}/${maxNodes})`);
      } else {
        // purchaseNode returns -1 when the player can't afford it. The
        // most likely reason is "no spare money" — not a bug.
        counters["FAIL-purchaseNode"]++;
        if (verbose) {
          ns.tprint(`SKIP-funds      no new node (need $${cost.toLocaleString()})`);
        }
      }
    } else if (numNodes >= newNodeCap) {
      counters["SKIP-cap"]++;
      if (verbose) ns.tprint(`SKIP-cap        at new-node cap (${numNodes}/${newNodeCap})`);
    } else if (numNodes >= maxNodes) {
      counters["SKIP-cap"]++;
      if (verbose) ns.tprint(`SKIP-cap        at game cap (${numNodes}/${maxNodes})`);
    }

    // 2. Walk every node and apply the cheapest next upgrade.
    //    Loop until either the wallet can't cover the next buy, the
    //    1-to-10 Rule blocks it, or every node has hit the tier's
    //    targets. The tier-relative target means a freshly-bought node
    //    immediately gets brought up to spec on the same pass (cheap
    //    upgrades all the way through).
    const targets = tierTargets(tier);
    // After we buy a new node on this pass, the new node should ALSO
    // be brought up to spec. The actual count we walk is the live
    // count, which already includes any NODE-BOUGHT from above.
    const walletWalkLimit = 200; // safety bound; one pass shouldn't loop forever
    for (let step = 0; step < walletWalkLimit; step++) {
      const money = ns.getServerMoneyAvailable("home");
      // 1-to-10 Rule ceiling for this tick. 0 disables the rule.
      const spendCap = ruleFraction > 0 ? money * ruleFraction : Infinity;
      // Track two cheapest-upgrade candidates in parallel: the
      // absolute cheapest (used to disambiguate "rule10" from
      // "funds"), and the cheapest that also fits under the rule.
      let bestIdx = -1;
      let bestKind = null;
      let bestCost = Infinity;
      let absCheapestCost = Infinity; // for the disambiguation
      let anyPending = false;
      for (let i = 0; i < ns.hacknet.numNodes(); i++) {
        const s = ns.hacknet.getNodeStats(i);
        if (s.level < targets.level) {
          anyPending = true;
          const c = ns.hacknet.getLevelUpgradeCost(i, 1);
          if (c < absCheapestCost) absCheapestCost = c;
          if (c <= spendCap && c < bestCost) { bestCost = c; bestIdx = i; bestKind = "level"; }
        }
        if (s.ram < targets.ramGB) {
          anyPending = true;
          const c = ns.hacknet.getRamUpgradeCost(i, 1);
          if (c < absCheapestCost) absCheapestCost = c;
          if (c <= spendCap && c < bestCost) { bestCost = c; bestIdx = i; bestKind = "ram"; }
        }
        if (s.cores < targets.cores) {
          anyPending = true;
          const c = ns.hacknet.getCoreUpgradeCost(i, 1);
          if (c < absCheapestCost) absCheapestCost = c;
          if (c <= spendCap && c < bestCost) { bestCost = c; bestIdx = i; bestKind = "core"; }
        }
      }
      if (bestIdx < 0) {
        if (!anyPending) {
          counters["SKIP-tier-met"]++;
        } else if (absCheapestCost > money) {
          // No upgrade fits the wallet at all — even with the rule
          // off, the cheapest one is unaffordable. The rule didn't
          // cause this skip; report it as funds.
          counters["SKIP-funds"]++;
          if (verbose) {
            ns.tprint(`SKIP-funds      no upgrade fits wallet (cheapest $${absCheapestCost.toLocaleString()}, wallet $${money.toLocaleString()})`);
          }
        } else {
          // Wallet can afford the cheapest, but the rule blocks it.
          counters["SKIP-rule10"]++;
          if (verbose) {
            ns.tprint(`SKIP-rule10     cheapest upgrade $${absCheapestCost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${money.toLocaleString()}`);
          }
        }
        break;
      }
      // Buy the cheapest pending upgrade on bestIdx. We do level / ram
      // / core in their own switch so the event label is exact.
      let ok = false;
      if (bestKind === "level") ok = ns.hacknet.upgradeLevel(bestIdx, 1);
      else if (bestKind === "ram") ok = ns.hacknet.upgradeRam(bestIdx, 1);
      else if (bestKind === "core") ok = ns.hacknet.upgradeCore(bestIdx, 1);
      if (!ok) {
        // upgrade* returns false on insufficient funds OR on hitting
        // the per-stat max. We pre-checked funds, so it's a max hit —
        // mark the target as met by re-running the loop (the condition
        // is now < targets.X, which is still true, so we'd loop
        // forever). Bail and let the next tick re-evaluate.
        counters["FAIL-upgrade"]++;
        if (verbose) {
          ns.tprint(`FAIL-upgrade    node-${bestIdx} ${bestKind} returned false (max hit? funds race?)`);
        }
        break;
      }
      counters["BOUGHT"]++;
      counters[`BOUGHT-${bestKind}`]++;
      // BOUGHT is the per-upgrade event. We only print a compact line
      // in verbose mode; quiet mode aggregates into the summary.
      if (verbose) {
        const s = ns.hacknet.getNodeStats(bestIdx);
        ns.tprint(`BOUGHT-${bestKind.padEnd(5)} node-${bestIdx}  $${bestCost.toLocaleString()}  -> L${s.level}/R${s.ram}/C${s.cores}`);
      }
    }

    if (once || verbose) {
      const summary = Object.entries(counters)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      // In quiet mode, suppress the summary line when nothing
      // interesting happened (no NODE-BOUGHT, no BOUGHT, no FAIL-).
      // --once always wants the full report.
      const interesting = counters["NODE-BOUGHT"] > 0 || counters["BOUGHT"] > 0 || counters["FAIL-upgrade"] > 0 || counters["FAIL-purchaseNode"] > 0;
      if (once || interesting) {
        ns.tprint(`done: ${summary || "no changes"}`);
      }
    }
  }

  function activeTier() {
    const n = ns.hacknet.numNodes();
    for (const t of TIERS) {
      if (n >= t.minNodes && n < t.maxNodes) return t;
    }
    // Past the last tier's maxNodes (e.g. 30+ which the game
    // disallows, but be defensive): stay on the last tier.
    return TIERS[TIERS.length - 1];
  }

  // Tier-relative target for the *current* node count. The spec says
  // bootstrap applies up to 8 nodes, sweet-spot 10-20, etc. We treat
  // the count itself as the tier key, so the target doesn't change
  // mid-pass.
  function tierTargets(tier) {
    return { level: tier.level, ramGB: tier.ramGB, cores: tier.cores };
  }

  if (once) {
    pass();
    return;
  }

  ns.tprint(`monitor-hacknet: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, cap=${newNodeCap}, rule=${(ruleFraction * 100).toFixed(0)}%`);
  while (true) {
    pass();
    await ns.sleep(intervalMs);
  }
}
