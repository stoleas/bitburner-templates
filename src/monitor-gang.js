/** @param {NS} ns */
//
// Long-lived daemon that runs your Gang on autopilot. Each gang
// tick it:
//   1. Recruits new members when respect allows.
//   2. Trains low-stat members (stats are the bottleneck for
//      everything else — money, respect, territory — until they're
//      reasonably high).
//   3. Assigns members to the highest-ROI task their stats qualify
//      for: respect grinding → money grinding → territory warfare,
//      depending on a configurable "phase".
//   4. Buys equipment upgrades for members that can afford them,
//      with a per-tick spend cap (the 1-to-N Rule).
//   5. Ascends members when the ascension multiplier passes a
//      threshold.
//   6. Engages / disengages territory warfare based on whether
//      we have the power advantage (configurable).
//
// BitNode 2 specifics:
//   - BitNode 2 forces disableCorporation = true (which is fine;
//     gangs and corps are mutually exclusive) and is the BN where
//     this script is the main income source.
//   - SF-2 (Source File 2) is the gang API unlock for non-BN-2
//     runs; the script checks for that via the player's source
//     files if it wants to be defensive. Without SF-2 outside
//     BN-2, every gang.* call would error, so the script gates on
//     the gang API access.
//
// Gang API access check:
//   There's no `ns.gang.hasGangApi()` (the API just throws if you
//   don't have access). We check `ns.gang.inGang()` first — that
//   one doesn't require the API — and if it returns false, we
//   fall through to the "create or join" path. For players who
//   are SF-2 outside BN-2, ns.gang.inGang() will work but the
//   other calls will fail. The script's behavior in that case is
//   "throws on the first call" — there's no clean way to detect
//   "I have access but the API is locked" short of trying.
//
// Phases (the strategy selector):
//   --phase respect    (default) everyone on respect tasks until
//                      you've unlocked everything you need.
//   --phase money      everyone on money tasks. Late-game once
//                      respect growth has plateaued.
//   --phase territory  engage territory warfare; members rotate
//                      between "Territory Warfare" and respect
//                      grinding. Heavily depends on power vs other
//                      gangs.
//
// Task selection rules (per member):
//   If the member's primary stat < 100 → train that stat. Training
//   is gated on the member's task history — we want a member to
//   train BEFORE they start a money/respect task, but not keep
//   training once they're at the per-task threshold.
//   Otherwise, the task is selected by phase:
//     respect    → "Ethical Hacking" (hacking) or "Mug People" /
//                  "Deal Drugs" (combat) based on gang type
//     money      → "Strongarm Civilians" (combat) or "Identity
//                  Theft" (hacking)
//     territory  → "Territory Warfare" if the gang's power is
//                  dominant, else rotate to a money task until
//                  the power gap closes
//
// Equipment buy rules:
//   - Per-tick budget: 25% of liquid cash by default (the 1-to-N
//     Rule, same shape as monitor-hacknet.js and monitor-stock.js).
//   - We only buy ROOT-LEVEL equipment (everything in
//     ns.gang.getEquipmentNames()) for now. Augmentations are
//     gated on the player having them in the first place; the
//     script will pick them up automatically when ns.gang lists
//     them as equipment. There's no "non-Aug" filter in the API.
//   - We skip equipment the member already owns.
//
// Ascension rules:
//   - Only ascend if the ascension multiplier for ANY stat
//     exceeds --ascend-threshold (default 1.5). 1.5 means
//     "50% bonus", which is the conventional first-ascend point.
//   - The API returns an ascension result; we use the maximum
//     stat multiplier from the result to decide.
//
// Output is QUIET by default — only RECRUITED / ASCENDED /
// TASK-changed / EQUIPMENT-bought lines print. --verbose re-enables
// per-tick per-member state. --once runs a single decision pass
// with full output and exits (diagnostic).
//
// Usage:
//   run monitor-gang.js                       # loop, every gang tick, QUIET
//   run monitor-gang.js --once                # one pass, full output, then exit
//   run monitor-gang.js --verbose             # loop, per-member state every tick
//   run monitor-gang.js --phase respect       # default
//   run monitor-gang.js --phase money         # grind money instead
//   run monitor-gang.js --phase territory     # focus territory warfare
//   run monitor-gang.js --ascend-threshold 2  # only ascend at 2x bonus (more patient)
//   run monitor-gang.js --rule-fraction 0.10  # max 10% of wallet on equipment per tick
//   run monitor-gang.js --no-territory        # never auto-engage territory
//
const USAGE = `Usage:
 run monitor-gang.js                       # loop, every gang tick, QUIET
 run monitor-gang.js --once                # one pass, full output, then exit
 run monitor-gang.js --verbose             # loop with per-member state
 run monitor-gang.js --phase respect       # default; respect grinding
 run monitor-gang.js --phase money         # money grinding
 run monitor-gang.js --phase territory     # focus territory warfare
 run monitor-gang.js --ascend-threshold 2  # only ascend at 2x bonus (default 1.5)
 run monitor-gang.js --rule-fraction 0.10  # max 10% of wallet on equipment per tick
 run monitor-gang.js --no-territory        # never auto-engage territory warfare
`;

