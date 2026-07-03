/** @param {NS} ns */
export async function main(ns) {
  // Stat training via the Singularity API. Requires the Singularity
  // augmentation (SF-4 in BitNode 4) — if you don't have it, this will
  // throw on first use. Without Singularity, you can still train stats
  // manually from the city UI.
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  if (!ns.singularity) {
    ns.tprint("ERROR: ns.singularity is not available. Install the Singularity augmentation first.");
    return;
  }

  // Each stat maps to a gym (str/def/dex/agi) or a university course
  // (hacking/charisma/intelligence). You must be in the correct city for
  // the chosen location. Defaults below keep you in Sector-12 to avoid
  // travel costs.
  //
  // Pass stat names as args to train one or more. Examples:
  //   run stat-train.js str def dex agi     # gym stats
  //   run stat-train.js hack cha int        # university stats
  //   run stat-train.js str def hack        # mix
  //
  // Default (no args): cycle str, def, dex, agi, switching every
  // 60 minutes of in-game time.
//
const USAGE = `Usage:
  run stat-train.js                  # cycle str/def/dex/agi, rotating every 60 in-game min
  run stat-train.js str def dex agi  # explicit gym stats
  run stat-train.js hack cha int     # university stats
  run stat-train.js str def hack     # mix
`;

const GYM = {
    str: { gym: "Sector12PowerhouseGym", stat: "str" },
    def: { gym: "Sector12PowerhouseGym", stat: "def" },
    dex: { gym: "Sector12IronGym",       stat: "dex" },
    agi: { gym: "Sector12IronGym",       stat: "agi" },
  };
  const UNI = {
    hack: { uni: "Sector12RothmanUniversity", course: "Algorithms" },
    int:  { uni: "Sector12RothmanUniversity", course: "Leadership" },
    cha:  { uni: "Sector12RothmanUniversity", course: "Communication" },
  };
  const ROTATE_MS = 60 * 60 * 1000; // 60 in-game minutes

  const args = (ns.args || []).map(String);
  const wanted = args.length > 0 ? args : ["str", "def", "dex", "agi"];

  // Validate that the player is in the right city for the chosen location.
  // If not, travel there (only if we have the money — travel costs $).
  const cityOf = {
    Sector12PowerhouseGym:   "Sector-12",
    Sector12IronGym:         "Sector-12",
    Sector12RothmanUniversity: "Sector-12",
  };
  for (const key of wanted) {
    const loc = (GYM[key] && GYM[key].gym) || (UNI[key] && UNI[key].uni);
    if (!loc) {
      ns.tprint(`ERROR: unknown stat "${key}". Valid: str, def, dex, agi, hack, int, cha`);
      return;
    }
    const targetCity = cityOf[loc];
    if (ns.getPlayer().city !== targetCity) {
      ns.singularity.travelToCity(targetCity);
    }
  }

  let i = 0;
  ns.disableLog("sleep");
  while (true) {
    const key = wanted[i % wanted.length];
    if (GYM[key]) {
      const { gym, stat } = GYM[key];
      const ok = ns.singularity.gymWorkout(gym, stat, true);
      ns.print(`training ${key} @ ${gym}: ${ok ? "started" : "FAILED"}`);
    } else if (UNI[key]) {
      const { uni, course } = UNI[key];
      const ok = ns.singularity.universityCourse(uni, course, true);
      ns.print(`training ${key} @ ${uni}: ${ok ? "started" : "FAILED"}`);
    }
    await ns.sleep(ROTATE_MS);
    i++;
  }
}
