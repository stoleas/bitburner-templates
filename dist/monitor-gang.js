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
const DEFAULT_RULE = 0.25; // 1-to-N: max 25% of wallet per tick on equipment
const DEFAULT_ASCEND = 1.5; // any stat bonus >= 1.5x → ascend
const DEFAULT_TRAIN_THRESHOLD = 100; // stat < this → train; >= this → work
const DEFAULT_TERRITORY_WIN_CHANCE = 0.5; // only auto-engage territory if we have >50% chance to win vs top gang
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
    if (phase === "respect")
        return isHacking ? TASKS.RESPECT_HACK : TASKS.RESPECT_COMBAT;
    if (phase === "money")
        return isHacking ? TASKS.MONEY_HACK : TASKS.MONEY_COMBAT;
    if (phase === "territory")
        return TASKS.TERRITORY;
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
        if (isHacking)
            return TASKS.TRAIN_STRENGTH; // even hacking members need combat stats for territory
        // Combat gang: train the lowest of str / def / dex / agi.
        const stats = {
            [TASKS.TRAIN_STRENGTH]: info.str,
            [TASKS.TRAIN_DEFENSE]: info.def,
            [TASKS.TRAIN_DEXTERITY]: info.dex,
            [TASKS.TRAIN_AGILITY]: info.agi,
        };
        let pick = TASKS.TRAIN_STRENGTH;
        for (const [k, v] of Object.entries(stats))
            if (v < stats[pick])
                pick = k;
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
        if (wantTerritory)
            return TASKS.TERRITORY;
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
            }
            else {
                break; // race: respect drained; bail
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
            if (!r)
                continue;
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
            }
            else {
                // Check the strongest rival's clash probability.
                const all = ns.gang.getAllGangInformation();
                const myName = info.faction; // GangGenInfo.faction is the gang name
                let maxWinChance = 0;
                for (const [gName, g] of Object.entries(all)) {
                    if (gName === myName)
                        continue;
                    const c = ns.gang.getChanceToWinClash(gName);
                    if (c > maxWinChance)
                        maxWinChance = c;
                }
                if (maxWinChance >= DEFAULT_TERRITORY_WIN_CHANCE)
                    wantTerritory = true;
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
                    if (verbose)
                        ns.tprint(`TASK           ${name}  ${m.task} → ${target}`);
                }
                catch (e) { /* task name typo'd — fall through */ }
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
                if (owned.has(eq))
                    continue;
                const cost = ns.gang.getEquipmentCost(eq);
                if (!Number.isFinite(cost) || cost <= 0)
                    continue;
                if (spent + cost > budget)
                    continue;
                const ok = ns.gang.purchaseEquipment(name, eq);
                if (ok) {
                    spent += cost;
                    counters.equipmentBought++;
                    if (verbose)
                        ns.tprint(`EQUIPMENT      ${name}  ${eq}  $${cost.toFixed(0)}`);
                    break; // one equipment per member per tick (else we over-spend the budget)
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
            if (num > recruitCounter)
                recruitCounter = num;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1nYW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21vbml0b3ItZ2FuZy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLGdFQUFnRTtBQUNoRSxXQUFXO0FBQ1gsaURBQWlEO0FBQ2pELDZEQUE2RDtBQUM3RCxtRUFBbUU7QUFDbkUseUJBQXlCO0FBQ3pCLG1FQUFtRTtBQUNuRSxtRUFBbUU7QUFDbkUsNENBQTRDO0FBQzVDLGlFQUFpRTtBQUNqRSxvREFBb0Q7QUFDcEQsOERBQThEO0FBQzlELGtCQUFrQjtBQUNsQiwrREFBK0Q7QUFDL0QsbURBQW1EO0FBQ25ELEVBQUU7QUFDRix1QkFBdUI7QUFDdkIsaUVBQWlFO0FBQ2pFLGtFQUFrRTtBQUNsRSw2Q0FBNkM7QUFDN0MsK0RBQStEO0FBQy9ELCtEQUErRDtBQUMvRCw4REFBOEQ7QUFDOUQsa0VBQWtFO0FBQ2xFLDJCQUEyQjtBQUMzQixFQUFFO0FBQ0YseUJBQXlCO0FBQ3pCLGtFQUFrRTtBQUNsRSxpRUFBaUU7QUFDakUsOERBQThEO0FBQzlELCtEQUErRDtBQUMvRCw4REFBOEQ7QUFDOUQsaUVBQWlFO0FBQ2pFLGdFQUFnRTtBQUNoRSwyREFBMkQ7QUFDM0QsRUFBRTtBQUNGLGtDQUFrQztBQUNsQyxpRUFBaUU7QUFDakUsNERBQTREO0FBQzVELCtEQUErRDtBQUMvRCxxREFBcUQ7QUFDckQsZ0VBQWdFO0FBQ2hFLCtEQUErRDtBQUMvRCxtRUFBbUU7QUFDbkUsOEJBQThCO0FBQzlCLEVBQUU7QUFDRixxQ0FBcUM7QUFDckMsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSwrREFBK0Q7QUFDL0QscURBQXFEO0FBQ3JELDhDQUE4QztBQUM5QyxpRUFBaUU7QUFDakUsNERBQTREO0FBQzVELCtEQUErRDtBQUMvRCxvQ0FBb0M7QUFDcEMsOERBQThEO0FBQzlELCtEQUErRDtBQUMvRCx3Q0FBd0M7QUFDeEMsRUFBRTtB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O0lBQ2pFLDhEQUE4RDtJQUM5RCxPQUFPLElBQUksRUFBRTtRQUNYLE1BQU0sRUFBRSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUMzQixJQUFJLEVBQUUsQ0FBQztLQUNSO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIExvbmctbGl2ZWQgZGFlbW9uIHRoYXQgcnVucyB5b3VyIEdhbmcgb24gYXV0b3BpbG90LiBFYWNoIGdhbmdcbi8vIHRpY2sgaXQ6XG4vLyAgIDEuIFJlY3J1aXRzIG5ldyBtZW1iZXJzIHdoZW4gcmVzcGVjdCBhbGxvd3MuXG4vLyAgIDIuIFRyYWlucyBsb3ctc3RhdCBtZW1iZXJzIChzdGF0cyBhcmUgdGhlIGJvdHRsZW5lY2sgZm9yXG4vLyAgICAgIGV2ZXJ5dGhpbmcgZWxzZSDigJQgbW9uZXksIHJlc3BlY3QsIHRlcnJpdG9yeSDigJQgdW50aWwgdGhleSdyZVxuLy8gICAgICByZWFzb25hYmx5IGhpZ2gpLlxuLy8gICAzLiBBc3NpZ25zIG1lbWJlcnMgdG8gdGhlIGhpZ2hlc3QtUk9JIHRhc2sgdGhlaXIgc3RhdHMgcXVhbGlmeVxuLy8gICAgICBmb3I6IHJlc3BlY3QgZ3JpbmRpbmcg4oaSIG1vbmV5IGdyaW5kaW5nIOKGkiB0ZXJyaXRvcnkgd2FyZmFyZSxcbi8vICAgICAgZGVwZW5kaW5nIG9uIGEgY29uZmlndXJhYmxlIFwicGhhc2VcIi5cbi8vICAgNC4gQnV5cyBlcXVpcG1lbnQgdXBncmFkZXMgZm9yIG1lbWJlcnMgdGhhdCBjYW4gYWZmb3JkIHRoZW0sXG4vLyAgICAgIHdpdGggYSBwZXItdGljayBzcGVuZCBjYXAgKHRoZSAxLXRvLU4gUnVsZSkuXG4vLyAgIDUuIEFzY2VuZHMgbWVtYmVycyB3aGVuIHRoZSBhc2NlbnNpb24gbXVsdGlwbGllciBwYXNzZXMgYVxuLy8gICAgICB0aHJlc2hvbGQuXG4vLyAgIDYuIEVuZ2FnZXMgLyBkaXNlbmdhZ2VzIHRlcnJpdG9yeSB3YXJmYXJlIGJhc2VkIG9uIHdoZXRoZXJcbi8vICAgICAgd2UgaGF2ZSB0aGUgcG93ZXIgYWR2YW50YWdlIChjb25maWd1cmFibGUpLlxuLy9cbi8vIEJpdE5vZGUgMiBzcGVjaWZpY3M6XG4vLyAgIC0gQml0Tm9kZSAyIGZvcmNlcyBkaXNhYmxlQ29ycG9yYXRpb24gPSB0cnVlICh3aGljaCBpcyBmaW5lO1xuLy8gICAgIGdhbmdzIGFuZCBjb3JwcyBhcmUgbXV0dWFsbHkgZXhjbHVzaXZlKSBhbmQgaXMgdGhlIEJOIHdoZXJlXG4vLyAgICAgdGhpcyBzY3JpcHQgaXMgdGhlIG1haW4gaW5jb21lIHNvdXJjZS5cbi8vICAgLSBTRi0yIChTb3VyY2UgRmlsZSAyKSBpcyB0aGUgZ2FuZyBBUEkgdW5sb2NrIGZvciBub24tQk4tMlxuLy8gICAgIHJ1bnM7IHRoZSBzY3JpcHQgY2hlY2tzIGZvciB0aGF0IHZpYSB0aGUgcGxheWVyJ3Mgc291cmNlXG4vLyAgICAgZmlsZXMgaWYgaXQgd2FudHMgdG8gYmUgZGVmZW5zaXZlLiBXaXRob3V0IFNGLTIgb3V0c2lkZVxuLy8gICAgIEJOLTIsIGV2ZXJ5IGdhbmcuKiBjYWxsIHdvdWxkIGVycm9yLCBzbyB0aGUgc2NyaXB0IGdhdGVzIG9uXG4vLyAgICAgdGhlIGdhbmcgQVBJIGFjY2Vzcy5cbi8vXG4vLyBHYW5nIEFQSSBhY2Nlc3MgY2hlY2s6XG4vLyAgIFRoZXJlJ3Mgbm8gYG5zLmdhbmcuaGFzR2FuZ0FwaSgpYCAodGhlIEFQSSBqdXN0IHRocm93cyBpZiB5b3Vcbi8vICAgZG9uJ3QgaGF2ZSBhY2Nlc3MpLiBXZSBjaGVjayBgbnMuZ2FuZy5pbkdhbmcoKWAgZmlyc3Qg4oCUIHRoYXRcbi8vICAgb25lIGRvZXNuJ3QgcmVxdWlyZSB0aGUgQVBJIOKAlCBhbmQgaWYgaXQgcmV0dXJucyBmYWxzZSwgd2Vcbi8vICAgZmFsbCB0aHJvdWdoIHRvIHRoZSBcImNyZWF0ZSBvciBqb2luXCIgcGF0aC4gRm9yIHBsYXllcnMgd2hvXG4vLyAgIGFyZSBTRi0yIG91dHNpZGUgQk4tMiwgbnMuZ2FuZy5pbkdhbmcoKSB3aWxsIHdvcmsgYnV0IHRoZVxuLy8gICBvdGhlciBjYWxscyB3aWxsIGZhaWwuIFRoZSBzY3JpcHQncyBiZWhhdmlvciBpbiB0aGF0IGNhc2UgaXNcbi8vICAgXCJ0aHJvd3Mgb24gdGhlIGZpcnN0IGNhbGxcIiDigJQgdGhlcmUncyBubyBjbGVhbiB3YXkgdG8gZGV0ZWN0XG4vLyAgIFwiSSBoYXZlIGFjY2VzcyBidXQgdGhlIEFQSSBpcyBsb2NrZWRcIiBzaG9ydCBvZiB0cnlpbmcuXG4vL1xuLy8gUGhhc2VzICh0aGUgc3RyYXRlZ3kgc2VsZWN0b3IpOlxuLy8gICAtLXBoYXNlIHJlc3BlY3QgICAgKGRlZmF1bHQpIGV2ZXJ5b25lIG9uIHJlc3BlY3QgdGFza3MgdW50aWxcbi8vICAgICAgICAgICAgICAgICAgICAgIHlvdSd2ZSB1bmxvY2tlZCBldmVyeXRoaW5nIHlvdSBuZWVkLlxuLy8gICAtLXBoYXNlIG1vbmV5ICAgICAgZXZlcnlvbmUgb24gbW9uZXkgdGFza3MuIExhdGUtZ2FtZSBvbmNlXG4vLyAgICAgICAgICAgICAgICAgICAgICByZXNwZWN0IGdyb3d0aCBoYXMgcGxhdGVhdWVkLlxuLy8gICAtLXBoYXNlIHRlcnJpdG9yeSAgZW5nYWdlIHRlcnJpdG9yeSB3YXJmYXJlOyBtZW1iZXJzIHJvdGF0ZVxuLy8gICAgICAgICAgICAgICAgICAgICAgYmV0d2VlbiBcIlRlcnJpdG9yeSBXYXJmYXJlXCIgYW5kIHJlc3BlY3Rcbi8vICAgICAgICAgICAgICAgICAgICAgIGdyaW5kaW5nLiBIZWF2aWx5IGRlcGVuZHMgb24gcG93ZXIgdnMgb3RoZXJcbi8vICAgICAgICAgICAgICAgICAgICAgIGdhbmdzLlxuLy9cbi8vIFRhc2sgc2VsZWN0aW9uIHJ1bGVzIChwZXIgbWVtYmVyKTpcbi8vICAgSWYgdGhlIG1lbWJlcidzIHByaW1hcnkgc3RhdCA8IDEwMCDihpIgdHJhaW4gdGhhdCBzdGF0LiBUcmFpbmluZ1xuLy8gICBpcyBnYXRlZCBvbiB0aGUgbWVtYmVyJ3MgdGFzayBoaXN0b3J5IOKAlCB3ZSB3YW50IGEgbWVtYmVyIHRvXG4vLyAgIHRyYWluIEJFRk9SRSB0aGV5IHN0YXJ0IGEgbW9uZXkvcmVzcGVjdCB0YXNrLCBidXQgbm90IGtlZXBcbi8vICAgdHJhaW5pbmcgb25jZSB0aGV5J3JlIGF0IHRoZSBwZXItdGFzayB0aHJlc2hvbGQuXG4vLyAgIE90aGVyd2lzZSwgdGhlIHRhc2sgaXMgc2VsZWN0ZWQgYnkgcGhhc2U6XG4vLyAgICAgcmVzcGVjdCAgICDihpIgXCJFdGhpY2FsIEhhY2tpbmdcIiAoaGFja2luZykgb3IgXCJNdWcgUGVvcGxlXCIgL1xuLy8gICAgICAgICAgICAgICAgICBcIkRlYWwgRHJ1Z3NcIiAoY29tYmF0KSBiYXNlZCBvbiBnYW5nIHR5cGVcbi8vICAgICBtb25leSAgICAgIOKGkiBcIlN0cm9uZ2FybSBDaXZpbGlhbnNcIiAoY29tYmF0KSBvciBcIklkZW50aXR5XG4vLyAgICAgICAgICAgICAgICAgIFRoZWZ0XCIgKGhhY2tpbmcpXG4vLyAgICAgdGVycml0b3J5ICDihpIgXCJUZXJyaXRvcnkgV2FyZmFyZVwiIGlmIHRoZSBnYW5nJ3MgcG93ZXIgaXNcbi8vICAgICAgICAgICAgICAgICAgZG9taW5hbnQsIGVsc2Ugcm90YXRlIHRvIGEgbW9uZXkgdGFzayB1bnRpbFxuLy8gICAgICAgICAgICAgICAgICB0aGUgcG93ZXIgZ2FwIGNsb3Nlc1xuLy9cbi8vIEVxdWlwbWVudCBidXkgcnVsZXM6XG4vLyAgIC0gUGVyLXRpY2sgYnVkZ2V0OiAyNSUgb2YgbGlxdWlkIGNhc2ggYnkgZGVmYXVsdCAodGhlIDEtdG8tTlxuLy8gICAgIFJ1bGUsIHNhbWUgc2hhcGUgYXMgbW9uaXRvci1oYWNrbmV0LmpzIGFuZCBtb25pdG9yLXN0b2NrLmpzKS5cbi8vICAgLSBXZSBvbmx5IGJ1eSBST09ULUxFVkVMIGVxdWlwbWVudCAoZXZlcnl0aGluZyBpblxuLy8gICAgIG5zLmdhbmcuZ2V0RXF1aXBtZW50TmFtZXMoKSkgZm9yIG5vdy4gQXVnbWVudGF0aW9ucyBhcmVcbi8vICAgICBnYXRlZCBvbiB0aGUgcGxheWVyIGhhdmluZyB0aGVtIGluIHRoZSBmaXJzdCBwbGFjZTsgdGhlXG4vLyAgICAgc2NyaXB0IHdpbGwgcGljayB0aGVtIHVwIGF1dG9tYXRpY2FsbHkgd2hlbiBucy5nYW5nIGxpc3RzXG4vLyAgICAgdGhlbSBhcyBlcXVpcG1lbnQuIFRoZXJlJ3Mgbm8gXCJub24tQXVnXCIgZmlsdGVyIGluIHRoZSBBUEkuXG4vLyAgIC0gV2Ugc2tpcCBlcXVpcG1lbnQgdGhlIG1lbWJlciBhbHJlYWR5IG93bnMuXG4vL1xuLy8gQXNjZW5zaW9uIHJ1bGVzOlxuLy8gICAtIE9ubHkgYXNjZW5kIGlmIHRoZSBhc2NlbnNpb24gbXVsdGlwbGllciBmb3IgQU5ZIHN0YXRcbi8vICAgICBleGNlZWRzIC0tYXNjZW5kLXRocmVzaG9sZCAoZGVmYXVsdCAxLjUpLiAxLjUgbWVhbnNcbi8vICAgICBcIjUwJSBib251c1wiLCB3aGljaCBpcyB0aGUgY29udmVudGlvbmFsIGZpcnN0LWFzY2VuZCBwb2ludC5cbi8vICAgLSBUaGUgQVBJIHJldHVybnMgYW4gYXNjZW5zaW9uIHJlc3VsdDsgd2UgdXNlIHRoZSBtYXhpbXVtXG4vLyAgICAgc3RhdCBtdWx0aXBsaWVyIGZyb20gdGhlIHJlc3VsdCB0byBkZWNpZGUuXG4vL1xuLy8gT3V0cHV0IGlzIFFVSUVUIGJ5IGRlZmF1bHQg4oCUIG9ubHkgUkVDUlVJVEVEIC8gQVNDRU5ERUQgL1xuLy8gVEFTSy1jaGFuZ2VkIC8gRVFVSVBNRU5ULWJvdWdodCBsaW5lcyBwcmludC4gLS12ZXJib3NlIHJlLWVuYWJsZXNcbi8vIHBlci10aWNrIHBlci1tZW1iZXIgc3RhdGUuIC0tb25jZSBydW5zIGEgc2luZ2xlIGRlY2lzaW9uIHBhc3Ncbi8vIHdpdGggZnVsbCBvdXRwdXQgYW5kIGV4aXRzIChkaWFnbm9zdGljKS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIG1vbml0b3ItZ2FuZy5qcyAgICAgICAgICAgICAgICAgICAgICAgIyBsb29wLCBldmVyeSBnYW5nIHRpY2ssIFFVSUVUXG4vLyAgIHJ1biBtb25pdG9yLWdhbmcuanMgLS1vbmNlICAgICAgICAgICAgICAgICMgb25lIHBhc3MsIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbi8vICAgcnVuIG1vbml0b3ItZ2FuZy5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyBsb29wLCBwZXItbWVtYmVyIHN0YXRlIGV2ZXJ5IHRpY2tcbi8vICAgcnVuIG1vbml0b3ItZ2FuZy5qcyAtLXBoYXNlIHJlc3BlY3QgICAgICAgIyBkZWZhdWx0XG4vLyAgIHJ1biBtb25pdG9yLWdhbmcuanMgLS1waGFzZSBtb25leSAgICAgICAgICMgZ3JpbmQgbW9uZXkgaW5zdGVhZFxuLy8gICBydW4gbW9uaXRvci1nYW5nLmpzIC0tcGhhc2UgdGVycml0b3J5ICAgICAjIGZvY3VzIHRlcnJpdG9yeSB3YXJmYXJlXG4vLyAgIHJ1biBtb25pdG9yLWdhbmcuanMgLS1hc2NlbmQtdGhyZXNob2xkIDIgICMgb25seSBhc2NlbmQgYXQgMnggYm9udXMgKG1vcmUgcGF0aWVudClcbi8vICAgcnVuIG1vbml0b3ItZ2FuZy5qcyAtLXJ1bGUtZnJhY3Rpb24gMC4xMCAgIyBtYXggMTAlIG9mIHdhbGxldCBvbiBlcXVpcG1lbnQgcGVyIHRpY2tcbi8vICAgcnVuIG1vbml0b3ItZ2FuZy5qcyAtLW5vLXRlcnJpdG9yeSAgICAgICAgIyBuZXZlciBhdXRvLWVuZ2FnZSB0ZXJyaXRvcnlcbi8vXG5jb25zdCBVU0FHRSA9IGBVc2FnZTpcbiBydW4gbW9uaXRvci1nYW5nLmpzICAgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IGdhbmcgdGljaywgUVVJRVRcbiBydW4gbW9uaXRvci1nYW5nLmpzIC0tb25jZSAgICAgICAgICAgICAgICAjIG9uZSBwYXNzLCBmdWxsIG91dHB1dCwgdGhlbiBleGl0XG4gcnVuIG1vbml0b3ItZ2FuZy5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyBsb29wIHdpdGggcGVyLW1lbWJlciBzdGF0ZVxuIHJ1biBtb25pdG9yLWdhbmcuanMgLS1waGFzZSByZXNwZWN0ICAgICAgICMgZGVmYXVsdDsgcmVzcGVjdCBncmluZGluZ1xuIHJ1biBtb25pdG9yLWdhbmcuanMgLS1waGFzZSBtb25leSAgICAgICAgICMgbW9uZXkgZ3JpbmRpbmdcbiBydW4gbW9uaXRvci1nYW5nLmpzIC0tcGhhc2UgdGVycml0b3J5ICAgICAjIGZvY3VzIHRlcnJpdG9yeSB3YXJmYXJlXG4gcnVuIG1vbml0b3ItZ2FuZy5qcyAtLWFzY2VuZC10aHJlc2hvbGQgMiAgIyBvbmx5IGFzY2VuZCBhdCAyeCBib251cyAoZGVmYXVsdCAxLjUpXG4gcnVuIG1vbml0b3ItZ2FuZy5qcyAtLXJ1bGUtZnJhY3Rpb24gMC4xMCAgIyBtYXggMTAlIG9mIHdhbGxldCBvbiBlcXVpcG1lbnQgcGVyIHRpY2tcbiBydW4gbW9uaXRvci1nYW5nLmpzIC0tbm8tdGVycml0b3J5ICAgICAgICAjIG5ldmVyIGF1dG8tZW5nYWdlIHRlcnJpdG9yeSB3YXJmYXJlXG5gO1xuXG4vLyBEZWZhdWx0cy5cbmNvbnN0IERFRkFVTFRfUEhBU0UgPSBcInJlc3BlY3RcIjtcbmNvbnN0IERFRkFVTFRfUlVMRSA9IDAuMjU7ICAgICAgICAgICAgLy8gMS10by1OOiBtYXggMjUlIG9mIHdhbGxldCBwZXIgdGljayBvbiBlcXVpcG1lbnRcbmNvbnN0IERFRkFVTFRfQVNDRU5EID0gMS41OyAgICAgICAgICAgLy8gYW55IHN0YXQgYm9udXMgPj0gMS41eCDihpIgYXNjZW5kXG5jb25zdCBERUZBVUxUX1RSQUlOX1RIUkVTSE9MRCA9IDEwMDsgIC8vIHN0YXQgPCB0aGlzIOKGkiB0cmFpbjsgPj0gdGhpcyDihpIgd29ya1xuY29uc3QgREVGQVVMVF9URVJSSVRPUllfV0lOX0NIQU5DRSA9IDAuNTsgIC8vIG9ubHkgYXV0by1lbmdhZ2UgdGVycml0b3J5IGlmIHdlIGhhdmUgPjUwJSBjaGFuY2UgdG8gd2luIHZzIHRvcCBnYW5nXG5jb25zdCBNSU5fUlVMRSA9IDA7XG5jb25zdCBNQVhfUlVMRSA9IDE7XG5cbi8vIFN0YW5kYXJkIHRhc2sgbmFtZXMuIFRoZSBnYW5nIEFQSSBsaXN0cyB0YXNrcyBkeW5hbWljYWxseVxuLy8gKG5zLmdhbmcuZ2V0VGFza05hbWVzKCkpLCBidXQgdGhlIGNhbm9uaWNhbCBzZXQgaXMgc21hbGwgZW5vdWdoXG4vLyB0byBoYXJkY29kZS4gSWYgdGhlIGdhbWUgYWRkcyBhIG5ldyB0YXNrLCBpdCdsbCBzaG93IHVwIGluXG4vLyBnZXRUYXNrTmFtZXMoKSDigJQgd2UganVzdCB3b24ndCBwaWNrIGl0LiBDb21iYXQgYW5kIGhhY2tpbmdcbi8vIGdhbmdzIHVzZSB0aGUgc2FtZSBzZXQ7IHRoZSBpbi1nYW1lIG1hdGggaGFuZGxlcyB3aGljaCBpc1xuLy8gYmV0dGVyIGZvciB3aGljaCBnYW5nIHR5cGUuXG5jb25zdCBUQVNLUyA9IHtcbiAgLy8gVHJhaW5pbmdcbiAgVFJBSU5fU1RSRU5HVEg6IFwiVHJhaW4gU3RyZW5ndGhcIixcbiAgVFJBSU5fREVGRU5TRTogXCJUcmFpbiBEZWZlbnNlXCIsXG4gIFRSQUlOX0RFWFRFUklUWTogXCJUcmFpbiBEZXh0ZXJpdHlcIixcbiAgVFJBSU5fQUdJTElUWTogXCJUcmFpbiBBZ2lsaXR5XCIsXG4gIC8vIFVuYXNzaWduZWQgLyBWaWdpbGFudGVcbiAgVU5BU1NJR05FRDogXCJVbmFzc2lnbmVkXCIsXG4gIFZJR0lMQU5URTogXCJWaWdpbGFudGUgSnVzdGljZVwiLFxuICAvLyBNb25leVxuICBNT05FWV9DT01CQVQ6IFwiU3Ryb25nYXJtIENpdmlsaWFuc1wiLFxuICBNT05FWV9IQUNLOiBcIklkZW50aXR5IFRoZWZ0XCIsXG4gIC8vIFJlc3BlY3RcbiAgUkVTUEVDVF9DT01CQVQ6IFwiTXVnIFBlb3BsZVwiLFxuICBSRVNQRUNUX0hBQ0s6IFwiRXRoaWNhbCBIYWNraW5nXCIsXG4gIC8vIFRlcnJpdG9yeVxuICBURVJSSVRPUlk6IFwiVGVycml0b3J5IFdhcmZhcmVcIixcbn07XG5cbi8vIE1hcDogZ2FuZyBcImlzSGFja2luZ0dhbmdcIiDihpIgcHJlZmVycmVkIHRhc2sgcGVyIHBoYXNlLlxuZnVuY3Rpb24gdGFza0ZvclBoYXNlKGlzSGFja2luZywgcGhhc2UpIHtcbiAgaWYgKHBoYXNlID09PSBcInJlc3BlY3RcIikgcmV0dXJuIGlzSGFja2luZyA/IFRBU0tTLlJFU1BFQ1RfSEFDSyA6IFRBU0tTLlJFU1BFQ1RfQ09NQkFUO1xuICBpZiAocGhhc2UgPT09IFwibW9uZXlcIikgcmV0dXJuIGlzSGFja2luZyA/IFRBU0tTLk1PTkVZX0hBQ0sgOiBUQVNLUy5NT05FWV9DT01CQVQ7XG4gIGlmIChwaGFzZSA9PT0gXCJ0ZXJyaXRvcnlcIikgcmV0dXJuIFRBU0tTLlRFUlJJVE9SWTtcbiAgcmV0dXJuIFRBU0tTLlVOQVNTSUdORUQ7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGlmIChucy5hcmdzLmluY2x1ZGVzKFwiLWhcIikgfHwgbnMuYXJncy5pbmNsdWRlcyhcIi0taGVscFwiKSkge1xuICAgIG5zLnRwcmludChVU0FHRSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR2F0ZTogbXVzdCBiZSBpbiBhIGdhbmcuIGluR2FuZygpIGlzIHRoZSBvbmx5IGdhbmcuKiBtZXRob2RcbiAgLy8gdGhhdCBkb2Vzbid0IHJlcXVpcmUgdGhlIEFQSSBhY2Nlc3MgKHBlciB0aGUgZG9jc3RyaW5nKSwgc29cbiAgLy8gd2UgdXNlIGl0IHRvIGRldGVjdCBcIm5vIGdhbmcgYXQgYWxsXCIgd2l0aG91dCB0aHJvd2luZy5cbiAgaWYgKCFucy5nYW5nLmluR2FuZygpKSB7XG4gICAgbnMudHByaW50KFwiRVJST1I6IG5vdCBpbiBhIGdhbmcuIENyZWF0ZSBvciBqb2luIG9uZSBpbiB0aGUgQ2l0eSBVSSBmaXJzdCAoa2FybWEgPD0gNTRrIHJlcXVpcmVkLCBvciBwbGF5IGluIEJpdE5vZGUgMikuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFBhcnNlIGFyZ3MuXG4gIGNvbnN0IGFyZ3MgPSBucy5hcmdzLnNsaWNlKCk7XG4gIGNvbnN0IG9uY2UgPSBhcmdzLmluY2x1ZGVzKFwiLS1vbmNlXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgY29uc3Qgbm9UZXJyaXRvcnkgPSBhcmdzLmluY2x1ZGVzKFwiLS1uby10ZXJyaXRvcnlcIik7XG4gIGNvbnN0IHBoYXNlSWR4ID0gYXJncy5pbmRleE9mKFwiLS1waGFzZVwiKTtcbiAgY29uc3QgcGhhc2UgPSBwaGFzZUlkeCA+PSAwID8gU3RyaW5nKGFyZ3NbcGhhc2VJZHggKyAxXSkgOiBERUZBVUxUX1BIQVNFO1xuICBpZiAoIVtcInJlc3BlY3RcIiwgXCJtb25leVwiLCBcInRlcnJpdG9yeVwiXS5pbmNsdWRlcyhwaGFzZSkpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3ItZ2FuZzogLS1waGFzZSBtdXN0IGJlIG9uZSBvZiByZXNwZWN0fG1vbmV5fHRlcnJpdG9yeSAoZ290ICR7cGhhc2V9KWApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydWxlSWR4ID0gYXJncy5pbmRleE9mKFwiLS1ydWxlLWZyYWN0aW9uXCIpO1xuICBjb25zdCBydWxlRnJhY3Rpb24gPSBydWxlSWR4ID49IDAgPyBOdW1iZXIoYXJnc1tydWxlSWR4ICsgMV0pIDogREVGQVVMVF9SVUxFO1xuICBpZiAocnVsZUlkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKHJ1bGVGcmFjdGlvbikgfHwgcnVsZUZyYWN0aW9uIDwgTUlOX1JVTEUgfHwgcnVsZUZyYWN0aW9uID4gTUFYX1JVTEUpKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLWdhbmc6IC0tcnVsZS1mcmFjdGlvbiBtdXN0IGJlIGEgbnVtYmVyICR7TUlOX1JVTEV9Li4ke01BWF9SVUxFfSAoZ290ICR7YXJnc1tydWxlSWR4ICsgMV19KWApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBhc2NlbmRJZHggPSBhcmdzLmluZGV4T2YoXCItLWFzY2VuZC10aHJlc2hvbGRcIik7XG4gIGNvbnN0IGFzY2VuZFRocmVzaG9sZCA9IGFzY2VuZElkeCA+PSAwID8gTnVtYmVyKGFyZ3NbYXNjZW5kSWR4ICsgMV0pIDogREVGQVVMVF9BU0NFTkQ7XG4gIGlmIChhc2NlbmRJZHggPj0gMCAmJiAoIU51bWJlci5pc0Zpbml0ZShhc2NlbmRUaHJlc2hvbGQpIHx8IGFzY2VuZFRocmVzaG9sZCA8IDEpKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLWdhbmc6IC0tYXNjZW5kLXRocmVzaG9sZCBtdXN0IGJlIGEgbnVtYmVyID49IDEgKGdvdCAke2FyZ3NbYXNjZW5kSWR4ICsgMV19KWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIG5zLmRpc2FibGVMb2coXCJzbGVlcFwiKTtcbiAgbnMuZGlzYWJsZUxvZyhcImdldFNlcnZlck1vbmV5QXZhaWxhYmxlXCIpO1xuXG4gIC8vIENhY2hlZCBlcXVpcG1lbnQgbGlzdC4gbnMuZ2FuZy5nZXRFcXVpcG1lbnROYW1lcygpIHJldHVybnMgdGhlXG4gIC8vIEZVTEwgbGlzdCBvZiBlcXVpcG1lbnQgKyBhdWdtZW50YXRpb25zIHRoZSBwbGF5ZXIgY2FuIGluc3RhbGxcbiAgLy8gb24gbWVtYmVyczsgdGhpcyBpcyBzdGFibGUgYWNyb3NzIHRpY2tzIChvbmx5IGNoYW5nZXMgd2hlblxuICAvLyB5b3UgaW5zdGFsbCBhbiBhdWcpLCBzbyB3ZSBjYWNoZSBpdCBvbmNlIGF0IHN0YXJ0dXAuXG4gIGNvbnN0IGVxdWlwbWVudExpc3QgPSBucy5nYW5nLmdldEVxdWlwbWVudE5hbWVzKCk7XG5cbiAgLy8gUGVyLW1lbWJlcjogcGljayB0aGUgYmVzdCB0cmFpbmluZyB0YXNrIGJhc2VkIG9uIHRoZSBnYW5nXG4gIC8vIHR5cGUuIEhhY2tpbmcgZ2FuZ3MgcHJpb3JpdGl6ZSBoYWNrIHRyYWluaW5nOyBjb21iYXQgZ2FuZ3NcbiAgLy8gcm90YXRlIHRocm91Z2ggdGhlIGZvdXIgY29tYmF0IHN0YXRzLiBcIkJlc3RcIiBpcyB0aGUgc3RhdFxuICAvLyB3aXRoIHRoZSBsb3dlc3QgY3VycmVudCBhYnNvbHV0ZSB2YWx1ZS5cbiAgZnVuY3Rpb24gYmVzdFRyYWluaW5nVGFzayhpbmZvKSB7XG4gICAgY29uc3QgaXNIYWNraW5nID0gaW5mby5oYWNrID4gaW5mby5zdHIgJiYgaW5mby5oYWNrID4gaW5mby5kZWYgJiYgaW5mby5oYWNrID4gaW5mby5kZXggJiYgaW5mby5oYWNrID4gaW5mby5hZ2k7XG4gICAgaWYgKGlzSGFja2luZykgcmV0dXJuIFRBU0tTLlRSQUlOX1NUUkVOR1RIOyAgLy8gZXZlbiBoYWNraW5nIG1lbWJlcnMgbmVlZCBjb21iYXQgc3RhdHMgZm9yIHRlcnJpdG9yeVxuICAgIC8vIENvbWJhdCBnYW5nOiB0cmFpbiB0aGUgbG93ZXN0IG9mIHN0ciAvIGRlZiAvIGRleCAvIGFnaS5cbiAgICBjb25zdCBzdGF0cyA9IHtcbiAgICAgIFtUQVNLUy5UUkFJTl9TVFJFTkdUSF06IGluZm8uc3RyLFxuICAgICAgW1RBU0tTLlRSQUlOX0RFRkVOU0VdOiBpbmZvLmRlZixcbiAgICAgIFtUQVNLUy5UUkFJTl9ERVhURVJJVFldOiBpbmZvLmRleCxcbiAgICAgIFtUQVNLUy5UUkFJTl9BR0lMSVRZXTogaW5mby5hZ2ksXG4gICAgfTtcbiAgICBsZXQgcGljayA9IFRBU0tTLlRSQUlOX1NUUkVOR1RIO1xuICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHN0YXRzKSkgaWYgKHYgPCBzdGF0c1twaWNrXSkgcGljayA9IGs7XG4gICAgcmV0dXJuIHBpY2s7XG4gIH1cblxuICAvLyBEZWNpZGUgd2hhdCB0YXNrIGEgbWVtYmVyIHNob3VsZCBiZSBvbi4gVGhlIGRlY2lzaW9uIHRyZWU6XG4gIC8vICAgMS4gSWYgYW55IHByaW1hcnkgc3RhdCA8IHRocmVzaG9sZCDihpIgdHJhaW4gKGxvd2VzdCBmaXJzdCkuXG4gIC8vICAgMi4gT3RoZXJ3aXNlIOKGkiB0YXNrIHBlciBwaGFzZS5cbiAgLy8gTm90ZTogYSBtZW1iZXIgdGhhdCdzIGN1cnJlbnRseSB0cmFpbmluZyBkb2Vzbid0IGdldFxuICAvLyByZS1ldmFsdWF0ZWQgdG8gXCJyZXNwZWN0XCIgdW50aWwgc3RhdHMgY3Jvc3MgdGhlIHRocmVzaG9sZDtcbiAgLy8gd2Ugd2FudCBhIG1lbWJlciB0byBhY3R1YWxseSBGSU5JU0ggdHJhaW5pbmcgaW5zdGVhZCBvZlxuICAvLyBmbGFwcGluZy5cbiAgZnVuY3Rpb24gZGVjaWRlVGFzayhpbmZvLCBpc0hhY2tpbmcsIHdhbnRUZXJyaXRvcnkpIHtcbiAgICBpZiAoaW5mby5zdHIgPCBERUZBVUxUX1RSQUlOX1RIUkVTSE9MRFxuICAgICAgICB8fCBpbmZvLmRlZiA8IERFRkFVTFRfVFJBSU5fVEhSRVNIT0xEXG4gICAgICAgIHx8IGluZm8uZGV4IDwgREVGQVVMVF9UUkFJTl9USFJFU0hPTERcbiAgICAgICAgfHwgaW5mby5hZ2kgPCBERUZBVUxUX1RSQUlOX1RIUkVTSE9MRCkge1xuICAgICAgcmV0dXJuIGJlc3RUcmFpbmluZ1Rhc2soaW5mbyk7XG4gICAgfVxuICAgIGlmICh3YW50VGVycml0b3J5KSByZXR1cm4gVEFTS1MuVEVSUklUT1JZO1xuICAgIHJldHVybiB0YXNrRm9yUGhhc2UoaXNIYWNraW5nLCBwaGFzZSk7XG4gIH1cblxuICAvLyBPbmUgZ2FuZyB0aWNrLlxuICAvLyAgIDEuIFJlY3J1aXQgaWYgcG9zc2libGUuXG4gIC8vICAgMi4gQXNjZW5kIGlmIGFueSBtZW1iZXIgcXVhbGlmaWVzLlxuICAvLyAgIDMuIFJlYXNzaWduIHRhc2tzIGZvciBldmVyeSBtZW1iZXIuXG4gIC8vICAgNC4gQnV5IGVxdWlwbWVudCAoc3ViamVjdCB0byBwZXItdGljayBidWRnZXQpLlxuICAvLyAgIDUuIFNldCB0ZXJyaXRvcnkgd2FyZmFyZSBmbGFnLlxuICBmdW5jdGlvbiBwYXNzKCkge1xuICAgIGNvbnN0IGNvdW50ZXJzID0geyByZWNydWl0ZWQ6IDAsIGFzY2VuZGVkOiAwLCB0YXNrQ2hhbmdlZDogMCwgZXF1aXBtZW50Qm91Z2h0OiAwIH07XG4gICAgY29uc3QgaW5mbyA9IG5zLmdhbmcuZ2V0R2FuZ0luZm9ybWF0aW9uKCk7XG4gICAgY29uc3QgaXNIYWNraW5nID0gaW5mby5pc0hhY2tpbmdHYW5nO1xuICAgIGxldCBtZW1iZXJzID0gbnMuZ2FuZy5nZXRNZW1iZXJOYW1lcygpO1xuICAgIC8vIFNvcnRpbmcgYnkgbmFtZSBpcyBmaW5lIOKAlCB0aGUgZ2FuZyBhc3NpZ25zIG5hbWVzIGluIHJlY3J1aXRcbiAgICAvLyBvcmRlciwgc28gaXQncyBlZmZlY3RpdmVseSBvbGRlc3QtZmlyc3QuXG4gICAgY29uc3Qgd2FsbGV0ID0gbnMuZ2V0U2VydmVyTW9uZXlBdmFpbGFibGUoXCJob21lXCIpO1xuICAgIGNvbnN0IGJ1ZGdldCA9IHJ1bGVGcmFjdGlvbiA+IDAgPyB3YWxsZXQgKiBydWxlRnJhY3Rpb24gOiB3YWxsZXQ7XG4gICAgbGV0IHNwZW50ID0gMDtcblxuICAgIC8vIDEuIFJlY3J1aXQuIHJlc3BlY3RGb3JOZXh0UmVjcnVpdCBpcyB0aGUgcmVzcGVjdCBjb3N0OyB3ZVxuICAgIC8vIGFsc28gbmVlZCB0aGUgcGxheWVyIHRvIGhhdmUgdGhlIHJlcXVpcmVkIHJlc3BlY3RcbiAgICAvLyBhY2N1bXVsYXRlZC4gbnMuZ2FuZy5yZWNydWl0TWVtYmVyKCkgaGFuZGxlcyBib3RoIGNoZWNrc1xuICAgIC8vIGludGVybmFsbHkgYW5kIHJldHVybnMgZmFsc2UgaWYgZWl0aGVyIGZhaWxzLlxuICAgIHdoaWxlIChucy5nYW5nLmNhblJlY3J1aXRNZW1iZXIoKSkge1xuICAgICAgLy8gUGljayBhIG5hbWUuIFdlIHVzZSBhIHBlci1yZWNydWl0IGNvdW50ZXIgc28gbmFtZXMgYXJlXG4gICAgICAvLyB1bmlxdWUgZXZlbiBhY3Jvc3MgcmVzdGFydHMuXG4gICAgICByZWNydWl0Q291bnRlcisrO1xuICAgICAgY29uc3QgbmFtZSA9IGBtJHtyZWNydWl0Q291bnRlcn1gO1xuICAgICAgaWYgKG5zLmdhbmcucmVjcnVpdE1lbWJlcihuYW1lKSkge1xuICAgICAgICBtZW1iZXJzLnB1c2gobmFtZSk7XG4gICAgICAgIGNvdW50ZXJzLnJlY3J1aXRlZCsrO1xuICAgICAgICBucy50cHJpbnQoYFJFQ1JVSVRFRCAgICAgICAke25hbWV9ICB0b3RhbD0ke21lbWJlcnMubGVuZ3RofWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJlYWs7ICAvLyByYWNlOiByZXNwZWN0IGRyYWluZWQ7IGJhaWxcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gcmVmcmVzaCBtZW1iZXJzIGluIGNhc2UgdGhlIEFQSSBjYWNoZXMgbGVuZ3RoXG4gICAgbWVtYmVycyA9IG5zLmdhbmcuZ2V0TWVtYmVyTmFtZXMoKTtcblxuICAgIC8vIDIuIEFzY2Vuc2lvbi4gZ2V0QXNjZW5zaW9uUmVzdWx0IHJldHVybnMgdGhlIHByb2plY3RlZCByZXN1bHRcbiAgICAvLyAgICB3aXRob3V0IGFjdHVhbGx5IGFzY2VuZGluZywgc28gd2UgY2FuIGNoZWNrIGVsaWdpYmlsaXR5XG4gICAgLy8gICAgY2hlYXBseS4gV2UgYXNjZW5kIGlmIEFOWSBzdGF0IG11bHRpcGxpZXIgZXhjZWVkcyB0aGVcbiAgICAvLyAgICB0aHJlc2hvbGQuXG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG1lbWJlcnMpIHtcbiAgICAgIGNvbnN0IHIgPSBucy5nYW5nLmdldEFzY2Vuc2lvblJlc3VsdChuYW1lKTtcbiAgICAgIGlmICghcikgY29udGludWU7XG4gICAgICBjb25zdCBtYXhNdWx0ID0gTWF0aC5tYXgoci5oYWNrLCByLnN0ciwgci5kZWYsIHIuZGV4LCByLmFnaSwgci5jaGEpO1xuICAgICAgaWYgKG1heE11bHQgPj0gYXNjZW5kVGhyZXNob2xkKSB7XG4gICAgICAgIGNvbnN0IG9rID0gbnMuZ2FuZy5hc2NlbmRNZW1iZXIobmFtZSk7XG4gICAgICAgIGlmIChvaykge1xuICAgICAgICAgIGNvdW50ZXJzLmFzY2VuZGVkKys7XG4gICAgICAgICAgbnMudHByaW50KGBBU0NFTkRFRCAgICAgICAke25hbWV9ICBtYXgtYm9udXM9JHttYXhNdWx0LnRvRml4ZWQoMil9eCAgcmVzcGVjdC1sb3N0PSR7ci5yZXNwZWN0LnRvRml4ZWQoMCl9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAzLiBUZXJyaXRvcnkgd2FyZmFyZSBkZWNpc2lvbi4gV2UgYXV0by1lbmdhZ2UgaWY6XG4gICAgLy8gICBhKSBwaGFzZSA9PSBcInRlcnJpdG9yeVwiLCBPUlxuICAgIC8vICAgYikgd2UgaGF2ZSA+NTAlIGNoYW5jZSB0byB3aW4gY2xhc2hlcyB3aXRoIHRoZSBzdHJvbmdlc3RcbiAgICAvLyAgICAgIHJpdmFsIGdhbmcgKGEgc3RhYmxlIHdheSB0byBnYWluIHRlcnJpdG9yeSkuXG4gICAgLy8gLS1uby10ZXJyaXRvcnkgZGlzYWJsZXMgdGhpcyBlbnRpcmVseSAoYW5kIGZvcmNlcyBhXG4gICAgLy8gbm9uLXRlcnJpdG9yeSB0YXNrIG9uIGV2ZXJ5IG1lbWJlcikuXG4gICAgbGV0IHdhbnRUZXJyaXRvcnkgPSBmYWxzZTtcbiAgICBpZiAoIW5vVGVycml0b3J5KSB7XG4gICAgICBpZiAocGhhc2UgPT09IFwidGVycml0b3J5XCIpIHtcbiAgICAgICAgd2FudFRlcnJpdG9yeSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBDaGVjayB0aGUgc3Ryb25nZXN0IHJpdmFsJ3MgY2xhc2ggcHJvYmFiaWxpdHkuXG4gICAgICAgIGNvbnN0IGFsbCA9IG5zLmdhbmcuZ2V0QWxsR2FuZ0luZm9ybWF0aW9uKCk7XG4gICAgICAgIGNvbnN0IG15TmFtZSA9IGluZm8uZmFjdGlvbjsgIC8vIEdhbmdHZW5JbmZvLmZhY3Rpb24gaXMgdGhlIGdhbmcgbmFtZVxuICAgICAgICBsZXQgbWF4V2luQ2hhbmNlID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBbZ05hbWUsIGddIG9mIE9iamVjdC5lbnRyaWVzKGFsbCkpIHtcbiAgICAgICAgICBpZiAoZ05hbWUgPT09IG15TmFtZSkgY29udGludWU7XG4gICAgICAgICAgY29uc3QgYyA9IG5zLmdhbmcuZ2V0Q2hhbmNlVG9XaW5DbGFzaChnTmFtZSk7XG4gICAgICAgICAgaWYgKGMgPiBtYXhXaW5DaGFuY2UpIG1heFdpbkNoYW5jZSA9IGM7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1heFdpbkNoYW5jZSA+PSBERUZBVUxUX1RFUlJJVE9SWV9XSU5fQ0hBTkNFKSB3YW50VGVycml0b3J5ID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgbnMuZ2FuZy5zZXRUZXJyaXRvcnlXYXJmYXJlKHdhbnRUZXJyaXRvcnkpO1xuXG4gICAgLy8gNC4gVGFzayBhc3NpZ25tZW50LlxuICAgIGZvciAoY29uc3QgbmFtZSBvZiBtZW1iZXJzKSB7XG4gICAgICBjb25zdCBtID0gbnMuZ2FuZy5nZXRNZW1iZXJJbmZvcm1hdGlvbihuYW1lKTtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGRlY2lkZVRhc2sobSwgaXNIYWNraW5nLCB3YW50VGVycml0b3J5KTtcbiAgICAgIGlmIChtLnRhc2sgIT09IHRhcmdldCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG5zLmdhbmcuc2V0TWVtYmVyVGFzayhuYW1lLCB0YXJnZXQpO1xuICAgICAgICAgIGNvdW50ZXJzLnRhc2tDaGFuZ2VkKys7XG4gICAgICAgICAgaWYgKHZlcmJvc2UpIG5zLnRwcmludChgVEFTSyAgICAgICAgICAgJHtuYW1lfSAgJHttLnRhc2t9IOKGkiAke3RhcmdldH1gKTtcbiAgICAgICAgfSBjYXRjaCAoZSkgeyAvKiB0YXNrIG5hbWUgdHlwbydkIOKAlCBmYWxsIHRocm91Z2ggKi8gfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDUuIEVxdWlwbWVudCBidXlzLiBXYWxrIHRoZSBsaXN0OyBmb3IgZWFjaCBtZW1iZXIgYW5kIGVhY2hcbiAgICAvLyAgICBlcXVpcG1lbnQgbmFtZSwgdHJ5IHRvIGJ1eSBpdCBpZiB0aGUgbWVtYmVyIGRvZXNuJ3RcbiAgICAvLyAgICBhbHJlYWR5IG93biBpdCBhbmQgd2UgaGF2ZSBidWRnZXQuIE9yZGVyIGlzIGRldGVybWluZWRcbiAgICAvLyAgICBieSBnZXRFcXVpcG1lbnRDb3N0IChjaGVhcGVzdCBmaXJzdCksIHNvIHdlIHNvcnQgdGhlXG4gICAgLy8gICAgZXF1aXBtZW50IGxpc3QgYnkgY29zdCBhdCBzdGFydHVwLlxuICAgIGNvbnN0IGVxdWlwbWVudEJ5Q29zdCA9IFsuLi5lcXVpcG1lbnRMaXN0XS5zb3J0KChhLCBiKSA9PiB7XG4gICAgICBjb25zdCBjYSA9IG5zLmdhbmcuZ2V0RXF1aXBtZW50Q29zdChhKTtcbiAgICAgIGNvbnN0IGNiID0gbnMuZ2FuZy5nZXRFcXVpcG1lbnRDb3N0KGIpO1xuICAgICAgcmV0dXJuIChjYSB8fCBJbmZpbml0eSkgLSAoY2IgfHwgSW5maW5pdHkpO1xuICAgIH0pO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBtZW1iZXJzKSB7XG4gICAgICBjb25zdCBtID0gbnMuZ2FuZy5nZXRNZW1iZXJJbmZvcm1hdGlvbihuYW1lKTtcbiAgICAgIGNvbnN0IG93bmVkID0gbmV3IFNldChbLi4ubS51cGdyYWRlcywgLi4ubS5hdWdtZW50YXRpb25zXSk7XG4gICAgICBmb3IgKGNvbnN0IGVxIG9mIGVxdWlwbWVudEJ5Q29zdCkge1xuICAgICAgICBpZiAob3duZWQuaGFzKGVxKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGNvc3QgPSBucy5nYW5nLmdldEVxdWlwbWVudENvc3QoZXEpO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjb3N0KSB8fCBjb3N0IDw9IDApIGNvbnRpbnVlO1xuICAgICAgICBpZiAoc3BlbnQgKyBjb3N0ID4gYnVkZ2V0KSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qgb2sgPSBucy5nYW5nLnB1cmNoYXNlRXF1aXBtZW50KG5hbWUsIGVxKTtcbiAgICAgICAgaWYgKG9rKSB7XG4gICAgICAgICAgc3BlbnQgKz0gY29zdDtcbiAgICAgICAgICBjb3VudGVycy5lcXVpcG1lbnRCb3VnaHQrKztcbiAgICAgICAgICBpZiAodmVyYm9zZSkgbnMudHByaW50KGBFUVVJUE1FTlQgICAgICAke25hbWV9ICAke2VxfSAgJCR7Y29zdC50b0ZpeGVkKDApfWApO1xuICAgICAgICAgIGJyZWFrOyAgLy8gb25lIGVxdWlwbWVudCBwZXIgbWVtYmVyIHBlciB0aWNrIChlbHNlIHdlIG92ZXItc3BlbmQgdGhlIGJ1ZGdldClcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICBjb25zdCB0b3RhbE1vbmV5ID0gbWVtYmVycy5yZWR1Y2UoKHMsIG4pID0+IHMgKyBucy5nYW5nLmdldE1lbWJlckluZm9ybWF0aW9uKG4pLm1vbmV5R2FpbiwgMCk7XG4gICAgICBjb25zdCB0b3RhbFJlc3BlY3QgPSBtZW1iZXJzLnJlZHVjZSgocywgbikgPT4gcyArIG5zLmdhbmcuZ2V0TWVtYmVySW5mb3JtYXRpb24obikucmVzcGVjdEdhaW4sIDApO1xuICAgICAgbnMudHByaW50KGBnYW5nOiBtZW1iZXJzPSR7bWVtYmVycy5sZW5ndGh9IG1vbmV5R2Fpbj0ke3RvdGFsTW9uZXkudG9GaXhlZCgwKX0vdGljayByZXNwZWN0R2Fpbj0ke3RvdGFsUmVzcGVjdC50b0ZpeGVkKDIpfS90aWNrIHRlcnJpdG9yeT0ke2luZm8udGVycml0b3J5LnRvRml4ZWQoNCl9IHdhbnRlZD0ke2luZm8ud2FudGVkTGV2ZWwudG9GaXhlZCgyKX1gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gY291bnRlcnM7XG4gIH1cblxuICAvLyBTdGFibGUsIHJlc3RhcnQtc2FmZSByZWNydWl0IGNvdW50ZXIuIE1lbWJlcnMgYXJlIG5hbWVkXG4gIC8vIFwibTFcIiwgXCJtMlwiLCAuLi4gaW4gcmVjcnVpdCBvcmRlcjsgdGhlIG5leHQgcmVjcnVpdCBnZXRzIHRoZVxuICAvLyBuZXh0IG51bWJlci4gV2Ugc2NhbiB0aGUgY3VycmVudCByb3N0ZXIgc28gdGhlIHNjcmlwdCBpc1xuICAvLyByZXN0YXJ0LXNhZmUgKHJlc3VtZSBudW1iZXJpbmcgZnJvbSB0aGUgaGlnaGVzdCBleGlzdGluZ1xuICAvLyBtTiByYXRoZXIgdGhhbiByZXN0YXJ0aW5nIGF0IG0xLCB3aGljaCB3b3VsZCBjb2xsaWRlKS5cbiAgbGV0IHJlY3J1aXRDb3VudGVyID0gMDtcbiAgZm9yIChjb25zdCBuIG9mIG5zLmdhbmcuZ2V0TWVtYmVyTmFtZXMoKSkge1xuICAgIGNvbnN0IG0gPSBuLm1hdGNoKC9ebShcXGQrKSQvKTtcbiAgICBpZiAobSkge1xuICAgICAgY29uc3QgbnVtID0gTnVtYmVyKG1bMV0pO1xuICAgICAgaWYgKG51bSA+IHJlY3J1aXRDb3VudGVyKSByZWNydWl0Q291bnRlciA9IG51bTtcbiAgICB9XG4gIH1cblxuICBpZiAob25jZSkge1xuICAgIHBhc3MoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBucy50cHJpbnQoYG1vbml0b3ItZ2FuZzogc3RhcnRlZCwgcGhhc2U9JHtwaGFzZX0sIHJ1bGU9JHsocnVsZUZyYWN0aW9uICogMTAwKS50b0ZpeGVkKDApfSUsIGFzY2VuZD49JHthc2NlbmRUaHJlc2hvbGR9LCBvdXRwdXQ9JHt2ZXJib3NlID8gXCJ2ZXJib3NlXCIgOiBcInF1aWV0XCJ9YCk7XG4gIC8vIE1haW4gbG9vcC4gbnMuZ2FuZy5uZXh0VXBkYXRlKCkgcmVzb2x2ZXMgb25jZSBwZXIgZ2FuZyB0aWNrXG4gIC8vICgyLTVzIHdpdGggbm8gYm9udXMgdGltZSkuIFNhbWUgcmF0aW9uYWxlIGFzIG1vbml0b3Itc3RvY2suanM6XG4gIC8vIHVzZSB0aGUgZ2FtZSdzIG93biBjYWRlbmNlIHNpZ25hbCBpbnN0ZWFkIG9mIGEgZml4ZWQgc2xlZXAuXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgYXdhaXQgbnMuZ2FuZy5uZXh0VXBkYXRlKCk7XG4gICAgcGFzcygpO1xuICB9XG59XG4iXX0=