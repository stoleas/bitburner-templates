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
    { name: "bootstrap", minRoster: 0, maxRoster: 8, targetGB: 64 },
    { name: "sweet-spot", minRoster: 8, maxRoster: 25, targetGB: 1024 },
    { name: "soft-cap", minRoster: 20, maxRoster: 25, targetGB: 4096, requiresFlag: "soft-cap" },
];
const SOURCE = "home";
const ROSTER_PREFIX = "pserv-";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NEW_SERVER_CAP = 25; // tier guide: 25 = game cap; mid-game sweet spot is 25
const MAX_ROSTER = 25; // hard cap from ns.cloud.getServerLimit()
const MAX_RAM = 2 ** 20; // 1,048,576 GB — game hard cap
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
const DEFAULT_RESERVE = 100e9; // $100B
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
            if (t.requiresFlag && !enabledTiers.has(t.name))
                continue;
            if (count >= t.minRoster && count < t.maxRoster)
                return t;
        }
        // Past the last eligible tier. Find the highest-priority
        // unconditional tier (or any opt-in tier that was enabled).
        for (const t of TIERS) {
            if (t.requiresFlag && !enabledTiers.has(t.name))
                continue;
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
            if (ns.serverExists(`${ROSTER_PREFIX}${i}`))
                n++;
        }
        return n;
    }
    // First missing slot in pserv-0..pserv-(limit-1), or -1 if all exist.
    function firstMissingSlot() {
        const limit = ns.cloud.getServerLimit();
        for (let i = 0; i < limit; i++) {
            if (!ns.serverExists(`${ROSTER_PREFIX}${i}`))
                return i;
        }
        return -1;
    }
    // RAM (in GB) of the next power-of-2 ≥ current. Cap at MAX_RAM.
    function nextPowerOf2AtLeast(ram) {
        let r = 1;
        while (r < ram && r < MAX_RAM)
            r *= 2;
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
        while (p < gb)
            p *= 2;
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
            "SKIP-rule": 0,
            "SKIP-reserve": 0,
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
                }
                else if (ruleFraction > 0 && cost > wallet * ruleFraction) {
                    counters["SKIP-rule"]++;
                    if (verbose) {
                        ns.tprint(`SKIP-rule       new ${name} ${tier.targetGB}GB $${cost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${wallet.toLocaleString()}`);
                    }
                }
                else if (cost > wallet) {
                    counters["SKIP-funds"]++;
                    if (verbose) {
                        ns.tprint(`SKIP-funds      no new ${name} (need $${cost.toLocaleString()}, have $${wallet.toLocaleString()})`);
                    }
                }
                else {
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
                            if (verbose)
                                ns.tprint(`FAIL-scp        ${result} (couldn't push worker scripts)`);
                        }
                    }
                    else {
                        // purchaseServer returns "" on the cap or some other
                        // race. We pre-checked the cap, so this is unusual.
                        counters["FAIL-purchaseServer"]++;
                        if (verbose) {
                            ns.tprint(`FAIL-purchaseServer  ${name} returned "" (cap hit? funds race?)`);
                        }
                    }
                }
            }
        }
        else if (count >= newServerCap) {
            counters["SKIP-cap"]++;
            if (verbose)
                ns.tprint(`SKIP-cap        at new-server cap (${count}/${newServerCap})`);
        }
        else if (count >= MAX_ROSTER) {
            counters["SKIP-cap"]++;
            if (verbose)
                ns.tprint(`SKIP-cap        at game cap (${count}/${MAX_ROSTER})`);
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
        const targetGB = ceilPow2AtLeast(tier.targetGB); // power-of-2 snap
        let bestIdx = -1;
        let bestCost = Infinity;
        let absCheapestCost = Infinity;
        let anyPending = false;
        for (let i = 0; i < liveCount; i++) {
            const name = `${ROSTER_PREFIX}${i}`;
            if (!ns.serverExists(name))
                continue;
            const currentGB = ns.getServerMaxRam(name);
            if (currentGB >= targetGB)
                continue; // at or above target
            if (currentGB >= MAX_RAM)
                continue; // at game cap
            anyPending = true;
            const c = costOfScale(targetGB); // snap to tier target, not 2×
            if (c < absCheapestCost)
                absCheapestCost = c;
            if (c <= liveSpendCap && c < bestCost) {
                bestCost = c;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) {
            if (!anyPending) {
                counters["SKIP-tier-met"]++;
            }
            else if (absCheapestCost > wallet) {
                counters["SKIP-funds"]++;
                if (verbose) {
                    ns.tprint(`SKIP-funds      no scale fits wallet (cheapest $${absCheapestCost.toLocaleString()}, wallet $${wallet.toLocaleString()})`);
                }
            }
            else if (wallet - absCheapestCost < reserveFloor) {
                // The cheapest scale would drop us below the reserve
                // floor. SKIP-reserve and let the wallet grow.
                counters["SKIP-reserve"]++;
                if (verbose) {
                    ns.tprint(`SKIP-reserve     cheapest scale $${absCheapestCost.toLocaleString()} would leave wallet=$${(wallet - absCheapestCost).toLocaleString()} < $${reserveFloor.toLocaleString()}`);
                }
            }
            else {
                counters["SKIP-rule"]++;
                if (verbose) {
                    ns.tprint(`SKIP-rule       cheapest scale $${absCheapestCost.toLocaleString()} > ${(ruleFraction * 100).toFixed(0)}% of wallet $${wallet.toLocaleString()}`);
                }
            }
        }
        else {
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
            }
            else if (!ns.cloud.deleteServer(targetName)) {
                counters["FAIL-deleteServer"]++;
                if (verbose) {
                    ns.tprint(`FAIL-deleteServer  ${targetName} (running scripts? RAM in use?)`);
                }
                // Don't continue — a deleteServer failure usually means
                // scripts are pinned to the server; one failure tends to
                // cascade, so we stop the pass here.
            }
            else {
                const result = ns.cloud.purchaseServer(targetName, newGB);
                if (result === "") {
                    counters["FAIL-purchaseAfterDelete"]++;
                    if (verbose) {
                        ns.tprint(`FAIL-purchaseAfterDelete  ${targetName} ${newGB}GB (slot re-taken? race?)`);
                    }
                }
                else {
                    counters["SCALED"]++;
                    // Push worker scripts to the re-purchased (scaled) server.
                    // Same reasoning as PSERV-BOUGHT — the delete+recreate wipes
                    // the file system on the pserv, so workers can't run on it
                    // until we re-scp them.
                    if (!pushWorkerScripts(result)) {
                        counters["FAIL-scp"] = (counters["FAIL-scp"] || 0) + 1;
                        if (verbose)
                            ns.tprint(`FAIL-scp        ${result} (couldn't push worker scripts after scale)`);
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
    if (verbose)
        ns.tprint(`monitor-servers: started, interval=${intervalMs}ms, output=${verbose ? "verbose" : "quiet"}, cap=${newServerCap}, rule=${(ruleFraction * 100).toFixed(0)}%`);
    while (true) {
        pass();
        await ns.sleep(intervalMs);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1zZXJ2ZXJzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21vbml0b3Itc2VydmVycy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxxRUFBcUU7QUFDckUsZ0JBQWdCO0FBQ2hCLEVBQUU7QUFDRixnRUFBZ0U7QUFDaEUsNERBQTREO0FBQzVELG1FQUFtRTtBQUNuRSxvRkFBb0Y7QUFDcEYsRUFBRTtBQUNGLGlFQUFpRTtBQUNqRSxvRUFBb0U7QUFDcEUsb0VBQW9FO0FBQ3BFLGdFQUFnRTtBQUNoRSxrRUFBa0U7QUFDbEUsbUVBQW1FO0FBQ25FLHVDQUF1QztBQUN2QyxFQUFFO0FBQ0Ysc0ZBQXNGO0FBQ3RGLGtFQUFrRTtBQUNsRSxtRUFBbUU7QUFDbkUsbUVBQW1FO0FBQ25FLHlEQUF5RDtBQUN6RCxrRUFBa0U7QUFDbEUsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxrRUFBa0U7QUFDbEUscUVBQXFFO0FBQ3JFLG9FQUFvRTtBQUNwRSxrRUFBa0U7QUFDbEUsOERBQThEO0FBQzlELHFFQUFxRTtBQUNyRSxtRUFBbUU7QUFDbkUsMERBQTBEO0FBQzFELEVBQUU7QUFDRixrRUFBa0U7QUFDbEUsbUVBQW1FO0FBQ25FLDJEQUEyRDtBQUMzRCwrREFBK0Q7QUFDL0Qsd0NBQXdDO0FBQ3hDLEVBQUU7QUFDRixnRUFBZ0U7QUFDaEUsZ0VBQWdFO0FBQ2hFLDRDQUE0QztBQUM1QyxnRUFBZ0U7QUFDaEUsOERBQThEO0FBQzlELDhEQUE4RDtBQUM5RCwrREFBK0Q7QUFDL0QsMkNBQTJDO0FBQzNDLCtEQUErRDtBQUMvRCx3REFBd0Q7QUFDeEQsa0VBQWtFO0FBQ2xFLGlFQUFpRTtBQUNqRSwyQkFBMkI7QUFDM0IsRUFBRTtBQUNGLDZEQUE2RDtBQUM3RCxzREFBc0Q7QUFDdEQsMENBQTBDO0FBQzFDLDZCQUE2QjtBQUM3QixnRUFBZ0U7QUFDaEUsa0VBQWtF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QUFDLENBQUM7YUFDL0M7U0FDRjtJQUNILENBQUM7SUFFRCxJQUFJLElBQUksRUFBRTtRQUNSLElBQUksRUFBRSxDQUFDO1FBQ1AsT0FBTztLQUNSO0lBRUQsSUFBSSxPQUFPO1FBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxzQ0FBc0MsVUFBVSxjQUFjLE9BQU8sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxPQUFPLFNBQVMsWUFBWSxVQUFVLENBQUMsWUFBWSxHQUFHLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDckwsT0FBTyxJQUFJLEVBQUU7UUFDWCxJQUFJLEVBQUUsQ0FBQztRQUNQLE1BQU0sRUFBRSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztLQUM1QjtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyBtb25pdG9yLXNlcnZlcnMuanMg4oCUIGxvbmctbGl2ZWQgZGFlbW9uIHRoYXQgcHJvZ3Jlc3NpdmVseSBidXlzIGFuZFxuLy8gUkFNLXNjYWxlcyBwdXJjaGFzZWQgc2VydmVycyBhbG9uZyB0aGUgXCJQdXJjaGFzZWQtU2VydmVyIFJBTSBUaWVyXCJcbi8vIHRhcmdldCB0YWJsZTpcbi8vXG4vLyAgIHRpZXIgICAgICAgICAgICByb3N0ZXIgY291bnQgICAgdGFyZ2V0IFJBTSAoR0IpLCBwZXItc2VydmVyXG4vLyAgIC0tLS0tLS0tLS0tLSAgICAtLS0tLS0tLS0tLS0gICAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vICAgYm9vdHN0cmFwICAgICAgIDAuLjggICAgICAgICAgICA2NCAgICAoY2hlYXAgdG8gZmlsbCB0aGUgc2xvdClcbi8vICAgc3dlZXQtc3BvdCAgICAgIDkuLjI1ICAgICAgICAgICAxMDI0ICAoMSBUQiDigJQgc2FtZSBhcyBob21lLCB1c2VmdWwgZm9yIGZhbi1vdXQpXG4vL1xuLy8gV2UgZG9uJ3QgdHJ5IHRvIHNjYWxlIG9uZSBzZXJ2ZXIgYWxsIHRoZSB3YXkgdG8gdGhlIGNhcCBiZWZvcmVcbi8vIG1vdmluZyBvbi4gSW5zdGVhZCwgZXZlcnkgdGljayB3ZSBwaWNrIHRoZSBDSEVBUEVTVCBuZXh0IHB1cmNoYXNlXG4vLyAoYSBuZXcgcHNlcnYgc2xvdCBhdCB0aGUgY3VycmVudCB0aWVyJ3MgdGFyZ2V0IFJBTSwgT1IgYSBzbmFwLXRvLVxuLy8gdGFyZ2V0IHVwZ3JhZGUgb24gdGhlIHNtYWxsZXN0IHVuZGVyLXRhcmdldCBzZXJ2ZXIpIGFuZCBhcHBseVxuLy8gaXQuIFRoaXMga2VlcHMgdGhlIHdob2xlIGZsZWV0IG1vdmluZyBpbiBsb2Nrc3RlcCBhbmQgc3RvcHMgdGhlXG4vLyBwZXItc2VydmVyIGNvc3QgY3VydmUgKGVhY2ggc2l6ZS11cCBzY2FsZXMgY29zdCBtdWNoIGZhc3RlciB0aGFuXG4vLyBsaW5lYXJseSkgZnJvbSBvdXRwYWNpbmcgdGhlIHdhbGxldC5cbi8vXG4vLyBUaGUgcm9zdGVyIGlzIGZpeGVkIGF0IHRoZSBnYW1lJ3MgMjUtc2VydmVyIGNhcCAobnMuY2xvdWQuZ2V0U2VydmVyTGltaXQgaW4gMy4wLjApLlxuLy8gTmFtZXMgYXJlIHBzZXJ2LTAuLnBzZXJ2LTI0LiBXZSBuZXZlciByZW5hbWUg4oCUIGEgc25hcC10by10YXJnZXRcbi8vIHVwZ3JhZGUgaXMgZGVsZXRlU2VydmVyICsgcHVyY2hhc2VTZXJ2ZXIgYXQgdGhlIG5ldyAodGllcikgc2l6ZS5cbi8vIFRoZSBsb3N0IHNjcmlwdHMgYW5kIHRtcCBkYXRhIG9uIGEgZGVsZXRlIGlzIGEgbm9uLWlzc3VlIGF0IHRoaXNcbi8vIHN0YWdlIG9mIHRoZSBnYW1lICh0aGUgd29ya2VyIHNjcmlwdHMgZ2V0IHJlLWZhbm5lZCBieVxuLy8gbW9uaXRvci1kZXBsb3kuanMsIGFuZCB0aGUgb3JjaGVzdHJhdG9yIGFscmVhZHkgbGl2ZXMgb24gaG9tZSkuXG4vL1xuLy8gXCJzd2VldC1zcG90XCIgaXMgdGhlIG9ubHkgdGllciB3ZSBub3cgc2hpcC4gVGhlIHByZXZpb3VzIFwic29mdC1jYXBcIlxuLy8gNCBUQiB0aWVyIHdhcyBjb3N0aW5nIH4kMS4xNVQgZm9yIDUgc2VydmVycyBhdCAkMjMwQiBlYWNoIOKAlCB0aGVcbi8vIGZsZWV0LWJhdGNoZXIgcGF0dGVybiBpbiBtYW5hZ2VyLmpzIChob21lICsgcHNlcnZzICsgcm9vdGVkLXdvcmxkc1xuLy8gPSB+MTIrIFRCKSBtYWtlcyB0aGUgbWFyZ2luYWwgdmFsdWUgb2YgNCBUQiBwc2VydnMgbmVhci16ZXJvLiBUaGVcbi8vIHdhbGxldCBzYXZpbmdzIGFyZSBkcmFtYXRpYzogYSA0IFRCIGZsZWV0IGNvc3RzIH4kMS4xNVQsIGEgMSBUQlxuLy8gZmxlZXQgY29zdHMgfiQxLjRULCBidXQgdGhlIGluY29tZSBkaWZmZXJlbmNlIGlzIG5lZ2xpZ2libGVcbi8vIChjbHVzdGVyIHV0aWxpemF0aW9uIGlzIHRoZSBiaW5kaW5nIGNvbnN0cmFpbnQsIG5vdCByYXcgY2FwYWNpdHkpLlxuLy8gVXNlcnMgd2hvIHdhbnQgdG8gcHVzaCBwYXN0IDEgVEIgY2FuIHJ1biBgcnVuIG1vbml0b3Itc2VydmVycy5qc1xuLy8gLS10aWVyIHNvZnQtY2FwYCAocmUtZW5hYmxlcyB0aGUgNCBUQiB0aWVyIGV4cGxpY2l0bHkpLlxuLy9cbi8vIENPTlNFUlZBVElWRSBTUEVORElORzogdGhpcyBkYWVtb24gaXMgdGhlIG1vc3QgbGlrZWx5IHNvdXJjZSBvZlxuLy8gd2FsbGV0IGRyYWluLiBUaGUgcHJldmlvdXMgZGVmYXVsdHMgKDEwJSBvZiB3YWxsZXQgcGVyIHB1cmNoYXNlLFxuLy8gbm8gcmVzZXJ2ZSBmbG9vciwgbXVsdGktc2VydmVyLXBlci10aWNrIHNjYWxlIHdhbGspIHdlcmVcbi8vIHJlc3BvbnNpYmxlIGZvciB0aGUgJDEuNUIrIHNwZW5kIHRoZSB1c2VyIHJlcG9ydGVkIHNlZWluZyBpblxuLy8gc2luY2VJbnN0YWxsIHN0YXRzLiBUaGUgbmV3IGRlZmF1bHRzOlxuLy9cbi8vICAgLS1ydWxlIDAuMDMgICAgICAxLXRvLTMgUnVsZTogbWF4IDMlIG9mIHdhbGxldCBwZXIgcHVyY2hhc2Vcbi8vICAgICAgICAgICAgICAgICAgICAod2FzIDEwJSDigJQgYXQgJDFUIHdhbGxldCwgdGhhdCdzICQzMEIvdGlja1xuLy8gICAgICAgICAgICAgICAgICAgIGluc3RlYWQgb2YgJDEwMEIvdGljaylcbi8vICAgLS1yZXNlcnZlIDEwMGU5ICBXYWxsZXQgZmxvb3I6IG5ldmVyIHNwZW5kIGJlbG93ICQxMDBCICh3YXNcbi8vICAgICAgICAgICAgICAgICAgICB1bmd1YXJkZWQg4oCUIHRoZSBkYWVtb24gaGFwcGlseSBzcGVudCB0aGVcbi8vICAgICAgICAgICAgICAgICAgICB3YWxsZXQgdG8gMCB0byBidXkgYSBzaW5nbGUgNCBUQiBwc2VydikuXG4vLyAgICAgICAgICAgICAgICAgICAgUmVzZXJ2ZSBwcm90ZWN0cyBIb21lIFJBTSB1cGdyYWRlcywgYXVncyxcbi8vICAgICAgICAgICAgICAgICAgICBhbmQgY29udHJhY3Qgc29sdmVycy5cbi8vICAgMSBidXkvdGljayAgICAgICBBdCBtb3N0IE9ORSBwdXJjaGFzZSBwZXIgcGFzcyAod2FzIFwiYnV5ICtcbi8vICAgICAgICAgICAgICAgICAgICBzY2FsZSAyLTMgc2VydmVycyBpZiBydWxlIGFsbG93c1wiKVxuLy8gICAxIHNjYWxlL3RpY2sgICAgIEF0IG1vc3QgT05FIHNjYWxlIHBlciBwYXNzICh3YXMgYSB3aGlsZSBsb29wXG4vLyAgICAgICAgICAgICAgICAgICAgdGhhdCBzY2FsZWQgZXZlcnkgdW5kZXItdGFyZ2V0IHBzZXJ2IGluIG9uZVxuLy8gICAgICAgICAgICAgICAgICAgIHBhc3MpXG4vL1xuLy8gVGhlc2UgdGhyZWUga25vYnMgdG9nZXRoZXIgY2FwIHRoZSBkYWVtb24ncyBzcGVuZCByYXRlIGF0OlxuLy8gICBwZXItcGFzcyBtYXggPSBtaW4od2FsbGV0ICogMC4wMywgd2FsbGV0IC0gJDEwMEIpXG4vLyAgIHBlci10aWNrIGF0IDYwcyBjYWRlbmNlID0gdXAgdG8gfiQzMEJcbi8vICAgcGVyLW1pbnV0ZSA9IHVwIHRvIH4kMzBCXG4vLyAgIHBlci1ob3VyID0gdXAgdG8gfiQxLjhUIChpZiBpbmNvbWUga2VlcHMgdXAg4oCUIG90aGVyd2lzZSB0aGVcbi8vICAgICAgICAgICAgICAxLXRvLTMgUnVsZSBraWNrcyBpbiBhbmQgY2FwcyBlYWNoIHB1cmNoYXNlIGF0IDMlKVxuLy9cbi8vIFRoaXMgaXMgaW50ZW50aW9uYWxseSBhIDMtNcOXIHJlZHVjdGlvbiBpbiBzcGVuZCByYXRlLiBUaGUgdXNlclxuLy8gcmVwb3J0ZWQgJDEuNUIgc3BlbnQgd2hpbGUgb25seSAkOC43TSB3YXMgZWFybmVkIOKAlCBhIDE3ODoxXG4vLyBuZWdhdGl2ZSBST0kuIEF0IHRoZSBuZXcgcmF0ZSwgJDEuNUIgb2YgQ0FQRVggaGFwcGVucyBvdmVyIH41MFxuLy8gbWludXRlcywgd2l0aCAkMTAwQisgYWx3YXlzIGluIHJlc2VydmUuIEluY29tZSBzaG91bGQgb3V0cGFjZVxuLy8gc3BlbmRpbmcgb25jZSB0aGUgbWFuYWdlcidzIGZsZWV0LWJhdGNoZXIgaXMgYWxzbyBydW5uaW5nXG4vLyAobWFuYWdlci5qcydzIG5ldyBmbGVldCBwYXR0ZXJuIHR5cGljYWxseSBwcm9kdWNlcyAkMTBCKy9zZWNcbi8vIGFnYWluc3QgdGhlIHRvcCA5IHRhcmdldHMpLlxuLy9cbi8vIE91dHB1dCBpcyBRVUlFVCBieSBkZWZhdWx0IOKAlCBvbmx5IFBTRVJWLUJPVUdIVCAvIFNDQUxFRCAvIGZhaWxcbi8vIHN1bW1hcnkgbGluZXMgcHJpbnQuIC0tdmVyYm9zZSByZS1lbmFibGVzIHBlci10aWNrIGJ1ZGdldCBhbmRcbi8vIHBlci1zZXJ2ZXIgdGFyZ2V0IHN0YXRlLiAtLW9uY2UgcnVucyBhIHNpbmdsZSB1cGdyYWRlIHBhc3MgYW5kXG4vLyBleGl0cyAoZnVsbCBvdXRwdXQpLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzICAgICAgICAgICAgICAgICAgICAgIyBsb29wLCBldmVyeSA2MHMsIFFVSUVULCAxLXRvLTMgUnVsZVxuLy8gICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzIC0tb25jZSAgICAgICAgICAgICAgIyBvbmUgcGFzcywgZnVsbCBvdXRwdXQsIHRoZW4gZXhpdFxuLy8gICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzIC0taW50ZXJ2YWwgMzAwMDAgICAgIyBsb29wLCBldmVyeSAzMHMsIFFVSUVUXG4vLyAgIHJ1biBtb25pdG9yLXNlcnZlcnMuanMgLS12ZXJib3NlICAgICAgICAgICAjIGxvb3AsIHBlci10aWNrIGJ1ZGdldCArIHBlci1zZXJ2ZXIgdGFyZ2V0c1xuLy8gICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzIC0tY2FwIDI1ICAgICAgICAgICAgIyBzdG9wIGJ1eWluZyBuZXcgcHNlcnZzIGF0IDI1IChkZWZhdWx0IDI1LCBnYW1lIGNhcClcbi8vICAgcnVuIG1vbml0b3Itc2VydmVycy5qcyAtLXJ1bGUgMC4wNSAgICAgICAgICMgbWF4IDUlIG9mIHdhbGxldCBwZXIgcHVyY2hhc2UgKGRlZmF1bHQgMC4wMylcbi8vICAgcnVuIG1vbml0b3Itc2VydmVycy5qcyAtLXJlc2VydmUgNTBlOSAgICAgIyB3YWxsZXQgZmxvb3I7IG5ldmVyIHNwZW5kIGJlbG93ICQ1MEIgKGRlZmF1bHQgMTAwQilcbi8vICAgcnVuIG1vbml0b3Itc2VydmVycy5qcyAtLXRpZXIgc29mdC1jYXAgICAgIyByZS1lbmFibGUgdGhlIDQgVEIgXCJzb2Z0LWNhcFwiIHRpZXIgKGRlZmF1bHQ6IG9mZilcbi8vICAgcnVuIG1vbml0b3Itc2VydmVycy5qcyAtLW9uY2UgMCAgICAgICAgICAgICMgcGFzcyAwIG1lYW5zIHByaW50IGEgcGVyLXRpY2sgYnVkZ2V0LCBubyBhcHBseVxuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxuICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzICAgICAgICAgICAgICAgICAgICAgIyBsb29wLCBldmVyeSA2MHMsIFFVSUVULCAxLXRvLTMgUnVsZVxuICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzIC0tb25jZSAgICAgICAgICAgICAgIyBvbmUgcGFzcywgZnVsbCBvdXRwdXQsIHRoZW4gZXhpdFxuICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzIC0taW50ZXJ2YWwgMzAwMDAgICAgIyBsb29wLCBldmVyeSAzMHMsIFFVSUVUXG4gIHJ1biBtb25pdG9yLXNlcnZlcnMuanMgLS12ZXJib3NlICAgICAgICAgICAjIGxvb3AsIHBlci10aWNrIGJ1ZGdldCArIHBlci1zZXJ2ZXIgdGFyZ2V0c1xuICBydW4gbW9uaXRvci1zZXJ2ZXJzLmpzIC0tY2FwIDI1ICAgICAgICAgICAgIyBzdG9wIGJ1eWluZyBuZXcgcHNlcnZzIGF0IDI1IChkZWZhdWx0IDI1LCBnYW1lIGNhcClcbiAgcnVuIG1vbml0b3Itc2VydmVycy5qcyAtLXJ1bGUgMC4wNSAgICAgICAgICMgbWF4IDUlIG9mIHdhbGxldCBwZXIgcHVyY2hhc2UgKGRlZmF1bHQgMC4wMylcbiAgcnVuIG1vbml0b3Itc2VydmVycy5qcyAtLXJlc2VydmUgNTBlOSAgICAgICMgd2FsbGV0IGZsb29yOyBuZXZlciBzcGVuZCBiZWxvdyAkNTBCIChkZWZhdWx0IDEwMEIpXG4gIHJ1biBtb25pdG9yLXNlcnZlcnMuanMgLS10aWVyIHNvZnQtY2FwICAgICAjIHJlLWVuYWJsZSB0aGUgNCBUQiBcInNvZnQtY2FwXCIgdGllciAoZGVmYXVsdDogb2ZmKVxuYDtcblxuLy8gVGllciB0YWJsZS4gb3JkZXIgbWF0dGVyczogdGhlIEZJUlNUIHRpZXIgd2hvc2Ugcm9zdGVyIHJhbmdlXG4vLyBjb250YWlucyB0aGUgY3VycmVudCBjb3VudCBpcyB0aGUgYWN0aXZlIHRpZXIuIEFkZCBhIG5ldyB0aWVyIGJ5XG4vLyBkcm9wcGluZyBpdCBpbiBhdCB0aGUgdG9wIG9mIHRoZSBhcnJheS5cbi8vXG4vLyA0IFRCIHRpZXIgaXMgbm93IG9wdC1pbiB2aWEgLS10aWVyIHNvZnQtY2FwLiBUaGUgZGVmYXVsdCAxIFRCXG4vLyBzd2VldC1zcG90IGlzIHBsZW50eSBmb3IgdGhlIGZsZWV0LWJhdGNoZXIgKG1hbmFnZXIuanMncyBwYXR0ZXJuXG4vLyBhbHJlYWR5IHVzZXMgaG9tZSArIHBzZXJ2cyArIHJvb3RlZC13b3JsZHMsIHNvIHRoZSBtYXJnaW5hbFxuLy8gdmFsdWUgb2YgNCBUQiBwc2VydnMgaXMgbWluaW1hbCkuXG4vL1xuLy8gQ29zdCBtYXRoOiBhdCA2NCBHQiB0aGUgcGVyLXBzZXJ2IGNvc3QgaXMgJDMuNTJNICg2NCDDlyAkNTVrKS5cbi8vIEF0IDEgVEIgdGhlIHBlci1wc2VydiBjb3N0IGlzICQ1Ny43Qi4gQXQgNCBUQiBpdCdzICQyMzBCLiBUaGVcbi8vIDEtdG8tMyBSdWxlIG1lYW5zIHdlIHdhaXQgZm9yIHRoZSB3YWxsZXQgdG8gZ3JvdyBiZWZvcmUgZWFjaFxuLy8gc3RlcCwgc28gdGhlIDQgVEIgdGllciBpcyBvbmx5IGhpdCB3aGVuIHRoZSB3YWxsZXQgaXMgfiQyLjNUKy5cbmNvbnN0IFRJRVJTID0gW1xuICB7IG5hbWU6IFwiYm9vdHN0cmFwXCIsICBtaW5Sb3N0ZXI6IDAsICBtYXhSb3N0ZXI6IDgsICB0YXJnZXRHQjogNjQgfSxcbiAgeyBuYW1lOiBcInN3ZWV0LXNwb3RcIiwgbWluUm9zdGVyOiA4LCAgbWF4Um9zdGVyOiAyNSwgdGFyZ2V0R0I6IDEwMjQgfSxcbiAgeyBuYW1lOiBcInNvZnQtY2FwXCIsICAgbWluUm9zdGVyOiAyMCwgbWF4Um9zdGVyOiAyNSwgdGFyZ2V0R0I6IDQwOTYsIHJlcXVpcmVzRmxhZzogXCJzb2Z0LWNhcFwiIH0sXG5dO1xuXG5jb25zdCBTT1VSQ0UgPSBcImhvbWVcIjtcbmNvbnN0IFJPU1RFUl9QUkVGSVggPSBcInBzZXJ2LVwiO1xuY29uc3QgREVGQVVMVF9JTlRFUlZBTF9NUyA9IDYwXzAwMDtcbmNvbnN0IERFRkFVTFRfTkVXX1NFUlZFUl9DQVAgPSAyNTsgICAgIC8vIHRpZXIgZ3VpZGU6IDI1ID0gZ2FtZSBjYXA7IG1pZC1nYW1lIHN3ZWV0IHNwb3QgaXMgMjVcbmNvbnN0IE1BWF9ST1NURVIgPSAyNTsgICAgICAgICAgICAgICAgIC8vIGhhcmQgY2FwIGZyb20gbnMuY2xvdWQuZ2V0U2VydmVyTGltaXQoKVxuY29uc3QgTUFYX1JBTSA9IDIgKiogMjA7ICAgICAgICAgICAgICAgLy8gMSwwNDgsNTc2IEdCIOKAlCBnYW1lIGhhcmQgY2FwXG4vLyAxLXRvLTMgUnVsZSAod2FzIDEtdG8tMTApLiBBdCAkMVQgd2FsbGV0LCAzJSA9ICQzMEIgcGVyIHB1cmNoYXNlXG4vLyBpbnN0ZWFkIG9mICQxMDBCIOKAlCBhIDMuM8OXIHJlZHVjdGlvbi4gVGhlIHVzZXIgcmVwb3J0ZWQgJDEuNUJcbi8vIHNwZW50IG9uIGEgJDguN00taW5jb21lIHJ1biwgd2hpY2ggaXMgdW5zdXN0YWluYWJsZS4gU2V0IC0tcnVsZSAwXG4vLyB0byBkaXNhYmxlIGZvciBlbmRnYW1lIG1heC1vdXQuXG5jb25zdCBERUZBVUxUX1JVTEUgPSAwLjAzO1xuY29uc3QgTUlOX1JVTEUgPSAwLjA7XG5jb25zdCBNQVhfUlVMRSA9IDEuMDtcbi8vIFdhbGxldCBmbG9vcjogbmV2ZXIgc3BlbmQgYmVsb3cgdGhpcy4gUHJvdGVjdHMgSG9tZSBSQU0gdXBncmFkZXMsXG4vLyBhdWdzLCBhbmQgY29udHJhY3Qgc29sdmVycyBmcm9tIGJlaW5nIHN0YXJ2ZWQgYnkgdGhlIGRhZW1vbi5cbi8vIERlZmF1bHQgJDEwMEIg4oCUIHRoZSBkYWVtb24gd2lsbCBza2lwIEFMTCBwdXJjaGFzZXMgKGNvdW50IGFzXG4vLyBTS0lQLXJlc2VydmUpIG9uY2UgdGhlIHdhbGxldCBkcm9wcyBiZWxvdyB0aGlzLiBTZXQgLS1yZXNlcnZlIDBcbi8vIHRvIGRpc2FibGUgKE5PVCByZWNvbW1lbmRlZCkuXG5jb25zdCBERUZBVUxUX1JFU0VSVkUgPSAxMDBlOTsgICAgICAgICAgLy8gJDEwMEJcbi8vIFNhZmV0eSBib3VuZCBmb3IgbGVnYWN5IGNvZGUgcGF0aHMuIFRoZSBzaW5nbGUtc2NhbGUtcGVyLXBhc3Ncbi8vIGxvZ2ljIGRvZXNuJ3QgbmVlZCBhIHdhbGsgbGltaXQsIGJ1dCB0aGUgY29uc3RhbnQgaXMga2VwdCBmb3Jcbi8vIGFueSBmdXR1cmUgZXhwYW5zaW9uIChlLmcuIG11bHRpLXN0ZXAgc2NhbGluZykgdGhhdCBtaWdodCB3YW50XG4vLyBhIGhhcmQgY2VpbGluZy4gQ3VycmVudGx5IHVudXNlZC5cbmNvbnN0IFJPU1RFUl9XQUxLX0xJTUlUID0gMjAwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGFyZ3MgPSBucy5hcmdzLnNsaWNlKCk7XG4gIGNvbnN0IG9uY2UgPSBhcmdzLmluY2x1ZGVzKFwiLS1vbmNlXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgY29uc3QgY2FwSWR4ID0gYXJncy5pbmRleE9mKFwiLS1jYXBcIik7XG4gIGNvbnN0IG5ld1NlcnZlckNhcCA9IGNhcElkeCA+PSAwXG4gICAgPyBNYXRoLm1heCgwLCBNYXRoLm1pbihNQVhfUk9TVEVSLCBOdW1iZXIoYXJnc1tjYXBJZHggKyAxXSkpKVxuICAgIDogREVGQVVMVF9ORVdfU0VSVkVSX0NBUDtcbiAgaWYgKGNhcElkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKG5ld1NlcnZlckNhcCkgfHwgbmV3U2VydmVyQ2FwIDwgMCkpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc2VydmVyczogLS1jYXAgbXVzdCBiZSBhIG51bWJlciAwLi4ke01BWF9ST1NURVJ9IChnb3QgJHthcmdzW2NhcElkeCArIDFdfSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcnVsZUlkeCA9IGFyZ3MuaW5kZXhPZihcIi0tcnVsZVwiKTtcbiAgY29uc3QgcnVsZUZyYWN0aW9uID0gcnVsZUlkeCA+PSAwXG4gICAgPyBOdW1iZXIoYXJnc1tydWxlSWR4ICsgMV0pXG4gICAgOiBERUZBVUxUX1JVTEU7XG4gIGlmIChydWxlSWR4ID49IDAgJiYgKCFOdW1iZXIuaXNGaW5pdGUocnVsZUZyYWN0aW9uKSB8fCBydWxlRnJhY3Rpb24gPCBNSU5fUlVMRSB8fCBydWxlRnJhY3Rpb24gPiBNQVhfUlVMRSkpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc2VydmVyczogLS1ydWxlIG11c3QgYmUgYSBudW1iZXIgJHtNSU5fUlVMRX0uLiR7TUFYX1JVTEV9IChnb3QgJHthcmdzW3J1bGVJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGludGVydmFsSWR4ID0gYXJncy5pbmRleE9mKFwiLS1pbnRlcnZhbFwiKTtcbiAgY29uc3QgaW50ZXJ2YWxNcyA9IGludGVydmFsSWR4ID49IDBcbiAgICA/IE51bWJlcihhcmdzW2ludGVydmFsSWR4ICsgMV0pXG4gICAgOiBERUZBVUxUX0lOVEVSVkFMX01TO1xuICBpZiAoaW50ZXJ2YWxJZHggPj0gMCAmJiAoIU51bWJlci5pc0Zpbml0ZShpbnRlcnZhbE1zKSB8fCBpbnRlcnZhbE1zIDwgMCkpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc2VydmVyczogLS1pbnRlcnZhbCBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIG51bWJlciAoZ290ICR7YXJnc1tpbnRlcnZhbElkeCArIDFdfSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gLS1yZXNlcnZlICROOiB3YWxsZXQgZmxvb3IuIERhZW1vbiBza2lwcyBwdXJjaGFzZXMgd2hlbiB0aGVcbiAgLy8gd2FsbGV0IHdvdWxkIGRyb3AgYmVsb3cgdGhpcy4gRGVmYXVsdCAkMTAwQi5cbiAgY29uc3QgcmVzZXJ2ZUlkeCA9IGFyZ3MuaW5kZXhPZihcIi0tcmVzZXJ2ZVwiKTtcbiAgY29uc3QgcmVzZXJ2ZUZsb29yID0gcmVzZXJ2ZUlkeCA+PSAwXG4gICAgPyBNYXRoLm1heCgwLCBOdW1iZXIoYXJnc1tyZXNlcnZlSWR4ICsgMV0pKVxuICAgIDogREVGQVVMVF9SRVNFUlZFO1xuICBpZiAocmVzZXJ2ZUlkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKHJlc2VydmVGbG9vcikgfHwgcmVzZXJ2ZUZsb29yIDwgMCkpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc2VydmVyczogLS1yZXNlcnZlIG11c3QgYmUgYSBub24tbmVnYXRpdmUgbnVtYmVyIChnb3QgJHthcmdzW3Jlc2VydmVJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIC0tdGllciA8bmFtZT46IG9wdCBiYWNrIGludG8gYSB0aWVyLiBDdXJyZW50bHkgdGhlIG9ubHkgb3B0LWluXG4gIC8vIHRpZXIgaXMgXCJzb2Z0LWNhcFwiICg0IFRCKS4gRGVmYXVsdDogbm8gc29mdC1jYXAgKDEgVEIgY2VpbGluZykuXG4gIGNvbnN0IHRpZXJJZHggPSBhcmdzLmluZGV4T2YoXCItLXRpZXJcIik7XG4gIGNvbnN0IGVuYWJsZWRUaWVycyA9IHRpZXJJZHggPj0gMFxuICAgID8gbmV3IFNldChbYXJnc1t0aWVySWR4ICsgMV1dKVxuICAgIDogbmV3IFNldCgpO1xuXG4gIG5zLmRpc2FibGVMb2coXCJzbGVlcFwiKTtcbiAgbnMuZGlzYWJsZUxvZyhcImdldFNlcnZlck1vbmV5QXZhaWxhYmxlXCIpO1xuICBucy5kaXNhYmxlTG9nKFwic2NhblwiKTtcblxuICAvLyAtLS0gaGVscGVycyAtLS1cblxuICAvLyBBY3RpdmUgdGllciBmb3IgYSBnaXZlbiBjdXJyZW50IHJvc3RlciBjb3VudC4gU2tpcHMgdGllcnNcbiAgLy8gdGhhdCByZXF1aXJlIGFuIG9wdC1pbiBmbGFnIChlLmcuIHNvZnQtY2FwIGlzIGdhdGVkIG9uXG4gIC8vIC0tdGllciBzb2Z0LWNhcCkuIEZhbGxzIGJhY2sgdG8gdGhlIGhpZ2hlc3QtcHJpb3JpdHlcbiAgLy8gdW5jb25kaXRpb25hbCB0aWVyLlxuICBmdW5jdGlvbiBhY3RpdmVUaWVyKGNvdW50KSB7XG4gICAgZm9yIChjb25zdCB0IG9mIFRJRVJTKSB7XG4gICAgICBpZiAodC5yZXF1aXJlc0ZsYWcgJiYgIWVuYWJsZWRUaWVycy5oYXModC5uYW1lKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gdC5taW5Sb3N0ZXIgJiYgY291bnQgPCB0Lm1heFJvc3RlcikgcmV0dXJuIHQ7XG4gICAgfVxuICAgIC8vIFBhc3QgdGhlIGxhc3QgZWxpZ2libGUgdGllci4gRmluZCB0aGUgaGlnaGVzdC1wcmlvcml0eVxuICAgIC8vIHVuY29uZGl0aW9uYWwgdGllciAob3IgYW55IG9wdC1pbiB0aWVyIHRoYXQgd2FzIGVuYWJsZWQpLlxuICAgIGZvciAoY29uc3QgdCBvZiBUSUVSUykge1xuICAgICAgaWYgKHQucmVxdWlyZXNGbGFnICYmICFlbmFibGVkVGllcnMuaGFzKHQubmFtZSkpIGNvbnRpbnVlO1xuICAgICAgcmV0dXJuIHQ7XG4gICAgfVxuICAgIC8vIE5vIHRpZXJzIGVuYWJsZWQ/IFNob3VsZG4ndCBoYXBwZW4gKHN3ZWV0LXNwb3QgaXMgYWx3YXlzXG4gICAgLy8gdW5jb25kaXRpb25hbCkgYnV0IGZhbGwgdGhyb3VnaCB0byB0aGUgbGFzdCBlbnRyeSByYXRoZXJcbiAgICAvLyB0aGFuIGNyYXNoLlxuICAgIHJldHVybiBUSUVSU1tUSUVSUy5sZW5ndGggLSAxXTtcbiAgfVxuXG4gIC8vIENvdW50IG9mIGN1cnJlbnRseS1leGlzdGluZyBwc2VydiBzbG90cy5cbiAgZnVuY3Rpb24gY3VycmVudENvdW50KCkge1xuICAgIGNvbnN0IGxpbWl0ID0gbnMuY2xvdWQuZ2V0U2VydmVyTGltaXQoKTtcbiAgICBsZXQgbiA9IDA7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW1pdDsgaSsrKSB7XG4gICAgICBpZiAobnMuc2VydmVyRXhpc3RzKGAke1JPU1RFUl9QUkVGSVh9JHtpfWApKSBuKys7XG4gICAgfVxuICAgIHJldHVybiBuO1xuICB9XG5cbiAgLy8gRmlyc3QgbWlzc2luZyBzbG90IGluIHBzZXJ2LTAuLnBzZXJ2LShsaW1pdC0xKSwgb3IgLTEgaWYgYWxsIGV4aXN0LlxuICBmdW5jdGlvbiBmaXJzdE1pc3NpbmdTbG90KCkge1xuICAgIGNvbnN0IGxpbWl0ID0gbnMuY2xvdWQuZ2V0U2VydmVyTGltaXQoKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbWl0OyBpKyspIHtcbiAgICAgIGlmICghbnMuc2VydmVyRXhpc3RzKGAke1JPU1RFUl9QUkVGSVh9JHtpfWApKSByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9XG5cbiAgLy8gUkFNIChpbiBHQikgb2YgdGhlIG5leHQgcG93ZXItb2YtMiDiiaUgY3VycmVudC4gQ2FwIGF0IE1BWF9SQU0uXG4gIGZ1bmN0aW9uIG5leHRQb3dlck9mMkF0TGVhc3QocmFtKSB7XG4gICAgbGV0IHIgPSAxO1xuICAgIHdoaWxlIChyIDwgcmFtICYmIHIgPCBNQVhfUkFNKSByICo9IDI7XG4gICAgcmV0dXJuIE1hdGgubWluKHIsIE1BWF9SQU0pO1xuICB9XG5cbiAgLy8gUHVzaCB3b3JrZXIgc2NyaXB0cyB0byBhIGZyZXNobHktcHVyY2hhc2VkIHBzZXJ2LiBUaGUgcnVudGltZVxuICAvLyByZXF1aXJlcyB0aGUgc2NyaXB0IHRvIGJlIG9uIHRoZSB0YXJnZXQgaG9zdCBmb3IgbnMuZXhlYyB0b1xuICAvLyBzdWNjZWVkIOKAlCB3aXRob3V0IHRoaXMsIGV2ZXJ5IGV4ZWMgdG8gYSBuZXcgcHNlcnYgZmFpbHMgd2l0aFxuICAvLyBcIlNjcmlwdCB3ZWFrZW4uanMgZG9lcyBub3QgZXhpc3Qgb24gcHNlcnYtTlwiLiBXZSBwdXNoIHRoZVxuICAvLyB0aHJlZSB3b3JrZXIgc2NyaXB0cyB0aGUgbWFuYWdlciBuZWVkcy4gbWFuYWdlci5qcyBpdHNlbGZcbiAgLy8gbGl2ZXMgb24gaG9tZSBzbyBkb2Vzbid0IG5lZWQgdG8gYmUgcHVzaGVkLlxuICAvL1xuICAvLyBGYWlsdXJlIGhlcmUgaXMgbm9uLWZhdGFsOiB0aGUgbmV4dCBtb25pdG9yLXNlcnZlcnMgdGljayAob3JcbiAgLy8gYSBtYW51YWwgYHJ1biBzeW5jLWFsbC5qc2ApIHdpbGwgcmV0cnkuIFRoZSBwc2VydiBtaWdodCBiZVxuICAvLyBicmllZmx5IHVuYWJsZSB0byBob3N0IHdvcmtlcnM7IHRoZSBtYW5hZ2VyIHdpbGwgU0tJUC1yYW1cbiAgLy8gYW5kIHRyeSBhbm90aGVyIHdvcmtlciBpbiB0aGUgbWVhbnRpbWUuXG4gIGZ1bmN0aW9uIHB1c2hXb3JrZXJTY3JpcHRzKGhvc3QpIHtcbiAgICBjb25zdCBzY3JpcHRzID0gW1wiaGFjay5qc1wiLCBcIndlYWtlbi5qc1wiLCBcImdyb3cuanNcIl07XG4gICAgcmV0dXJuIG5zLnNjcChzY3JpcHRzLCBob3N0LCBTT1VSQ0UpO1xuICB9XG5cbiAgLy8gQ29zdCBvZiBzY2FsaW5nIGEgc2VydmVyIGZyb20gYGN1cnJlbnRHQmAgdG8gYG5ld0dCYC4gVGhlXG4gIC8vIEJpdGJ1cm5lciBBUEkgaGFzIG5vIGluLXBsYWNlIHVwZ3JhZGUsIHNvIHNjYWxpbmcgaXMgYVxuICAvLyBkZWxldGVTZXJ2ZXIgKyBwdXJjaGFzZVNlcnZlciBhdCB0aGUgbmV3IHNpemUuIFRoZSBuZXcgc2l6ZVxuICAvLyBpcyB3aGF0ZXZlciB0aGUgdXBncmFkZSBsb2dpYyBkZWNpZGVzICgyw5cgc3RlcCBPUiBzbmFwIHRvXG4gIC8vIHRpZXIgdGFyZ2V0KSwgYW5kIHRoZSBjb3N0IGlzIHRoZSBnZXRTZXJ2ZXJDb3N0IG9mIHRoYXQgc2l6ZS5cbiAgZnVuY3Rpb24gY29zdE9mU2NhbGUobmV3R0IpIHtcbiAgICByZXR1cm4gbnMuY2xvdWQuZ2V0U2VydmVyQ29zdChNYXRoLm1pbihuZXdHQiwgTUFYX1JBTSkpO1xuICB9XG5cbiAgLy8gU25hcCBhIGRlc2lyZWQgc2l6ZSB1cCB0byB0aGUgbmV4dCBwb3dlciBvZiAyLiBCaXRidXJuZXJcbiAgLy8gcmVxdWlyZXMgcHVyY2hhc2VkLXNlcnZlciBSQU0gdG8gYmUgYSBwb3dlciBvZiAyICgyLCA0LCA4LFxuICAvLyAuLi4sIDY1NTM2LCAuLi4pLiAxMDIzIEdCIGlzIGludmFsaWQ7IDEwMjQgR0IgaXMgdmFsaWQuIFdlXG4gIC8vIHVzZSB0aGlzIGZvciB0aGUgc25hcC10by10YXJnZXQgdXBncmFkZSBwYXRoIHNvIGEgdGFyZ2V0XG4gIC8vIGxpa2UgNjQgR0Ig4oaSIDEwMjQgR0Igd29ya3MgZXZlbiBpZiB0aWVyLnRhcmdldEdCIGlzIHRoZVxuICAvLyBleGFjdCAxMDI0LlxuICBmdW5jdGlvbiBjZWlsUG93MkF0TGVhc3QoZ2IpIHtcbiAgICBsZXQgcCA9IDE7XG4gICAgd2hpbGUgKHAgPCBnYikgcCAqPSAyO1xuICAgIHJldHVybiBNYXRoLm1pbihwLCBNQVhfUkFNKTtcbiAgfVxuXG4gIC8vIC0tLSBvbmUgcGFzcyAtLS1cblxuICBmdW5jdGlvbiBwYXNzKCkge1xuICAgIGNvbnN0IGNvdW50ZXJzID0ge1xuICAgICAgXCJQU0VSVi1CT1VHSFRcIjogMCxcbiAgICAgIFwiU0NBTEVEXCI6IDAsXG4gICAgICBcIlNLSVAtY2FwXCI6IDAsXG4gICAgICBcIlNLSVAtdGllci1tZXRcIjogMCxcbiAgICAgIFwiU0tJUC1mdW5kc1wiOiAwLFxuICAgICAgXCJTS0lQLXJ1bGVcIjogMCwgICAgICAgICAvLyByZW5hbWVkIGZyb20gU0tJUC1ydWxlMTAgKDEtdG8tMyBSdWxlIG5vdylcbiAgICAgIFwiU0tJUC1yZXNlcnZlXCI6IDAsICAgICAgLy8gbmV3OiB3YWxsZXQgYmVsb3cgLS1yZXNlcnZlIGZsb29yXG4gICAgICBcIkZBSUwtcHVyY2hhc2VTZXJ2ZXJcIjogMCxcbiAgICAgIFwiRkFJTC1kZWxldGVTZXJ2ZXJcIjogMCxcbiAgICAgIFwiRkFJTC1wdXJjaGFzZUFmdGVyRGVsZXRlXCI6IDAsXG4gICAgfTtcblxuICAgIGNvbnN0IGNvdW50ID0gY3VycmVudENvdW50KCk7XG4gICAgY29uc3QgdGllciA9IGFjdGl2ZVRpZXIoY291bnQpO1xuICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICBucy50cHJpbnQoYG1vbml0b3Itc2VydmVyczogdGllcj0ke3RpZXIubmFtZX0gKCR7dGllci5taW5Sb3N0ZXJ9LSR7dGllci5tYXhSb3N0ZXJ9KSB0YXJnZXQ9JHt0aWVyLnRhcmdldEdCfUdCIGNhcD0ke25ld1NlcnZlckNhcH0gcnVsZT0keyhydWxlRnJhY3Rpb24gKiAxMDApLnRvRml4ZWQoMCl9JSByZXNlcnZlPSQke3Jlc2VydmVGbG9vci50b0xvY2FsZVN0cmluZygpfWApO1xuICAgIH1cblxuICAgIC8vIFJlYWQgdGhlIHdhbGxldCBPTkNFIHBlciBwYXNzLiBUaGUgMS10by0zIFJ1bGUgYW5kIHRoZVxuICAgIC8vIHJlc2VydmUgZmxvb3IgYm90aCBjaGVjayBhZ2FpbnN0IHRoZSBTQU1FIHdhbGxldCB2YWx1ZSwgc29cbiAgICAvLyBhIHNpbmdsZSByZWFkIGhlcmUgaXMgdGhlIGNsZWFuZXN0IHdheSB0byBrZWVwIHRoZW1cbiAgICAvLyBjb25zaXN0ZW50LiBSZS1yZWFkaW5nIG1pZC1wYXNzIHdvdWxkIGxldCBhIHRpY2stYnV5ZXIgc2xpcFxuICAgIC8vIGEgcHVyY2hhc2UgcGFzdCB0aGUgZmxvb3IgKGUuZy4gaWYgdGhlIHdhbGxldCBkcm9wcyBiZXR3ZWVuXG4gICAgLy8gdGhlIHJlYWQgYW5kIHRoZSBidXkpLlxuICAgIGNvbnN0IHdhbGxldCA9IG5zLmdldFNlcnZlck1vbmV5QXZhaWxhYmxlKFNPVVJDRSk7XG4gICAgaWYgKHdhbGxldCA8IHJlc2VydmVGbG9vcikge1xuICAgICAgLy8gUmVzZXJ2ZSBmbG9vcjogcmVmdXNlIHRvIHNwZW5kLiBUaGUgd2FsbGV0IGlzIGJlbG93IHRoZVxuICAgICAgLy8gY29uZmlndXJlZCBmbG9vcjsgYmV0dGVyIHRvIHdhaXQgZm9yIGluY29tZSB0byBicmluZyBpdFxuICAgICAgLy8gYmFjayB1cC4gV2l0aG91dCB0aGlzIGd1YXJkLCB0aGUgZGFlbW9uIHdvdWxkIGhhcHBpbHlcbiAgICAgIC8vIHNwZW5kIHRoZSB3YWxsZXQgdG8gJDAgdG8gZnVuZCBhIDQgVEIgcHNlcnYuXG4gICAgICBjb3VudGVyc1tcIlNLSVAtcmVzZXJ2ZVwiXSsrO1xuICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgbnMudHByaW50KGBTS0lQLXJlc2VydmUgICAgIHdhbGxldD0kJHt3YWxsZXQudG9Mb2NhbGVTdHJpbmcoKX0gPCAkJHtyZXNlcnZlRmxvb3IudG9Mb2NhbGVTdHJpbmcoKX1gKTtcbiAgICAgIH1cbiAgICAgIGlmIChvbmNlIHx8IHZlcmJvc2UpIHtcbiAgICAgICAgbnMudHByaW50KGBkb25lOiAke09iamVjdC5lbnRyaWVzKGNvdW50ZXJzKS5maWx0ZXIoKFssIHZdKSA9PiB2ID4gMCkubWFwKChbaywgdl0pID0+IGAke2t9PSR7dn1gKS5qb2luKFwiIFwiKSB8fCBcIm5vIGNoYW5nZXNcIn1gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyAxLiBCdXkgYSBuZXcgcHNlcnYgYXQgdGhlIHRpZXIncyB0YXJnZXQgUkFNIGlmIHdlIGhhdmUgaGVhZHJvb20uXG4gICAgLy8gICAgV2UgbmV2ZXIgYnV5IGEgbmV3IHNlcnZlciBiZWxvdyB0aGUgdGllciB0YXJnZXQg4oCUIGV2ZXJ5XG4gICAgLy8gICAgZnJlc2ggcHNlcnYgbGFuZHMgYXQgdGhlIGFjdGl2ZSB0aWVyJ3Mgc3BlYy5cbiAgICAvL1xuICAgIC8vICAgIEFUIE1PU1QgT05FIGJ1eSBwZXIgcGFzcyAod2FzIHVubGltaXRlZDsgdGhlIHVzZXIgcmVwb3J0ZWRcbiAgICAvLyAgICB0aGUgZGFlbW9uIGJ1eWluZyAyLTMgc2VydmVycyBwZXIgdGljayB3aGVuIGZ1bmRzIGFsbG93ZWQpLlxuICAgIC8vICAgIE9uZSBidXkgcGVyIHRpY2sgbWF0Y2hlcyB0aGUgd2FsbGV0IGdyb3d0aCByYXRlOyBtdWx0aS1idXlcbiAgICAvLyAgICBwZXIgdGljayBpcyB3aGF0IGRyYWluZWQgdGhlIHdhbGxldC5cbiAgICBpZiAoY291bnQgPCBuZXdTZXJ2ZXJDYXAgJiYgY291bnQgPCBNQVhfUk9TVEVSKSB7XG4gICAgICBjb25zdCBzbG90ID0gZmlyc3RNaXNzaW5nU2xvdCgpO1xuICAgICAgaWYgKHNsb3QgPj0gMCkge1xuICAgICAgICBjb25zdCBuYW1lID0gYCR7Uk9TVEVSX1BSRUZJWH0ke3Nsb3R9YDtcbiAgICAgICAgY29uc3QgY29zdCA9IG5zLmNsb3VkLmdldFNlcnZlckNvc3QodGllci50YXJnZXRHQik7XG4gICAgICAgIC8vIENoZWNrIHJlc2VydmUgZmxvb3IgZmlyc3Q6IGlmIHRoZSBidXkgd291bGQgZHJvcCB1c1xuICAgICAgICAvLyBiZWxvdyB0aGUgZmxvb3IsIHNraXAgd2l0aCBTS0lQLXJlc2VydmUuXG4gICAgICAgIGlmICh3YWxsZXQgLSBjb3N0IDwgcmVzZXJ2ZUZsb29yKSB7XG4gICAgICAgICAgY291bnRlcnNbXCJTS0lQLXJlc2VydmVcIl0rKztcbiAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgbnMudHByaW50KGBTS0lQLXJlc2VydmUgICAgIG5ldyAke25hbWV9ICR7dGllci50YXJnZXRHQn1HQiB3b3VsZCBsZWF2ZSB3YWxsZXQ9JCR7KHdhbGxldCAtIGNvc3QpLnRvTG9jYWxlU3RyaW5nKCl9IDwgJCR7cmVzZXJ2ZUZsb29yLnRvTG9jYWxlU3RyaW5nKCl9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKHJ1bGVGcmFjdGlvbiA+IDAgJiYgY29zdCA+IHdhbGxldCAqIHJ1bGVGcmFjdGlvbikge1xuICAgICAgICAgIGNvdW50ZXJzW1wiU0tJUC1ydWxlXCJdKys7XG4gICAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICAgIG5zLnRwcmludChgU0tJUC1ydWxlICAgICAgIG5ldyAke25hbWV9ICR7dGllci50YXJnZXRHQn1HQiAkJHtjb3N0LnRvTG9jYWxlU3RyaW5nKCl9ID4gJHsocnVsZUZyYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSUgb2Ygd2FsbGV0ICQke3dhbGxldC50b0xvY2FsZVN0cmluZygpfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChjb3N0ID4gd2FsbGV0KSB7XG4gICAgICAgICAgY291bnRlcnNbXCJTS0lQLWZ1bmRzXCJdKys7XG4gICAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICAgIG5zLnRwcmludChgU0tJUC1mdW5kcyAgICAgIG5vIG5ldyAke25hbWV9IChuZWVkICQke2Nvc3QudG9Mb2NhbGVTdHJpbmcoKX0sIGhhdmUgJCR7d2FsbGV0LnRvTG9jYWxlU3RyaW5nKCl9KWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBucy5jbG91ZC5wdXJjaGFzZVNlcnZlcihuYW1lLCB0aWVyLnRhcmdldEdCKTtcbiAgICAgICAgICBpZiAocmVzdWx0ICE9PSBcIlwiKSB7XG4gICAgICAgICAgICBjb3VudGVyc1tcIlBTRVJWLUJPVUdIVFwiXSsrO1xuICAgICAgICAgICAgLy8gUFNFUlYtQk9VR0hUIGlzIHRoZSBpbnRlcmVzdGluZyBldmVudDsgYWx3YXlzIHByaW50IGV2ZW5cbiAgICAgICAgICAgIC8vIGluIHF1aWV0IG1vZGUuIE1hdGNoZXMgbW9uaXRvci1oYWNrbmV0J3MgTk9ERS1CT1VHSFRcbiAgICAgICAgICAgIC8vIGJlaGF2aW9yLlxuICAgICAgICAgICAgbnMudHByaW50KGBQU0VSVi1CT1VHSFQgICAgJHtyZXN1bHR9ICR7dGllci50YXJnZXRHQn1HQiBmb3IgJCR7Y29zdC50b0xvY2FsZVN0cmluZygpfSAobm93ICR7Y291bnQgKyAxfS8ke01BWF9ST1NURVJ9KWApO1xuICAgICAgICAgICAgLy8gUHVzaCB0aGUgd29ya2VyIHNjcmlwdHMgc28gdGhlIG1hbmFnZXIgY2FuIGV4ZWMgdG9cbiAgICAgICAgICAgIC8vIHRoaXMgbmV3IHNlcnZlci4gV2l0aG91dCB0aGlzLCB0aGUgbmV3IHBzZXJ2IHNpdHNcbiAgICAgICAgICAgIC8vIGVtcHR5IHVudGlsIHRoZSBuZXh0IG1hbnVhbCBgcnVuIHN5bmMtYWxsLmpzYC5cbiAgICAgICAgICAgIGlmICghcHVzaFdvcmtlclNjcmlwdHMocmVzdWx0KSkge1xuICAgICAgICAgICAgICBjb3VudGVyc1tcIkZBSUwtc2NwXCJdID0gKGNvdW50ZXJzW1wiRkFJTC1zY3BcIl0gfHwgMCkgKyAxO1xuICAgICAgICAgICAgICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBGQUlMLXNjcCAgICAgICAgJHtyZXN1bHR9IChjb3VsZG4ndCBwdXNoIHdvcmtlciBzY3JpcHRzKWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBwdXJjaGFzZVNlcnZlciByZXR1cm5zIFwiXCIgb24gdGhlIGNhcCBvciBzb21lIG90aGVyXG4gICAgICAgICAgICAvLyByYWNlLiBXZSBwcmUtY2hlY2tlZCB0aGUgY2FwLCBzbyB0aGlzIGlzIHVudXN1YWwuXG4gICAgICAgICAgICBjb3VudGVyc1tcIkZBSUwtcHVyY2hhc2VTZXJ2ZXJcIl0rKztcbiAgICAgICAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgICAgICAgIG5zLnRwcmludChgRkFJTC1wdXJjaGFzZVNlcnZlciAgJHtuYW1lfSByZXR1cm5lZCBcIlwiIChjYXAgaGl0PyBmdW5kcyByYWNlPylgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGNvdW50ID49IG5ld1NlcnZlckNhcCkge1xuICAgICAgY291bnRlcnNbXCJTS0lQLWNhcFwiXSsrO1xuICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgU0tJUC1jYXAgICAgICAgIGF0IG5ldy1zZXJ2ZXIgY2FwICgke2NvdW50fS8ke25ld1NlcnZlckNhcH0pYCk7XG4gICAgfSBlbHNlIGlmIChjb3VudCA+PSBNQVhfUk9TVEVSKSB7XG4gICAgICBjb3VudGVyc1tcIlNLSVAtY2FwXCJdKys7XG4gICAgICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBTS0lQLWNhcCAgICAgICAgYXQgZ2FtZSBjYXAgKCR7Y291bnR9LyR7TUFYX1JPU1RFUn0pYCk7XG4gICAgfVxuXG4gICAgLy8gMi4gV2FsayBldmVyeSBleGlzdGluZyBwc2VydiBhbmQgYXBwbHkgQVQgTU9TVCBPTkUgc25hcC10by1cbiAgICAvLyAgICB0YXJnZXQgdXBncmFkZS4gU2FtZSBwYXR0ZXJuIGFzIG1vbml0b3ItaGFja25ldDogY2hlYXBlc3RcbiAgICAvLyAgICBjYW5kaWRhdGUgZmlyc3QsIDEtdG8tMyBSdWxlIGdhdGVzIGl0LCBubyBsb29waW5nIG92ZXJcbiAgICAvLyAgICB0aGUgd2FsbGV0LlxuICAgIC8vXG4gICAgLy8gICAgU05BUC1UTy1UQVJHRVQgKHdhcyAyw5cgc3RlcCkuIEZvciBldmVyeSBwc2VydiB1bmRlciB0aGVcbiAgICAvLyAgICBhY3RpdmUgdGllcidzIHRhcmdldEdCLCBjb21wdXRlIHRoZSBjb3N0IHRvIGp1bXAgRElSRUNUTFlcbiAgICAvLyAgICB0byB0aGUgdGFyZ2V0LiBQaWNrIHRoZSBjaGVhcGVzdCBzdWNoIGp1bXAgKHRoZSBzbWFsbGVzdFxuICAgIC8vICAgIHBzZXJ2IGlzIHR5cGljYWxseSB0aGUgY2hlYXBlc3QgdG8gdXBncmFkZSwgc2luY2UgcGVyLUdCXG4gICAgLy8gICAgY29zdCBncm93cyB3aXRoIHNpemUpLlxuICAgIC8vXG4gICAgLy8gICAgVGhlIDLDlyBzdGVwIHRoZSBwcmV2aW91cyB2ZXJzaW9uIHVzZWQgd2FzIGEgbXVsdGktdGlja1xuICAgIC8vICAgIHdhbGs6IDY0IOKGkiAxMjgg4oaSIDI1NiDihpIgNTEyIOKGkiAxMDI0IGlzIDUgdGlja3MgcGVyIHBzZXJ2IMOXXG4gICAgLy8gICAgMjUgcHNlcnZzID0gbWFueSBtaW51dGVzIG9mIGNodXJuLiBFYWNoIHRpY2sgc3BlbnQgYnVkZ2V0XG4gICAgLy8gICAgb24gYSAyw5cgc2NhbGUgdGhhdCBkaWRuJ3QgYnJpbmcgdGhlIHBzZXJ2IHRvIGl0cyBmaW5hbFxuICAgIC8vICAgIHNpemUuIFRoZSBzbmFwIHZlcnNpb24gbGFuZHMgdGhlIEZJTkFMIHN0YXRlIGluIG9uZVxuICAgIC8vICAgIGRlbGV0ZStyZWJ1eSBwZXIgcHNlcnYgcGVyIHRpY2ssIGdhdGVkIGJ5IHRoZSAxLXRvLTMgUnVsZVxuICAgIC8vICAgIGFuZCByZXNlcnZlIGZsb29yIGxpa2UgYmVmb3JlLlxuICAgIC8vXG4gICAgLy8gICAgU291cmNlZCBmcm9tIHNrZWVzbGVyL2JpdGJ1cm5lci1jb21tYW5kZXIvbWF5YmVCdXlTZXJ2ZXJcbiAgICAvLyAgICAoY29tbWFuZGVyLmpzOjE0OC0xNjMpOiBcImZpbmQgdGhlIHNtYWxsZXN0IHNlcnZlciBiZWxvd1xuICAgIC8vICAgIHRhcmdldCBzaXplIGFuZCB1cGdyYWRlIGl0LlwiIE91ciBwYXNzIGlzIHRoZSBzYW1lIGlkZWEsXG4gICAgLy8gICAgYXBwbGllZCBwZXIgdGljayB3aXRoIHdhbGxldC1yZXN0cmFpbnQgZ2F0ZXMuXG4gICAgLy9cbiAgICAvLyAgICBXZSByZS1yZWFkIHRoZSBjb3VudCBhZnRlciB0aGUgQlVZIHN0ZXAgc28gYSBmcmVzaGx5LWJvdWdodFxuICAgIC8vICAgIHBzZXJ2IGlzIGFsc28gZWxpZ2libGUgdG8gYmUgc2NhbGVkIGluIHRoZSBzYW1lIHBhc3MuXG4gICAgY29uc3QgbGl2ZUNvdW50ID0gY3VycmVudENvdW50KCk7XG4gICAgY29uc3QgbGl2ZVNwZW5kQ2FwID0gcnVsZUZyYWN0aW9uID4gMCA/IHdhbGxldCAqIHJ1bGVGcmFjdGlvbiA6IEluZmluaXR5O1xuICAgIGNvbnN0IHRhcmdldEdCID0gY2VpbFBvdzJBdExlYXN0KHRpZXIudGFyZ2V0R0IpOyAgLy8gcG93ZXItb2YtMiBzbmFwXG4gICAgbGV0IGJlc3RJZHggPSAtMTtcbiAgICBsZXQgYmVzdENvc3QgPSBJbmZpbml0eTtcbiAgICBsZXQgYWJzQ2hlYXBlc3RDb3N0ID0gSW5maW5pdHk7XG4gICAgbGV0IGFueVBlbmRpbmcgPSBmYWxzZTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxpdmVDb3VudDsgaSsrKSB7XG4gICAgICBjb25zdCBuYW1lID0gYCR7Uk9TVEVSX1BSRUZJWH0ke2l9YDtcbiAgICAgIGlmICghbnMuc2VydmVyRXhpc3RzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGN1cnJlbnRHQiA9IG5zLmdldFNlcnZlck1heFJhbShuYW1lKTtcbiAgICAgIGlmIChjdXJyZW50R0IgPj0gdGFyZ2V0R0IpIGNvbnRpbnVlOyAgICAgICAgLy8gYXQgb3IgYWJvdmUgdGFyZ2V0XG4gICAgICBpZiAoY3VycmVudEdCID49IE1BWF9SQU0pIGNvbnRpbnVlOyAgICAgICAgICAvLyBhdCBnYW1lIGNhcFxuICAgICAgYW55UGVuZGluZyA9IHRydWU7XG4gICAgICBjb25zdCBjID0gY29zdE9mU2NhbGUodGFyZ2V0R0IpOyAgICAgICAgICAgICAvLyBzbmFwIHRvIHRpZXIgdGFyZ2V0LCBub3QgMsOXXG4gICAgICBpZiAoYyA8IGFic0NoZWFwZXN0Q29zdCkgYWJzQ2hlYXBlc3RDb3N0ID0gYztcbiAgICAgIGlmIChjIDw9IGxpdmVTcGVuZENhcCAmJiBjIDwgYmVzdENvc3QpIHtcbiAgICAgICAgYmVzdENvc3QgPSBjO1xuICAgICAgICBiZXN0SWR4ID0gaTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGJlc3RJZHggPCAwKSB7XG4gICAgICBpZiAoIWFueVBlbmRpbmcpIHtcbiAgICAgICAgY291bnRlcnNbXCJTS0lQLXRpZXItbWV0XCJdKys7XG4gICAgICB9IGVsc2UgaWYgKGFic0NoZWFwZXN0Q29zdCA+IHdhbGxldCkge1xuICAgICAgICBjb3VudGVyc1tcIlNLSVAtZnVuZHNcIl0rKztcbiAgICAgICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgICAgICBucy50cHJpbnQoYFNLSVAtZnVuZHMgICAgICBubyBzY2FsZSBmaXRzIHdhbGxldCAoY2hlYXBlc3QgJCR7YWJzQ2hlYXBlc3RDb3N0LnRvTG9jYWxlU3RyaW5nKCl9LCB3YWxsZXQgJCR7d2FsbGV0LnRvTG9jYWxlU3RyaW5nKCl9KWApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHdhbGxldCAtIGFic0NoZWFwZXN0Q29zdCA8IHJlc2VydmVGbG9vcikge1xuICAgICAgICAvLyBUaGUgY2hlYXBlc3Qgc2NhbGUgd291bGQgZHJvcCB1cyBiZWxvdyB0aGUgcmVzZXJ2ZVxuICAgICAgICAvLyBmbG9vci4gU0tJUC1yZXNlcnZlIGFuZCBsZXQgdGhlIHdhbGxldCBncm93LlxuICAgICAgICBjb3VudGVyc1tcIlNLSVAtcmVzZXJ2ZVwiXSsrO1xuICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgIG5zLnRwcmludChgU0tJUC1yZXNlcnZlICAgICBjaGVhcGVzdCBzY2FsZSAkJHthYnNDaGVhcGVzdENvc3QudG9Mb2NhbGVTdHJpbmcoKX0gd291bGQgbGVhdmUgd2FsbGV0PSQkeyh3YWxsZXQgLSBhYnNDaGVhcGVzdENvc3QpLnRvTG9jYWxlU3RyaW5nKCl9IDwgJCR7cmVzZXJ2ZUZsb29yLnRvTG9jYWxlU3RyaW5nKCl9YCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvdW50ZXJzW1wiU0tJUC1ydWxlXCJdKys7XG4gICAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgICAgbnMudHByaW50KGBTS0lQLXJ1bGUgICAgICAgY2hlYXBlc3Qgc2NhbGUgJCR7YWJzQ2hlYXBlc3RDb3N0LnRvTG9jYWxlU3RyaW5nKCl9ID4gJHsocnVsZUZyYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSUgb2Ygd2FsbGV0ICQke3dhbGxldC50b0xvY2FsZVN0cmluZygpfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEFwcGx5IHRoZSBjaGVhcGVzdCBzY2FsZTogZGVsZXRlICsgcmVwdXJjaGFzZSBhdCB0aGVcbiAgICAgIC8vIHRhcmdldCBzaXplLiBTbmFwLXRvLXRhcmdldCBtZWFucyB0aGUgbmV3IHNpemUgaXNcbiAgICAgIC8vIGFsd2F5cyBgdGFyZ2V0R0JgICh0aGUgdGllcidzIGdvYWwsIHNuYXBwZWQgdG8gYSBwb3dlclxuICAgICAgLy8gb2YgMikuIElmIHRoZSBhY3R1YWwgc2NhbGUgY29zdCB3b3VsZCBkcm9wIHVzIGJlbG93XG4gICAgICAvLyB0aGUgcmVzZXJ2ZSBmbG9vciwgc2tpcCB3aXRoIFNLSVAtcmVzZXJ2ZS5cbiAgICAgIGNvbnN0IHRhcmdldE5hbWUgPSBgJHtST1NURVJfUFJFRklYfSR7YmVzdElkeH1gO1xuICAgICAgY29uc3QgY3VycmVudEdCID0gbnMuZ2V0U2VydmVyTWF4UmFtKHRhcmdldE5hbWUpO1xuICAgICAgY29uc3QgbmV3R0IgPSB0YXJnZXRHQjtcbiAgICAgIGlmICh3YWxsZXQgLSBiZXN0Q29zdCA8IHJlc2VydmVGbG9vcikge1xuICAgICAgICBjb3VudGVyc1tcIlNLSVAtcmVzZXJ2ZVwiXSsrO1xuICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgIG5zLnRwcmludChgU0tJUC1yZXNlcnZlICAgICBzY2FsZSAke3RhcmdldE5hbWV9ICR7Y3VycmVudEdCfUdC4oaSJHtuZXdHQn1HQiAkJHtiZXN0Q29zdC50b0xvY2FsZVN0cmluZygpfSB3b3VsZCBsZWF2ZSB3YWxsZXQ9JCR7KHdhbGxldCAtIGJlc3RDb3N0KS50b0xvY2FsZVN0cmluZygpfSA8ICQke3Jlc2VydmVGbG9vci50b0xvY2FsZVN0cmluZygpfWApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKCFucy5jbG91ZC5kZWxldGVTZXJ2ZXIodGFyZ2V0TmFtZSkpIHtcbiAgICAgICAgY291bnRlcnNbXCJGQUlMLWRlbGV0ZVNlcnZlclwiXSsrO1xuICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgIG5zLnRwcmludChgRkFJTC1kZWxldGVTZXJ2ZXIgICR7dGFyZ2V0TmFtZX0gKHJ1bm5pbmcgc2NyaXB0cz8gUkFNIGluIHVzZT8pYCk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRG9uJ3QgY29udGludWUg4oCUIGEgZGVsZXRlU2VydmVyIGZhaWx1cmUgdXN1YWxseSBtZWFuc1xuICAgICAgICAvLyBzY3JpcHRzIGFyZSBwaW5uZWQgdG8gdGhlIHNlcnZlcjsgb25lIGZhaWx1cmUgdGVuZHMgdG9cbiAgICAgICAgLy8gY2FzY2FkZSwgc28gd2Ugc3RvcCB0aGUgcGFzcyBoZXJlLlxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gbnMuY2xvdWQucHVyY2hhc2VTZXJ2ZXIodGFyZ2V0TmFtZSwgbmV3R0IpO1xuICAgICAgICBpZiAocmVzdWx0ID09PSBcIlwiKSB7XG4gICAgICAgICAgY291bnRlcnNbXCJGQUlMLXB1cmNoYXNlQWZ0ZXJEZWxldGVcIl0rKztcbiAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgbnMudHByaW50KGBGQUlMLXB1cmNoYXNlQWZ0ZXJEZWxldGUgICR7dGFyZ2V0TmFtZX0gJHtuZXdHQn1HQiAoc2xvdCByZS10YWtlbj8gcmFjZT8pYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvdW50ZXJzW1wiU0NBTEVEXCJdKys7XG4gICAgICAgICAgLy8gUHVzaCB3b3JrZXIgc2NyaXB0cyB0byB0aGUgcmUtcHVyY2hhc2VkIChzY2FsZWQpIHNlcnZlci5cbiAgICAgICAgICAvLyBTYW1lIHJlYXNvbmluZyBhcyBQU0VSVi1CT1VHSFQg4oCUIHRoZSBkZWxldGUrcmVjcmVhdGUgd2lwZXNcbiAgICAgICAgICAvLyB0aGUgZmlsZSBzeXN0ZW0gb24gdGhlIHBzZXJ2LCBzbyB3b3JrZXJzIGNhbid0IHJ1biBvbiBpdFxuICAgICAgICAgIC8vIHVudGlsIHdlIHJlLXNjcCB0aGVtLlxuICAgICAgICAgIGlmICghcHVzaFdvcmtlclNjcmlwdHMocmVzdWx0KSkge1xuICAgICAgICAgICAgY291bnRlcnNbXCJGQUlMLXNjcFwiXSA9IChjb3VudGVyc1tcIkZBSUwtc2NwXCJdIHx8IDApICsgMTtcbiAgICAgICAgICAgIGlmICh2ZXJib3NlKSBucy50cHJpbnQoYEZBSUwtc2NwICAgICAgICAke3Jlc3VsdH0gKGNvdWxkbid0IHB1c2ggd29ya2VyIHNjcmlwdHMgYWZ0ZXIgc2NhbGUpYCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgICAgICBucy50cHJpbnQoYFNDQUxFRCAgICAgICAgICAke3Jlc3VsdH0gICR7Y3VycmVudEdCfUdCIOKGkiAke25ld0dCfUdCIGZvciAkJHtiZXN0Q29zdC50b0xvY2FsZVN0cmluZygpfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChvbmNlIHx8IHZlcmJvc2UpIHtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBPYmplY3QuZW50cmllcyhjb3VudGVycylcbiAgICAgICAgLmZpbHRlcigoWywgdl0pID0+IHYgPiAwKVxuICAgICAgICAubWFwKChbaywgdl0pID0+IGAke2t9PSR7dn1gKVxuICAgICAgICAuam9pbihcIiBcIik7XG4gICAgICBjb25zdCBpbnRlcmVzdGluZyA9IGNvdW50ZXJzW1wiUFNFUlYtQk9VR0hUXCJdID4gMCB8fCBjb3VudGVyc1tcIlNDQUxFRFwiXSA+IDAgfHwgY291bnRlcnNbXCJGQUlMLXB1cmNoYXNlU2VydmVyXCJdID4gMCB8fCBjb3VudGVyc1tcIkZBSUwtZGVsZXRlU2VydmVyXCJdID4gMCB8fCBjb3VudGVyc1tcIkZBSUwtcHVyY2hhc2VBZnRlckRlbGV0ZVwiXSA+IDAgfHwgY291bnRlcnNbXCJGQUlMLXNjcFwiXSA+IDA7XG4gICAgICBpZiAob25jZSB8fCBpbnRlcmVzdGluZykge1xuICAgICAgICBucy50cHJpbnQoYGRvbmU6ICR7c3VtbWFyeSB8fCBcIm5vIGNoYW5nZXNcIn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAob25jZSkge1xuICAgIHBhc3MoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBtb25pdG9yLXNlcnZlcnM6IHN0YXJ0ZWQsIGludGVydmFsPSR7aW50ZXJ2YWxNc31tcywgb3V0cHV0PSR7dmVyYm9zZSA/IFwidmVyYm9zZVwiIDogXCJxdWlldFwifSwgY2FwPSR7bmV3U2VydmVyQ2FwfSwgcnVsZT0keyhydWxlRnJhY3Rpb24gKiAxMDApLnRvRml4ZWQoMCl9JWApO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIHBhc3MoKTtcbiAgICBhd2FpdCBucy5zbGVlcChpbnRlcnZhbE1zKTtcbiAgfVxufVxuIl19