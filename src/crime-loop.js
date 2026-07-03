/** @param {NS} ns */
//
// Long-lived daemon that picks the best crime for karma grinding and
// loops it forever. Uses ns.singularity.commitCrime, which requires
// the Singularity Functions aug (SF-4 in BitNode 4) — without it
// the script errors and exits with a clear message.
//
// Crime ranking: by KARMA PER SECOND (karma / timeMs * 1000). This
// is the dominant goal for a karma farm — the user explicitly asked
// about Homicide for karma, and a karma-per-second ranking picks
// Homicide (1.0 karma/sec) over Heist (0.025) by ~40×. The wiki
// table is the source of truth; we re-derive the ranking each tick
// via ns.singularity.getCrimeStats(), so buff state, mults, and
// BitNode multipliers are all respected automatically.
//
// Filters: only considers crimes whose current success rate
// (ns.singularity.getCrimeChance) is at or above --min-chance
// (default 0.5 = 50%). Below that, the expected karma gain is
// worse than a higher-tier crime with high success — so we skip
// them. Set --min-chance 0 to disable the filter (always pick
// the highest karma/sec crime, even if your success rate is bad).
//
// Stat requirement check: there isn't one in the API. The
// "X stat required" tooltip in the Crime UI is just the success-
// rate floor in disguise. ns.singularity.getCrimeChance() returns
// the actual computed success rate for the current player, which
// subsumes any stat floor. The "tier" of a crime is its karma/sec
// ranking, not a stat gate.
//
// HP guard: by default we require at least 50% HP before
// starting a crime. Failure scales HP loss with crime tier, and
// HP death = prison = real time locked out of all scripts.
// Game auto-saves, so a jail trip doesn't roll back, but it
// costs productive time. Adjust with --min-hp 0.25 (loose) or
// --min-hp 0.75 (paranoid). 0 disables the guard entirely —
// useful when chaining low-tier crimes (Shoplift/Mug) where
// HP loss is trivial and you don't want the script to ever
// stall.
//
// Singularity check is at the top so you get a clear error if
// the aug isn't installed — without it, every ns.singularity.*
// call would throw and the script would die mid-loop with no
// explanation.
//
// Output is QUIET by default — only tier-promotion lines and
// errors print. Per-crime lines are silent. --verbose opts in
// to a one-line-per-crime summary (crime name, time, gains).
//
// commitCrime semantics: per the official API docs, it
// "returns the number of milliseconds it takes to attempt the
// specified crime" but does NOT block the script. The crime
// runs in the background. Calling commitCrime again cancels
// any in-progress working action (including a still-running
// crime). The script sleeps the returned duration between
// calls so we never cancel a crime that's still running.
//
// Usage:
//   run crime-loop.js                  # loop, auto-pick best karma crime, QUIET
//   run crime-loop.js --min-hp 0.75    # stricter HP guard (default 0.5)
//   run crime-loop.js --min-hp 0       # disable HP guard
//   run crime-loop.js --min-chance 0.7 # require 70%+ success rate to consider
//   run crime-loop.js --min-chance 0   # no success-rate filter
//   run crime-loop.js --verbose        # one line per crime completion
//   run crime-loop.js --once           # one crime, full output, then exit
//
const USAGE = `Usage:
  run crime-loop.js                  # loop, auto-pick best karma crime, QUIET
  run crime-loop.js --min-hp 0.75    # stricter HP guard (default 0.5)
  run crime-loop.js --min-hp 0       # disable HP guard
  run crime-loop.js --min-chance 0.7 # require 70%+ success rate to consider
  run crime-loop.js --min-chance 0   # no success-rate filter
  run crime-loop.js --verbose        # one line per crime completion
  run crime-loop.js --once           # one crime, full output, then exit
`;

// All 12 crimes in the canonical Title-Case spelling that
// ns.singularity.commitCrime / getCrimeStats accept. Sourced
// from src/Crime/Enums.ts in the Bitburner source. Order here
// doesn't matter — the script re-ranks by karma/sec on every
// pass. Listed in the same order as the in-game Crime UI
// (weakest → strongest) for readability.
const CRIMES = [
  "Shoplift",
  "Rob Store",
  "Mug",
  "Larceny",
  "Deal Drugs",
  "Bond Forgery",
  "Traffick Arms",
  "Homicide",
  "Grand Theft Auto",
  "Kidnap",
  "Assassination",
  "Heist",
];