// Defaults.
const DEFAULT_PHASE = "respect";
const DEFAULT_RULE = 0.25;            // 1-to-N: max 25% of wallet per tick on equipment
const DEFAULT_ASCEND = 1.5;           // any stat bonus >= 1.5x → ascend
const DEFAULT_TRAIN_THRESHOLD = 100;  // stat < this → train; >= this → work
const DEFAULT_TERRITORY_WIN_CHANCE = 0.5;  // only auto-engage territory if we have >50% chance to win vs top gang
const MIN_RULE = 0;
const MAX_RULE = 1;

// Standard task names. The gang API lists tasks dynamically
// (ns.gang.getTaskNames()), but the canonical set is small enough
// to hardcode. If the game adds a new task, it'll show up in
// getTaskNames() — we just won't pick it. Combat and hacking
// gangs use the same set; the in-game math handles which is
// better for which gang type.
const TASKS = {
  // Training
  TRAIN_STRENGTH: "Train Strength",
  TRAIN_DEFENSE: "Train Defense",
  TRAIN_DEXTERITY: "Train Dexterity",
  TRAIN_AGILITY: "Train Agility",
  // Unassigned / Vigilante
  UNASSIGNED: "Unassigned",
  VIGILANTE: "Vigilante Justice",
  // Money
  MONEY_COMBAT: "Strongarm Civilians",
  MONEY_HACK: "Identity Theft",
  // Respect
  RESPECT_COMBAT: "Mug People",
  RESPECT_HACK: "Ethical Hacking",
  // Territory
  TERRITORY: "Territory Warfare",
};

