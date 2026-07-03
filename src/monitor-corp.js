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
const DEFAULT_TARGET_EMPLOYEES = 9;       // the natural "3x3" office grid
const DEFAULT_PRODUCT_MARKUP = "MP+5";    // "MP" is market price; "MP+5" is +$5/unit
const DEFAULT_MATERIAL_MARKUP = "MP";     // materials are competitive, hold at MP
const DEFAULT_MAX_NEW_SHARES = 100e9;     // safety bound; script never issues >$100b of new shares/tick
const DEFAULT_RESERVE_FRACTION = 0.10;    // keep 10% of corp cash untouched (for emergency costs)

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
  Agriculture:       { Operations: 0.50, Engineer: 0.25, Business: 0.10, "Research & Development": 0.15 },
  Mining:            { Operations: 0.50, Engineer: 0.25, Business: 0.10, "Research & Development": 0.15 },
  Chemical:          { Operations: 0.45, Engineer: 0.25, Business: 0.15, "Research & Development": 0.15 },
  Fishing:           { Operations: 0.50, Engineer: 0.20, Business: 0.15, "Research & Development": 0.15 },
  Food:              { Operations: 0.45, Engineer: 0.20, Business: 0.20, "Research & Development": 0.15 },
  // "Mixed" industries — more even split.
  Tobacco:           { Operations: 0.40, Engineer: 0.20, Business: 0.20, "Research & Development": 0.20 },
  Energy:            { Operations: 0.40, Engineer: 0.30, Business: 0.10, "Research & Development": 0.20 },
  Utilities:         { Operations: 0.40, Engineer: 0.30, Business: 0.10, "Research & Development": 0.20 },
  Pharmaceutical:    { Operations: 0.35, Engineer: 0.25, Business: 0.20, "Research & Development": 0.20 },
  Robotics:          { Operations: 0.35, Engineer: 0.30, Business: 0.15, "Research & Development": 0.20 },
  // Product industries — R&D and Business are the value drivers.
  Software:          { Operations: 0.30, Engineer: 0.20, Business: 0.25, "Research & Development": 0.25 },
  Hardware:          { Operations: 0.30, Engineer: 0.25, Business: 0.20, "Research & Development": 0.25 },
  RealEstate:        { Operations: 0.30, Engineer: 0.20, Business: 0.30, "Research & Development": 0.20 },
  // Default: balanced
  _default:          { Operations: 0.40, Engineer: 0.25, Business: 0.15, "Research & Development": 0.20 },
};

// Starter unlocks (in this order). Each entry: (unlockName, cost).
// These are one-time corp-wide unlocks. The script only buys each
// once. Note: "Export" is a separate division decision; this script
// does not auto-buy it because the export topology is strategic.
// "Smart Supply", "Market Research - Demand", "Market Data -
// Competition" are all useful and are bought when affordable.
const STARTER_UNLOCKS = [
  "Office API",        // $1b — needed for the script to do anything
  "Warehouse API",     // $1b — needed for smart supply / materials
  "Smart Supply",      // $1b — auto-buy materials, big QoL
  "Market Research - Demand",      // $5b — unlocks demand-based pricing decisions
  "Market Data - Competition",     // $5b — same for competition
  "Shady Accounting",  // $5b — passive money (high-value once you have it)
  "Government Partnership",        // $10b — passive money
  // "Export" intentionally omitted — see header comment.
];

// Upgrades (one-at-a-time, can be leveled). Cheapest first, so the
// script always applies the most bang-for-buck next level. The
// script only buys one level per tick to avoid blowing the reserve.
const UPGRADE_LEVEL_ORDER = [
  "Smart Factories",   // +production mult
  "Smart Storage",     // +warehouse storage
  "Wilson Analytics",  // +product rating
  "FocusWires",        // +employee stats
  "ABC SalesBots",     // +sales
  "Nuoptimal Nootropic Injector Implants",
  "Speech Processor Implants",
  "Neural Accelerators",
  "Project Insight",
];

