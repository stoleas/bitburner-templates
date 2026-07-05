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
// 16-32GB, 4 cores. We pick the UPPER end of the "100-150" range (150)
// and the UPPER end of the RAM ranges (32GB) so each upgrade is
// meaningful and we don't burn money climbing a level just to drop
// the same wallet on the next node.
//
// No RAM softcap: 64GB unlocks the full set of hash upgrades
// (Company Buyback, Reduce Minimum Security, etc.) and is a huge
// production boost, so the script always targets the next power of 2
// up to 64GB. The game hard-caps Hacknet Node RAM at 64GB.
const TIERS = [
    { name: "bootstrap", minNodes: 0, maxNodes: 8, level: 50, ramGB: 8, cores: 2 },
    { name: "sweet-spot", minNodes: 8, maxNodes: 20, level: 150, ramGB: 64, cores: 4 },
    { name: "soft-cap", minNodes: 20, maxNodes: 30, level: 150, ramGB: 64, cores: 4 },
];
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NEW_NODE_CAP = 15; // tier guide: "keep it around 15 nodes" for early/mid game
const MAX_NODE_INDEX = 30; // hard cap from ns.hacknet.maxNumNodes()
const DEFAULT_RULE = 0.10; // 1-to-10 Rule: max 10% of wallet per single purchase
const MIN_RULE = 0.0; // 0 = disabled (only check absolute affordability)
const MAX_RULE = 1.0; // 1 = "no rule, spend whatever"; sane upper bound
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
            }
            else if (ns.hacknet.purchaseNode() !== -1) {
                counters["NODE-BOUGHT"]++;
                // NODE-BOUGHT is the interesting event; always print even in
                // quiet mode. The cost is reported for context.
                ns.tprint(`NODE-BOUGHT     new node for $${cost.toLocaleString()} (now ${numNodes + 1}/${maxNodes})`);
            }
            else {
                // purchaseNode returns -1 when the player can't afford it. The
                // most likely reason is "no spare money" — not a bug.
                counters["FAIL-purchaseNode"]++;
                if (verbose) {
                    ns.tprint(`SKIP-funds      no new node (need $${cost.toLocaleString()})`);
                }
            }
        }
        else if (numNodes >= newNodeCap) {
            counters["SKIP-cap"]++;
            if (verbose)
                ns.tprint(`SKIP-cap        at new-node cap (${numNodes}/${newNodeCap})`);
        }
        else if (numNodes >= maxNodes) {
            counters["SKIP-cap"]++;
            if (verbose)
                ns.tprint(`SKIP-cap        at game cap (${numNodes}/${maxNodes})`);
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
                    if (c < absCheapestCost)
                        absCheapestCost = c;
                    if (c <= spendCap && c < bestCost) {
                        bestCost = c;
                        bestIdx = i;
                        bestKind = "level";
                    }
                }
                if (s.ram < targets.ramGB) {
                    anyPending = true;
                    const c = ns.hacknet.getRamUpgradeCost(i, 1);
                    if (c < absCheapestCost)
                        absCheapestCost = c;
                    if (c <= spendCap && c < bestCost) {
                        bestCost = c;
                        bestIdx = i;
                        bestKind = "ram";
                    }
                }
                if (s.cores < targets.cores) {
                    anyPending = true;
                    const c = ns.hacknet.getCoreUpgradeCost(i, 1);
                    if (c < absCheapestCost)
                        absCheapestCost = c;
                    if (c <= spendCap && c < bestCost) {
                        bestCost = c;
                        bestIdx = i;
                        bestKind = "core";
                    }
                }
            }
            if (bestIdx < 0) {
                if (!anyPending) {
                    counters["SKIP-tier-met"]++;
                }
                else if (absCheapestCost > money) {
                    // No upgrade fits the wallet at all — even with the rule
                    // off, the cheapest one is unaffordable. The rule didn't
                    // cause this skip; report it as funds.
                    counters["SKIP-funds"]++;
                    if (verbose) {
                        ns.tprint(`SKIP-funds      no upgrade fits wallet (cheapest $${absCheapestCost.toLocaleString()}, wallet $${money.toLocaleString()})`);
                    }
                }
                else {
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
            if (bestKind === "level")
                ok = ns.hacknet.upgradeLevel(bestIdx, 1);
            else if (bestKind === "ram")
                ok = ns.hacknet.upgradeRam(bestIdx, 1);
            else if (bestKind === "core")
                ok = ns.hacknet.upgradeCore(bestIdx, 1);
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
            if (n >= t.minNodes && n < t.maxNodes)
                return t;
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
    if (verbose)
        ns.tprint(`monitor-hacknet: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, cap=${newNodeCap}, rule=${(ruleFraction * 100).toFixed(0)}%`);
    while (true) {
        pass();
        await ns.sleep(intervalMs);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1oYWNrbmV0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21vbml0b3ItaGFja25ldC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLG9FQUFvRTtBQUNwRSxtQ0FBbUM7QUFDbkMsRUFBRTtBQUNGLG9FQUFvRTtBQUNwRSxrRUFBa0U7QUFDbEUsK0NBQStDO0FBQy9DLGlEQUFpRDtBQUNqRCw0RUFBNEU7QUFDNUUsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxtRUFBbUU7QUFDbkUsbUVBQW1FO0FBQ25FLGtFQUFrRTtBQUNsRSw4Q0FBOEM7QUFDOUMsRUFBRTtBQUNGLGtFQUFrRTtBQUNsRSxrRUFBa0U7QUFDbEUsaUVBQWlFO0FBQ2pFLGdEQUFnRDtBQUNoRCxFQUFFO0FBQ0YscUVBQXFFO0FBQ3JFLG9FQUFvRTtBQUNwRSxxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLHFFQUFxRTtBQUNyRSxtQ0FBbUM7QUFDbkMsRUFBRTtBQUNGLG1FQUFtRTtBQUNuRSxvRUFBb0U7QUFDcEUsbUVBQW1FO0FBQ25FLGtFQUFrRTtBQUNsRSxxRUFBcUU7QUFDckUsZ0VBQWdFO0FBQ2hFLGdDQUFnQztBQUNoQyxFQUFFO0FBQ0Ysb0VBQW9FO0FBQ3BFLG1FQUFtRTtBQUNuRSxtRUFBbUU7QUFDbkUsdUJBQXVCO0FBQ3ZCLEVBQUU7QUFDRixTQUFTO0FBQ1Qsd0VBQXdFO0FBQ3hFLGtGQUFrRjtBQUNsRix3RUFBd0U7QUFDeEUsMEZBQTBGO0FBQzFGLDBGQUEwRjtBQUMxRiwrRkFBK0Y7QUFDL0YsRUFBRTtBQUNGLHNFQUFzRTtBQUN0RSxzRUFBc0U7QUFDdEUsb0VBQW9FO0FBQ3BFLGlFQUFpRTtBQUNqRSxpRUFBaUU7QUFDakUsMkRBQTJEO0FBQzNELEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7Ozs7OztDQU9iLENBQUM7QUFFRixpRUFBaUU7QUFDakUsbUVBQW1FO0FBQ25FLGtFQUFr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TyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDckUsQ0FBQztJQUVELElBQUksSUFBSSxFQUFFO1FBQ1IsSUFBSSxFQUFFLENBQUM7UUFDUCxPQUFPO0tBQ1I7SUFFRCxJQUFJLE9BQU87UUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLHNDQUFzQyxVQUFVLGNBQWMsT0FBTyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE9BQU8sU0FBUyxVQUFVLFVBQVUsQ0FBQyxZQUFZLEdBQUcsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNuTCxPQUFPLElBQUksRUFBRTtRQUNYLElBQUksRUFBRSxDQUFDO1FBQ1AsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0tBQzVCO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIExvbmctbGl2ZWQgZGFlbW9uIHRoYXQgcHJvZ3Jlc3NpdmVseSB1cGdyYWRlcyBIYWNrbmV0IE5vZGVzIGFsb25nXG4vLyB0aGUgXCJIYWNraW5nIFRpZXJcIiB0YXJnZXQgdGFibGU6XG4vL1xuLy8gICB0aWVyICAgICAgICAgICAgbnVtTm9kZXMgcmFuZ2UgICAgdGFyZ2V0IChsZXZlbCwgcmFtIEdCLCBjb3Jlcylcbi8vICAgLS0tLS0tLS0tLS0tICAgIC0tLS0tLS0tLS0tLS0tICAgIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gICBib290c3RyYXAgICAgICAgMS4uOCAgICAgICAgICAgICAgNTAsIDgsIDJcbi8vICAgc3dlZXQtc3BvdCAgICAgIDkuLjIwICAgICAgICAgICAgIDEwMCwgNjQsIDRcbi8vICAgc29mdC1jYXAgICAgICAgIDIxLi4zMCAgICAgICAgICAgIDE1MCwgNjQsIDQgIChvbmx5IGhpdCB2aWEgYXV0b21hdGlvbilcbi8vXG4vLyBXZSBkb24ndCB0cnkgdG8gcHVzaCBvbmUgbm9kZSBhbGwgdGhlIHdheSB0byB0aGUgY2FwIGJlZm9yZSBtb3Zpbmdcbi8vIG9uLiBJbnN0ZWFkLCBldmVyeSB0aWNrIHdlIHBpY2sgdGhlIENIRUFQRVNUIG5leHQgdXBncmFkZSBhY3Jvc3Ncbi8vIGFsbCBub2RlcyAoc3ViamVjdCB0byB0aGUgMS10by0xMCBSdWxlIGJlbG93KSBhbmQgYXBwbHkgaXQuIFRoaXNcbi8vIGtlZXBzIHRoZSB3aG9sZSBmbGVldCBtb3ZpbmcgaW4gbG9ja3N0ZXAgYW5kIHN0b3BzIHRoZSBwZXItbm9kZVxuLy8gY29zdCBjdXJ2ZSBmcm9tIGV2ZXIgb3V0cGFjaW5nIHlvdXIgd2FsbGV0LlxuLy9cbi8vIFJBTSBpcyB1bmNhcHBlZCBiZWxvdyB0aGUgNjQgR0IgZ2FtZSBoYXJkLWNhcCBvbiBwdXJwb3NlOiA2NCBHQlxuLy8gdW5sb2NrcyB0aGUgZnVsbCBzZXQgb2YgaGFzaCB1cGdyYWRlcyBhbmQgaXMgYSBtYWpvciBwcm9kdWN0aW9uXG4vLyBib29zdC4gQm9vdHN0cmFwIHN0YXlzIGF0IDggR0Igc28gdGhlIGVhcmx5LWdhbWUgZWNvbm9teSBpc24ndFxuLy8gYmxvd24gb24gUkFNIGJlZm9yZSB0aGUgd2FsbGV0IGNhbiBhZmZvcmQgaXQuXG4vL1xuLy8gVGhlIFwic29mdCBjYXBcIiB0aWVyIG9ubHkgYWN0aXZhdGVzIGF0IG51bU5vZGVzID4gMjAsIGFuZCBldmVuIHRoZW5cbi8vIHRoZSB0YXJnZXRzIGFyZSB0aGUgc2FtZSBhcyBzd2VldC1zcG90IOKAlCAxNTAvNjQvNCDigJQgc28gdGhlIHNjcmlwdFxuLy8gbmV2ZXIgdHJpZXMgdG8gcHVzaCBhIHNpbmdsZSBub2RlIGludG8gNS1maWd1cmUgbGV2ZWxzLiBUaGUgcmVhc29uXG4vLyB0byBvd24gMjEtMzAgbm9kZXMgYXQgYWxsIGlzIHRoZSBwcm9kdWN0aW9uIG11bHRpcGxpZXIgZnJvbSBoYXZpbmdcbi8vIG1vcmUgbm9kZXMsIG5vdCBwZXItbm9kZSBsZXZlbC4gSGl0IHRoaXMgdGllciBvbmx5IHdoZW4gYXV0b21hdGlvblxuLy8gaXMga2VlcGluZyB0aGUgd2FsbGV0IHRvcHBlZCB1cC5cbi8vXG4vLyBFbmRnYW1lIChCTi05KTogYWZ0ZXIgZGVzdHJveWluZyBCaXROb2RlLTksIEhhY2tuZXQgTm9kZXMgYmVjb21lXG4vLyBcIkhhY2tuZXQgU2VydmVyc1wiIHRoYXQgcHJvZHVjZSBoYXNoZXMsIG5vdCBtb25leS4gVGhlIHVwZ3JhZGUgQVBJXG4vLyAobnMuaGFja25ldC51cGdyYWRlKikgaXMgdW5jaGFuZ2VkIGJ1dCB0aGUgY29zdC9iZW5lZml0IGludmVydHMuXG4vLyBUaGlzIHNjcmlwdCBkb2VzIE5PVCBhdXRvbWF0ZSBoYXNoIHVwZ3JhZGVzIOKAlCB0aGUgc3RyYXRlZ3kgdGhlblxuLy8gaXMgdG8gcHVzaCBFVkVSWSBzZXJ2ZXIgdG8gaXRzIGNhcHMsIG5vdCB0byBzcHJlYWQgdXBncmFkZXMgYWNyb3NzXG4vLyB0aGUgZmxlZXQuIFRyZWF0IHRoaXMgc2NyaXB0IGFzIGEgQk4tMS4uOCB0b29sIGFuZCByZXdyaXRlIG9yXG4vLyBkaXNhYmxlIGl0IG9uY2UgQk4tOSB1bmxvY2tzLlxuLy9cbi8vIE91dHB1dCBpcyBRVUlFVCBieSBkZWZhdWx0IOKAlCBvbmx5IHVwZ3JhZGUtcHVyY2hhc2VkIC8gbm9kZS1ib3VnaHRcbi8vIC8gZmFpbC1zdW1tYXJ5IGxpbmVzIHByaW50LiAtLXZlcmJvc2UgcmUtZW5hYmxlcyBwZXItdGljayBidWRnZXRcbi8vIGFuZCBwZXItbm9kZSB0YXJnZXQgc3RhdGUuIC0tb25jZSBydW5zIGEgc2luZ2xlIHVwZ3JhZGUgcGFzcyBhbmRcbi8vIGV4aXRzIChmdWxsIG91dHB1dCkuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBtb25pdG9yLWhhY2tuZXQuanMgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IDYwcywgUVVJRVRcbi8vICAgcnVuIG1vbml0b3ItaGFja25ldC5qcyAtLW9uY2UgICAgICAgICAgICAgICMgb25lIHBhc3MsIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbi8vICAgcnVuIG1vbml0b3ItaGFja25ldC5qcyAtLWludGVydmFsIDMwMDAwICAgICMgbG9vcCwgZXZlcnkgMzBzLCBRVUlFVFxuLy8gICBydW4gbW9uaXRvci1oYWNrbmV0LmpzIC0tdmVyYm9zZSAgICAgICAgICAgIyBsb29wLCBwZXItdGljayBidWRnZXQgKyBwZXItbm9kZSB0YXJnZXRzXG4vLyAgIHJ1biBtb25pdG9yLWhhY2tuZXQuanMgLS1jYXAgMzAgICAgICAgICAgICAjIHN0b3AgYnV5aW5nIG5ldyBub2RlcyBhdCAzMCAoZGVmYXVsdCAxNSlcbi8vICAgcnVuIG1vbml0b3ItaGFja25ldC5qcyAtLXJ1bGUgMC4xMCAgICAgICAgICMgbWF4IDEwJSBvZiB3YWxsZXQgcGVyIHB1cmNoYXNlIChkZWZhdWx0IDAuMTApXG4vL1xuLy8gSW1wbGVtZW50cyB0aGUgXCIxLXRvLTEwIFJ1bGVcIiBmcm9tIHRoZSB0aWVyIGd1aWRlOiBuZXZlciBzcGVuZCBtb3JlXG4vLyB0aGFuIDEwJSBvZiBsaXF1aWQgY2FzaCBvbiBhIHNpbmdsZSBIYWNrbmV0IHB1cmNoYXNlIChhIG5ldyBub2RlIE9SXG4vLyBvbmUgdXBncmFkZSkuIEFueXRoaW5nIG1vcmUgaXMgdHJlYXRlZCBhcyBTS0lQLXJ1bGUxMCBhbmQgd2Ugd2FpdFxuLy8gZm9yIHRoZSB3YWxsZXQgdG8gZ3Jvdy4gVGhpcyBwcm90ZWN0cyB0aGUgbWFpbiBlY29ub215IOKAlCBtb25leVxuLy8gdGhhdCBzaG91bGQgYmUgZ29pbmcgdG8gSG9tZSBSQU0gLyBoYWNraW5nIGluZnJhc3RydWN0dXJlLiBTZXRcbi8vIC0tcnVsZSAwIHRvIGRpc2FibGUgdGhlIHJ1bGUgKGUuZy4gZm9yIGVuZGdhbWUgbWF4LW91dCkuXG4vL1xuY29uc3QgVVNBR0UgPSBgVXNhZ2U6XG4gIHJ1biBtb25pdG9yLWhhY2tuZXQuanMgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IDYwcywgUVVJRVRcbiAgcnVuIG1vbml0b3ItaGFja25ldC5qcyAtLW9uY2UgICAgICAgICAgICAgICMgb25lIHBhc3MsIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbiAgcnVuIG1vbml0b3ItaGFja25ldC5qcyAtLWludGVydmFsIDMwMDAwICAgICMgbG9vcCwgZXZlcnkgMzBzLCBRVUlFVFxuICBydW4gbW9uaXRvci1oYWNrbmV0LmpzIC0tdmVyYm9zZSAgICAgICAgICAgIyBsb29wLCBwZXItdGljayBidWRnZXQgKyBwZXItbm9kZSB0YXJnZXRzXG4gIHJ1biBtb25pdG9yLWhhY2tuZXQuanMgLS1jYXAgMzAgICAgICAgICAgICAjIHN0b3AgYnV5aW5nIG5ldyBub2RlcyBhdCAzMCAoZGVmYXVsdCAxNSlcbiAgcnVuIG1vbml0b3ItaGFja25ldC5qcyAtLXJ1bGUgMC4xMCAgICAgICAgICMgbWF4IDEwJSBvZiB3YWxsZXQgcGVyIHB1cmNoYXNlIChkZWZhdWx0IDAuMTApXG5gO1xuXG4vLyBUaWVyIHRhYmxlLiBvcmRlciBtYXR0ZXJzOiB0aGUgRklSU1QgdGllciB3aG9zZSBudW1Ob2RlcyByYW5nZVxuLy8gY29udGFpbnMgdGhlIGN1cnJlbnQgY291bnQgaXMgdGhlIGFjdGl2ZSB0aWVyLiBBZGQgYSBuZXcgdGllciBieVxuLy8gZHJvcHBpbmcgaXQgaW4gYXQgdGhlIHRvcCBvZiB0aGUgYXJyYXkg4oCUIHRoZSBzY3JpcHQgcGlja3MgaXQgdXBcbi8vIGF1dG9tYXRpY2FsbHkuXG4vL1xuLy8gUGVyIHRoZSBzcGVjOiBib290c3RyYXAgPSBMNTAsIDhHQiwgMiBjb3Jlcy4gc3dlZXQtc3BvdCA9IEwxMDAtMTUwLFxuLy8gMTYtMzJHQiwgNCBjb3Jlcy4gV2UgcGljayB0aGUgVVBQRVIgZW5kIG9mIHRoZSBcIjEwMC0xNTBcIiByYW5nZSAoMTUwKVxuLy8gYW5kIHRoZSBVUFBFUiBlbmQgb2YgdGhlIFJBTSByYW5nZXMgKDMyR0IpIHNvIGVhY2ggdXBncmFkZSBpc1xuLy8gbWVhbmluZ2Z1bCBhbmQgd2UgZG9uJ3QgYnVybiBtb25leSBjbGltYmluZyBhIGxldmVsIGp1c3QgdG8gZHJvcFxuLy8gdGhlIHNhbWUgd2FsbGV0IG9uIHRoZSBuZXh0IG5vZGUuXG4vL1xuLy8gTm8gUkFNIHNvZnRjYXA6IDY0R0IgdW5sb2NrcyB0aGUgZnVsbCBzZXQgb2YgaGFzaCB1cGdyYWRlc1xuLy8gKENvbXBhbnkgQnV5YmFjaywgUmVkdWNlIE1pbmltdW0gU2VjdXJpdHksIGV0Yy4pIGFuZCBpcyBhIGh1Z2Vcbi8vIHByb2R1Y3Rpb24gYm9vc3QsIHNvIHRoZSBzY3JpcHQgYWx3YXlzIHRhcmdldHMgdGhlIG5leHQgcG93ZXIgb2YgMlxuLy8gdXAgdG8gNjRHQi4gVGhlIGdhbWUgaGFyZC1jYXBzIEhhY2tuZXQgTm9kZSBSQU0gYXQgNjRHQi5cbmNvbnN0IFRJRVJTID0gW1xuICB7IG5hbWU6IFwiYm9vdHN0cmFwXCIsICBtaW5Ob2RlczogMCwgIG1heE5vZGVzOiA4LCAgbGV2ZWw6IDUwLCAgcmFtR0I6IDgsICBjb3JlczogMiB9LFxuICB7IG5hbWU6IFwic3dlZXQtc3BvdFwiLCBtaW5Ob2RlczogOCwgIG1heE5vZGVzOiAyMCwgbGV2ZWw6IDE1MCwgcmFtR0I6IDY0LCBjb3JlczogNCB9LFxuICB7IG5hbWU6IFwic29mdC1jYXBcIiwgICBtaW5Ob2RlczogMjAsIG1heE5vZGVzOiAzMCwgbGV2ZWw6IDE1MCwgcmFtR0I6IDY0LCBjb3JlczogNCB9LFxuXTtcblxuY29uc3QgREVGQVVMVF9JTlRFUlZBTF9NUyA9IDYwXzAwMDtcbmNvbnN0IERFRkFVTFRfTkVXX05PREVfQ0FQID0gMTU7ICAvLyB0aWVyIGd1aWRlOiBcImtlZXAgaXQgYXJvdW5kIDE1IG5vZGVzXCIgZm9yIGVhcmx5L21pZCBnYW1lXG5jb25zdCBNQVhfTk9ERV9JTkRFWCA9IDMwOyAvLyBoYXJkIGNhcCBmcm9tIG5zLmhhY2tuZXQubWF4TnVtTm9kZXMoKVxuY29uc3QgREVGQVVMVF9SVUxFID0gMC4xMDsgIC8vIDEtdG8tMTAgUnVsZTogbWF4IDEwJSBvZiB3YWxsZXQgcGVyIHNpbmdsZSBwdXJjaGFzZVxuY29uc3QgTUlOX1JVTEUgPSAwLjA7ICAgICAgIC8vIDAgPSBkaXNhYmxlZCAob25seSBjaGVjayBhYnNvbHV0ZSBhZmZvcmRhYmlsaXR5KVxuY29uc3QgTUFYX1JVTEUgPSAxLjA7ICAgICAgIC8vIDEgPSBcIm5vIHJ1bGUsIHNwZW5kIHdoYXRldmVyXCI7IHNhbmUgdXBwZXIgYm91bmRcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnMpIHtcbiAgaWYgKG5zLmFyZ3MuaW5jbHVkZXMoXCItaFwiKSB8fCBucy5hcmdzLmluY2x1ZGVzKFwiLS1oZWxwXCIpKSB7XG4gICAgbnMudHByaW50KFVTQUdFKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBhcmdzID0gbnMuYXJncy5zbGljZSgpO1xuICBjb25zdCBvbmNlID0gYXJncy5pbmNsdWRlcyhcIi0tb25jZVwiKTtcbiAgY29uc3QgdmVyYm9zZSA9IGFyZ3MuaW5jbHVkZXMoXCItLXZlcmJvc2VcIik7XG4gIGNvbnN0IGNhcElkeCA9IGFyZ3MuaW5kZXhPZihcIi0tY2FwXCIpO1xuICBjb25zdCBuZXdOb2RlQ2FwID0gY2FwSWR4ID49IDBcbiAgICA/IE1hdGgubWF4KDAsIE1hdGgubWluKE1BWF9OT0RFX0lOREVYLCBOdW1iZXIoYXJnc1tjYXBJZHggKyAxXSkpKVxuICAgIDogREVGQVVMVF9ORVdfTk9ERV9DQVA7XG4gIGlmIChjYXBJZHggPj0gMCAmJiAoIU51bWJlci5pc0Zpbml0ZShuZXdOb2RlQ2FwKSB8fCBuZXdOb2RlQ2FwIDwgMCkpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3ItaGFja25ldDogLS1jYXAgbXVzdCBiZSBhIG51bWJlciAwLi4ke01BWF9OT0RFX0lOREVYfSAoZ290ICR7YXJnc1tjYXBJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJ1bGVJZHggPSBhcmdzLmluZGV4T2YoXCItLXJ1bGVcIik7XG4gIGNvbnN0IHJ1bGVGcmFjdGlvbiA9IHJ1bGVJZHggPj0gMFxuICAgID8gTnVtYmVyKGFyZ3NbcnVsZUlkeCArIDFdKVxuICAgIDogREVGQVVMVF9SVUxFO1xuICBpZiAocnVsZUlkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKHJ1bGVGcmFjdGlvbikgfHwgcnVsZUZyYWN0aW9uIDwgTUlOX1JVTEUgfHwgcnVsZUZyYWN0aW9uID4gTUFYX1JVTEUpKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLWhhY2tuZXQ6IC0tcnVsZSBtdXN0IGJlIGEgbnVtYmVyICR7TUlOX1JVTEV9Li4ke01BWF9SVUxFfSAoZ290ICR7YXJnc1tydWxlSWR4ICsgMV19KWApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBpbnRlcnZhbElkeCA9IGFyZ3MuaW5kZXhPZihcIi0taW50ZXJ2YWxcIik7XG4gIGNvbnN0IGludGVydmFsTXMgPSBpbnRlcnZhbElkeCA+PSAwXG4gICAgPyBOdW1iZXIoYXJnc1tpbnRlcnZhbElkeCArIDFdKVxuICAgIDogREVGQVVMVF9JTlRFUlZBTF9NUztcbiAgaWYgKGludGVydmFsSWR4ID49IDAgJiYgKCFOdW1iZXIuaXNGaW5pdGUoaW50ZXJ2YWxNcykgfHwgaW50ZXJ2YWxNcyA8IDApKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLWhhY2tuZXQ6IC0taW50ZXJ2YWwgbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBudW1iZXIgKGdvdCAke2FyZ3NbaW50ZXJ2YWxJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbnMuZGlzYWJsZUxvZyhcInNsZWVwXCIpO1xuICBucy5kaXNhYmxlTG9nKFwiZ2V0U2VydmVyTW9uZXlBdmFpbGFibGVcIik7XG4gIG5zLmRpc2FibGVMb2coXCJzY2FuXCIpO1xuXG4gIC8vIE9uZSB1cGdyYWRlIHBhc3M6IGJ1eSBhIG5ldyBub2RlIGlmIHdlJ3JlIHVuZGVyIHRoZSB0aWVyJ3NcbiAgLy8gcHJlZmVycmVkIGNvdW50LCB0aGVuIHdhbGsgZXZlcnkgbm9kZSBvbmNlIGFuZCBhcHBseSB0aGUgY2hlYXBlc3RcbiAgLy8gcGVuZGluZyB1cGdyYWRlLiBTdG9wcyB3aGVuIHRoZSB3YWxsZXQgY2FuJ3QgY292ZXIgdGhlIG5leHRcbiAgLy8gcHVyY2hhc2UgKHdlJ2QganVzdCBzcGFtIEZBSUwtZnVuZHMgbGluZXMgb3RoZXJ3aXNlKS5cbiAgZnVuY3Rpb24gcGFzcygpIHtcbiAgICBjb25zdCBjb3VudGVycyA9IHtcbiAgICAgIFwiTk9ERS1CT1VHSFRcIjogMCxcbiAgICAgIFwiQk9VR0hUXCI6IDAsXG4gICAgICBcIkJPVUdIVC1sZXZlbFwiOiAwLFxuICAgICAgXCJCT1VHSFQtcmFtXCI6IDAsXG4gICAgICBcIkJPVUdIVC1jb3JlXCI6IDAsXG4gICAgICBcIlNLSVAtY2FwXCI6IDAsXG4gICAgICBcIlNLSVAtdGllci1tZXRcIjogMCxcbiAgICAgIFwiU0tJUC1mdW5kc1wiOiAwLFxuICAgICAgXCJTS0lQLXJ1bGUxMFwiOiAwLFxuICAgICAgXCJGQUlMLXB1cmNoYXNlTm9kZVwiOiAwLFxuICAgICAgXCJGQUlMLXVwZ3JhZGVcIjogMCxcbiAgICB9O1xuXG4gICAgY29uc3QgdGllciA9IGFjdGl2ZVRpZXIoKTtcbiAgICBpZiAodmVyYm9zZSkge1xuICAgICAgbnMudHByaW50KGBtb25pdG9yLWhhY2tuZXQ6IHRpZXI9JHt0aWVyLm5hbWV9ICgke3RpZXIubWluTm9kZXN9LSR7dGllci5tYXhOb2Rlc30pIHRhcmdldD1MJHt0aWVyLmxldmVsfS9SJHt0aWVyLnJhbUdCfUdCL0Mke3RpZXIuY29yZXN9IGNhcD0ke25ld05vZGVDYXB9IHJ1bGU9JHsocnVsZUZyYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSVgKTtcbiAgICB9XG5cbiAgICAvLyAxLiBCdXkgYSBuZXcgbm9kZSBpZiB3ZSBoYXZlIGhlYWRyb29tLlxuICAgIGNvbnN0IG51bU5vZGVzID0gbnMuaGFja25ldC5udW1Ob2RlcygpO1xuICAgIGNvbnN0IG1heE5vZGVzID0gbnMuaGFja25ldC5tYXhOdW1Ob2RlcygpO1xuICAgIGlmIChudW1Ob2RlcyA8IG5ld05vZGVDYXAgJiYgbnVtTm9kZXMgPCBtYXhOb2Rlcykge1xuICAgICAgY29uc3QgY29zdCA9IG5zLmhhY2tuZXQuZ2V0UHVyY2hhc2VOb2RlQ29zdCgpO1xuICAgICAgY29uc3QgbW9uZXkgPSBucy5nZXRTZXJ2ZXJNb25leUF2YWlsYWJsZShcImhvbWVcIik7XG4gICAgICAvLyAxLXRvLTEwIFJ1bGU6IHBlci1wdXJjaGFzZSBjYXAgYXMgYSBmcmFjdGlvbiBvZiBsaXF1aWQgY2FzaC5cbiAgICAgIC8vIERpc3RpbmN0IGZyb20gU0tJUC1mdW5kcyAod2FsbGV0IGxpdGVyYWxseSA8IGNvc3QpIOKAlCBoZXJlIHRoZVxuICAgICAgLy8gd2FsbGV0IENBTiBhZmZvcmQgaXQsIGJ1dCBzcGVuZGluZyB0aGF0IG11Y2ggd291bGQgc3RhcnZlIHRoZVxuICAgICAgLy8gbWFpbiBlY29ub215LiBXZSB3YWl0IGZvciB0aGUgd2FsbGV0IHRvIGdyb3cuXG4gICAgICBjb25zdCBjYXAxMCA9IG1vbmV5ICogcnVsZUZyYWN0aW9uO1xuICAgICAgaWYgKHJ1bGVGcmFjdGlvbiA+IDAgJiYgY29zdCA+IGNhcDEwKSB7XG4gICAgICAgIGNvdW50ZXJzW1wiU0tJUC1ydWxlMTBcIl0rKztcbiAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICBucy50cHJpbnQoYFNLSVAtcnVsZTEwICAgICBuZXcgbm9kZSAkJHtjb3N0LnRvTG9jYWxlU3RyaW5nKCl9ID4gJHsocnVsZUZyYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSUgb2Ygd2FsbGV0ICQke21vbmV5LnRvTG9jYWxlU3RyaW5nKCl9ICh3b3VsZCBsZWF2ZSAkJHsobW9uZXkgLSBjb3N0KS50b0xvY2FsZVN0cmluZygpfSlgKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChucy5oYWNrbmV0LnB1cmNoYXNlTm9kZSgpICE9PSAtMSkge1xuICAgICAgICBjb3VudGVyc1tcIk5PREUtQk9VR0hUXCJdKys7XG4gICAgICAgIC8vIE5PREUtQk9VR0hUIGlzIHRoZSBpbnRlcmVzdGluZyBldmVudDsgYWx3YXlzIHByaW50IGV2ZW4gaW5cbiAgICAgICAgLy8gcXVpZXQgbW9kZS4gVGhlIGNvc3QgaXMgcmVwb3J0ZWQgZm9yIGNvbnRleHQuXG4gICAgICAgIG5zLnRwcmludChgTk9ERS1CT1VHSFQgICAgIG5ldyBub2RlIGZvciAkJHtjb3N0LnRvTG9jYWxlU3RyaW5nKCl9IChub3cgJHtudW1Ob2RlcyArIDF9LyR7bWF4Tm9kZXN9KWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gcHVyY2hhc2VOb2RlIHJldHVybnMgLTEgd2hlbiB0aGUgcGxheWVyIGNhbid0IGFmZm9yZCBpdC4gVGhlXG4gICAgICAgIC8vIG1vc3QgbGlrZWx5IHJlYXNvbiBpcyBcIm5vIHNwYXJlIG1vbmV5XCIg4oCUIG5vdCBhIGJ1Zy5cbiAgICAgICAgY291bnRlcnNbXCJGQUlMLXB1cmNoYXNlTm9kZVwiXSsrO1xuICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgIG5zLnRwcmludChgU0tJUC1mdW5kcyAgICAgIG5vIG5ldyBub2RlIChuZWVkICQke2Nvc3QudG9Mb2NhbGVTdHJpbmcoKX0pYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG51bU5vZGVzID49IG5ld05vZGVDYXApIHtcbiAgICAgIGNvdW50ZXJzW1wiU0tJUC1jYXBcIl0rKztcbiAgICAgIGlmICh2ZXJib3NlKSBucy50cHJpbnQoYFNLSVAtY2FwICAgICAgICBhdCBuZXctbm9kZSBjYXAgKCR7bnVtTm9kZXN9LyR7bmV3Tm9kZUNhcH0pYCk7XG4gICAgfSBlbHNlIGlmIChudW1Ob2RlcyA+PSBtYXhOb2Rlcykge1xuICAgICAgY291bnRlcnNbXCJTS0lQLWNhcFwiXSsrO1xuICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgU0tJUC1jYXAgICAgICAgIGF0IGdhbWUgY2FwICgke251bU5vZGVzfS8ke21heE5vZGVzfSlgKTtcbiAgICB9XG5cbiAgICAvLyAyLiBXYWxrIGV2ZXJ5IG5vZGUgYW5kIGFwcGx5IHRoZSBjaGVhcGVzdCBuZXh0IHVwZ3JhZGUuXG4gICAgLy8gICAgTG9vcCB1bnRpbCBlaXRoZXIgdGhlIHdhbGxldCBjYW4ndCBjb3ZlciB0aGUgbmV4dCBidXksIHRoZVxuICAgIC8vICAgIDEtdG8tMTAgUnVsZSBibG9ja3MgaXQsIG9yIGV2ZXJ5IG5vZGUgaGFzIGhpdCB0aGUgdGllcidzXG4gICAgLy8gICAgdGFyZ2V0cy4gVGhlIHRpZXItcmVsYXRpdmUgdGFyZ2V0IG1lYW5zIGEgZnJlc2hseS1ib3VnaHQgbm9kZVxuICAgIC8vICAgIGltbWVkaWF0ZWx5IGdldHMgYnJvdWdodCB1cCB0byBzcGVjIG9uIHRoZSBzYW1lIHBhc3MgKGNoZWFwXG4gICAgLy8gICAgdXBncmFkZXMgYWxsIHRoZSB3YXkgdGhyb3VnaCkuXG4gICAgY29uc3QgdGFyZ2V0cyA9IHRpZXJUYXJnZXRzKHRpZXIpO1xuICAgIC8vIEFmdGVyIHdlIGJ1eSBhIG5ldyBub2RlIG9uIHRoaXMgcGFzcywgdGhlIG5ldyBub2RlIHNob3VsZCBBTFNPXG4gICAgLy8gYmUgYnJvdWdodCB1cCB0byBzcGVjLiBUaGUgYWN0dWFsIGNvdW50IHdlIHdhbGsgaXMgdGhlIGxpdmVcbiAgICAvLyBjb3VudCwgd2hpY2ggYWxyZWFkeSBpbmNsdWRlcyBhbnkgTk9ERS1CT1VHSFQgZnJvbSBhYm92ZS5cbiAgICBjb25zdCB3YWxsZXRXYWxrTGltaXQgPSAyMDA7IC8vIHNhZmV0eSBib3VuZDsgb25lIHBhc3Mgc2hvdWxkbid0IGxvb3AgZm9yZXZlclxuICAgIGZvciAobGV0IHN0ZXAgPSAwOyBzdGVwIDwgd2FsbGV0V2Fsa0xpbWl0OyBzdGVwKyspIHtcbiAgICAgIGNvbnN0IG1vbmV5ID0gbnMuZ2V0U2VydmVyTW9uZXlBdmFpbGFibGUoXCJob21lXCIpO1xuICAgICAgLy8gMS10by0xMCBSdWxlIGNlaWxpbmcgZm9yIHRoaXMgdGljay4gMCBkaXNhYmxlcyB0aGUgcnVsZS5cbiAgICAgIGNvbnN0IHNwZW5kQ2FwID0gcnVsZUZyYWN0aW9uID4gMCA/IG1vbmV5ICogcnVsZUZyYWN0aW9uIDogSW5maW5pdHk7XG4gICAgICAvLyBUcmFjayB0d28gY2hlYXBlc3QtdXBncmFkZSBjYW5kaWRhdGVzIGluIHBhcmFsbGVsOiB0aGVcbiAgICAgIC8vIGFic29sdXRlIGNoZWFwZXN0ICh1c2VkIHRvIGRpc2FtYmlndWF0ZSBcInJ1bGUxMFwiIGZyb21cbiAgICAgIC8vIFwiZnVuZHNcIiksIGFuZCB0aGUgY2hlYXBlc3QgdGhhdCBhbHNvIGZpdHMgdW5kZXIgdGhlIHJ1bGUuXG4gICAgICBsZXQgYmVzdElkeCA9IC0xO1xuICAgICAgbGV0IGJlc3RLaW5kID0gbnVsbDtcbiAgICAgIGxldCBiZXN0Q29zdCA9IEluZmluaXR5O1xuICAgICAgbGV0IGFic0NoZWFwZXN0Q29zdCA9IEluZmluaXR5OyAvLyBmb3IgdGhlIGRpc2FtYmlndWF0aW9uXG4gICAgICBsZXQgYW55UGVuZGluZyA9IGZhbHNlO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBucy5oYWNrbmV0Lm51bU5vZGVzKCk7IGkrKykge1xuICAgICAgICBjb25zdCBzID0gbnMuaGFja25ldC5nZXROb2RlU3RhdHMoaSk7XG4gICAgICAgIGlmIChzLmxldmVsIDwgdGFyZ2V0cy5sZXZlbCkge1xuICAgICAgICAgIGFueVBlbmRpbmcgPSB0cnVlO1xuICAgICAgICAgIGNvbnN0IGMgPSBucy5oYWNrbmV0LmdldExldmVsVXBncmFkZUNvc3QoaSwgMSk7XG4gICAgICAgICAgaWYgKGMgPCBhYnNDaGVhcGVzdENvc3QpIGFic0NoZWFwZXN0Q29zdCA9IGM7XG4gICAgICAgICAgaWYgKGMgPD0gc3BlbmRDYXAgJiYgYyA8IGJlc3RDb3N0KSB7IGJlc3RDb3N0ID0gYzsgYmVzdElkeCA9IGk7IGJlc3RLaW5kID0gXCJsZXZlbFwiOyB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHMucmFtIDwgdGFyZ2V0cy5yYW1HQikge1xuICAgICAgICAgIGFueVBlbmRpbmcgPSB0cnVlO1xuICAgICAgICAgIGNvbnN0IGMgPSBucy5oYWNrbmV0LmdldFJhbVVwZ3JhZGVDb3N0KGksIDEpO1xuICAgICAgICAgIGlmIChjIDwgYWJzQ2hlYXBlc3RDb3N0KSBhYnNDaGVhcGVzdENvc3QgPSBjO1xuICAgICAgICAgIGlmIChjIDw9IHNwZW5kQ2FwICYmIGMgPCBiZXN0Q29zdCkgeyBiZXN0Q29zdCA9IGM7IGJlc3RJZHggPSBpOyBiZXN0S2luZCA9IFwicmFtXCI7IH1cbiAgICAgICAgfVxuICAgICAgICBpZiAocy5jb3JlcyA8IHRhcmdldHMuY29yZXMpIHtcbiAgICAgICAgICBhbnlQZW5kaW5nID0gdHJ1ZTtcbiAgICAgICAgICBjb25zdCBjID0gbnMuaGFja25ldC5nZXRDb3JlVXBncmFkZUNvc3QoaSwgMSk7XG4gICAgICAgICAgaWYgKGMgPCBhYnNDaGVhcGVzdENvc3QpIGFic0NoZWFwZXN0Q29zdCA9IGM7XG4gICAgICAgICAgaWYgKGMgPD0gc3BlbmRDYXAgJiYgYyA8IGJlc3RDb3N0KSB7IGJlc3RDb3N0ID0gYzsgYmVzdElkeCA9IGk7IGJlc3RLaW5kID0gXCJjb3JlXCI7IH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGJlc3RJZHggPCAwKSB7XG4gICAgICAgIGlmICghYW55UGVuZGluZykge1xuICAgICAgICAgIGNvdW50ZXJzW1wiU0tJUC10aWVyLW1ldFwiXSsrO1xuICAgICAgICB9IGVsc2UgaWYgKGFic0NoZWFwZXN0Q29zdCA+IG1vbmV5KSB7XG4gICAgICAgICAgLy8gTm8gdXBncmFkZSBmaXRzIHRoZSB3YWxsZXQgYXQgYWxsIOKAlCBldmVuIHdpdGggdGhlIHJ1bGVcbiAgICAgICAgICAvLyBvZmYsIHRoZSBjaGVhcGVzdCBvbmUgaXMgdW5hZmZvcmRhYmxlLiBUaGUgcnVsZSBkaWRuJ3RcbiAgICAgICAgICAvLyBjYXVzZSB0aGlzIHNraXA7IHJlcG9ydCBpdCBhcyBmdW5kcy5cbiAgICAgICAgICBjb3VudGVyc1tcIlNLSVAtZnVuZHNcIl0rKztcbiAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgbnMudHByaW50KGBTS0lQLWZ1bmRzICAgICAgbm8gdXBncmFkZSBmaXRzIHdhbGxldCAoY2hlYXBlc3QgJCR7YWJzQ2hlYXBlc3RDb3N0LnRvTG9jYWxlU3RyaW5nKCl9LCB3YWxsZXQgJCR7bW9uZXkudG9Mb2NhbGVTdHJpbmcoKX0pYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFdhbGxldCBjYW4gYWZmb3JkIHRoZSBjaGVhcGVzdCwgYnV0IHRoZSBydWxlIGJsb2NrcyBpdC5cbiAgICAgICAgICBjb3VudGVyc1tcIlNLSVAtcnVsZTEwXCJdKys7XG4gICAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICAgIG5zLnRwcmludChgU0tJUC1ydWxlMTAgICAgIGNoZWFwZXN0IHVwZ3JhZGUgJCR7YWJzQ2hlYXBlc3RDb3N0LnRvTG9jYWxlU3RyaW5nKCl9ID4gJHsocnVsZUZyYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSUgb2Ygd2FsbGV0ICQke21vbmV5LnRvTG9jYWxlU3RyaW5nKCl9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgLy8gQnV5IHRoZSBjaGVhcGVzdCBwZW5kaW5nIHVwZ3JhZGUgb24gYmVzdElkeC4gV2UgZG8gbGV2ZWwgLyByYW1cbiAgICAgIC8vIC8gY29yZSBpbiB0aGVpciBvd24gc3dpdGNoIHNvIHRoZSBldmVudCBsYWJlbCBpcyBleGFjdC5cbiAgICAgIGxldCBvayA9IGZhbHNlO1xuICAgICAgaWYgKGJlc3RLaW5kID09PSBcImxldmVsXCIpIG9rID0gbnMuaGFja25ldC51cGdyYWRlTGV2ZWwoYmVzdElkeCwgMSk7XG4gICAgICBlbHNlIGlmIChiZXN0S2luZCA9PT0gXCJyYW1cIikgb2sgPSBucy5oYWNrbmV0LnVwZ3JhZGVSYW0oYmVzdElkeCwgMSk7XG4gICAgICBlbHNlIGlmIChiZXN0S2luZCA9PT0gXCJjb3JlXCIpIG9rID0gbnMuaGFja25ldC51cGdyYWRlQ29yZShiZXN0SWR4LCAxKTtcbiAgICAgIGlmICghb2spIHtcbiAgICAgICAgLy8gdXBncmFkZSogcmV0dXJucyBmYWxzZSBvbiBpbnN1ZmZpY2llbnQgZnVuZHMgT1Igb24gaGl0dGluZ1xuICAgICAgICAvLyB0aGUgcGVyLXN0YXQgbWF4LiBXZSBwcmUtY2hlY2tlZCBmdW5kcywgc28gaXQncyBhIG1heCBoaXQg4oCUXG4gICAgICAgIC8vIG1hcmsgdGhlIHRhcmdldCBhcyBtZXQgYnkgcmUtcnVubmluZyB0aGUgbG9vcCAodGhlIGNvbmRpdGlvblxuICAgICAgICAvLyBpcyBub3cgPCB0YXJnZXRzLlgsIHdoaWNoIGlzIHN0aWxsIHRydWUsIHNvIHdlJ2QgbG9vcFxuICAgICAgICAvLyBmb3JldmVyKS4gQmFpbCBhbmQgbGV0IHRoZSBuZXh0IHRpY2sgcmUtZXZhbHVhdGUuXG4gICAgICAgIGNvdW50ZXJzW1wiRkFJTC11cGdyYWRlXCJdKys7XG4gICAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgICAgbnMudHByaW50KGBGQUlMLXVwZ3JhZGUgICAgbm9kZS0ke2Jlc3RJZHh9ICR7YmVzdEtpbmR9IHJldHVybmVkIGZhbHNlIChtYXggaGl0PyBmdW5kcyByYWNlPylgKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvdW50ZXJzW1wiQk9VR0hUXCJdKys7XG4gICAgICBjb3VudGVyc1tgQk9VR0hULSR7YmVzdEtpbmR9YF0rKztcbiAgICAgIC8vIEJPVUdIVCBpcyB0aGUgcGVyLXVwZ3JhZGUgZXZlbnQuIFdlIG9ubHkgcHJpbnQgYSBjb21wYWN0IGxpbmVcbiAgICAgIC8vIGluIHZlcmJvc2UgbW9kZTsgcXVpZXQgbW9kZSBhZ2dyZWdhdGVzIGludG8gdGhlIHN1bW1hcnkuXG4gICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICBjb25zdCBzID0gbnMuaGFja25ldC5nZXROb2RlU3RhdHMoYmVzdElkeCk7XG4gICAgICAgIG5zLnRwcmludChgQk9VR0hULSR7YmVzdEtpbmQucGFkRW5kKDUpfSBub2RlLSR7YmVzdElkeH0gICQke2Jlc3RDb3N0LnRvTG9jYWxlU3RyaW5nKCl9ICAtPiBMJHtzLmxldmVsfS9SJHtzLnJhbX0vQyR7cy5jb3Jlc31gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAob25jZSB8fCB2ZXJib3NlKSB7XG4gICAgICBjb25zdCBzdW1tYXJ5ID0gT2JqZWN0LmVudHJpZXMoY291bnRlcnMpXG4gICAgICAgIC5maWx0ZXIoKFssIHZdKSA9PiB2ID4gMClcbiAgICAgICAgLm1hcCgoW2ssIHZdKSA9PiBgJHtrfT0ke3Z9YClcbiAgICAgICAgLmpvaW4oXCIgXCIpO1xuICAgICAgLy8gSW4gcXVpZXQgbW9kZSwgc3VwcHJlc3MgdGhlIHN1bW1hcnkgbGluZSB3aGVuIG5vdGhpbmdcbiAgICAgIC8vIGludGVyZXN0aW5nIGhhcHBlbmVkIChubyBOT0RFLUJPVUdIVCwgbm8gQk9VR0hULCBubyBGQUlMLSkuXG4gICAgICAvLyAtLW9uY2UgYWx3YXlzIHdhbnRzIHRoZSBmdWxsIHJlcG9ydC5cbiAgICAgIGNvbnN0IGludGVyZXN0aW5nID0gY291bnRlcnNbXCJOT0RFLUJPVUdIVFwiXSA+IDAgfHwgY291bnRlcnNbXCJCT1VHSFRcIl0gPiAwIHx8IGNvdW50ZXJzW1wiRkFJTC11cGdyYWRlXCJdID4gMCB8fCBjb3VudGVyc1tcIkZBSUwtcHVyY2hhc2VOb2RlXCJdID4gMDtcbiAgICAgIGlmIChvbmNlIHx8IGludGVyZXN0aW5nKSB7XG4gICAgICAgIG5zLnRwcmludChgZG9uZTogJHtzdW1tYXJ5IHx8IFwibm8gY2hhbmdlc1wifWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGFjdGl2ZVRpZXIoKSB7XG4gICAgY29uc3QgbiA9IG5zLmhhY2tuZXQubnVtTm9kZXMoKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgVElFUlMpIHtcbiAgICAgIGlmIChuID49IHQubWluTm9kZXMgJiYgbiA8IHQubWF4Tm9kZXMpIHJldHVybiB0O1xuICAgIH1cbiAgICAvLyBQYXN0IHRoZSBsYXN0IHRpZXIncyBtYXhOb2RlcyAoZS5nLiAzMCsgd2hpY2ggdGhlIGdhbWVcbiAgICAvLyBkaXNhbGxvd3MsIGJ1dCBiZSBkZWZlbnNpdmUpOiBzdGF5IG9uIHRoZSBsYXN0IHRpZXIuXG4gICAgcmV0dXJuIFRJRVJTW1RJRVJTLmxlbmd0aCAtIDFdO1xuICB9XG5cbiAgLy8gVGllci1yZWxhdGl2ZSB0YXJnZXQgZm9yIHRoZSAqY3VycmVudCogbm9kZSBjb3VudC4gVGhlIHNwZWMgc2F5c1xuICAvLyBib290c3RyYXAgYXBwbGllcyB1cCB0byA4IG5vZGVzLCBzd2VldC1zcG90IDEwLTIwLCBldGMuIFdlIHRyZWF0XG4gIC8vIHRoZSBjb3VudCBpdHNlbGYgYXMgdGhlIHRpZXIga2V5LCBzbyB0aGUgdGFyZ2V0IGRvZXNuJ3QgY2hhbmdlXG4gIC8vIG1pZC1wYXNzLlxuICBmdW5jdGlvbiB0aWVyVGFyZ2V0cyh0aWVyKSB7XG4gICAgcmV0dXJuIHsgbGV2ZWw6IHRpZXIubGV2ZWwsIHJhbUdCOiB0aWVyLnJhbUdCLCBjb3JlczogdGllci5jb3JlcyB9O1xuICB9XG5cbiAgaWYgKG9uY2UpIHtcbiAgICBwYXNzKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgbW9uaXRvci1oYWNrbmV0OiBzdGFydGVkLCBpbnRlcnZhbD0ke2ludGVydmFsTXN9bXMsIG91dHB1dD0ke3ZlcmJvc2UgPyBcInZlcmJvc2VcIiA6IFwicXVpZXRcIn0sIGNhcD0ke25ld05vZGVDYXB9LCBydWxlPSR7KHJ1bGVGcmFjdGlvbiAqIDEwMCkudG9GaXhlZCgwKX0lYCk7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgcGFzcygpO1xuICAgIGF3YWl0IG5zLnNsZWVwKGludGVydmFsTXMpO1xuICB9XG59XG4iXX0=