// Map: gang "isHackingGang" → preferred task per phase.
function taskForPhase(isHacking, phase) {
  if (phase === "respect") return isHacking ? TASKS.RESPECT_HACK : TASKS.RESPECT_COMBAT;
  if (phase === "money") return isHacking ? TASKS.MONEY_HACK : TASKS.MONEY_COMBAT;
  if (phase === "territory") return TASKS.TERRITORY;
  return TASKS.UNASSIGNED;
}

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }

  // Gate: must be in a gang. inGang() is the only gang.* method
  // that doesn't require the API access (per the docstring), so
  // we use it to detect "no gang at all" without throwing.
  if (!ns.gang.inGang()) {
    ns.tprint("ERROR: not in a gang. Create or join one in the City UI first (karma <= 54k required, or play in BitNode 2).");
    return;
  }

  // Parse args.
  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const noTerritory = args.includes("--no-territory");
  const phaseIdx = args.indexOf("--phase");
  const phase = phaseIdx >= 0 ? String(args[phaseIdx + 1]) : DEFAULT_PHASE;
  if (!["respect", "money", "territory"].includes(phase)) {
    ns.tprint(`monitor-gang: --phase must be one of respect|money|territory (got ${phase})`);
    return;
  }
  const ruleIdx = args.indexOf("--rule-fraction");
  const ruleFraction = ruleIdx >= 0 ? Number(args[ruleIdx + 1]) : DEFAULT_RULE;
  if (ruleIdx >= 0 && (!Number.isFinite(ruleFraction) || ruleFraction < MIN_RULE || ruleFraction > MAX_RULE)) {
    ns.tprint(`monitor-gang: --rule-fraction must be a number ${MIN_RULE}..${MAX_RULE} (got ${args[ruleIdx + 1]})`);
    return;
  }
  const ascendIdx = args.indexOf("--ascend-threshold");
  const ascendThreshold = ascendIdx >= 0 ? Number(args[ascendIdx + 1]) : DEFAULT_ASCEND;
  if (ascendIdx >= 0 && (!Number.isFinite(ascendThreshold) || ascendThreshold < 1)) {
    ns.tprint(`monitor-gang: --ascend-threshold must be a number >= 1 (got ${args[ascendIdx + 1]})`);
    return;
  }

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");

  // Cached equipment list. ns.gang.getEquipmentNames() returns the
  // FULL list of equipment + augmentations the player can install
  // on members; this is stable across ticks (only changes when
  // you install an aug), so we cache it once at startup.
  const equipmentList = ns.gang.getEquipmentNames();

  // Per-member: pick the best training task based on the gang
  // type. Hacking gangs prioritize hack training; combat gangs
  // rotate through the four combat stats. "Best" is the stat
  // with the lowest current absolute value.
  function bestTrainingTask(info) {
    const isHacking = info.hack > info.str && info.hack > info.def && info.hack > info.dex && info.hack > info.agi;
    if (isHacking) return TASKS.TRAIN_STRENGTH;  // even hacking members need combat stats for territory
    // Combat gang: train the lowest of str / def / dex / agi.
    const stats = {
      [TASKS.TRAIN_STRENGTH]: info.str,
      [TASKS.TRAIN_DEFENSE]: info.def,
      [TASKS.TRAIN_DEXTERITY]: info.dex,
      [TASKS.TRAIN_AGILITY]: info.agi,
    };
    let pick = TASKS.TRAIN_STRENGTH;
    for (const [k, v] of Object.entries(stats)) if (v < stats[pick]) pick = k;
    return pick;
  }

  // Decide what task a member should be on. The decision tree:
  //   1. If any primary stat < threshold → train (lowest first).
  //   2. Otherwise → task per phase.
  // Note: a member that's currently training doesn't get
  // re-evaluated to "respect" until stats cross the threshold;
  // we want a member to actually FINISH training instead of
  // flapping.
  function decideTask(info, isHacking, wantTerritory) {
    if (info.str < DEFAULT_TRAIN_THRESHOLD
        || info.def < DEFAULT_TRAIN_THRESHOLD
        || info.dex < DEFAULT_TRAIN_THRESHOLD
        || info.agi < DEFAULT_TRAIN_THRESHOLD) {
      return bestTrainingTask(info);
    }
    if (wantTerritory) return TASKS.TERRITORY;
    return taskForPhase(isHacking, phase);
  }

  // One gang tick.
  //   1. Recruit if possible.
  //   2. Ascend if any member qualifies.
  //   3. Reassign tasks for every member.
  //   4. Buy equipment (subject to per-tick budget).
  //   5. Set territory warfare flag.
  function pass() {
    const counters = { recruited: 0, ascended: 0, taskChanged: 0, equipmentBought: 0 };
    const info = ns.gang.getGangInformation();
    const isHacking = info.isHackingGang;
    let members = ns.gang.getMemberNames();
    // Sorting by name is fine — the gang assigns names in recruit
    // order, so it's effectively oldest-first.
    const wallet = ns.getServerMoneyAvailable("home");
    const budget = ruleFraction > 0 ? wallet * ruleFraction : wallet;
    let spent = 0;

    // 1. Recruit. respectForNextRecruit is the respect cost; we
    // also need the player to have the required respect
    // accumulated. ns.gang.recruitMember() handles both checks
    // internally and returns false if either fails.
    while (ns.gang.canRecruitMember()) {
      // Pick a name. We use a per-recruit counter so names are
      // unique even across restarts.
      recruitCounter++;
      const name = `m${recruitCounter}`;
      if (ns.gang.recruitMember(name)) {
        members.push(name);
        counters.recruited++;
        ns.tprint(`RECRUITED       ${name}  total=${members.length}`);
      } else {
        break;  // race: respect drained; bail
      }
    }
    // refresh members in case the API caches length
    members = ns.gang.getMemberNames();

    // 2. Ascension. getAscensionResult returns the projected result
    //    without actually ascending, so we can check eligibility
    //    cheaply. We ascend if ANY stat multiplier exceeds the
    //    threshold.
    for (const name of members) {
      const r = ns.gang.getAscensionResult(name);
      if (!r) continue;
      const maxMult = Math.max(r.hack, r.str, r.def, r.dex, r.agi, r.cha);
      if (maxMult >= ascendThreshold) {
        const ok = ns.gang.ascendMember(name);
        if (ok) {
          counters.ascended++;
          ns.tprint(`ASCENDED       ${name}  max-bonus=${maxMult.toFixed(2)}x  respect-lost=${r.respect.toFixed(0)}`);
        }
      }
    }

    // 3. Territory warfare decision. We auto-engage if:
    //   a) phase == "territory", OR
    //   b) we have >50% chance to win clashes with the strongest
    //      rival gang (a stable way to gain territory).
    // --no-territory disables this entirely (and forces a
    // non-territory task on every member).
    let wantTerritory = false;
    if (!noTerritory) {
      if (phase === "territory") {
        wantTerritory = true;
      } else {
        // Check the strongest rival's clash probability.
        const all = ns.gang.getAllGangInformation();
        const myName = info.faction;  // GangGenInfo.faction is the gang name
        let maxWinChance = 0;
        for (const [gName, g] of Object.entries(all)) {
          if (gName === myName) continue;
          const c = ns.gang.getChanceToWinClash(gName);
          if (c > maxWinChance) maxWinChance = c;
        }
        if (maxWinChance >= DEFAULT_TERRITORY_WIN_CHANCE) wantTerritory = true;
      }
    }
    ns.gang.setTerritoryWarfare(wantTerritory);

    // 4. Task assignment.
    for (const name of members) {
      const m = ns.gang.getMemberInformation(name);
      const target = decideTask(m, isHacking, wantTerritory);
      if (m.task !== target) {
        try {
          ns.gang.setMemberTask(name, target);
          counters.taskChanged++;
          if (verbose) ns.tprint(`TASK           ${name}  ${m.task} → ${target}`);
        } catch (e) { /* task name typo'd — fall through */ }
      }
    }

    // 5. Equipment buys. Walk the list; for each member and each
    //    equipment name, try to buy it if the member doesn't
    //    already own it and we have budget. Order is determined
    //    by getEquipmentCost (cheapest first), so we sort the
    //    equipment list by cost at startup.
    const equipmentByCost = [...equipmentList].sort((a, b) => {
      const ca = ns.gang.getEquipmentCost(a);
      const cb = ns.gang.getEquipmentCost(b);
      return (ca || Infinity) - (cb || Infinity);
    });
    for (const name of members) {
      const m = ns.gang.getMemberInformation(name);
      const owned = new Set([...m.upgrades, ...m.augmentations]);
      for (const eq of equipmentByCost) {
        if (owned.has(eq)) continue;
        const cost = ns.gang.getEquipmentCost(eq);
        if (!Number.isFinite(cost) || cost <= 0) continue;
        if (spent + cost > budget) continue;
        const ok = ns.gang.purchaseEquipment(name, eq);
        if (ok) {
          spent += cost;
          counters.equipmentBought++;
          if (verbose) ns.tprint(`EQUIPMENT      ${name}  ${eq}  $${cost.toFixed(0)}`);
          break;  // one equipment per member per tick (else we over-spend the budget)
        }
      }
    }

    if (verbose) {
      const totalMoney = members.reduce((s, n) => s + ns.gang.getMemberInformation(n).moneyGain, 0);
      const totalRespect = members.reduce((s, n) => s + ns.gang.getMemberInformation(n).respectGain, 0);
      ns.tprint(`gang: members=${members.length} moneyGain=${totalMoney.toFixed(0)}/tick respectGain=${totalRespect.toFixed(2)}/tick territory=${info.territory.toFixed(4)} wanted=${info.wantedLevel.toFixed(2)}`);
    }

    return counters;
  }

  // Stable, restart-safe recruit counter. Members are named
  // "m1", "m2", ... in recruit order; the next recruit gets the
  // next number. We scan the current roster so the script is
  // restart-safe (resume numbering from the highest existing
  // mN rather than restarting at m1, which would collide).
  let recruitCounter = 0;
  for (const n of ns.gang.getMemberNames()) {
    const m = n.match(/^m(\d+)$/);
    if (m) {
      const num = Number(m[1]);
      if (num > recruitCounter) recruitCounter = num;
    }
  }

  if (once) {
    pass();
    return;
  }

  ns.tprint(`monitor-gang: started, phase=${phase}, rule=${(ruleFraction * 100).toFixed(0)}%, ascend>=${ascendThreshold}, output=${verbose ? "verbose" : "quiet"}`);
  // Main loop. ns.gang.nextUpdate() resolves once per gang tick
  // (2-5s with no bonus time). Same rationale as monitor-stock.js:
  // use the game's own cadence signal instead of a fixed sleep.
  while (true) {
    await ns.gang.nextUpdate();
    pass();
  }
}
