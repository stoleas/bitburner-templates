/** @param {NS} ns */
export async function main(ns) {
  // Train the four combat stats (str, def, dex, agi) at the gym up to a
  // target level. Stops once all four have reached the target.
  //
  // Usage:
  //   run train-attack.js 100          # train str/def/dex/agi to 100
  //   run train-attack.js 50 str def   # only str + def to 50
  //
  // Requires the Singularity API (SF-4). Travel to Sector-12 is automatic.

  const USAGE = `Usage:
  run train-attack.js <target> [stat ...]

Examples:
  run train-attack.js 100              # str, def, dex, agi all to 100
  run train-attack.js 50 str def       # str and def to 50 only
  run train-attack.js 200              # all four combat stats to 200

Valid stats: str, def, dex, agi
`;

  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  if (!ns.singularity) {
    ns.tprint("ERROR: ns.singularity is not available. Install the Singularity augmentation first.");
    ns.tprint("       Without SF-4, gym training must be done manually from the city UI.");
    return;
  }
  // ns.singularity is present but SF-4 may not be installed yet. The
  // individual API calls will throw — wrap them and report the blocker
  // once instead of spamming every iteration.
  let singularityReady = true;
  try {
    ns.singularity.getCurrentWork();
  } catch (e) {
    singularityReady = false;
  }

  const args = (ns.args || []).map((a) => (typeof a === "number" ? a : String(a)));
  if (args.length === 0) {
    ns.tprint(USAGE);
    return;
  }

  const target = Number(args[0]);
  if (!Number.isFinite(target) || target <= 0) {
    ns.tprint(`ERROR: target must be a positive number, got "${args[0]}"`);
    return;
  }

  const VALID = ["str", "def", "dex", "agi"];
  const requested = args.slice(1).map(String);
  const stats = requested.length > 0 ? requested : ["str", "def", "dex", "agi"];

  for (const s of stats) {
    if (!VALID.includes(s)) {
      ns.tprint(`ERROR: unknown stat "${s}". Valid: ${VALID.join(", ")}`);
      return;
    }
  }

  const GYM = {
    str: { gym: "Sector12PowerhouseGym", stat: "str" },
    def: { gym: "Sector12PowerhouseGym", stat: "def" },
    dex: { gym: "Sector12IronGym",       stat: "dex" },
    agi: { gym: "Sector12IronGym",       stat: "agi" },
  };

  // ns.getPlayer() keys are the long names; map our short codes to them.
  const PLAYER_STAT = { str: "strength", def: "defense", dex: "dexterity", agi: "agility" };

  // Travel to Sector-12 if needed (skipped when SF-4 is missing).
  if (singularityReady && ns.getPlayer().city !== "Sector-12") {
    ns.singularity.travelToCity("Sector-12");
  }

  const readStat = (s) => {
    const key = PLAYER_STAT[s] || s;
    const v = ns.getPlayer()[key];
    return typeof v === "number" ? v : 0;
  };
  const allAtTarget = () => stats.every((s) => readStat(s) >= target);

  if (allAtTarget()) {
    ns.tprint(`train-attack.js: all stats already at target ${target}. nothing to do.`);
    return;
  }

  ns.disableLog("sleep");
  ns.tprint(`train-attack.js: training ${stats.join(", ")} to ${target} (current: ${
    stats.map((s) => `${s}=${readStat(s).toFixed(2)}`).join(", ")
  })`);

  if (!singularityReady) {
    // No SF-4: can't script the gym. Print manual instructions and exit
    // cleanly. The user can re-run this script later once SF-4 is
    // installed.
    ns.tprint("train-attack.js: Singularity (SF-4) not installed — cannot automate.");
    ns.tprint("  Manual training (one stat at a time, ~$300/h, +0.1 to +0.4 per minute):");
    ns.tprint("    1. Travel to Sector-12");
    ns.tprint("    2. City ▸ Powerhouse Gym (str/def) or Iron Gym (dex/agi)");
    ns.tprint("    3. Pick a stat, start training, switch every 20 in-game minutes");
    ns.tprint("  Re-run this script after installing SF-4 to automate it.");
    return;
  }

  // Cycle through the requested stats, training each for one in-game
  // minute before rotating. Stops the moment all targets are met.
  const ROTATE_MS = 60 * 1000;
  let i = 0;
  while (!allAtTarget()) {
    const key = stats[i % stats.length];
    const { gym, stat } = GYM[key];
    const ok = ns.singularity.gymWorkout(gym, stat, true);
    ns.print(`training ${key} @ ${gym} → ${readStat(stat).toFixed(2)}/${target} (${ok ? "started" : "FAILED"})`);
    await ns.sleep(ROTATE_MS);
    i++;
  }

  const final = stats.map((s) => `${s}=${readStat(s).toFixed(2)}`).join(", ");
  ns.tprint(`train-attack.js: target ${target} reached. final: ${final}`);
}