// Research priority. List the common researches we want unlocked
// for every division. Product-only researches are added only if the
// division actually makes products (checked at runtime).
const BASE_RESEARCH = [
  "Hi-Tech R&D Laboratory",  // unlocks the rest
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
        } catch (e) {
          // We can't afford; bail on this hire for this tick.
          return false;
        }
      } else {
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
    if (n === 0) return;
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
    for (const j of jobs) if (mix[j] > mix[topJob]) topJob = j;
    targets[topJob] += n - assigned;
    for (const j of jobs) {
      if (targets[j] > 0) {
        try {
          ns.corporation.setJobAssignment(div, city, j, targets[j]);
        } catch (e) {
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
      if (boughtUnlocks.has(name)) continue;
      if (ns.corporation.hasUnlock(name)) {
        boughtUnlocks.add(name);
        continue;
      }
      const cost = ns.corporation.getUnlockCost(name);
      if (!Number.isFinite(cost) || cost <= 0) {
        boughtUnlocks.add(name);  // free or N/A
        continue;
      }
      if (cost < spendableCash(corp)) {
        try {
          ns.corporation.purchaseUnlock(name);
          boughtUnlocks.add(name);
          ns.tprint(`UNLOCKED       ${name}  cost=$${cost.toFixed(0)}`);
        } catch (e) {
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
      if (!Number.isFinite(cost) || cost <= 0) continue;  // maxed
      if (cost < spendableCash(corp)) {
        try {
          ns.corporation.levelUpgrade(name);
          ns.tprint(`UPGRADED       ${name}  level=${ns.corporation.getUpgradeLevel(name)}  cost=$${cost.toFixed(0)}`);
          return;  // one per tick
        } catch (e) {
          return;
        }
      }
    }
  }

  // Research what's missing for a division, in priority order. We
  // track researched names in a Set so we don't repeatedly try.
  const researchedPerDiv = new Map();  // divName -> Set of researched names
  function researchForDiv(div, industry) {
    let done = researchedPerDiv.get(div);
    if (!done) {
      done = new Set();
      researchedPerDiv.set(div, done);
    }
    const industryData = ns.corporation.getIndustryData(industry);
    const makesProducts = industryData.makesProducts;
    const list = [...BASE_RESEARCH];
    if (makesProducts) list.push(...PRODUCT_RESEARCH);
    for (const name of list) {
      if (done.has(name)) continue;
      if (ns.corporation.hasResearched(div, name)) {
        done.add(name);
        continue;
      }
      const cost = ns.corporation.getResearchCost(div, name);
      if (!Number.isFinite(cost) || cost <= 0) {
        done.add(name);  // free or unknown
        continue;
      }
      const corp = ns.corporation.getCorporation();
      if (cost < spendableCash(corp)) {
        try {
          ns.corporation.research(div, name);
          done.add(name);
          ns.tprint(`RESEARCHED     ${div}/${name}  cost=$${cost.toFixed(0)}`);
          return;  // one per tick per pass
        } catch (e) {
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
    if (d.cities.length >= CITIES.length) return;
    for (const city of CITIES) {
      if (d.cities.includes(city)) continue;
      // Probe: try expandCity, see if it throws. There's no
      // getExpandCost API, so we attempt and check.
      const corp = ns.corporation.getCorporation();
      // Conservative gate: need at least 10x current revenue in
      // cash. Without this, expanding into a new city on a thin
      // wallet starves the existing cities.
      const gate = corp.revenue > 0 ? corp.revenue * 10 : 1e9;
      if (corp.funds < gate) return;
      try {
        ns.corporation.expandCity(div, city);
        // Also buy a warehouse there so production can start.
        try {
          ns.corporation.purchaseWarehouse(div, city);
        } catch (e) { /* warehouse might already exist */ }
        // Hire a starter set so the new city isn't a ghost.
        for (let i = 0; i < 3; i++) ns.corporation.hireEmployee(div, city, "Operations");
        ns.tprint(`EXPANDED-city   ${div}/${city}  cities=${d.cities.length + 1}/${CITIES.length}`);
        return;
      } catch (e) {
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
      } catch (e) {
        // Material not produced here; ignore.
      }
    }
    // Sell every product the division has developed. For product
    // divisions, sell MAX at the configured markup.
    for (const productName of d.products) {
      try {
        ns.corporation.sellProduct(div, city, productName, "MAX", productMarkup, true);
      } catch (e) {
        // Product might not be developed yet (under design); ignore.
      }
    }
  }

  // Enable smart supply on a division's warehouse for each city.
  // Requires the "Smart Supply" unlock (which buyStarterUnlocks
  // buys on its own). The function is a no-op if the unlock isn't
  // there.
  function enableSmartSupply(div) {
    if (!ns.corporation.hasUnlock("Smart Supply")) return;
    for (const city of CITIES) {
      try {
        ns.corporation.setSmartSupply(div, city, true);
      } catch (e) { /* warehouse not yet bought in this city */ }
    }
  }

  // Develop the first product for a division, if it doesn't have
  // one. The investment numbers are conservative (designed for
  // early-game capital efficiency). New products beyond the first
  // are NOT auto-created; see header.
  const firstProductDone = new Set();
  function developFirstProduct(div, industry) {
    if (firstProductDone.has(div)) return;
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
    if (!ns.corporation.hasResearched(div, "Hi-Tech R&D Laboratory")) return;
    const corp = ns.corporation.getCorporation();
    // Conservative investments. $1b design + $1b marketing is a
    // reasonable starting point; the player can top these up
    // manually if they want a better product.
    const designInvest = 1e9;
    const marketingInvest = 1e9;
    if (corp.funds < designInvest + marketingInvest + 1e9) return;  // keep a reserve
    try {
      const productName = `${div}-Product`;
      // pick a city that has employees
      const city = d.cities[0];
      if (!city) return;
      ns.corporation.makeProduct(div, city, productName, designInvest, marketingInvest);
      firstProductDone.add(div);
      ns.tprint(`PRODUCT        ${div}/${productName}  design=$${designInvest.toLocaleString()} marketing=$${marketingInvest.toLocaleString()}`);
    } catch (e) {
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
    if (!acceptInvestments) return;
    const offer = ns.corporation.getInvestmentOffer();
    if (!offer || offer.funds <= 0) return;
    if (offer.round < 1 || offer.round > 4) return;
    const pps = offer.funds / Math.max(1, offer.shares);
    // No hard threshold — investments are almost always worth it.
    // Skip if the offer is suspiciously small (round 1 with tiny
    // funds is usually a "wait it out" situation).
    if (offer.funds < 1e8) return;
    try {
      const ok = ns.corporation.acceptInvestmentOffer();
      if (ok) ns.tprint(`INVESTMENT     round=${offer.round}  funds=$${offer.funds.toFixed(0)}  shares=${offer.shares.toFixed(0)}  ($/share=$${pps.toFixed(2)})`);
    } catch (e) { /* ignore */ }
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
    if (!corp) return;  // corp deleted out from under us
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
      if (divAfter.cities.length > before) counters.expanded++;
      // Develop first product if applicable.
      developFirstProduct(divName, div.industry);
      // Set up selling for every city the division has.
      for (const city of divAfter.cities) {
        setupSelling(divName, city);
      }
      // Hire employees up to target, balanced mix.
      for (const city of divAfter.cities) {
        const office = ns.corporation.getOffice(divName, city);
        if (office.numEmployees >= targetEmployees) continue;
        // Hire one at a time so we don't blow the cash budget.
        const ok = hireOne(divName, city, "Operations");
        if (ok) counters.hired++;
        else break;  // can't afford; try again next tick
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
          try { ns.corporation.buyTea(divName, city); } catch (e) { /* no money */ }
          try { ns.corporation.throwParty(divName, city, 500_000); } catch (e) { /* no money */ }
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
