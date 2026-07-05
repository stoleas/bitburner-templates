/** @param {NS} ns */
//
// Long-lived daemon that keeps a Corporation profitable with no
// manual clicking. Walks every division / city and:
//   - Hires employees up to the per-division target (--target-employees).
//   - Assigns them across Operations/Engineer/Business/R&D with
//     a balanced job mix that matches the industry type.
//   - Expands to a new city when the division has the cash to
//     afford it (warehouse + office + initial employees).
//   - Buys industry unlocks and the standard "starter" upgrades
//     (Smart Factories, Smart Storage, Wilson Analytics, FocusWires).
//   - Sets smart supply where the unlock exists.
//   - Sells produced materials/products with a configurable markup
//     over the market price.
//   - Auto-accepts investment offers above a configurable valuation
//     threshold (only if --accept-investments is set).
//   - Buys tea and throws parties on a long-ish cadence to keep
//     morale/energy up.
//
// Why this script exists:
//   The Corporation UI is a micromanagement nightmare. Every
//   division in every city has its own employee pool, job mix,
//   warehouse, and product line, and the game requires you to
//   click through ALL of them every couple of minutes to keep
//   things moving. This script replaces all of that with one
//   loop.
//
// What this script does NOT do:
//   - It does NOT create the corporation. Founding a Corp is a
//     one-time action in the UI (City → Aevum First Financial;
//     pick a name; toggle "self-fund" if you have the cash and
//     want the 150b seed money). After founding, this script
//     takes over.
//   - It does NOT expand to a second division (e.g. from
//     Agriculture to Tobacco). Adding a new division is a
//     significant strategic decision (cost, employee allocation,
//     market selection) and the script silently ignores new-
//     division needs — you add them by hand, the script manages
//     whatever divisions exist at startup.
//   - It does NOT develop new products beyond the first one for
//     each division. The first product in a division gets
//     developed with a fixed design/marketing investment. New
//     products per division are gated by the "uPgrade: Capacity"
//     research, which the script will research but the actual
//     product creation is left to the user (it's a one-time
//     decision, not a loop task).
//   - It does NOT handle the "Sell for Corporation Funds" hash
//     upgrade. That's a separate loop driven by your wallet's
//     state; this script only deals with corp-internal cash.
//
// Tuning knobs:
//   --target-employees   headcount ceiling per city (default 9,
//                        the natural "9-employee" early-game
//                        stop). Setting this higher means the
//                        script will keep hiring up to that
//                        number, but salary cost grows linearly.
//   --product-markup     "MP+5" / "MP*1.5" / etc. pricing string
//                        passed to sellProduct. Default is "MP+5"
//                        which is the conservative beginner mark.
//   --material-markup    same idea, for materials. Default "MP".
//   --accept-investments auto-accept investment offers if the
//                        offered funds per share look reasonable.
//   --no-accept-investments (default) just print the offer.
//
// BitNode 3 (Corporation) specifics:
//   - You can self-fund with $150b OR get the $150b seed for free.
//   - CorporationSoftcap is 0.5, so softcap and valuation mults
//     are reasonable. The script works as-is.
//
// BitNode elsewhere:
//   - BitNode 1..8: needs seed money ($150b is the early-game corp
//     unlock threshold). Most BitNodes make this achievable
//     mid-late game.
//   - BitNode 2 (Gang): disableCorporation is true, the script
//     will exit immediately. That's a feature, not a bug.
//   - BitNode 3: this is the corp BN, so the script is the whole
//     point.
//   - BitNode 9: hacknet hashes replace cash income, corp still
//     works but salary costs are still in cash. Make sure you have
//     income sources outside the corp.
//
// Output is QUIET by default — only HIRED / EXPANDED-city /
// UPGRADED / INVESTMENT / RESEARCH / SELL-event lines print.
// --verbose opts in to per-tick cash and per-division employee
// counts. --once runs a single decision pass with full output
// and exits (diagnostic).
//
// Usage:
//   run monitor-corp.js                       # loop, every corp tick, QUIET
//   run monitor-corp.js --once                # one pass, full output, then exit
//   run monitor-corp.js --verbose             # loop with per-division state
//   run monitor-corp.js --target-employees 15 # bigger offices
//   run monitor-corp.js --product-markup "MP*1.5"  # more aggressive pricing
//   run monitor-corp.js --accept-investments  # auto-accept good offers
//
const USAGE = `Usage:
 run monitor-corp.js                       # loop, every corp tick, QUIET
 run monitor-corp.js --once                # one pass, full output, then exit
 run monitor-corp.js --verbose             # loop with per-division state
 run monitor-corp.js --target-employees 15 # bigger offices (default 9)
 run monitor-corp.js --product-markup "MP*1.5"  # product pricing (default MP+5)
 run monitor-corp.js --material-markup "MP+1"   # material pricing (default MP)
 run monitor-corp.js --accept-investments  # auto-accept good offers
`;
// Defaults.
const DEFAULT_TARGET_EMPLOYEES = 9; // the natural "3x3" office grid
const DEFAULT_PRODUCT_MARKUP = "MP+5"; // "MP" is market price; "MP+5" is +$5/unit
const DEFAULT_MATERIAL_MARKUP = "MP"; // materials are competitive, hold at MP
const DEFAULT_MAX_NEW_SHARES = 100e9; // safety bound; script never issues >$100b of new shares/tick
const DEFAULT_RESERVE_FRACTION = 0.10; // keep 10% of corp cash untouched (for emergency costs)
// Per-industry job mix. The "right" mix depends on the industry
// type: an Agriculture division wants more Operations + a few
// Engineers; a product industry (Tobacco, Software, etc.) wants
// more R&D and Business. We bias by industry type. Numbers are
// (Operations, Engineer, Business, R&D) and must sum to 1.
//
// Source: in-game UI "optimal" hints and the wiki's early-game
// guide for each industry. The exact ratio doesn't matter as
// long as we're not piling everyone into one job.
const INDUSTRY_MIX = {
    // Materials producers — Operations is the bottleneck, Engineering
    // helps production mult, R&D and Business are nice-to-have.
    Agriculture: { Operations: 0.50, Engineer: 0.25, Business: 0.10, "Research & Development": 0.15 },
    Mining: { Operations: 0.50, Engineer: 0.25, Business: 0.10, "Research & Development": 0.15 },
    Chemical: { Operations: 0.45, Engineer: 0.25, Business: 0.15, "Research & Development": 0.15 },
    Fishing: { Operations: 0.50, Engineer: 0.20, Business: 0.15, "Research & Development": 0.15 },
    Food: { Operations: 0.45, Engineer: 0.20, Business: 0.20, "Research & Development": 0.15 },
    // "Mixed" industries — more even split.
    Tobacco: { Operations: 0.40, Engineer: 0.20, Business: 0.20, "Research & Development": 0.20 },
    Energy: { Operations: 0.40, Engineer: 0.30, Business: 0.10, "Research & Development": 0.20 },
    Utilities: { Operations: 0.40, Engineer: 0.30, Business: 0.10, "Research & Development": 0.20 },
    Pharmaceutical: { Operations: 0.35, Engineer: 0.25, Business: 0.20, "Research & Development": 0.20 },
    Robotics: { Operations: 0.35, Engineer: 0.30, Business: 0.15, "Research & Development": 0.20 },
    // Product industries — R&D and Business are the value drivers.
    Software: { Operations: 0.30, Engineer: 0.20, Business: 0.25, "Research & Development": 0.25 },
    Hardware: { Operations: 0.30, Engineer: 0.25, Business: 0.20, "Research & Development": 0.25 },
    RealEstate: { Operations: 0.30, Engineer: 0.20, Business: 0.30, "Research & Development": 0.20 },
    // Default: balanced
    _default: { Operations: 0.40, Engineer: 0.25, Business: 0.15, "Research & Development": 0.20 },
};
// Starter unlocks (in this order). Each entry: (unlockName, cost).
// These are one-time corp-wide unlocks. The script only buys each
// once. Note: "Export" is a separate division decision; this script
// does not auto-buy it because the export topology is strategic.
// "Smart Supply", "Market Research - Demand", "Market Data -
// Competition" are all useful and are bought when affordable.
const STARTER_UNLOCKS = [
    "Office API",
    "Warehouse API",
    "Smart Supply",
    "Market Research - Demand",
    "Market Data - Competition",
    "Shady Accounting",
    "Government Partnership", // $10b — passive money
    // "Export" intentionally omitted — see header comment.
];
// Upgrades (one-at-a-time, can be leveled). Cheapest first, so the
// script always applies the most bang-for-buck next level. The
// script only buys one level per tick to avoid blowing the reserve.
const UPGRADE_LEVEL_ORDER = [
    "Smart Factories",
    "Smart Storage",
    "Wilson Analytics",
    "FocusWires",
    "ABC SalesBots",
    "Nuoptimal Nootropic Injector Implants",
    "Speech Processor Implants",
    "Neural Accelerators",
    "Project Insight",
];
// Research priority. List the common researches we want unlocked
// for every division. Product-only researches are added only if the
// division actually makes products (checked at runtime).
const BASE_RESEARCH = [
    "Hi-Tech R&D Laboratory",
    "AutoBrew",
    "AutoPartyManager",
    "Drones",
    "Drones - Assembly",
    "Drones - Transport",
    "Self-Correcting Assemblers",
    "uPgrade: Dashboard",
];
const PRODUCT_RESEARCH = [
    "Market-TA.I",
    "Market-TA.II",
    "uPgrade: Capacity.I",
    "uPgrade: Capacity.II",
    "Overclock",
    "Sti.mu",
    "CPH4 Injections",
    "Go-Juice",
    "Automatic Drug Administration",
    "HRBuddy-Recruitment",
    "HRBuddy-Training",
    "uPgrade: Fulcrum",
];
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    // Gate: corp must exist AND the BN must not disable it. Without
    // hasCorporation, every corp call would error. The user might
    // have the API installed but be in BN-2 (disableCorporation) —
    // the API methods just throw in that case, so we check the BN
    // multiplier up front.
    if (!ns.corporation.hasCorporation()) {
        ns.tprint("ERROR: no corporation found. Found one in the UI first (City → Aevum First Financial), then run this script.");
        return;
    }
    const player = ns.getPlayer();
    if (player.bitNodeN === 2) {
        ns.tprint("ERROR: BitNode 2 disables corporations (disableCorporation = true). This script cannot run here.");
        return;
    }
    // Parse args.
    const args = ns.args.slice();
    const once = args.includes("--once");
    const verbose = args.includes("--verbose");
    const acceptInvestments = args.includes("--accept-investments");
    const targetIdx = args.indexOf("--target-employees");
    const targetEmployees = targetIdx >= 0 ? Math.max(0, Math.floor(Number(args[targetIdx + 1]))) : DEFAULT_TARGET_EMPLOYEES;
    if (targetIdx >= 0 && (!Number.isFinite(targetEmployees) || targetEmployees < 0)) {
        ns.tprint(`monitor-corp: --target-employees must be a non-negative integer (got ${args[targetIdx + 1]})`);
        return;
    }
    const prodMarkupIdx = args.indexOf("--product-markup");
    const productMarkup = prodMarkupIdx >= 0 ? String(args[prodMarkupIdx + 1]) : DEFAULT_PRODUCT_MARKUP;
    const matMarkupIdx = args.indexOf("--material-markup");
    const materialMarkup = matMarkupIdx >= 0 ? String(args[matMarkupIdx + 1]) : DEFAULT_MATERIAL_MARKUP;
    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("scan");
    // Per-division cache: each tick we read getDivision once and reuse
    // the result for the rest of the pass. Without this we'd be
    // double-billing RAM costs on every function call.
    const CITIES = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"];
    // Helper: how much cash the corp has, MINUS a small reserve. Used
    // as the upper bound for "can we afford X" checks. The reserve
    // keeps the corp liquid in case of sudden costs (employee raise,
    // import fees, etc.).
    function spendableCash(corp) {
        return Math.max(0, corp.funds * (1 - DEFAULT_RESERVE_FRACTION));
    }
    // Helper: hire a single employee into a position. Tries
    // "Operations" if not specified, which is the most common early
    // job. Note: hireEmployee only succeeds if the office has space
    // — it auto-grows the office by 3 slots when it can.
    function hireOne(div, city, position) {
        // Check if the office has space first; grow it by 3 if it
        // doesn't, then retry. upgradeOfficeSize throws if we can't
        // afford it, so we check with getOfficeSizeUpgradeCost.
        const office = ns.corporation.getOffice(div, city);
        if (office.numEmployees >= office.size) {
            const grow = 3;
            const cost = ns.corporation.getOfficeSizeUpgradeCost(div, city, grow);
            const cash = ns.corporation.getCorporation().funds;
            if (Number.isFinite(cost) && cost > 0 && cost < cash * (1 - DEFAULT_RESERVE_FRACTION)) {
                try {
                    ns.corporation.upgradeOfficeSize(div, city, grow);
                    ns.tprint(`UPGRADED-office ${div}/${city} +${grow} (cost=$${cost.toFixed(0)})`);
                }
                catch (e) {
                    // We can't afford; bail on this hire for this tick.
                    return false;
                }
            }
            else {
                // Can't afford to grow the office; bail.
                return false;
            }
        }
        return ns.corporation.hireEmployee(div, city, position);
    }
    // Apply a balanced job mix for the office. The job counts add up
    // to the current headcount, weighted by the industry-specific
    // mix. The REMAINDER (one or two employees) goes to whatever role
    // the mix says is most important for this industry.
    function applyJobMix(div, industry, city) {
        const office = ns.corporation.getOffice(div, city);
        const mix = INDUSTRY_MIX[industry] || INDUSTRY_MIX._default;
        const n = office.numEmployees;
        if (n === 0)
            return;
        // Compute the target counts. We assign floor(n * weight) to
        // each job, then top up the highest-priority job to reach n.
        const jobs = ["Operations", "Engineer", "Business", "Research & Development"];
        const targets = {};
        let assigned = 0;
        for (const j of jobs) {
            targets[j] = Math.floor(n * mix[j]);
            assigned += targets[j];
        }
        // Top-up: put the remainder into the highest-weight job (first
        // job in the mix list with the largest weight).
        let topJob = jobs[0];
        for (const j of jobs)
            if (mix[j] > mix[topJob])
                topJob = j;
        targets[topJob] += n - assigned;
        for (const j of jobs) {
            if (targets[j] > 0) {
                try {
                    ns.corporation.setJobAssignment(div, city, j, targets[j]);
                }
                catch (e) {
                    // setJobAssignment throws on bad job name; ignore.
                }
            }
        }
    }
    // Buy "starter" unlocks (Office API, Warehouse API, Smart Supply,
    // etc.) one at a time. Each is a one-time corp-wide unlock. We
    // track bought unlocks in a Set so we don't try to re-buy.
    const boughtUnlocks = new Set();
    function buyStarterUnlocks(corp) {
        for (const name of STARTER_UNLOCKS) {
            if (boughtUnlocks.has(name))
                continue;
            if (ns.corporation.hasUnlock(name)) {
                boughtUnlocks.add(name);
                continue;
            }
            const cost = ns.corporation.getUnlockCost(name);
            if (!Number.isFinite(cost) || cost <= 0) {
                boughtUnlocks.add(name); // free or N/A
                continue;
            }
            if (cost < spendableCash(corp)) {
                try {
                    ns.corporation.purchaseUnlock(name);
                    boughtUnlocks.add(name);
                    ns.tprint(`UNLOCKED       ${name}  cost=$${cost.toFixed(0)}`);
                }
                catch (e) {
                    // Race: cash changed between check and purchase. Try
                    // again next tick.
                }
            }
        }
    }
    // Buy the cheapest next upgrade level. Loops one level per tick
    // to avoid blowing the reserve.
    function buyUpgrades(corp) {
        for (const name of UPGRADE_LEVEL_ORDER) {
            const cost = ns.corporation.getUpgradeLevelCost(name);
            if (!Number.isFinite(cost) || cost <= 0)
                continue; // maxed
            if (cost < spendableCash(corp)) {
                try {
                    ns.corporation.levelUpgrade(name);
                    ns.tprint(`UPGRADED       ${name}  level=${ns.corporation.getUpgradeLevel(name)}  cost=$${cost.toFixed(0)}`);
                    return; // one per tick
                }
                catch (e) {
                    return;
                }
            }
        }
    }
    // Research what's missing for a division, in priority order. We
    // track researched names in a Set so we don't repeatedly try.
    const researchedPerDiv = new Map(); // divName -> Set of researched names
    function researchForDiv(div, industry) {
        let done = researchedPerDiv.get(div);
        if (!done) {
            done = new Set();
            researchedPerDiv.set(div, done);
        }
        const industryData = ns.corporation.getIndustryData(industry);
        const makesProducts = industryData.makesProducts;
        const list = [...BASE_RESEARCH];
        if (makesProducts)
            list.push(...PRODUCT_RESEARCH);
        for (const name of list) {
            if (done.has(name))
                continue;
            if (ns.corporation.hasResearched(div, name)) {
                done.add(name);
                continue;
            }
            const cost = ns.corporation.getResearchCost(div, name);
            if (!Number.isFinite(cost) || cost <= 0) {
                done.add(name); // free or unknown
                continue;
            }
            const corp = ns.corporation.getCorporation();
            if (cost < spendableCash(corp)) {
                try {
                    ns.corporation.research(div, name);
                    done.add(name);
                    ns.tprint(`RESEARCHED     ${div}/${name}  cost=$${cost.toFixed(0)}`);
                    return; // one per tick per pass
                }
                catch (e) {
                    return;
                }
            }
        }
    }
    // Expand a division to a new city if the cash supports it. Cost
    // is roughly: warehouseInitialCost + officeInitialCost + 3
    // initial employees' salary first cycle. We approximate with a
    // generous multiplier and check actual cash.
    function maybeExpandCity(div) {
        const d = ns.corporation.getDivision(div);
        if (d.cities.length >= CITIES.length)
            return;
        for (const city of CITIES) {
            if (d.cities.includes(city))
                continue;
            // Probe: try expandCity, see if it throws. There's no
            // getExpandCost API, so we attempt and check.
            const corp = ns.corporation.getCorporation();
            // Conservative gate: need at least 10x current revenue in
            // cash. Without this, expanding into a new city on a thin
            // wallet starves the existing cities.
            const gate = corp.revenue > 0 ? corp.revenue * 10 : 1e9;
            if (corp.funds < gate)
                return;
            try {
                ns.corporation.expandCity(div, city);
                // Also buy a warehouse there so production can start.
                try {
                    ns.corporation.purchaseWarehouse(div, city);
                }
                catch (e) { /* warehouse might already exist */ }
                // Hire a starter set so the new city isn't a ghost.
                for (let i = 0; i < 3; i++)
                    ns.corporation.hireEmployee(div, city, "Operations");
                ns.tprint(`EXPANDED-city   ${div}/${city}  cities=${d.cities.length + 1}/${CITIES.length}`);
                return;
            }
            catch (e) {
                // Can't afford or city unavailable; try the next city.
            }
        }
    }
    // Set up selling for a division's products / materials. We do
    // this for every product the division has, using sellProduct
    // with the configured markup. "MP" means market price; the API
    // supports "MP+5", "MP*1.5", "MP" etc.
    function setupSelling(div, city) {
        const d = ns.corporation.getDivision(div);
        // Sell every material the division produces (not buys).
        for (const mat of d.makesProducts ? [] : []) { /* placeholder, see below */ }
        // We don't have a direct "produced materials" list per division
        // in the API. Try the standard set; the call is cheap and
        // sellMaterial is a no-op for materials the division doesn't
        // make. The set is small (12 names) so we just enumerate.
        for (const mat of ["Minerals", "Ore", "Water", "Food", "Plants", "Metal", "Hardware", "Chemicals", "Drugs", "Robots", "AI Cores", "Real Estate"]) {
            try {
                // Sell PROD/2 each cycle at market markup. The "PROD/2"
                // string tells the engine to sell half of what was produced
                // last cycle, which is the conventional "don't sell
                // everything" ratio (keeps stock in the warehouse for
                // resilience against demand spikes).
                ns.corporation.sellMaterial(div, city, mat, "PROD/2", materialMarkup);
            }
            catch (e) {
                // Material not produced here; ignore.
            }
        }
        // Sell every product the division has developed. For product
        // divisions, sell MAX at the configured markup.
        for (const productName of d.products) {
            try {
                ns.corporation.sellProduct(div, city, productName, "MAX", productMarkup, true);
            }
            catch (e) {
                // Product might not be developed yet (under design); ignore.
            }
        }
    }
    // Enable smart supply on a division's warehouse for each city.
    // Requires the "Smart Supply" unlock (which buyStarterUnlocks
    // buys on its own). The function is a no-op if the unlock isn't
    // there.
    function enableSmartSupply(div) {
        if (!ns.corporation.hasUnlock("Smart Supply"))
            return;
        for (const city of CITIES) {
            try {
                ns.corporation.setSmartSupply(div, city, true);
            }
            catch (e) { /* warehouse not yet bought in this city */ }
        }
    }
    // Develop the first product for a division, if it doesn't have
    // one. The investment numbers are conservative (designed for
    // early-game capital efficiency). New products beyond the first
    // are NOT auto-created; see header.
    const firstProductDone = new Set();
    function developFirstProduct(div, industry) {
        if (firstProductDone.has(div))
            return;
        const d = ns.corporation.getDivision(div);
        if (d.products.length > 0) {
            firstProductDone.add(div);
            return;
        }
        // "Product" industries only. Material industries (Agriculture,
        // Mining, etc.) don't have a "first product" concept.
        const industryData = ns.corporation.getIndustryData(industry);
        if (!industryData.makesProducts) {
            firstProductDone.add(div);
            return;
        }
        // Require "Hi-Tech R&D Laboratory" research first; without it
        // we can't develop a product at all.
        if (!ns.corporation.hasResearched(div, "Hi-Tech R&D Laboratory"))
            return;
        const corp = ns.corporation.getCorporation();
        // Conservative investments. $1b design + $1b marketing is a
        // reasonable starting point; the player can top these up
        // manually if they want a better product.
        const designInvest = 1e9;
        const marketingInvest = 1e9;
        if (corp.funds < designInvest + marketingInvest + 1e9)
            return; // keep a reserve
        try {
            const productName = `${div}-Product`;
            // pick a city that has employees
            const city = d.cities[0];
            if (!city)
                return;
            ns.corporation.makeProduct(div, city, productName, designInvest, marketingInvest);
            firstProductDone.add(div);
            ns.tprint(`PRODUCT        ${div}/${productName}  design=$${designInvest.toLocaleString()} marketing=$${marketingInvest.toLocaleString()}`);
        }
        catch (e) {
            // Race / not enough cash; try next tick.
        }
    }
    // Accept an investment offer if it looks good. "Good" is a vague
    // metric; we use funds-per-share as a proxy. The default
    // threshold is "any offer", which is almost always a good idea
    // because investments boost valuation (which boosts share
    // price, which boosts the next round). The script can be tuned
    // with --accept-investments off (default) to be conservative.
    function maybeAcceptInvestment() {
        if (!acceptInvestments)
            return;
        const offer = ns.corporation.getInvestmentOffer();
        if (!offer || offer.funds <= 0)
            return;
        if (offer.round < 1 || offer.round > 4)
            return;
        const pps = offer.funds / Math.max(1, offer.shares);
        // No hard threshold — investments are almost always worth it.
        // Skip if the offer is suspiciously small (round 1 with tiny
        // funds is usually a "wait it out" situation).
        if (offer.funds < 1e8)
            return;
        try {
            const ok = ns.corporation.acceptInvestmentOffer();
            if (ok)
                ns.tprint(`INVESTMENT     round=${offer.round}  funds=$${offer.funds.toFixed(0)}  shares=${offer.shares.toFixed(0)}  ($/share=$${pps.toFixed(2)})`);
        }
        catch (e) { /* ignore */ }
    }
    // Per-division cadence counter for tea+party (cheap morale boost).
    // Tick counter is per-division so divisions don't all hit the
    // "party time" tick on the same game state transition, which
    // would briefly starve the corp's cash.
    const teaAndPartyTick = {};
    // One corp tick. The corp cycles through PRODUCTION → SALE → etc.
    // on a 200ms cadence, so 2s is a comfortable "do work, then
    // yield" interval. Using nextUpdate() would tie the script to
    // the slowest state transition; a fixed sleep is fine because
    // most of the work here is O(divisions) and the corp grows
    // slowly.
    function pass() {
        const corp = ns.corporation.getCorporation();
        if (!corp)
            return; // corp deleted out from under us
        const counters = { hired: 0, offices: 0, expanded: 0 };
        // 1. Buy corp-wide unlocks.
        buyStarterUnlocks(corp);
        // 2. Buy corp-wide upgrades.
        buyUpgrades(corp);
        // 3. Maybe accept an investment.
        maybeAcceptInvestment();
        // 4. Walk every division.
        for (const divName of corp.divisions) {
            const div = ns.corporation.getDivision(divName);
            // Per-division research.
            researchForDiv(divName, div.industry);
            // Smart supply (no-op if unlock missing).
            enableSmartSupply(divName);
            // Try to expand to a new city.
            const before = div.cities.length;
            maybeExpandCity(divName);
            const divAfter = ns.corporation.getDivision(divName);
            if (divAfter.cities.length > before)
                counters.expanded++;
            // Develop first product if applicable.
            developFirstProduct(divName, div.industry);
            // Set up selling for every city the division has.
            for (const city of divAfter.cities) {
                setupSelling(divName, city);
            }
            // Hire employees up to target, balanced mix.
            for (const city of divAfter.cities) {
                const office = ns.corporation.getOffice(divName, city);
                if (office.numEmployees >= targetEmployees)
                    continue;
                // Hire one at a time so we don't blow the cash budget.
                const ok = hireOne(divName, city, "Operations");
                if (ok)
                    counters.hired++;
                else
                    break; // can't afford; try again next tick
            }
            // Re-apply job mix (hiring changed the headcount).
            for (const city of divAfter.cities) {
                applyJobMix(divName, div.industry, city);
            }
            // Buy tea and throw a party (cheap morale boost) on a slow
            // cadence — once every ~20 ticks. We use a tick counter
            // keyed by the division so the cadence is per-division.
            teaAndPartyTick[divName] = (teaAndPartyTick[divName] || 0) + 1;
            if (teaAndPartyTick[divName] % 20 === 0) {
                for (const city of divAfter.cities) {
                    try {
                        ns.corporation.buyTea(divName, city);
                    }
                    catch (e) { /* no money */ }
                    try {
                        ns.corporation.throwParty(divName, city, 500_000);
                    }
                    catch (e) { /* no money */ }
                }
            }
        }
        if (verbose) {
            const after = ns.corporation.getCorporation();
            for (const divName of after.divisions) {
                const d = ns.corporation.getDivision(divName);
                const empTotal = d.cities.reduce((s, c) => s + ns.corporation.getOffice(divName, c).numEmployees, 0);
                ns.tprint(`division ${divName.padEnd(12)} ${d.industry.padEnd(14)} cities=${d.cities.length} emp=${empTotal} rev=$${d.thisCycleRevenue.toFixed(0)}/s exp=$${d.thisCycleExpenses.toFixed(0)}/s fund=$${after.funds.toFixed(0)}`);
            }
        }
        return counters;
    }
    if (once) {
        pass();
        return;
    }
    ns.tprint(`monitor-corp: started, target-employees=${targetEmployees}, output=${verbose ? "verbose" : "quiet"}, investments=${acceptInvestments ? "auto" : "off"}`);
    while (true) {
        pass();
        // 2s sleep: corp updates on a 200ms cycle internally, so 2s
        // is 10 cycles — long enough that a single tick of corp work
        // completes, short enough to keep the script responsive.
        await ns.sleep(2000);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1jb3JwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21vbml0b3ItY29ycC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLGdFQUFnRTtBQUNoRSxvREFBb0Q7QUFDcEQsMEVBQTBFO0FBQzFFLGdFQUFnRTtBQUNoRSx5REFBeUQ7QUFDekQsOERBQThEO0FBQzlELDBEQUEwRDtBQUMxRCxnRUFBZ0U7QUFDaEUsc0VBQXNFO0FBQ3RFLGlEQUFpRDtBQUNqRCxtRUFBbUU7QUFDbkUsNkJBQTZCO0FBQzdCLG9FQUFvRTtBQUNwRSx1REFBdUQ7QUFDdkQsZ0VBQWdFO0FBQ2hFLHdCQUF3QjtBQUN4QixFQUFFO0FBQ0YsMEJBQTBCO0FBQzFCLDZEQUE2RDtBQUM3RCwrREFBK0Q7QUFDL0QsOERBQThEO0FBQzlELDhEQUE4RDtBQUM5RCw2REFBNkQ7QUFDN0QsVUFBVTtBQUNWLEVBQUU7QUFDRixnQ0FBZ0M7QUFDaEMsK0RBQStEO0FBQy9ELCtEQUErRDtBQUMvRCwrREFBK0Q7QUFDL0QsNkRBQTZEO0FBQzdELGtCQUFrQjtBQUNsQix5REFBeUQ7QUFDekQsMERBQTBEO0FBQzFELGlFQUFpRTtBQUNqRSw2REFBNkQ7QUFDN0QsZ0VBQWdFO0FBQ2hFLDJDQUEyQztBQUMzQyxnRUFBZ0U7QUFDaEUsMERBQTBEO0FBQzFELDhEQUE4RDtBQUM5RCxpRUFBaUU7QUFDakUsOERBQThEO0FBQzlELDREQUE0RDtBQUM1RCxrQ0FBa0M7QUFDbEMsK0RBQStEO0FBQy9ELDhEQUE4RDtBQUM5RCw2REFBNkQ7QUFDN0QsRUFBRTtBQUNGLGdCQUFnQjtBQUNoQixnRUFBZ0U7QUFDaEUsNkRBQTZEO0FBQzdELDhEQUE4RDtBQUM5RCw0REFBNEQ7QUFDNUQsaUVBQWlFO0FBQ2pFLGlFQUFpRTtBQUNqRSxrRUFBa0U7QUFDbEUsa0VBQWtFO0FBQ2xFLGlFQUFpRTtBQUNqRSw4REFBOEQ7QUFDOUQsa0VBQWtFO0FBQ2xFLDREQUE0RDtBQUM1RCxFQUFFO0FBQ0YscUNBQXFDO0FBQ3JDLG1FQUFtRTtBQUNuRSxnRUFBZ0U7QUFDaEUsOENBQThDO0FBQzlDLEVBQUU7QUFDRixxQkFBcUI7QUFDckIsbUVBQW1FO0FBQ25FLDREQUE0RDtBQUM1RCxxQkFBcUI7QUFDckIsK0RBQStEO0FBQy9ELDBEQUEwRDtBQUMxRCxpRUFBaUU7QUFDakUsYUFBYTtBQUNiLGdFQUFnRTtBQUNoRSxtRUFBbUU7QUFDbkUsdUNBQXVDO0FBQ3ZDLEVBQUU7QUFDRiw0REFBNEQ7QUFDNUQsNkRBQTZEO0FBQzdELCtEQUErRDtBQUMvRCw4REFBOEQ7QUFDOUQsMEJBQTBCO0FBQzFCLEVBQUU7QUFDRixTQUFTO0FBQ1QsNkVBQTZFO0FBQzdFLGlGQUFpRjtBQUNqRiw2RUFBNkU7QUFDN0UsK0RBQStEO0FBQy9ELDZFQUE2RTtBQUM3RSx3RUFBd0U7QUFDeEUsRUFBRTtBQUNGLE1BQU0sS0FBSyxHQUFHOzs7Ozs7OztDQVFiLENBQUM7QUFFRixZQUFZO0FBQ1osTUFBTSx3QkFBd0IsR0FBRyxDQUFDLENBQUMsQ0FBTyxnQ0FBZ0M7QUFDMUUsTUFBTSxzQkFBc0IsR0FBRyxNQUFNLENBQUMsQ0FBSSwyQ0FBMkM7QUFDckYsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLENBQUMsQ0FBSyx3Q0FBd0M7QUFDbEYsTUFBTSxzQkFBc0IsR0FBRyxLQUFLLENBQUMsQ0FBSyw4REFBOEQ7QUFDeEcsTUFBTSx3QkFBd0IsR0FBRyxJQUFJLENBQUMsQ0FBSSx3REFBd0Q7QUFFbEcsZ0VBQWdFO0FBQ2hFLDhEQUE4RDtBQUM5RCxnRUFBZ0U7QUFDaEUsK0RBQStEO0FBQy9ELDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsK0RBQStEO0FBQy9ELDZEQUE2RDtBQUM3RCxrREFBa0Q7QUFDbEQsTUFBTSxZQUFZLEdBQUc7SUFDbkIsa0VBQWtFO0lBQ2xFLDREQUE0RDtJQUM1RCxXQUFXLEVBQVEsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSx3QkFBd0IsRUFBRSxJQUFJLEVBQUU7SUFDdkcsTUFBTSxFQUFhLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUUsSUFBSSxFQUFFO0lBQ3ZHLFFBQVEsRUFBVyxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFLElBQUksRUFBRTtJQUN2RyxPQUFPLEVBQVksRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSx3QkFBd0IsRUFBRSxJQUFJLEVBQUU7SUFDdkcsSUFBSSxFQUFlLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUUsSUFBSSxFQUFFO0lBQ3ZHLHdDQUF3QztJQUN4QyxPQUFPLEVBQVksRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSx3QkFBd0IsRUFBRSxJQUFJLEVBQUU7SUFDdkcsTUFBTSxFQUFhLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUUsSUFBSSxFQUFFO0lBQ3ZHLFNBQVMsRUFBVSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFLElBQUksRUFBRTtJQUN2RyxjQUFjLEVBQUssRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSx3QkFBd0IsRUFBRSxJQUFJLEVBQUU7SUFDdkcsUUFBUSxFQUFX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QUFTLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsWUFBWSxLQUFLLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7YUFDak87U0FDRjtRQUVELE9BQU8sUUFBUSxDQUFDO0lBQ2xCLENBQUM7SUFFRCxJQUFJLElBQUksRUFBRTtRQUNSLElBQUksRUFBRSxDQUFDO1FBQ1AsT0FBTztLQUNSO0lBRUQsRUFBRSxDQUFDLE1BQU0sQ0FBQywyQ0FBMkMsZUFBZSxZQUFZLE9BQU8sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxPQUFPLGlCQUFpQixpQkFBaUIsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3BLLE9BQU8sSUFBSSxFQUFFO1FBQ1gsSUFBSSxFQUFFLENBQUM7UUFDUCw0REFBNEQ7UUFDNUQsNkRBQTZEO1FBQzdELHlEQUF5RDtRQUN6RCxNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7S0FDdEI7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gTG9uZy1saXZlZCBkYWVtb24gdGhhdCBrZWVwcyBhIENvcnBvcmF0aW9uIHByb2ZpdGFibGUgd2l0aCBub1xuLy8gbWFudWFsIGNsaWNraW5nLiBXYWxrcyBldmVyeSBkaXZpc2lvbiAvIGNpdHkgYW5kOlxuLy8gICAtIEhpcmVzIGVtcGxveWVlcyB1cCB0byB0aGUgcGVyLWRpdmlzaW9uIHRhcmdldCAoLS10YXJnZXQtZW1wbG95ZWVzKS5cbi8vICAgLSBBc3NpZ25zIHRoZW0gYWNyb3NzIE9wZXJhdGlvbnMvRW5naW5lZXIvQnVzaW5lc3MvUiZEIHdpdGhcbi8vICAgICBhIGJhbGFuY2VkIGpvYiBtaXggdGhhdCBtYXRjaGVzIHRoZSBpbmR1c3RyeSB0eXBlLlxuLy8gICAtIEV4cGFuZHMgdG8gYSBuZXcgY2l0eSB3aGVuIHRoZSBkaXZpc2lvbiBoYXMgdGhlIGNhc2ggdG9cbi8vICAgICBhZmZvcmQgaXQgKHdhcmVob3VzZSArIG9mZmljZSArIGluaXRpYWwgZW1wbG95ZWVzKS5cbi8vICAgLSBCdXlzIGluZHVzdHJ5IHVubG9ja3MgYW5kIHRoZSBzdGFuZGFyZCBcInN0YXJ0ZXJcIiB1cGdyYWRlc1xuLy8gICAgIChTbWFydCBGYWN0b3JpZXMsIFNtYXJ0IFN0b3JhZ2UsIFdpbHNvbiBBbmFseXRpY3MsIEZvY3VzV2lyZXMpLlxuLy8gICAtIFNldHMgc21hcnQgc3VwcGx5IHdoZXJlIHRoZSB1bmxvY2sgZXhpc3RzLlxuLy8gICAtIFNlbGxzIHByb2R1Y2VkIG1hdGVyaWFscy9wcm9kdWN0cyB3aXRoIGEgY29uZmlndXJhYmxlIG1hcmt1cFxuLy8gICAgIG92ZXIgdGhlIG1hcmtldCBwcmljZS5cbi8vICAgLSBBdXRvLWFjY2VwdHMgaW52ZXN0bWVudCBvZmZlcnMgYWJvdmUgYSBjb25maWd1cmFibGUgdmFsdWF0aW9uXG4vLyAgICAgdGhyZXNob2xkIChvbmx5IGlmIC0tYWNjZXB0LWludmVzdG1lbnRzIGlzIHNldCkuXG4vLyAgIC0gQnV5cyB0ZWEgYW5kIHRocm93cyBwYXJ0aWVzIG9uIGEgbG9uZy1pc2ggY2FkZW5jZSB0byBrZWVwXG4vLyAgICAgbW9yYWxlL2VuZXJneSB1cC5cbi8vXG4vLyBXaHkgdGhpcyBzY3JpcHQgZXhpc3RzOlxuLy8gICBUaGUgQ29ycG9yYXRpb24gVUkgaXMgYSBtaWNyb21hbmFnZW1lbnQgbmlnaHRtYXJlLiBFdmVyeVxuLy8gICBkaXZpc2lvbiBpbiBldmVyeSBjaXR5IGhhcyBpdHMgb3duIGVtcGxveWVlIHBvb2wsIGpvYiBtaXgsXG4vLyAgIHdhcmVob3VzZSwgYW5kIHByb2R1Y3QgbGluZSwgYW5kIHRoZSBnYW1lIHJlcXVpcmVzIHlvdSB0b1xuLy8gICBjbGljayB0aHJvdWdoIEFMTCBvZiB0aGVtIGV2ZXJ5IGNvdXBsZSBvZiBtaW51dGVzIHRvIGtlZXBcbi8vICAgdGhpbmdzIG1vdmluZy4gVGhpcyBzY3JpcHQgcmVwbGFjZXMgYWxsIG9mIHRoYXQgd2l0aCBvbmVcbi8vICAgbG9vcC5cbi8vXG4vLyBXaGF0IHRoaXMgc2NyaXB0IGRvZXMgTk9UIGRvOlxuLy8gICAtIEl0IGRvZXMgTk9UIGNyZWF0ZSB0aGUgY29ycG9yYXRpb24uIEZvdW5kaW5nIGEgQ29ycCBpcyBhXG4vLyAgICAgb25lLXRpbWUgYWN0aW9uIGluIHRoZSBVSSAoQ2l0eSDihpIgQWV2dW0gRmlyc3QgRmluYW5jaWFsO1xuLy8gICAgIHBpY2sgYSBuYW1lOyB0b2dnbGUgXCJzZWxmLWZ1bmRcIiBpZiB5b3UgaGF2ZSB0aGUgY2FzaCBhbmRcbi8vICAgICB3YW50IHRoZSAxNTBiIHNlZWQgbW9uZXkpLiBBZnRlciBmb3VuZGluZywgdGhpcyBzY3JpcHRcbi8vICAgICB0YWtlcyBvdmVyLlxuLy8gICAtIEl0IGRvZXMgTk9UIGV4cGFuZCB0byBhIHNlY29uZCBkaXZpc2lvbiAoZS5nLiBmcm9tXG4vLyAgICAgQWdyaWN1bHR1cmUgdG8gVG9iYWNjbykuIEFkZGluZyBhIG5ldyBkaXZpc2lvbiBpcyBhXG4vLyAgICAgc2lnbmlmaWNhbnQgc3RyYXRlZ2ljIGRlY2lzaW9uIChjb3N0LCBlbXBsb3llZSBhbGxvY2F0aW9uLFxuLy8gICAgIG1hcmtldCBzZWxlY3Rpb24pIGFuZCB0aGUgc2NyaXB0IHNpbGVudGx5IGlnbm9yZXMgbmV3LVxuLy8gICAgIGRpdmlzaW9uIG5lZWRzIOKAlCB5b3UgYWRkIHRoZW0gYnkgaGFuZCwgdGhlIHNjcmlwdCBtYW5hZ2VzXG4vLyAgICAgd2hhdGV2ZXIgZGl2aXNpb25zIGV4aXN0IGF0IHN0YXJ0dXAuXG4vLyAgIC0gSXQgZG9lcyBOT1QgZGV2ZWxvcCBuZXcgcHJvZHVjdHMgYmV5b25kIHRoZSBmaXJzdCBvbmUgZm9yXG4vLyAgICAgZWFjaCBkaXZpc2lvbi4gVGhlIGZpcnN0IHByb2R1Y3QgaW4gYSBkaXZpc2lvbiBnZXRzXG4vLyAgICAgZGV2ZWxvcGVkIHdpdGggYSBmaXhlZCBkZXNpZ24vbWFya2V0aW5nIGludmVzdG1lbnQuIE5ld1xuLy8gICAgIHByb2R1Y3RzIHBlciBkaXZpc2lvbiBhcmUgZ2F0ZWQgYnkgdGhlIFwidVBncmFkZTogQ2FwYWNpdHlcIlxuLy8gICAgIHJlc2VhcmNoLCB3aGljaCB0aGUgc2NyaXB0IHdpbGwgcmVzZWFyY2ggYnV0IHRoZSBhY3R1YWxcbi8vICAgICBwcm9kdWN0IGNyZWF0aW9uIGlzIGxlZnQgdG8gdGhlIHVzZXIgKGl0J3MgYSBvbmUtdGltZVxuLy8gICAgIGRlY2lzaW9uLCBub3QgYSBsb29wIHRhc2spLlxuLy8gICAtIEl0IGRvZXMgTk9UIGhhbmRsZSB0aGUgXCJTZWxsIGZvciBDb3Jwb3JhdGlvbiBGdW5kc1wiIGhhc2hcbi8vICAgICB1cGdyYWRlLiBUaGF0J3MgYSBzZXBhcmF0ZSBsb29wIGRyaXZlbiBieSB5b3VyIHdhbGxldCdzXG4vLyAgICAgc3RhdGU7IHRoaXMgc2NyaXB0IG9ubHkgZGVhbHMgd2l0aCBjb3JwLWludGVybmFsIGNhc2guXG4vL1xuLy8gVHVuaW5nIGtub2JzOlxuLy8gICAtLXRhcmdldC1lbXBsb3llZXMgICBoZWFkY291bnQgY2VpbGluZyBwZXIgY2l0eSAoZGVmYXVsdCA5LFxuLy8gICAgICAgICAgICAgICAgICAgICAgICB0aGUgbmF0dXJhbCBcIjktZW1wbG95ZWVcIiBlYXJseS1nYW1lXG4vLyAgICAgICAgICAgICAgICAgICAgICAgIHN0b3ApLiBTZXR0aW5nIHRoaXMgaGlnaGVyIG1lYW5zIHRoZVxuLy8gICAgICAgICAgICAgICAgICAgICAgICBzY3JpcHQgd2lsbCBrZWVwIGhpcmluZyB1cCB0byB0aGF0XG4vLyAgICAgICAgICAgICAgICAgICAgICAgIG51bWJlciwgYnV0IHNhbGFyeSBjb3N0IGdyb3dzIGxpbmVhcmx5LlxuLy8gICAtLXByb2R1Y3QtbWFya3VwICAgICBcIk1QKzVcIiAvIFwiTVAqMS41XCIgLyBldGMuIHByaWNpbmcgc3RyaW5nXG4vLyAgICAgICAgICAgICAgICAgICAgICAgIHBhc3NlZCB0byBzZWxsUHJvZHVjdC4gRGVmYXVsdCBpcyBcIk1QKzVcIlxuLy8gICAgICAgICAgICAgICAgICAgICAgICB3aGljaCBpcyB0aGUgY29uc2VydmF0aXZlIGJlZ2lubmVyIG1hcmsuXG4vLyAgIC0tbWF0ZXJpYWwtbWFya3VwICAgIHNhbWUgaWRlYSwgZm9yIG1hdGVyaWFscy4gRGVmYXVsdCBcIk1QXCIuXG4vLyAgIC0tYWNjZXB0LWludmVzdG1lbnRzIGF1dG8tYWNjZXB0IGludmVzdG1lbnQgb2ZmZXJzIGlmIHRoZVxuLy8gICAgICAgICAgICAgICAgICAgICAgICBvZmZlcmVkIGZ1bmRzIHBlciBzaGFyZSBsb29rIHJlYXNvbmFibGUuXG4vLyAgIC0tbm8tYWNjZXB0LWludmVzdG1lbnRzIChkZWZhdWx0KSBqdXN0IHByaW50IHRoZSBvZmZlci5cbi8vXG4vLyBCaXROb2RlIDMgKENvcnBvcmF0aW9uKSBzcGVjaWZpY3M6XG4vLyAgIC0gWW91IGNhbiBzZWxmLWZ1bmQgd2l0aCAkMTUwYiBPUiBnZXQgdGhlICQxNTBiIHNlZWQgZm9yIGZyZWUuXG4vLyAgIC0gQ29ycG9yYXRpb25Tb2Z0Y2FwIGlzIDAuNSwgc28gc29mdGNhcCBhbmQgdmFsdWF0aW9uIG11bHRzXG4vLyAgICAgYXJlIHJlYXNvbmFibGUuIFRoZSBzY3JpcHQgd29ya3MgYXMtaXMuXG4vL1xuLy8gQml0Tm9kZSBlbHNld2hlcmU6XG4vLyAgIC0gQml0Tm9kZSAxLi44OiBuZWVkcyBzZWVkIG1vbmV5ICgkMTUwYiBpcyB0aGUgZWFybHktZ2FtZSBjb3JwXG4vLyAgICAgdW5sb2NrIHRocmVzaG9sZCkuIE1vc3QgQml0Tm9kZXMgbWFrZSB0aGlzIGFjaGlldmFibGVcbi8vICAgICBtaWQtbGF0ZSBnYW1lLlxuLy8gICAtIEJpdE5vZGUgMiAoR2FuZyk6IGRpc2FibGVDb3Jwb3JhdGlvbiBpcyB0cnVlLCB0aGUgc2NyaXB0XG4vLyAgICAgd2lsbCBleGl0IGltbWVkaWF0ZWx5LiBUaGF0J3MgYSBmZWF0dXJlLCBub3QgYSBidWcuXG4vLyAgIC0gQml0Tm9kZSAzOiB0aGlzIGlzIHRoZSBjb3JwIEJOLCBzbyB0aGUgc2NyaXB0IGlzIHRoZSB3aG9sZVxuLy8gICAgIHBvaW50LlxuLy8gICAtIEJpdE5vZGUgOTogaGFja25ldCBoYXNoZXMgcmVwbGFjZSBjYXNoIGluY29tZSwgY29ycCBzdGlsbFxuLy8gICAgIHdvcmtzIGJ1dCBzYWxhcnkgY29zdHMgYXJlIHN0aWxsIGluIGNhc2guIE1ha2Ugc3VyZSB5b3UgaGF2ZVxuLy8gICAgIGluY29tZSBzb3VyY2VzIG91dHNpZGUgdGhlIGNvcnAuXG4vL1xuLy8gT3V0cHV0IGlzIFFVSUVUIGJ5IGRlZmF1bHQg4oCUIG9ubHkgSElSRUQgLyBFWFBBTkRFRC1jaXR5IC9cbi8vIFVQR1JBREVEIC8gSU5WRVNUTUVOVCAvIFJFU0VBUkNIIC8gU0VMTC1ldmVudCBsaW5lcyBwcmludC5cbi8vIC0tdmVyYm9zZSBvcHRzIGluIHRvIHBlci10aWNrIGNhc2ggYW5kIHBlci1kaXZpc2lvbiBlbXBsb3llZVxuLy8gY291bnRzLiAtLW9uY2UgcnVucyBhIHNpbmdsZSBkZWNpc2lvbiBwYXNzIHdpdGggZnVsbCBvdXRwdXRcbi8vIGFuZCBleGl0cyAoZGlhZ25vc3RpYykuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBtb25pdG9yLWNvcnAuanMgICAgICAgICAgICAgICAgICAgICAgICMgbG9vcCwgZXZlcnkgY29ycCB0aWNrLCBRVUlFVFxuLy8gICBydW4gbW9uaXRvci1jb3JwLmpzIC0tb25jZSAgICAgICAgICAgICAgICAjIG9uZSBwYXNzLCBmdWxsIG91dHB1dCwgdGhlbiBleGl0XG4vLyAgIHJ1biBtb25pdG9yLWNvcnAuanMgLS12ZXJib3NlICAgICAgICAgICAgICMgbG9vcCB3aXRoIHBlci1kaXZpc2lvbiBzdGF0ZVxuLy8gICBydW4gbW9uaXRvci1jb3JwLmpzIC0tdGFyZ2V0LWVtcGxveWVlcyAxNSAjIGJpZ2dlciBvZmZpY2VzXG4vLyAgIHJ1biBtb25pdG9yLWNvcnAuanMgLS1wcm9kdWN0LW1hcmt1cCBcIk1QKjEuNVwiICAjIG1vcmUgYWdncmVzc2l2ZSBwcmljaW5nXG4vLyAgIHJ1biBtb25pdG9yLWNvcnAuanMgLS1hY2NlcHQtaW52ZXN0bWVudHMgICMgYXV0by1hY2NlcHQgZ29vZCBvZmZlcnNcbi8vXG5jb25zdCBVU0FHRSA9IGBVc2FnZTpcbiBydW4gbW9uaXRvci1jb3JwLmpzICAgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IGNvcnAgdGljaywgUVVJRVRcbiBydW4gbW9uaXRvci1jb3JwLmpzIC0tb25jZSAgICAgICAgICAgICAgICAjIG9uZSBwYXNzLCBmdWxsIG91dHB1dCwgdGhlbiBleGl0XG4gcnVuIG1vbml0b3ItY29ycC5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyBsb29wIHdpdGggcGVyLWRpdmlzaW9uIHN0YXRlXG4gcnVuIG1vbml0b3ItY29ycC5qcyAtLXRhcmdldC1lbXBsb3llZXMgMTUgIyBiaWdnZXIgb2ZmaWNlcyAoZGVmYXVsdCA5KVxuIHJ1biBtb25pdG9yLWNvcnAuanMgLS1wcm9kdWN0LW1hcmt1cCBcIk1QKjEuNVwiICAjIHByb2R1Y3QgcHJpY2luZyAoZGVmYXVsdCBNUCs1KVxuIHJ1biBtb25pdG9yLWNvcnAuanMgLS1tYXRlcmlhbC1tYXJrdXAgXCJNUCsxXCIgICAjIG1hdGVyaWFsIHByaWNpbmcgKGRlZmF1bHQgTVApXG4gcnVuIG1vbml0b3ItY29ycC5qcyAtLWFjY2VwdC1pbnZlc3RtZW50cyAgIyBhdXRvLWFjY2VwdCBnb29kIG9mZmVyc1xuYDtcblxuLy8gRGVmYXVsdHMuXG5jb25zdCBERUZBVUxUX1RBUkdFVF9FTVBMT1lFRVMgPSA5OyAgICAgICAvLyB0aGUgbmF0dXJhbCBcIjN4M1wiIG9mZmljZSBncmlkXG5jb25zdCBERUZBVUxUX1BST0RVQ1RfTUFSS1VQID0gXCJNUCs1XCI7ICAgIC8vIFwiTVBcIiBpcyBtYXJrZXQgcHJpY2U7IFwiTVArNVwiIGlzICskNS91bml0XG5jb25zdCBERUZBVUxUX01BVEVSSUFMX01BUktVUCA9IFwiTVBcIjsgICAgIC8vIG1hdGVyaWFscyBhcmUgY29tcGV0aXRpdmUsIGhvbGQgYXQgTVBcbmNvbnN0IERFRkFVTFRfTUFYX05FV19TSEFSRVMgPSAxMDBlOTsgICAgIC8vIHNhZmV0eSBib3VuZDsgc2NyaXB0IG5ldmVyIGlzc3VlcyA+JDEwMGIgb2YgbmV3IHNoYXJlcy90aWNrXG5jb25zdCBERUZBVUxUX1JFU0VSVkVfRlJBQ1RJT04gPSAwLjEwOyAgICAvLyBrZWVwIDEwJSBvZiBjb3JwIGNhc2ggdW50b3VjaGVkIChmb3IgZW1lcmdlbmN5IGNvc3RzKVxuXG4vLyBQZXItaW5kdXN0cnkgam9iIG1peC4gVGhlIFwicmlnaHRcIiBtaXggZGVwZW5kcyBvbiB0aGUgaW5kdXN0cnlcbi8vIHR5cGU6IGFuIEFncmljdWx0dXJlIGRpdmlzaW9uIHdhbnRzIG1vcmUgT3BlcmF0aW9ucyArIGEgZmV3XG4vLyBFbmdpbmVlcnM7IGEgcHJvZHVjdCBpbmR1c3RyeSAoVG9iYWNjbywgU29mdHdhcmUsIGV0Yy4pIHdhbnRzXG4vLyBtb3JlIFImRCBhbmQgQnVzaW5lc3MuIFdlIGJpYXMgYnkgaW5kdXN0cnkgdHlwZS4gTnVtYmVycyBhcmVcbi8vIChPcGVyYXRpb25zLCBFbmdpbmVlciwgQnVzaW5lc3MsIFImRCkgYW5kIG11c3Qgc3VtIHRvIDEuXG4vL1xuLy8gU291cmNlOiBpbi1nYW1lIFVJIFwib3B0aW1hbFwiIGhpbnRzIGFuZCB0aGUgd2lraSdzIGVhcmx5LWdhbWVcbi8vIGd1aWRlIGZvciBlYWNoIGluZHVzdHJ5LiBUaGUgZXhhY3QgcmF0aW8gZG9lc24ndCBtYXR0ZXIgYXNcbi8vIGxvbmcgYXMgd2UncmUgbm90IHBpbGluZyBldmVyeW9uZSBpbnRvIG9uZSBqb2IuXG5jb25zdCBJTkRVU1RSWV9NSVggPSB7XG4gIC8vIE1hdGVyaWFscyBwcm9kdWNlcnMg4oCUIE9wZXJhdGlvbnMgaXMgdGhlIGJvdHRsZW5lY2ssIEVuZ2luZWVyaW5nXG4gIC8vIGhlbHBzIHByb2R1Y3Rpb24gbXVsdCwgUiZEIGFuZCBCdXNpbmVzcyBhcmUgbmljZS10by1oYXZlLlxuICBBZ3JpY3VsdHVyZTogICAgICAgeyBPcGVyYXRpb25zOiAwLjUwLCBFbmdpbmVlcjogMC4yNSwgQnVzaW5lc3M6IDAuMTAsIFwiUmVzZWFyY2ggJiBEZXZlbG9wbWVudFwiOiAwLjE1IH0sXG4gIE1pbmluZzogICAgICAgICAgICB7IE9wZXJhdGlvbnM6IDAuNTAsIEVuZ2luZWVyOiAwLjI1LCBCdXNpbmVzczogMC4xMCwgXCJSZXNlYXJjaCAmIERldmVsb3BtZW50XCI6IDAuMTUgfSxcbiAgQ2hlbWljYWw6ICAgICAgICAgIHsgT3BlcmF0aW9uczogMC40NSwgRW5naW5lZXI6IDAuMjUsIEJ1c2luZXNzOiAwLjE1LCBcIlJlc2VhcmNoICYgRGV2ZWxvcG1lbnRcIjogMC4xNSB9LFxuICBGaXNoaW5nOiAgICAgICAgICAgeyBPcGVyYXRpb25zOiAwLjUwLCBFbmdpbmVlcjogMC4yMCwgQnVzaW5lc3M6IDAuMTUsIFwiUmVzZWFyY2ggJiBEZXZlbG9wbWVudFwiOiAwLjE1IH0sXG4gIEZvb2Q6ICAgICAgICAgICAgICB7IE9wZXJhdGlvbnM6IDAuNDUsIEVuZ2luZWVyOiAwLjIwLCBCdXNpbmVzczogMC4yMCwgXCJSZXNlYXJjaCAmIERldmVsb3BtZW50XCI6IDAuMTUgfSxcbiAgLy8gXCJNaXhlZFwiIGluZHVzdHJpZXMg4oCUIG1vcmUgZXZlbiBzcGxpdC5cbiAgVG9iYWNjbzogICAgICAgICAgIHsgT3BlcmF0aW9uczogMC40MCwgRW5naW5lZXI6IDAuMjAsIEJ1c2luZXNzOiAwLjIwLCBcIlJlc2VhcmNoICYgRGV2ZWxvcG1lbnRcIjogMC4yMCB9LFxuICBFbmVyZ3k6ICAgICAgICAgICAgeyBPcGVyYXRpb25zOiAwLjQwLCBFbmdpbmVlcjogMC4zMCwgQnVzaW5lc3M6IDAuMTAsIFwiUmVzZWFyY2ggJiBEZXZlbG9wbWVudFwiOiAwLjIwIH0sXG4gIFV0aWxpdGllczogICAgICAgICB7IE9wZXJhdGlvbnM6IDAuNDAsIEVuZ2luZWVyOiAwLjMwLCBCdXNpbmVzczogMC4xMCwgXCJSZXNlYXJjaCAmIERldmVsb3BtZW50XCI6IDAuMjAgfSxcbiAgUGhhcm1hY2V1dGljYWw6ICAgIHsgT3BlcmF0aW9uczogMC4zNSwgRW5naW5lZXI6IDAuMjUsIEJ1c2luZXNzOiAwLjIwLCBcIlJlc2VhcmNoICYgRGV2ZWxvcG1lbnRcIjogMC4yMCB9LFxuICBSb2JvdGljczogICAgICAgICAgeyBPcGVyYXRpb25zOiAwLjM1LCBFbmdpbmVlcjogMC4zMCwgQnVzaW5lc3M6IDAuMTUsIFwiUmVzZWFyY2ggJiBEZXZlbG9wbWVudFwiOiAwLjIwIH0sXG4gIC8vIFByb2R1Y3QgaW5kdXN0cmllcyDigJQgUiZEIGFuZCBCdXNpbmVzcyBhcmUgdGhlIHZhbHVlIGRyaXZlcnMuXG4gIFNvZnR3YXJlOiAgICAgICAgICB7IE9wZXJhdGlvbnM6IDAuMzAsIEVuZ2luZWVyOiAwLjIwLCBCdXNpbmVzczogMC4yNSwgXCJSZXNlYXJjaCAmIERldmVsb3BtZW50XCI6IDAuMjUgfSxcbiAgSGFyZHdhcmU6ICAgICAgICAgIHsgT3BlcmF0aW9uczogMC4zMCwgRW5naW5lZXI6IDAuMjUsIEJ1c2luZXNzOiAwLjIwLCBcIlJlc2VhcmNoICYgRGV2ZWxvcG1lbnRcIjogMC4yNSB9LFxuICBSZWFsRXN0YXRlOiAgICAgICAgeyBPcGVyYXRpb25zOiAwLjMwLCBFbmdpbmVlcjogMC4yMCwgQnVzaW5lc3M6IDAuMzAsIFwiUmVzZWFyY2ggJiBEZXZlbG9wbWVudFwiOiAwLjIwIH0sXG4gIC8vIERlZmF1bHQ6IGJhbGFuY2VkXG4gIF9kZWZhdWx0OiAgICAgICAgICB7IE9wZXJhdGlvbnM6IDAuNDAsIEVuZ2luZWVyOiAwLjI1LCBCdXNpbmVzczogMC4xNSwgXCJSZXNlYXJjaCAmIERldmVsb3BtZW50XCI6IDAuMjAgfSxcbn07XG5cbi8vIFN0YXJ0ZXIgdW5sb2NrcyAoaW4gdGhpcyBvcmRlcikuIEVhY2ggZW50cnk6ICh1bmxvY2tOYW1lLCBjb3N0KS5cbi8vIFRoZXNlIGFyZSBvbmUtdGltZSBjb3JwLXdpZGUgdW5sb2Nrcy4gVGhlIHNjcmlwdCBvbmx5IGJ1eXMgZWFjaFxuLy8gb25jZS4gTm90ZTogXCJFeHBvcnRcIiBpcyBhIHNlcGFyYXRlIGRpdmlzaW9uIGRlY2lzaW9uOyB0aGlzIHNjcmlwdFxuLy8gZG9lcyBub3QgYXV0by1idXkgaXQgYmVjYXVzZSB0aGUgZXhwb3J0IHRvcG9sb2d5IGlzIHN0cmF0ZWdpYy5cbi8vIFwiU21hcnQgU3VwcGx5XCIsIFwiTWFya2V0IFJlc2VhcmNoIC0gRGVtYW5kXCIsIFwiTWFya2V0IERhdGEgLVxuLy8gQ29tcGV0aXRpb25cIiBhcmUgYWxsIHVzZWZ1bCBhbmQgYXJlIGJvdWdodCB3aGVuIGFmZm9yZGFibGUuXG5jb25zdCBTVEFSVEVSX1VOTE9DS1MgPSBbXG4gIFwiT2ZmaWNlIEFQSVwiLCAgICAgICAgLy8gJDFiIOKAlCBuZWVkZWQgZm9yIHRoZSBzY3JpcHQgdG8gZG8gYW55dGhpbmdcbiAgXCJXYXJlaG91c2UgQVBJXCIsICAgICAvLyAkMWIg4oCUIG5lZWRlZCBmb3Igc21hcnQgc3VwcGx5IC8gbWF0ZXJpYWxzXG4gIFwiU21hcnQgU3VwcGx5XCIsICAgICAgLy8gJDFiIOKAlCBhdXRvLWJ1eSBtYXRlcmlhbHMsIGJpZyBRb0xcbiAgXCJNYXJrZXQgUmVzZWFyY2ggLSBEZW1hbmRcIiwgICAgICAvLyAkNWIg4oCUIHVubG9ja3MgZGVtYW5kLWJhc2VkIHByaWNpbmcgZGVjaXNpb25zXG4gIFwiTWFya2V0IERhdGEgLSBDb21wZXRpdGlvblwiLCAgICAgLy8gJDViIOKAlCBzYW1lIGZvciBjb21wZXRpdGlvblxuICBcIlNoYWR5IEFjY291bnRpbmdcIiwgIC8vICQ1YiDigJQgcGFzc2l2ZSBtb25leSAoaGlnaC12YWx1ZSBvbmNlIHlvdSBoYXZlIGl0KVxuICBcIkdvdmVybm1lbnQgUGFydG5lcnNoaXBcIiwgICAgICAgIC8vICQxMGIg4oCUIHBhc3NpdmUgbW9uZXlcbiAgLy8gXCJFeHBvcnRcIiBpbnRlbnRpb25hbGx5IG9taXR0ZWQg4oCUIHNlZSBoZWFkZXIgY29tbWVudC5cbl07XG5cbi8vIFVwZ3JhZGVzIChvbmUtYXQtYS10aW1lLCBjYW4gYmUgbGV2ZWxlZCkuIENoZWFwZXN0IGZpcnN0LCBzbyB0aGVcbi8vIHNjcmlwdCBhbHdheXMgYXBwbGllcyB0aGUgbW9zdCBiYW5nLWZvci1idWNrIG5leHQgbGV2ZWwuIFRoZVxuLy8gc2NyaXB0IG9ubHkgYnV5cyBvbmUgbGV2ZWwgcGVyIHRpY2sgdG8gYXZvaWQgYmxvd2luZyB0aGUgcmVzZXJ2ZS5cbmNvbnN0IFVQR1JBREVfTEVWRUxfT1JERVIgPSBbXG4gIFwiU21hcnQgRmFjdG9yaWVzXCIsICAgLy8gK3Byb2R1Y3Rpb24gbXVsdFxuICBcIlNtYXJ0IFN0b3JhZ2VcIiwgICAgIC8vICt3YXJlaG91c2Ugc3RvcmFnZVxuICBcIldpbHNvbiBBbmFseXRpY3NcIiwgIC8vICtwcm9kdWN0IHJhdGluZ1xuICBcIkZvY3VzV2lyZXNcIiwgICAgICAgIC8vICtlbXBsb3llZSBzdGF0c1xuICBcIkFCQyBTYWxlc0JvdHNcIiwgICAgIC8vICtzYWxlc1xuICBcIk51b3B0aW1hbCBOb290cm9waWMgSW5qZWN0b3IgSW1wbGFudHNcIixcbiAgXCJTcGVlY2ggUHJvY2Vzc29yIEltcGxhbnRzXCIsXG4gIFwiTmV1cmFsIEFjY2VsZXJhdG9yc1wiLFxuICBcIlByb2plY3QgSW5zaWdodFwiLFxuXTtcblxuLy8gUmVzZWFyY2ggcHJpb3JpdHkuIExpc3QgdGhlIGNvbW1vbiByZXNlYXJjaGVzIHdlIHdhbnQgdW5sb2NrZWRcbi8vIGZvciBldmVyeSBkaXZpc2lvbi4gUHJvZHVjdC1vbmx5IHJlc2VhcmNoZXMgYXJlIGFkZGVkIG9ubHkgaWYgdGhlXG4vLyBkaXZpc2lvbiBhY3R1YWxseSBtYWtlcyBwcm9kdWN0cyAoY2hlY2tlZCBhdCBydW50aW1lKS5cbmNvbnN0IEJBU0VfUkVTRUFSQ0ggPSBbXG4gIFwiSGktVGVjaCBSJkQgTGFib3JhdG9yeVwiLCAgLy8gdW5sb2NrcyB0aGUgcmVzdFxuICBcIkF1dG9CcmV3XCIsXG4gIFwiQXV0b1BhcnR5TWFuYWdlclwiLFxuICBcIkRyb25lc1wiLFxuICBcIkRyb25lcyAtIEFzc2VtYmx5XCIsXG4gIFwiRHJvbmVzIC0gVHJhbnNwb3J0XCIsXG4gIFwiU2VsZi1Db3JyZWN0aW5nIEFzc2VtYmxlcnNcIixcbiAgXCJ1UGdyYWRlOiBEYXNoYm9hcmRcIixcbl07XG5cbmNvbnN0IFBST0RVQ1RfUkVTRUFSQ0ggPSBbXG4gIFwiTWFya2V0LVRBLklcIixcbiAgXCJNYXJrZXQtVEEuSUlcIixcbiAgXCJ1UGdyYWRlOiBDYXBhY2l0eS5JXCIsXG4gIFwidVBncmFkZTogQ2FwYWNpdHkuSUlcIixcbiAgXCJPdmVyY2xvY2tcIixcbiAgXCJTdGkubXVcIixcbiAgXCJDUEg0IEluamVjdGlvbnNcIixcbiAgXCJHby1KdWljZVwiLFxuICBcIkF1dG9tYXRpYyBEcnVnIEFkbWluaXN0cmF0aW9uXCIsXG4gIFwiSFJCdWRkeS1SZWNydWl0bWVudFwiLFxuICBcIkhSQnVkZHktVHJhaW5pbmdcIixcbiAgXCJ1UGdyYWRlOiBGdWxjcnVtXCIsXG5dO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEdhdGU6IGNvcnAgbXVzdCBleGlzdCBBTkQgdGhlIEJOIG11c3Qgbm90IGRpc2FibGUgaXQuIFdpdGhvdXRcbiAgLy8gaGFzQ29ycG9yYXRpb24sIGV2ZXJ5IGNvcnAgY2FsbCB3b3VsZCBlcnJvci4gVGhlIHVzZXIgbWlnaHRcbiAgLy8gaGF2ZSB0aGUgQVBJIGluc3RhbGxlZCBidXQgYmUgaW4gQk4tMiAoZGlzYWJsZUNvcnBvcmF0aW9uKSDigJRcbiAgLy8gdGhlIEFQSSBtZXRob2RzIGp1c3QgdGhyb3cgaW4gdGhhdCBjYXNlLCBzbyB3ZSBjaGVjayB0aGUgQk5cbiAgLy8gbXVsdGlwbGllciB1cCBmcm9udC5cbiAgaWYgKCFucy5jb3Jwb3JhdGlvbi5oYXNDb3Jwb3JhdGlvbigpKSB7XG4gICAgbnMudHByaW50KFwiRVJST1I6IG5vIGNvcnBvcmF0aW9uIGZvdW5kLiBGb3VuZCBvbmUgaW4gdGhlIFVJIGZpcnN0IChDaXR5IOKGkiBBZXZ1bSBGaXJzdCBGaW5hbmNpYWwpLCB0aGVuIHJ1biB0aGlzIHNjcmlwdC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBsYXllciA9IG5zLmdldFBsYXllcigpO1xuICBpZiAocGxheWVyLmJpdE5vZGVOID09PSAyKSB7XG4gICAgbnMudHByaW50KFwiRVJST1I6IEJpdE5vZGUgMiBkaXNhYmxlcyBjb3Jwb3JhdGlvbnMgKGRpc2FibGVDb3Jwb3JhdGlvbiA9IHRydWUpLiBUaGlzIHNjcmlwdCBjYW5ub3QgcnVuIGhlcmUuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFBhcnNlIGFyZ3MuXG4gIGNvbnN0IGFyZ3MgPSBucy5hcmdzLnNsaWNlKCk7XG4gIGNvbnN0IG9uY2UgPSBhcmdzLmluY2x1ZGVzKFwiLS1vbmNlXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgY29uc3QgYWNjZXB0SW52ZXN0bWVudHMgPSBhcmdzLmluY2x1ZGVzKFwiLS1hY2NlcHQtaW52ZXN0bWVudHNcIik7XG4gIGNvbnN0IHRhcmdldElkeCA9IGFyZ3MuaW5kZXhPZihcIi0tdGFyZ2V0LWVtcGxveWVlc1wiKTtcbiAgY29uc3QgdGFyZ2V0RW1wbG95ZWVzID0gdGFyZ2V0SWR4ID49IDAgPyBNYXRoLm1heCgwLCBNYXRoLmZsb29yKE51bWJlcihhcmdzW3RhcmdldElkeCArIDFdKSkpIDogREVGQVVMVF9UQVJHRVRfRU1QTE9ZRUVTO1xuICBpZiAodGFyZ2V0SWR4ID49IDAgJiYgKCFOdW1iZXIuaXNGaW5pdGUodGFyZ2V0RW1wbG95ZWVzKSB8fCB0YXJnZXRFbXBsb3llZXMgPCAwKSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1jb3JwOiAtLXRhcmdldC1lbXBsb3llZXMgbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyIChnb3QgJHthcmdzW3RhcmdldElkeCArIDFdfSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcHJvZE1hcmt1cElkeCA9IGFyZ3MuaW5kZXhPZihcIi0tcHJvZHVjdC1tYXJrdXBcIik7XG4gIGNvbnN0IHByb2R1Y3RNYXJrdXAgPSBwcm9kTWFya3VwSWR4ID49IDAgPyBTdHJpbmcoYXJnc1twcm9kTWFya3VwSWR4ICsgMV0pIDogREVGQVVMVF9QUk9EVUNUX01BUktVUDtcbiAgY29uc3QgbWF0TWFya3VwSWR4ID0gYXJncy5pbmRleE9mKFwiLS1tYXRlcmlhbC1tYXJrdXBcIik7XG4gIGNvbnN0IG1hdGVyaWFsTWFya3VwID0gbWF0TWFya3VwSWR4ID49IDAgPyBTdHJpbmcoYXJnc1ttYXRNYXJrdXBJZHggKyAxXSkgOiBERUZBVUxUX01BVEVSSUFMX01BUktVUDtcblxuICBucy5kaXNhYmxlTG9nKFwic2xlZXBcIik7XG4gIG5zLmRpc2FibGVMb2coXCJnZXRTZXJ2ZXJNb25leUF2YWlsYWJsZVwiKTtcbiAgbnMuZGlzYWJsZUxvZyhcInNjYW5cIik7XG5cbiAgLy8gUGVyLWRpdmlzaW9uIGNhY2hlOiBlYWNoIHRpY2sgd2UgcmVhZCBnZXREaXZpc2lvbiBvbmNlIGFuZCByZXVzZVxuICAvLyB0aGUgcmVzdWx0IGZvciB0aGUgcmVzdCBvZiB0aGUgcGFzcy4gV2l0aG91dCB0aGlzIHdlJ2QgYmVcbiAgLy8gZG91YmxlLWJpbGxpbmcgUkFNIGNvc3RzIG9uIGV2ZXJ5IGZ1bmN0aW9uIGNhbGwuXG4gIGNvbnN0IENJVElFUyA9IFtcIkFldnVtXCIsIFwiQ2hvbmdxaW5nXCIsIFwiU2VjdG9yLTEyXCIsIFwiTmV3IFRva3lvXCIsIFwiSXNoaW1hXCIsIFwiVm9saGF2ZW5cIl07XG5cbiAgLy8gSGVscGVyOiBob3cgbXVjaCBjYXNoIHRoZSBjb3JwIGhhcywgTUlOVVMgYSBzbWFsbCByZXNlcnZlLiBVc2VkXG4gIC8vIGFzIHRoZSB1cHBlciBib3VuZCBmb3IgXCJjYW4gd2UgYWZmb3JkIFhcIiBjaGVja3MuIFRoZSByZXNlcnZlXG4gIC8vIGtlZXBzIHRoZSBjb3JwIGxpcXVpZCBpbiBjYXNlIG9mIHN1ZGRlbiBjb3N0cyAoZW1wbG95ZWUgcmFpc2UsXG4gIC8vIGltcG9ydCBmZWVzLCBldGMuKS5cbiAgZnVuY3Rpb24gc3BlbmRhYmxlQ2FzaChjb3JwKSB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIGNvcnAuZnVuZHMgKiAoMSAtIERFRkFVTFRfUkVTRVJWRV9GUkFDVElPTikpO1xuICB9XG5cbiAgLy8gSGVscGVyOiBoaXJlIGEgc2luZ2xlIGVtcGxveWVlIGludG8gYSBwb3NpdGlvbi4gVHJpZXNcbiAgLy8gXCJPcGVyYXRpb25zXCIgaWYgbm90IHNwZWNpZmllZCwgd2hpY2ggaXMgdGhlIG1vc3QgY29tbW9uIGVhcmx5XG4gIC8vIGpvYi4gTm90ZTogaGlyZUVtcGxveWVlIG9ubHkgc3VjY2VlZHMgaWYgdGhlIG9mZmljZSBoYXMgc3BhY2VcbiAgLy8g4oCUIGl0IGF1dG8tZ3Jvd3MgdGhlIG9mZmljZSBieSAzIHNsb3RzIHdoZW4gaXQgY2FuLlxuICBmdW5jdGlvbiBoaXJlT25lKGRpdiwgY2l0eSwgcG9zaXRpb24pIHtcbiAgICAvLyBDaGVjayBpZiB0aGUgb2ZmaWNlIGhhcyBzcGFjZSBmaXJzdDsgZ3JvdyBpdCBieSAzIGlmIGl0XG4gICAgLy8gZG9lc24ndCwgdGhlbiByZXRyeS4gdXBncmFkZU9mZmljZVNpemUgdGhyb3dzIGlmIHdlIGNhbid0XG4gICAgLy8gYWZmb3JkIGl0LCBzbyB3ZSBjaGVjayB3aXRoIGdldE9mZmljZVNpemVVcGdyYWRlQ29zdC5cbiAgICBjb25zdCBvZmZpY2UgPSBucy5jb3Jwb3JhdGlvbi5nZXRPZmZpY2UoZGl2LCBjaXR5KTtcbiAgICBpZiAob2ZmaWNlLm51bUVtcGxveWVlcyA+PSBvZmZpY2Uuc2l6ZSkge1xuICAgICAgY29uc3QgZ3JvdyA9IDM7XG4gICAgICBjb25zdCBjb3N0ID0gbnMuY29ycG9yYXRpb24uZ2V0T2ZmaWNlU2l6ZVVwZ3JhZGVDb3N0KGRpdiwgY2l0eSwgZ3Jvdyk7XG4gICAgICBjb25zdCBjYXNoID0gbnMuY29ycG9yYXRpb24uZ2V0Q29ycG9yYXRpb24oKS5mdW5kcztcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoY29zdCkgJiYgY29zdCA+IDAgJiYgY29zdCA8IGNhc2ggKiAoMSAtIERFRkFVTFRfUkVTRVJWRV9GUkFDVElPTikpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBucy5jb3Jwb3JhdGlvbi51cGdyYWRlT2ZmaWNlU2l6ZShkaXYsIGNpdHksIGdyb3cpO1xuICAgICAgICAgIG5zLnRwcmludChgVVBHUkFERUQtb2ZmaWNlICR7ZGl2fS8ke2NpdHl9ICske2dyb3d9IChjb3N0PSQke2Nvc3QudG9GaXhlZCgwKX0pYCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBXZSBjYW4ndCBhZmZvcmQ7IGJhaWwgb24gdGhpcyBoaXJlIGZvciB0aGlzIHRpY2suXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBDYW4ndCBhZmZvcmQgdG8gZ3JvdyB0aGUgb2ZmaWNlOyBiYWlsLlxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBucy5jb3Jwb3JhdGlvbi5oaXJlRW1wbG95ZWUoZGl2LCBjaXR5LCBwb3NpdGlvbik7XG4gIH1cblxuICAvLyBBcHBseSBhIGJhbGFuY2VkIGpvYiBtaXggZm9yIHRoZSBvZmZpY2UuIFRoZSBqb2IgY291bnRzIGFkZCB1cFxuICAvLyB0byB0aGUgY3VycmVudCBoZWFkY291bnQsIHdlaWdodGVkIGJ5IHRoZSBpbmR1c3RyeS1zcGVjaWZpY1xuICAvLyBtaXguIFRoZSBSRU1BSU5ERVIgKG9uZSBvciB0d28gZW1wbG95ZWVzKSBnb2VzIHRvIHdoYXRldmVyIHJvbGVcbiAgLy8gdGhlIG1peCBzYXlzIGlzIG1vc3QgaW1wb3J0YW50IGZvciB0aGlzIGluZHVzdHJ5LlxuICBmdW5jdGlvbiBhcHBseUpvYk1peChkaXYsIGluZHVzdHJ5LCBjaXR5KSB7XG4gICAgY29uc3Qgb2ZmaWNlID0gbnMuY29ycG9yYXRpb24uZ2V0T2ZmaWNlKGRpdiwgY2l0eSk7XG4gICAgY29uc3QgbWl4ID0gSU5EVVNUUllfTUlYW2luZHVzdHJ5XSB8fCBJTkRVU1RSWV9NSVguX2RlZmF1bHQ7XG4gICAgY29uc3QgbiA9IG9mZmljZS5udW1FbXBsb3llZXM7XG4gICAgaWYgKG4gPT09IDApIHJldHVybjtcbiAgICAvLyBDb21wdXRlIHRoZSB0YXJnZXQgY291bnRzLiBXZSBhc3NpZ24gZmxvb3IobiAqIHdlaWdodCkgdG9cbiAgICAvLyBlYWNoIGpvYiwgdGhlbiB0b3AgdXAgdGhlIGhpZ2hlc3QtcHJpb3JpdHkgam9iIHRvIHJlYWNoIG4uXG4gICAgY29uc3Qgam9icyA9IFtcIk9wZXJhdGlvbnNcIiwgXCJFbmdpbmVlclwiLCBcIkJ1c2luZXNzXCIsIFwiUmVzZWFyY2ggJiBEZXZlbG9wbWVudFwiXTtcbiAgICBjb25zdCB0YXJnZXRzID0ge307XG4gICAgbGV0IGFzc2lnbmVkID0gMDtcbiAgICBmb3IgKGNvbnN0IGogb2Ygam9icykge1xuICAgICAgdGFyZ2V0c1tqXSA9IE1hdGguZmxvb3IobiAqIG1peFtqXSk7XG4gICAgICBhc3NpZ25lZCArPSB0YXJnZXRzW2pdO1xuICAgIH1cbiAgICAvLyBUb3AtdXA6IHB1dCB0aGUgcmVtYWluZGVyIGludG8gdGhlIGhpZ2hlc3Qtd2VpZ2h0IGpvYiAoZmlyc3RcbiAgICAvLyBqb2IgaW4gdGhlIG1peCBsaXN0IHdpdGggdGhlIGxhcmdlc3Qgd2VpZ2h0KS5cbiAgICBsZXQgdG9wSm9iID0gam9ic1swXTtcbiAgICBmb3IgKGNvbnN0IGogb2Ygam9icykgaWYgKG1peFtqXSA+IG1peFt0b3BKb2JdKSB0b3BKb2IgPSBqO1xuICAgIHRhcmdldHNbdG9wSm9iXSArPSBuIC0gYXNzaWduZWQ7XG4gICAgZm9yIChjb25zdCBqIG9mIGpvYnMpIHtcbiAgICAgIGlmICh0YXJnZXRzW2pdID4gMCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG5zLmNvcnBvcmF0aW9uLnNldEpvYkFzc2lnbm1lbnQoZGl2LCBjaXR5LCBqLCB0YXJnZXRzW2pdKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIHNldEpvYkFzc2lnbm1lbnQgdGhyb3dzIG9uIGJhZCBqb2IgbmFtZTsgaWdub3JlLlxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQnV5IFwic3RhcnRlclwiIHVubG9ja3MgKE9mZmljZSBBUEksIFdhcmVob3VzZSBBUEksIFNtYXJ0IFN1cHBseSxcbiAgLy8gZXRjLikgb25lIGF0IGEgdGltZS4gRWFjaCBpcyBhIG9uZS10aW1lIGNvcnAtd2lkZSB1bmxvY2suIFdlXG4gIC8vIHRyYWNrIGJvdWdodCB1bmxvY2tzIGluIGEgU2V0IHNvIHdlIGRvbid0IHRyeSB0byByZS1idXkuXG4gIGNvbnN0IGJvdWdodFVubG9ja3MgPSBuZXcgU2V0KCk7XG4gIGZ1bmN0aW9uIGJ1eVN0YXJ0ZXJVbmxvY2tzKGNvcnApIHtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgU1RBUlRFUl9VTkxPQ0tTKSB7XG4gICAgICBpZiAoYm91Z2h0VW5sb2Nrcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgaWYgKG5zLmNvcnBvcmF0aW9uLmhhc1VubG9jayhuYW1lKSkge1xuICAgICAgICBib3VnaHRVbmxvY2tzLmFkZChuYW1lKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBjb3N0ID0gbnMuY29ycG9yYXRpb24uZ2V0VW5sb2NrQ29zdChuYW1lKTtcbiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGNvc3QpIHx8IGNvc3QgPD0gMCkge1xuICAgICAgICBib3VnaHRVbmxvY2tzLmFkZChuYW1lKTsgIC8vIGZyZWUgb3IgTi9BXG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGNvc3QgPCBzcGVuZGFibGVDYXNoKGNvcnApKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbnMuY29ycG9yYXRpb24ucHVyY2hhc2VVbmxvY2sobmFtZSk7XG4gICAgICAgICAgYm91Z2h0VW5sb2Nrcy5hZGQobmFtZSk7XG4gICAgICAgICAgbnMudHByaW50KGBVTkxPQ0tFRCAgICAgICAke25hbWV9ICBjb3N0PSQke2Nvc3QudG9GaXhlZCgwKX1gKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIFJhY2U6IGNhc2ggY2hhbmdlZCBiZXR3ZWVuIGNoZWNrIGFuZCBwdXJjaGFzZS4gVHJ5XG4gICAgICAgICAgLy8gYWdhaW4gbmV4dCB0aWNrLlxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQnV5IHRoZSBjaGVhcGVzdCBuZXh0IHVwZ3JhZGUgbGV2ZWwuIExvb3BzIG9uZSBsZXZlbCBwZXIgdGlja1xuICAvLyB0byBhdm9pZCBibG93aW5nIHRoZSByZXNlcnZlLlxuICBmdW5jdGlvbiBidXlVcGdyYWRlcyhjb3JwKSB7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFVQR1JBREVfTEVWRUxfT1JERVIpIHtcbiAgICAgIGNvbnN0IGNvc3QgPSBucy5jb3Jwb3JhdGlvbi5nZXRVcGdyYWRlTGV2ZWxDb3N0KG5hbWUpO1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoY29zdCkgfHwgY29zdCA8PSAwKSBjb250aW51ZTsgIC8vIG1heGVkXG4gICAgICBpZiAoY29zdCA8IHNwZW5kYWJsZUNhc2goY29ycCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBucy5jb3Jwb3JhdGlvbi5sZXZlbFVwZ3JhZGUobmFtZSk7XG4gICAgICAgICAgbnMudHByaW50KGBVUEdSQURFRCAgICAgICAke25hbWV9ICBsZXZlbD0ke25zLmNvcnBvcmF0aW9uLmdldFVwZ3JhZGVMZXZlbChuYW1lKX0gIGNvc3Q9JCR7Y29zdC50b0ZpeGVkKDApfWApO1xuICAgICAgICAgIHJldHVybjsgIC8vIG9uZSBwZXIgdGlja1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gUmVzZWFyY2ggd2hhdCdzIG1pc3NpbmcgZm9yIGEgZGl2aXNpb24sIGluIHByaW9yaXR5IG9yZGVyLiBXZVxuICAvLyB0cmFjayByZXNlYXJjaGVkIG5hbWVzIGluIGEgU2V0IHNvIHdlIGRvbid0IHJlcGVhdGVkbHkgdHJ5LlxuICBjb25zdCByZXNlYXJjaGVkUGVyRGl2ID0gbmV3IE1hcCgpOyAgLy8gZGl2TmFtZSAtPiBTZXQgb2YgcmVzZWFyY2hlZCBuYW1lc1xuICBmdW5jdGlvbiByZXNlYXJjaEZvckRpdihkaXYsIGluZHVzdHJ5KSB7XG4gICAgbGV0IGRvbmUgPSByZXNlYXJjaGVkUGVyRGl2LmdldChkaXYpO1xuICAgIGlmICghZG9uZSkge1xuICAgICAgZG9uZSA9IG5ldyBTZXQoKTtcbiAgICAgIHJlc2VhcmNoZWRQZXJEaXYuc2V0KGRpdiwgZG9uZSk7XG4gICAgfVxuICAgIGNvbnN0IGluZHVzdHJ5RGF0YSA9IG5zLmNvcnBvcmF0aW9uLmdldEluZHVzdHJ5RGF0YShpbmR1c3RyeSk7XG4gICAgY29uc3QgbWFrZXNQcm9kdWN0cyA9IGluZHVzdHJ5RGF0YS5tYWtlc1Byb2R1Y3RzO1xuICAgIGNvbnN0IGxpc3QgPSBbLi4uQkFTRV9SRVNFQVJDSF07XG4gICAgaWYgKG1ha2VzUHJvZHVjdHMpIGxpc3QucHVzaCguLi5QUk9EVUNUX1JFU0VBUkNIKTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbGlzdCkge1xuICAgICAgaWYgKGRvbmUuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIGlmIChucy5jb3Jwb3JhdGlvbi5oYXNSZXNlYXJjaGVkKGRpdiwgbmFtZSkpIHtcbiAgICAgICAgZG9uZS5hZGQobmFtZSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgY29zdCA9IG5zLmNvcnBvcmF0aW9uLmdldFJlc2VhcmNoQ29zdChkaXYsIG5hbWUpO1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoY29zdCkgfHwgY29zdCA8PSAwKSB7XG4gICAgICAgIGRvbmUuYWRkKG5hbWUpOyAgLy8gZnJlZSBvciB1bmtub3duXG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgY29ycCA9IG5zLmNvcnBvcmF0aW9uLmdldENvcnBvcmF0aW9uKCk7XG4gICAgICBpZiAoY29zdCA8IHNwZW5kYWJsZUNhc2goY29ycCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBucy5jb3Jwb3JhdGlvbi5yZXNlYXJjaChkaXYsIG5hbWUpO1xuICAgICAgICAgIGRvbmUuYWRkKG5hbWUpO1xuICAgICAgICAgIG5zLnRwcmludChgUkVTRUFSQ0hFRCAgICAgJHtkaXZ9LyR7bmFtZX0gIGNvc3Q9JCR7Y29zdC50b0ZpeGVkKDApfWApO1xuICAgICAgICAgIHJldHVybjsgIC8vIG9uZSBwZXIgdGljayBwZXIgcGFzc1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRXhwYW5kIGEgZGl2aXNpb24gdG8gYSBuZXcgY2l0eSBpZiB0aGUgY2FzaCBzdXBwb3J0cyBpdC4gQ29zdFxuICAvLyBpcyByb3VnaGx5OiB3YXJlaG91c2VJbml0aWFsQ29zdCArIG9mZmljZUluaXRpYWxDb3N0ICsgM1xuICAvLyBpbml0aWFsIGVtcGxveWVlcycgc2FsYXJ5IGZpcnN0IGN5Y2xlLiBXZSBhcHByb3hpbWF0ZSB3aXRoIGFcbiAgLy8gZ2VuZXJvdXMgbXVsdGlwbGllciBhbmQgY2hlY2sgYWN0dWFsIGNhc2guXG4gIGZ1bmN0aW9uIG1heWJlRXhwYW5kQ2l0eShkaXYpIHtcbiAgICBjb25zdCBkID0gbnMuY29ycG9yYXRpb24uZ2V0RGl2aXNpb24oZGl2KTtcbiAgICBpZiAoZC5jaXRpZXMubGVuZ3RoID49IENJVElFUy5sZW5ndGgpIHJldHVybjtcbiAgICBmb3IgKGNvbnN0IGNpdHkgb2YgQ0lUSUVTKSB7XG4gICAgICBpZiAoZC5jaXRpZXMuaW5jbHVkZXMoY2l0eSkpIGNvbnRpbnVlO1xuICAgICAgLy8gUHJvYmU6IHRyeSBleHBhbmRDaXR5LCBzZWUgaWYgaXQgdGhyb3dzLiBUaGVyZSdzIG5vXG4gICAgICAvLyBnZXRFeHBhbmRDb3N0IEFQSSwgc28gd2UgYXR0ZW1wdCBhbmQgY2hlY2suXG4gICAgICBjb25zdCBjb3JwID0gbnMuY29ycG9yYXRpb24uZ2V0Q29ycG9yYXRpb24oKTtcbiAgICAgIC8vIENvbnNlcnZhdGl2ZSBnYXRlOiBuZWVkIGF0IGxlYXN0IDEweCBjdXJyZW50IHJldmVudWUgaW5cbiAgICAgIC8vIGNhc2guIFdpdGhvdXQgdGhpcywgZXhwYW5kaW5nIGludG8gYSBuZXcgY2l0eSBvbiBhIHRoaW5cbiAgICAgIC8vIHdhbGxldCBzdGFydmVzIHRoZSBleGlzdGluZyBjaXRpZXMuXG4gICAgICBjb25zdCBnYXRlID0gY29ycC5yZXZlbnVlID4gMCA/IGNvcnAucmV2ZW51ZSAqIDEwIDogMWU5O1xuICAgICAgaWYgKGNvcnAuZnVuZHMgPCBnYXRlKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBucy5jb3Jwb3JhdGlvbi5leHBhbmRDaXR5KGRpdiwgY2l0eSk7XG4gICAgICAgIC8vIEFsc28gYnV5IGEgd2FyZWhvdXNlIHRoZXJlIHNvIHByb2R1Y3Rpb24gY2FuIHN0YXJ0LlxuICAgICAgICB0cnkge1xuICAgICAgICAgIG5zLmNvcnBvcmF0aW9uLnB1cmNoYXNlV2FyZWhvdXNlKGRpdiwgY2l0eSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHsgLyogd2FyZWhvdXNlIG1pZ2h0IGFscmVhZHkgZXhpc3QgKi8gfVxuICAgICAgICAvLyBIaXJlIGEgc3RhcnRlciBzZXQgc28gdGhlIG5ldyBjaXR5IGlzbid0IGEgZ2hvc3QuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSBucy5jb3Jwb3JhdGlvbi5oaXJlRW1wbG95ZWUoZGl2LCBjaXR5LCBcIk9wZXJhdGlvbnNcIik7XG4gICAgICAgIG5zLnRwcmludChgRVhQQU5ERUQtY2l0eSAgICR7ZGl2fS8ke2NpdHl9ICBjaXRpZXM9JHtkLmNpdGllcy5sZW5ndGggKyAxfS8ke0NJVElFUy5sZW5ndGh9YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gQ2FuJ3QgYWZmb3JkIG9yIGNpdHkgdW5hdmFpbGFibGU7IHRyeSB0aGUgbmV4dCBjaXR5LlxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFNldCB1cCBzZWxsaW5nIGZvciBhIGRpdmlzaW9uJ3MgcHJvZHVjdHMgLyBtYXRlcmlhbHMuIFdlIGRvXG4gIC8vIHRoaXMgZm9yIGV2ZXJ5IHByb2R1Y3QgdGhlIGRpdmlzaW9uIGhhcywgdXNpbmcgc2VsbFByb2R1Y3RcbiAgLy8gd2l0aCB0aGUgY29uZmlndXJlZCBtYXJrdXAuIFwiTVBcIiBtZWFucyBtYXJrZXQgcHJpY2U7IHRoZSBBUElcbiAgLy8gc3VwcG9ydHMgXCJNUCs1XCIsIFwiTVAqMS41XCIsIFwiTVBcIiBldGMuXG4gIGZ1bmN0aW9uIHNldHVwU2VsbGluZyhkaXYsIGNpdHkpIHtcbiAgICBjb25zdCBkID0gbnMuY29ycG9yYXRpb24uZ2V0RGl2aXNpb24oZGl2KTtcbiAgICAvLyBTZWxsIGV2ZXJ5IG1hdGVyaWFsIHRoZSBkaXZpc2lvbiBwcm9kdWNlcyAobm90IGJ1eXMpLlxuICAgIGZvciAoY29uc3QgbWF0IG9mIGQubWFrZXNQcm9kdWN0cyA/IFtdIDogW10pIHsgLyogcGxhY2Vob2xkZXIsIHNlZSBiZWxvdyAqLyB9XG4gICAgLy8gV2UgZG9uJ3QgaGF2ZSBhIGRpcmVjdCBcInByb2R1Y2VkIG1hdGVyaWFsc1wiIGxpc3QgcGVyIGRpdmlzaW9uXG4gICAgLy8gaW4gdGhlIEFQSS4gVHJ5IHRoZSBzdGFuZGFyZCBzZXQ7IHRoZSBjYWxsIGlzIGNoZWFwIGFuZFxuICAgIC8vIHNlbGxNYXRlcmlhbCBpcyBhIG5vLW9wIGZvciBtYXRlcmlhbHMgdGhlIGRpdmlzaW9uIGRvZXNuJ3RcbiAgICAvLyBtYWtlLiBUaGUgc2V0IGlzIHNtYWxsICgxMiBuYW1lcykgc28gd2UganVzdCBlbnVtZXJhdGUuXG4gICAgZm9yIChjb25zdCBtYXQgb2YgW1wiTWluZXJhbHNcIiwgXCJPcmVcIiwgXCJXYXRlclwiLCBcIkZvb2RcIiwgXCJQbGFudHNcIiwgXCJNZXRhbFwiLCBcIkhhcmR3YXJlXCIsIFwiQ2hlbWljYWxzXCIsIFwiRHJ1Z3NcIiwgXCJSb2JvdHNcIiwgXCJBSSBDb3Jlc1wiLCBcIlJlYWwgRXN0YXRlXCJdKSB7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBTZWxsIFBST0QvMiBlYWNoIGN5Y2xlIGF0IG1hcmtldCBtYXJrdXAuIFRoZSBcIlBST0QvMlwiXG4gICAgICAgIC8vIHN0cmluZyB0ZWxscyB0aGUgZW5naW5lIHRvIHNlbGwgaGFsZiBvZiB3aGF0IHdhcyBwcm9kdWNlZFxuICAgICAgICAvLyBsYXN0IGN5Y2xlLCB3aGljaCBpcyB0aGUgY29udmVudGlvbmFsIFwiZG9uJ3Qgc2VsbFxuICAgICAgICAvLyBldmVyeXRoaW5nXCIgcmF0aW8gKGtlZXBzIHN0b2NrIGluIHRoZSB3YXJlaG91c2UgZm9yXG4gICAgICAgIC8vIHJlc2lsaWVuY2UgYWdhaW5zdCBkZW1hbmQgc3Bpa2VzKS5cbiAgICAgICAgbnMuY29ycG9yYXRpb24uc2VsbE1hdGVyaWFsKGRpdiwgY2l0eSwgbWF0LCBcIlBST0QvMlwiLCBtYXRlcmlhbE1hcmt1cCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIE1hdGVyaWFsIG5vdCBwcm9kdWNlZCBoZXJlOyBpZ25vcmUuXG4gICAgICB9XG4gICAgfVxuICAgIC8vIFNlbGwgZXZlcnkgcHJvZHVjdCB0aGUgZGl2aXNpb24gaGFzIGRldmVsb3BlZC4gRm9yIHByb2R1Y3RcbiAgICAvLyBkaXZpc2lvbnMsIHNlbGwgTUFYIGF0IHRoZSBjb25maWd1cmVkIG1hcmt1cC5cbiAgICBmb3IgKGNvbnN0IHByb2R1Y3ROYW1lIG9mIGQucHJvZHVjdHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5zLmNvcnBvcmF0aW9uLnNlbGxQcm9kdWN0KGRpdiwgY2l0eSwgcHJvZHVjdE5hbWUsIFwiTUFYXCIsIHByb2R1Y3RNYXJrdXAsIHRydWUpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBQcm9kdWN0IG1pZ2h0IG5vdCBiZSBkZXZlbG9wZWQgeWV0ICh1bmRlciBkZXNpZ24pOyBpZ25vcmUuXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRW5hYmxlIHNtYXJ0IHN1cHBseSBvbiBhIGRpdmlzaW9uJ3Mgd2FyZWhvdXNlIGZvciBlYWNoIGNpdHkuXG4gIC8vIFJlcXVpcmVzIHRoZSBcIlNtYXJ0IFN1cHBseVwiIHVubG9jayAod2hpY2ggYnV5U3RhcnRlclVubG9ja3NcbiAgLy8gYnV5cyBvbiBpdHMgb3duKS4gVGhlIGZ1bmN0aW9uIGlzIGEgbm8tb3AgaWYgdGhlIHVubG9jayBpc24ndFxuICAvLyB0aGVyZS5cbiAgZnVuY3Rpb24gZW5hYmxlU21hcnRTdXBwbHkoZGl2KSB7XG4gICAgaWYgKCFucy5jb3Jwb3JhdGlvbi5oYXNVbmxvY2soXCJTbWFydCBTdXBwbHlcIikpIHJldHVybjtcbiAgICBmb3IgKGNvbnN0IGNpdHkgb2YgQ0lUSUVTKSB7XG4gICAgICB0cnkge1xuICAgICAgICBucy5jb3Jwb3JhdGlvbi5zZXRTbWFydFN1cHBseShkaXYsIGNpdHksIHRydWUpO1xuICAgICAgfSBjYXRjaCAoZSkgeyAvKiB3YXJlaG91c2Ugbm90IHlldCBib3VnaHQgaW4gdGhpcyBjaXR5ICovIH1cbiAgICB9XG4gIH1cblxuICAvLyBEZXZlbG9wIHRoZSBmaXJzdCBwcm9kdWN0IGZvciBhIGRpdmlzaW9uLCBpZiBpdCBkb2Vzbid0IGhhdmVcbiAgLy8gb25lLiBUaGUgaW52ZXN0bWVudCBudW1iZXJzIGFyZSBjb25zZXJ2YXRpdmUgKGRlc2lnbmVkIGZvclxuICAvLyBlYXJseS1nYW1lIGNhcGl0YWwgZWZmaWNpZW5jeSkuIE5ldyBwcm9kdWN0cyBiZXlvbmQgdGhlIGZpcnN0XG4gIC8vIGFyZSBOT1QgYXV0by1jcmVhdGVkOyBzZWUgaGVhZGVyLlxuICBjb25zdCBmaXJzdFByb2R1Y3REb25lID0gbmV3IFNldCgpO1xuICBmdW5jdGlvbiBkZXZlbG9wRmlyc3RQcm9kdWN0KGRpdiwgaW5kdXN0cnkpIHtcbiAgICBpZiAoZmlyc3RQcm9kdWN0RG9uZS5oYXMoZGl2KSkgcmV0dXJuO1xuICAgIGNvbnN0IGQgPSBucy5jb3Jwb3JhdGlvbi5nZXREaXZpc2lvbihkaXYpO1xuICAgIGlmIChkLnByb2R1Y3RzLmxlbmd0aCA+IDApIHtcbiAgICAgIGZpcnN0UHJvZHVjdERvbmUuYWRkKGRpdik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIFwiUHJvZHVjdFwiIGluZHVzdHJpZXMgb25seS4gTWF0ZXJpYWwgaW5kdXN0cmllcyAoQWdyaWN1bHR1cmUsXG4gICAgLy8gTWluaW5nLCBldGMuKSBkb24ndCBoYXZlIGEgXCJmaXJzdCBwcm9kdWN0XCIgY29uY2VwdC5cbiAgICBjb25zdCBpbmR1c3RyeURhdGEgPSBucy5jb3Jwb3JhdGlvbi5nZXRJbmR1c3RyeURhdGEoaW5kdXN0cnkpO1xuICAgIGlmICghaW5kdXN0cnlEYXRhLm1ha2VzUHJvZHVjdHMpIHtcbiAgICAgIGZpcnN0UHJvZHVjdERvbmUuYWRkKGRpdik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIFJlcXVpcmUgXCJIaS1UZWNoIFImRCBMYWJvcmF0b3J5XCIgcmVzZWFyY2ggZmlyc3Q7IHdpdGhvdXQgaXRcbiAgICAvLyB3ZSBjYW4ndCBkZXZlbG9wIGEgcHJvZHVjdCBhdCBhbGwuXG4gICAgaWYgKCFucy5jb3Jwb3JhdGlvbi5oYXNSZXNlYXJjaGVkKGRpdiwgXCJIaS1UZWNoIFImRCBMYWJvcmF0b3J5XCIpKSByZXR1cm47XG4gICAgY29uc3QgY29ycCA9IG5zLmNvcnBvcmF0aW9uLmdldENvcnBvcmF0aW9uKCk7XG4gICAgLy8gQ29uc2VydmF0aXZlIGludmVzdG1lbnRzLiAkMWIgZGVzaWduICsgJDFiIG1hcmtldGluZyBpcyBhXG4gICAgLy8gcmVhc29uYWJsZSBzdGFydGluZyBwb2ludDsgdGhlIHBsYXllciBjYW4gdG9wIHRoZXNlIHVwXG4gICAgLy8gbWFudWFsbHkgaWYgdGhleSB3YW50IGEgYmV0dGVyIHByb2R1Y3QuXG4gICAgY29uc3QgZGVzaWduSW52ZXN0ID0gMWU5O1xuICAgIGNvbnN0IG1hcmtldGluZ0ludmVzdCA9IDFlOTtcbiAgICBpZiAoY29ycC5mdW5kcyA8IGRlc2lnbkludmVzdCArIG1hcmtldGluZ0ludmVzdCArIDFlOSkgcmV0dXJuOyAgLy8ga2VlcCBhIHJlc2VydmVcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJvZHVjdE5hbWUgPSBgJHtkaXZ9LVByb2R1Y3RgO1xuICAgICAgLy8gcGljayBhIGNpdHkgdGhhdCBoYXMgZW1wbG95ZWVzXG4gICAgICBjb25zdCBjaXR5ID0gZC5jaXRpZXNbMF07XG4gICAgICBpZiAoIWNpdHkpIHJldHVybjtcbiAgICAgIG5zLmNvcnBvcmF0aW9uLm1ha2VQcm9kdWN0KGRpdiwgY2l0eSwgcHJvZHVjdE5hbWUsIGRlc2lnbkludmVzdCwgbWFya2V0aW5nSW52ZXN0KTtcbiAgICAgIGZpcnN0UHJvZHVjdERvbmUuYWRkKGRpdik7XG4gICAgICBucy50cHJpbnQoYFBST0RVQ1QgICAgICAgICR7ZGl2fS8ke3Byb2R1Y3ROYW1lfSAgZGVzaWduPSQke2Rlc2lnbkludmVzdC50b0xvY2FsZVN0cmluZygpfSBtYXJrZXRpbmc9JCR7bWFya2V0aW5nSW52ZXN0LnRvTG9jYWxlU3RyaW5nKCl9YCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgLy8gUmFjZSAvIG5vdCBlbm91Z2ggY2FzaDsgdHJ5IG5leHQgdGljay5cbiAgICB9XG4gIH1cblxuICAvLyBBY2NlcHQgYW4gaW52ZXN0bWVudCBvZmZlciBpZiBpdCBsb29rcyBnb29kLiBcIkdvb2RcIiBpcyBhIHZhZ3VlXG4gIC8vIG1ldHJpYzsgd2UgdXNlIGZ1bmRzLXBlci1zaGFyZSBhcyBhIHByb3h5LiBUaGUgZGVmYXVsdFxuICAvLyB0aHJlc2hvbGQgaXMgXCJhbnkgb2ZmZXJcIiwgd2hpY2ggaXMgYWxtb3N0IGFsd2F5cyBhIGdvb2QgaWRlYVxuICAvLyBiZWNhdXNlIGludmVzdG1lbnRzIGJvb3N0IHZhbHVhdGlvbiAod2hpY2ggYm9vc3RzIHNoYXJlXG4gIC8vIHByaWNlLCB3aGljaCBib29zdHMgdGhlIG5leHQgcm91bmQpLiBUaGUgc2NyaXB0IGNhbiBiZSB0dW5lZFxuICAvLyB3aXRoIC0tYWNjZXB0LWludmVzdG1lbnRzIG9mZiAoZGVmYXVsdCkgdG8gYmUgY29uc2VydmF0aXZlLlxuICBmdW5jdGlvbiBtYXliZUFjY2VwdEludmVzdG1lbnQoKSB7XG4gICAgaWYgKCFhY2NlcHRJbnZlc3RtZW50cykgcmV0dXJuO1xuICAgIGNvbnN0IG9mZmVyID0gbnMuY29ycG9yYXRpb24uZ2V0SW52ZXN0bWVudE9mZmVyKCk7XG4gICAgaWYgKCFvZmZlciB8fCBvZmZlci5mdW5kcyA8PSAwKSByZXR1cm47XG4gICAgaWYgKG9mZmVyLnJvdW5kIDwgMSB8fCBvZmZlci5yb3VuZCA+IDQpIHJldHVybjtcbiAgICBjb25zdCBwcHMgPSBvZmZlci5mdW5kcyAvIE1hdGgubWF4KDEsIG9mZmVyLnNoYXJlcyk7XG4gICAgLy8gTm8gaGFyZCB0aHJlc2hvbGQg4oCUIGludmVzdG1lbnRzIGFyZSBhbG1vc3QgYWx3YXlzIHdvcnRoIGl0LlxuICAgIC8vIFNraXAgaWYgdGhlIG9mZmVyIGlzIHN1c3BpY2lvdXNseSBzbWFsbCAocm91bmQgMSB3aXRoIHRpbnlcbiAgICAvLyBmdW5kcyBpcyB1c3VhbGx5IGEgXCJ3YWl0IGl0IG91dFwiIHNpdHVhdGlvbikuXG4gICAgaWYgKG9mZmVyLmZ1bmRzIDwgMWU4KSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG9rID0gbnMuY29ycG9yYXRpb24uYWNjZXB0SW52ZXN0bWVudE9mZmVyKCk7XG4gICAgICBpZiAob2spIG5zLnRwcmludChgSU5WRVNUTUVOVCAgICAgcm91bmQ9JHtvZmZlci5yb3VuZH0gIGZ1bmRzPSQke29mZmVyLmZ1bmRzLnRvRml4ZWQoMCl9ICBzaGFyZXM9JHtvZmZlci5zaGFyZXMudG9GaXhlZCgwKX0gICgkL3NoYXJlPSQke3Bwcy50b0ZpeGVkKDIpfSlgKTtcbiAgICB9IGNhdGNoIChlKSB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cblxuICAvLyBQZXItZGl2aXNpb24gY2FkZW5jZSBjb3VudGVyIGZvciB0ZWErcGFydHkgKGNoZWFwIG1vcmFsZSBib29zdCkuXG4gIC8vIFRpY2sgY291bnRlciBpcyBwZXItZGl2aXNpb24gc28gZGl2aXNpb25zIGRvbid0IGFsbCBoaXQgdGhlXG4gIC8vIFwicGFydHkgdGltZVwiIHRpY2sgb24gdGhlIHNhbWUgZ2FtZSBzdGF0ZSB0cmFuc2l0aW9uLCB3aGljaFxuICAvLyB3b3VsZCBicmllZmx5IHN0YXJ2ZSB0aGUgY29ycCdzIGNhc2guXG4gIGNvbnN0IHRlYUFuZFBhcnR5VGljayA9IHt9O1xuXG4gIC8vIE9uZSBjb3JwIHRpY2suIFRoZSBjb3JwIGN5Y2xlcyB0aHJvdWdoIFBST0RVQ1RJT04g4oaSIFNBTEUg4oaSIGV0Yy5cbiAgLy8gb24gYSAyMDBtcyBjYWRlbmNlLCBzbyAycyBpcyBhIGNvbWZvcnRhYmxlIFwiZG8gd29yaywgdGhlblxuICAvLyB5aWVsZFwiIGludGVydmFsLiBVc2luZyBuZXh0VXBkYXRlKCkgd291bGQgdGllIHRoZSBzY3JpcHQgdG9cbiAgLy8gdGhlIHNsb3dlc3Qgc3RhdGUgdHJhbnNpdGlvbjsgYSBmaXhlZCBzbGVlcCBpcyBmaW5lIGJlY2F1c2VcbiAgLy8gbW9zdCBvZiB0aGUgd29yayBoZXJlIGlzIE8oZGl2aXNpb25zKSBhbmQgdGhlIGNvcnAgZ3Jvd3NcbiAgLy8gc2xvd2x5LlxuICBmdW5jdGlvbiBwYXNzKCkge1xuICAgIGNvbnN0IGNvcnAgPSBucy5jb3Jwb3JhdGlvbi5nZXRDb3Jwb3JhdGlvbigpO1xuICAgIGlmICghY29ycCkgcmV0dXJuOyAgLy8gY29ycCBkZWxldGVkIG91dCBmcm9tIHVuZGVyIHVzXG4gICAgY29uc3QgY291bnRlcnMgPSB7IGhpcmVkOiAwLCBvZmZpY2VzOiAwLCBleHBhbmRlZDogMCB9O1xuXG4gICAgLy8gMS4gQnV5IGNvcnAtd2lkZSB1bmxvY2tzLlxuICAgIGJ1eVN0YXJ0ZXJVbmxvY2tzKGNvcnApO1xuICAgIC8vIDIuIEJ1eSBjb3JwLXdpZGUgdXBncmFkZXMuXG4gICAgYnV5VXBncmFkZXMoY29ycCk7XG4gICAgLy8gMy4gTWF5YmUgYWNjZXB0IGFuIGludmVzdG1lbnQuXG4gICAgbWF5YmVBY2NlcHRJbnZlc3RtZW50KCk7XG5cbiAgICAvLyA0LiBXYWxrIGV2ZXJ5IGRpdmlzaW9uLlxuICAgIGZvciAoY29uc3QgZGl2TmFtZSBvZiBjb3JwLmRpdmlzaW9ucykge1xuICAgICAgY29uc3QgZGl2ID0gbnMuY29ycG9yYXRpb24uZ2V0RGl2aXNpb24oZGl2TmFtZSk7XG4gICAgICAvLyBQZXItZGl2aXNpb24gcmVzZWFyY2guXG4gICAgICByZXNlYXJjaEZvckRpdihkaXZOYW1lLCBkaXYuaW5kdXN0cnkpO1xuICAgICAgLy8gU21hcnQgc3VwcGx5IChuby1vcCBpZiB1bmxvY2sgbWlzc2luZykuXG4gICAgICBlbmFibGVTbWFydFN1cHBseShkaXZOYW1lKTtcbiAgICAgIC8vIFRyeSB0byBleHBhbmQgdG8gYSBuZXcgY2l0eS5cbiAgICAgIGNvbnN0IGJlZm9yZSA9IGRpdi5jaXRpZXMubGVuZ3RoO1xuICAgICAgbWF5YmVFeHBhbmRDaXR5KGRpdk5hbWUpO1xuICAgICAgY29uc3QgZGl2QWZ0ZXIgPSBucy5jb3Jwb3JhdGlvbi5nZXREaXZpc2lvbihkaXZOYW1lKTtcbiAgICAgIGlmIChkaXZBZnRlci5jaXRpZXMubGVuZ3RoID4gYmVmb3JlKSBjb3VudGVycy5leHBhbmRlZCsrO1xuICAgICAgLy8gRGV2ZWxvcCBmaXJzdCBwcm9kdWN0IGlmIGFwcGxpY2FibGUuXG4gICAgICBkZXZlbG9wRmlyc3RQcm9kdWN0KGRpdk5hbWUsIGRpdi5pbmR1c3RyeSk7XG4gICAgICAvLyBTZXQgdXAgc2VsbGluZyBmb3IgZXZlcnkgY2l0eSB0aGUgZGl2aXNpb24gaGFzLlxuICAgICAgZm9yIChjb25zdCBjaXR5IG9mIGRpdkFmdGVyLmNpdGllcykge1xuICAgICAgICBzZXR1cFNlbGxpbmcoZGl2TmFtZSwgY2l0eSk7XG4gICAgICB9XG4gICAgICAvLyBIaXJlIGVtcGxveWVlcyB1cCB0byB0YXJnZXQsIGJhbGFuY2VkIG1peC5cbiAgICAgIGZvciAoY29uc3QgY2l0eSBvZiBkaXZBZnRlci5jaXRpZXMpIHtcbiAgICAgICAgY29uc3Qgb2ZmaWNlID0gbnMuY29ycG9yYXRpb24uZ2V0T2ZmaWNlKGRpdk5hbWUsIGNpdHkpO1xuICAgICAgICBpZiAob2ZmaWNlLm51bUVtcGxveWVlcyA+PSB0YXJnZXRFbXBsb3llZXMpIGNvbnRpbnVlO1xuICAgICAgICAvLyBIaXJlIG9uZSBhdCBhIHRpbWUgc28gd2UgZG9uJ3QgYmxvdyB0aGUgY2FzaCBidWRnZXQuXG4gICAgICAgIGNvbnN0IG9rID0gaGlyZU9uZShkaXZOYW1lLCBjaXR5LCBcIk9wZXJhdGlvbnNcIik7XG4gICAgICAgIGlmIChvaykgY291bnRlcnMuaGlyZWQrKztcbiAgICAgICAgZWxzZSBicmVhazsgIC8vIGNhbid0IGFmZm9yZDsgdHJ5IGFnYWluIG5leHQgdGlja1xuICAgICAgfVxuICAgICAgLy8gUmUtYXBwbHkgam9iIG1peCAoaGlyaW5nIGNoYW5nZWQgdGhlIGhlYWRjb3VudCkuXG4gICAgICBmb3IgKGNvbnN0IGNpdHkgb2YgZGl2QWZ0ZXIuY2l0aWVzKSB7XG4gICAgICAgIGFwcGx5Sm9iTWl4KGRpdk5hbWUsIGRpdi5pbmR1c3RyeSwgY2l0eSk7XG4gICAgICB9XG4gICAgICAvLyBCdXkgdGVhIGFuZCB0aHJvdyBhIHBhcnR5IChjaGVhcCBtb3JhbGUgYm9vc3QpIG9uIGEgc2xvd1xuICAgICAgLy8gY2FkZW5jZSDigJQgb25jZSBldmVyeSB+MjAgdGlja3MuIFdlIHVzZSBhIHRpY2sgY291bnRlclxuICAgICAgLy8ga2V5ZWQgYnkgdGhlIGRpdmlzaW9uIHNvIHRoZSBjYWRlbmNlIGlzIHBlci1kaXZpc2lvbi5cbiAgICAgIHRlYUFuZFBhcnR5VGlja1tkaXZOYW1lXSA9ICh0ZWFBbmRQYXJ0eVRpY2tbZGl2TmFtZV0gfHwgMCkgKyAxO1xuICAgICAgaWYgKHRlYUFuZFBhcnR5VGlja1tkaXZOYW1lXSAlIDIwID09PSAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgY2l0eSBvZiBkaXZBZnRlci5jaXRpZXMpIHtcbiAgICAgICAgICB0cnkgeyBucy5jb3Jwb3JhdGlvbi5idXlUZWEoZGl2TmFtZSwgY2l0eSk7IH0gY2F0Y2ggKGUpIHsgLyogbm8gbW9uZXkgKi8gfVxuICAgICAgICAgIHRyeSB7IG5zLmNvcnBvcmF0aW9uLnRocm93UGFydHkoZGl2TmFtZSwgY2l0eSwgNTAwXzAwMCk7IH0gY2F0Y2ggKGUpIHsgLyogbm8gbW9uZXkgKi8gfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgIGNvbnN0IGFmdGVyID0gbnMuY29ycG9yYXRpb24uZ2V0Q29ycG9yYXRpb24oKTtcbiAgICAgIGZvciAoY29uc3QgZGl2TmFtZSBvZiBhZnRlci5kaXZpc2lvbnMpIHtcbiAgICAgICAgY29uc3QgZCA9IG5zLmNvcnBvcmF0aW9uLmdldERpdmlzaW9uKGRpdk5hbWUpO1xuICAgICAgICBjb25zdCBlbXBUb3RhbCA9IGQuY2l0aWVzLnJlZHVjZSgocywgYykgPT4gcyArIG5zLmNvcnBvcmF0aW9uLmdldE9mZmljZShkaXZOYW1lLCBjKS5udW1FbXBsb3llZXMsIDApO1xuICAgICAgICBucy50cHJpbnQoYGRpdmlzaW9uICR7ZGl2TmFtZS5wYWRFbmQoMTIpfSAke2QuaW5kdXN0cnkucGFkRW5kKDE0KX0gY2l0aWVzPSR7ZC5jaXRpZXMubGVuZ3RofSBlbXA9JHtlbXBUb3RhbH0gcmV2PSQke2QudGhpc0N5Y2xlUmV2ZW51ZS50b0ZpeGVkKDApfS9zIGV4cD0kJHtkLnRoaXNDeWNsZUV4cGVuc2VzLnRvRml4ZWQoMCl9L3MgZnVuZD0kJHthZnRlci5mdW5kcy50b0ZpeGVkKDApfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjb3VudGVycztcbiAgfVxuXG4gIGlmIChvbmNlKSB7XG4gICAgcGFzcygpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIG5zLnRwcmludChgbW9uaXRvci1jb3JwOiBzdGFydGVkLCB0YXJnZXQtZW1wbG95ZWVzPSR7dGFyZ2V0RW1wbG95ZWVzfSwgb3V0cHV0PSR7dmVyYm9zZSA/IFwidmVyYm9zZVwiIDogXCJxdWlldFwifSwgaW52ZXN0bWVudHM9JHthY2NlcHRJbnZlc3RtZW50cyA/IFwiYXV0b1wiIDogXCJvZmZcIn1gKTtcbiAgd2hpbGUgKHRydWUpIHtcbiAgICBwYXNzKCk7XG4gICAgLy8gMnMgc2xlZXA6IGNvcnAgdXBkYXRlcyBvbiBhIDIwMG1zIGN5Y2xlIGludGVybmFsbHksIHNvIDJzXG4gICAgLy8gaXMgMTAgY3ljbGVzIOKAlCBsb25nIGVub3VnaCB0aGF0IGEgc2luZ2xlIHRpY2sgb2YgY29ycCB3b3JrXG4gICAgLy8gY29tcGxldGVzLCBzaG9ydCBlbm91Z2ggdG8ga2VlcCB0aGUgc2NyaXB0IHJlc3BvbnNpdmUuXG4gICAgYXdhaXQgbnMuc2xlZXAoMjAwMCk7XG4gIH1cbn1cbiJdfQ==