const DEFAULT_MIN_HP = 0.5;
const DEFAULT_MIN_CHANCE = 0.5;  // 50% success rate floor
const HP_RECHECK_MS = 60_000;    // how long to sleep when HP is below the floor

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }

  // Singularity is mandatory — the rest of the script calls
  // ns.singularity.* directly. Without it, the first commitCrime
  // would throw and the user would get a useless stack trace.
  if (!ns.singularity) {
    ns.tprint("ERROR: ns.singularity is not available. Install the Singularity Functions aug (SF-4 in BitNode 4) first.");
    return;
  }

  // Parse args. Same quiet-by-default pattern as monitor-hacknet.js
  // and monitor-nuke.js: --verbose re-enables per-tick output,
  // --once does a single crime then exits (full output).
  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const hpIdx = args.indexOf("--min-hp");
  const minHpFraction = hpIdx >= 0
    ? Number(args[hpIdx + 1])
    : DEFAULT_MIN_HP;
  if (hpIdx >= 0 && (!Number.isFinite(minHpFraction) || minHpFraction < 0 || minHpFraction > 1)) {
    ns.tprint(`crime-loop: --min-hp must be a number 0..1 (got ${args[hpIdx + 1]})`);
    return;
  }
  const chanceIdx = args.indexOf("--min-chance");
  const minChance = chanceIdx >= 0
    ? Number(args[chanceIdx + 1])
    : DEFAULT_MIN_CHANCE;
  if (chanceIdx >= 0 && (!Number.isFinite(minChance) || minChance < 0 || minChance > 1)) {
    ns.tprint(`crime-loop: --min-chance must be a number 0..1 (got ${args[chanceIdx + 1]})`);
    return;
  }

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");

  // HP guard. If the player's HP ratio is below the floor, we
  // refuse to start a crime and sleep until it's safe to
  // re-check. Note: ns.getPlayer().hp is an object { current,
  // max } — NOT a scalar. (Caught a real bug here: the first
  // draft of this script did p.hp / p.max_hp, which is object
  // division = NaN, and the guard silently never fired.)
  function hpOk() {
    if (minHpFraction <= 0) return true;  // guard disabled
    const p = ns.getPlayer();
    return p.hp.current / p.hp.max >= minHpFraction;
  }

  // Pick the best crime by karma-per-second, filtered by the
  // success-rate floor. Returns { name, ms, karma, chance, kps }
  // or null if no crime qualifies (every crime is below
  // --min-chance, OR getCrimeStats threw — should never happen
  // for a real player).
  function pickBestCrime() {
    let best = null;
    for (const name of CRIMES) {
      const stats = ns.singularity.getCrimeStats(name);
      const chance = ns.singularity.getCrimeChance(name);
      if (chance < minChance) continue;  // success rate too low — skip
      const kps = (stats.karma / stats.time) * 1000;  // karma per second
      if (best === null || kps > best.kps) {
        best = { name, ms: stats.time, karma: stats.karma, chance, kps };
      }
    }
    return best;
  }

  // One crime pass. Returns the time the crime took in ms (or 0
  // if we bailed for HP / no qualifying tier / commitCrime
  // returned 0). Prints the tier-promotion line if the picked
  // crime changed from the last call — that's the only
  // "interesting" event in quiet mode.
  let lastTier = null;
  function pass() {
    if (!hpOk()) return 0;

    const crime = pickBestCrime();
    if (!crime) {
      ns.tprint(`crime-loop: no crime meets --min-chance ${(minChance * 100).toFixed(0)}% (try --min-chance 0 if you want to grind anyway)`);
      return 0;
    }

    if (lastTier !== crime.name) {
      // Tier change is the interesting event. Always print,
      // even in quiet mode — the whole point of the script is
      // to silently pick the best karma/sec crime, and the
      // user wants to know when that changes.
      ns.tprint(`tier: ${lastTier ?? "(start)"} → ${crime.name} (${(crime.chance * 100).toFixed(0)}% chance, ${crime.kps.toFixed(3)} karma/s)`);
      lastTier = crime.name;
    }

    const ms = ns.singularity.commitCrime(crime.name);
    if (ms <= 0) {
      // commitCrime returns 0 when the player is in a state
      // that can't commit crimes (e.g. hospitalized post-
      // prison, currently working out a sentence). Demote one
      // tier on the cache so the next pass can re-evaluate.
      ns.tprint(`FAIL-commit     ${crime.name} returned ${ms}ms — retrying in ${HP_RECHECK_MS / 1000}s`);
      return 0;
    }

    if (verbose) {
      const p = ns.getPlayer();
      ns.tprint(`COMMITTED       ${crime.name.padEnd(16)} ${(ms / 1000).toFixed(1)}s  HP ${p.hp.current.toFixed(0)}/${p.hp.max.toFixed(0)}  karma ${p.karma.toFixed(1)}  chance ${(crime.chance * 100).toFixed(0)}%`);
    }
    return ms;
  }

  if (once) {
    pass();
    return;
  }

  ns.tprint(`crime-loop: started, min-hp=${(minHpFraction * 100).toFixed(0)}%, min-chance=${(minChance * 100).toFixed(0)}%, output=${verbose ? "verbose" : "quiet"}`);
  while (true) {
    const ms = pass();
    // commitCrime starts the crime and returns immediately
    // with the time it WILL take. We sleep the returned ms so
    // the next pass doesn't cancel the in-progress crime
    // (commitCrime cancels any current 'working' action,
    // including a crime that's still running). The math is
    // just: sleep for the crime's duration, then start the
    // next one.
    //
    // If ms is 0 we bailed (HP guard, no crime met the
    // chance floor, commitCrime returned 0) and sleep the HP
    // recheck interval instead.
    await ns.sleep(ms > 0 ? ms : HP_RECHECK_MS);
  }
}
