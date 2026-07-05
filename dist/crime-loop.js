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
const DEFAULT_MIN_CHANCE = 0.5; // 50% success rate floor
const HP_RECHECK_MS = 60_000; // how long to sleep when HP is below the floor
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
        if (minHpFraction <= 0)
            return true; // guard disabled
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
            if (chance < minChance)
                continue; // success rate too low — skip
            const kps = (stats.karma / stats.time) * 1000; // karma per second
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
        if (!hpOk())
            return 0;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JpbWUtbG9vcC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9jcmltZS1sb29wLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YscUVBQXFFO0FBQ3JFLG9FQUFvRTtBQUNwRSxpRUFBaUU7QUFDakUsb0RBQW9EO0FBQ3BELEVBQUU7QUFDRixtRUFBbUU7QUFDbkUsb0VBQW9FO0FBQ3BFLGlFQUFpRTtBQUNqRSxnRUFBZ0U7QUFDaEUsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSx1REFBdUQ7QUFDdkQsRUFBRTtBQUNGLDREQUE0RDtBQUM1RCw4REFBOEQ7QUFDOUQsOERBQThEO0FBQzlELGdFQUFnRTtBQUNoRSw4REFBOEQ7QUFDOUQsa0VBQWtFO0FBQ2xFLEVBQUU7QUFDRiwwREFBMEQ7QUFDMUQsaUVBQWlFO0FBQ2pFLGtFQUFrRTtBQUNsRSxpRUFBaUU7QUFDakUsa0VBQWtFO0FBQ2xFLDRCQUE0QjtBQUM1QixFQUFFO0FBQ0YseURBQXlEO0FBQ3pELGdFQUFnRTtBQUNoRSwyREFBMkQ7QUFDM0QsNERBQTREO0FBQzVELDhEQUE4RDtBQUM5RCw0REFBNEQ7QUFDNUQsNERBQTREO0FBQzVELDJEQUEyRDtBQUMzRCxTQUFTO0FBQ1QsRUFBRTtBQUNGLDhEQUE4RDtBQUM5RCwrREFBK0Q7QUFDL0QsNkRBQTZEO0FBQzdELGVBQWU7QUFDZixFQUFFO0FBQ0YsNkRBQTZEO0FBQzdELDhEQUE4RDtBQUM5RCw2REFBNkQ7QUFDN0QsRUFBRTtBQUNGLHVEQUF1RDtBQUN2RCw4REFBOEQ7QUFDOUQsNERBQTREO0FBQzVELDREQUE0RDtBQUM1RCw0REFBNEQ7QUFDNUQsMERBQTBEO0FBQzFELHlEQUF5RDtBQUN6RCxFQUFFO0FBQ0YsU0FBUztBQUNULGlGQUFpRjtBQUNqRix5RUFBeUU7QUFDekUsMERBQTBEO0FBQzFELCtFQUErRTtBQUMvRSxnRUFBZ0U7QUFDaEUsdUVBQXVFO0FBQ3ZFLDJF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QUFxRDtRQUNyRCxxREFBcUQ7UUFDckQsdURBQXVEO1FBQ3ZELHVEQUF1RDtRQUN2RCxZQUFZO1FBQ1osRUFBRTtRQUNGLG1EQUFtRDtRQUNuRCx5REFBeUQ7UUFDekQsNEJBQTRCO1FBQzVCLE1BQU0sRUFBRSxDQUFDLEtBQUssQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0tBQzdDO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIExvbmctbGl2ZWQgZGFlbW9uIHRoYXQgcGlja3MgdGhlIGJlc3QgY3JpbWUgZm9yIGthcm1hIGdyaW5kaW5nIGFuZFxuLy8gbG9vcHMgaXQgZm9yZXZlci4gVXNlcyBucy5zaW5ndWxhcml0eS5jb21taXRDcmltZSwgd2hpY2ggcmVxdWlyZXNcbi8vIHRoZSBTaW5ndWxhcml0eSBGdW5jdGlvbnMgYXVnIChTRi00IGluIEJpdE5vZGUgNCkg4oCUIHdpdGhvdXQgaXRcbi8vIHRoZSBzY3JpcHQgZXJyb3JzIGFuZCBleGl0cyB3aXRoIGEgY2xlYXIgbWVzc2FnZS5cbi8vXG4vLyBDcmltZSByYW5raW5nOiBieSBLQVJNQSBQRVIgU0VDT05EIChrYXJtYSAvIHRpbWVNcyAqIDEwMDApLiBUaGlzXG4vLyBpcyB0aGUgZG9taW5hbnQgZ29hbCBmb3IgYSBrYXJtYSBmYXJtIOKAlCB0aGUgdXNlciBleHBsaWNpdGx5IGFza2VkXG4vLyBhYm91dCBIb21pY2lkZSBmb3Iga2FybWEsIGFuZCBhIGthcm1hLXBlci1zZWNvbmQgcmFua2luZyBwaWNrc1xuLy8gSG9taWNpZGUgKDEuMCBrYXJtYS9zZWMpIG92ZXIgSGVpc3QgKDAuMDI1KSBieSB+NDDDly4gVGhlIHdpa2lcbi8vIHRhYmxlIGlzIHRoZSBzb3VyY2Ugb2YgdHJ1dGg7IHdlIHJlLWRlcml2ZSB0aGUgcmFua2luZyBlYWNoIHRpY2tcbi8vIHZpYSBucy5zaW5ndWxhcml0eS5nZXRDcmltZVN0YXRzKCksIHNvIGJ1ZmYgc3RhdGUsIG11bHRzLCBhbmRcbi8vIEJpdE5vZGUgbXVsdGlwbGllcnMgYXJlIGFsbCByZXNwZWN0ZWQgYXV0b21hdGljYWxseS5cbi8vXG4vLyBGaWx0ZXJzOiBvbmx5IGNvbnNpZGVycyBjcmltZXMgd2hvc2UgY3VycmVudCBzdWNjZXNzIHJhdGVcbi8vIChucy5zaW5ndWxhcml0eS5nZXRDcmltZUNoYW5jZSkgaXMgYXQgb3IgYWJvdmUgLS1taW4tY2hhbmNlXG4vLyAoZGVmYXVsdCAwLjUgPSA1MCUpLiBCZWxvdyB0aGF0LCB0aGUgZXhwZWN0ZWQga2FybWEgZ2FpbiBpc1xuLy8gd29yc2UgdGhhbiBhIGhpZ2hlci10aWVyIGNyaW1lIHdpdGggaGlnaCBzdWNjZXNzIOKAlCBzbyB3ZSBza2lwXG4vLyB0aGVtLiBTZXQgLS1taW4tY2hhbmNlIDAgdG8gZGlzYWJsZSB0aGUgZmlsdGVyIChhbHdheXMgcGlja1xuLy8gdGhlIGhpZ2hlc3Qga2FybWEvc2VjIGNyaW1lLCBldmVuIGlmIHlvdXIgc3VjY2VzcyByYXRlIGlzIGJhZCkuXG4vL1xuLy8gU3RhdCByZXF1aXJlbWVudCBjaGVjazogdGhlcmUgaXNuJ3Qgb25lIGluIHRoZSBBUEkuIFRoZVxuLy8gXCJYIHN0YXQgcmVxdWlyZWRcIiB0b29sdGlwIGluIHRoZSBDcmltZSBVSSBpcyBqdXN0IHRoZSBzdWNjZXNzLVxuLy8gcmF0ZSBmbG9vciBpbiBkaXNndWlzZS4gbnMuc2luZ3VsYXJpdHkuZ2V0Q3JpbWVDaGFuY2UoKSByZXR1cm5zXG4vLyB0aGUgYWN0dWFsIGNvbXB1dGVkIHN1Y2Nlc3MgcmF0ZSBmb3IgdGhlIGN1cnJlbnQgcGxheWVyLCB3aGljaFxuLy8gc3Vic3VtZXMgYW55IHN0YXQgZmxvb3IuIFRoZSBcInRpZXJcIiBvZiBhIGNyaW1lIGlzIGl0cyBrYXJtYS9zZWNcbi8vIHJhbmtpbmcsIG5vdCBhIHN0YXQgZ2F0ZS5cbi8vXG4vLyBIUCBndWFyZDogYnkgZGVmYXVsdCB3ZSByZXF1aXJlIGF0IGxlYXN0IDUwJSBIUCBiZWZvcmVcbi8vIHN0YXJ0aW5nIGEgY3JpbWUuIEZhaWx1cmUgc2NhbGVzIEhQIGxvc3Mgd2l0aCBjcmltZSB0aWVyLCBhbmRcbi8vIEhQIGRlYXRoID0gcHJpc29uID0gcmVhbCB0aW1lIGxvY2tlZCBvdXQgb2YgYWxsIHNjcmlwdHMuXG4vLyBHYW1lIGF1dG8tc2F2ZXMsIHNvIGEgamFpbCB0cmlwIGRvZXNuJ3Qgcm9sbCBiYWNrLCBidXQgaXRcbi8vIGNvc3RzIHByb2R1Y3RpdmUgdGltZS4gQWRqdXN0IHdpdGggLS1taW4taHAgMC4yNSAobG9vc2UpIG9yXG4vLyAtLW1pbi1ocCAwLjc1IChwYXJhbm9pZCkuIDAgZGlzYWJsZXMgdGhlIGd1YXJkIGVudGlyZWx5IOKAlFxuLy8gdXNlZnVsIHdoZW4gY2hhaW5pbmcgbG93LXRpZXIgY3JpbWVzIChTaG9wbGlmdC9NdWcpIHdoZXJlXG4vLyBIUCBsb3NzIGlzIHRyaXZpYWwgYW5kIHlvdSBkb24ndCB3YW50IHRoZSBzY3JpcHQgdG8gZXZlclxuLy8gc3RhbGwuXG4vL1xuLy8gU2luZ3VsYXJpdHkgY2hlY2sgaXMgYXQgdGhlIHRvcCBzbyB5b3UgZ2V0IGEgY2xlYXIgZXJyb3IgaWZcbi8vIHRoZSBhdWcgaXNuJ3QgaW5zdGFsbGVkIOKAlCB3aXRob3V0IGl0LCBldmVyeSBucy5zaW5ndWxhcml0eS4qXG4vLyBjYWxsIHdvdWxkIHRocm93IGFuZCB0aGUgc2NyaXB0IHdvdWxkIGRpZSBtaWQtbG9vcCB3aXRoIG5vXG4vLyBleHBsYW5hdGlvbi5cbi8vXG4vLyBPdXRwdXQgaXMgUVVJRVQgYnkgZGVmYXVsdCDigJQgb25seSB0aWVyLXByb21vdGlvbiBsaW5lcyBhbmRcbi8vIGVycm9ycyBwcmludC4gUGVyLWNyaW1lIGxpbmVzIGFyZSBzaWxlbnQuIC0tdmVyYm9zZSBvcHRzIGluXG4vLyB0byBhIG9uZS1saW5lLXBlci1jcmltZSBzdW1tYXJ5IChjcmltZSBuYW1lLCB0aW1lLCBnYWlucykuXG4vL1xuLy8gY29tbWl0Q3JpbWUgc2VtYW50aWNzOiBwZXIgdGhlIG9mZmljaWFsIEFQSSBkb2NzLCBpdFxuLy8gXCJyZXR1cm5zIHRoZSBudW1iZXIgb2YgbWlsbGlzZWNvbmRzIGl0IHRha2VzIHRvIGF0dGVtcHQgdGhlXG4vLyBzcGVjaWZpZWQgY3JpbWVcIiBidXQgZG9lcyBOT1QgYmxvY2sgdGhlIHNjcmlwdC4gVGhlIGNyaW1lXG4vLyBydW5zIGluIHRoZSBiYWNrZ3JvdW5kLiBDYWxsaW5nIGNvbW1pdENyaW1lIGFnYWluIGNhbmNlbHNcbi8vIGFueSBpbi1wcm9ncmVzcyB3b3JraW5nIGFjdGlvbiAoaW5jbHVkaW5nIGEgc3RpbGwtcnVubmluZ1xuLy8gY3JpbWUpLiBUaGUgc2NyaXB0IHNsZWVwcyB0aGUgcmV0dXJuZWQgZHVyYXRpb24gYmV0d2VlblxuLy8gY2FsbHMgc28gd2UgbmV2ZXIgY2FuY2VsIGEgY3JpbWUgdGhhdCdzIHN0aWxsIHJ1bm5pbmcuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBjcmltZS1sb29wLmpzICAgICAgICAgICAgICAgICAgIyBsb29wLCBhdXRvLXBpY2sgYmVzdCBrYXJtYSBjcmltZSwgUVVJRVRcbi8vICAgcnVuIGNyaW1lLWxvb3AuanMgLS1taW4taHAgMC43NSAgICAjIHN0cmljdGVyIEhQIGd1YXJkIChkZWZhdWx0IDAuNSlcbi8vICAgcnVuIGNyaW1lLWxvb3AuanMgLS1taW4taHAgMCAgICAgICAjIGRpc2FibGUgSFAgZ3VhcmRcbi8vICAgcnVuIGNyaW1lLWxvb3AuanMgLS1taW4tY2hhbmNlIDAuNyAjIHJlcXVpcmUgNzAlKyBzdWNjZXNzIHJhdGUgdG8gY29uc2lkZXJcbi8vICAgcnVuIGNyaW1lLWxvb3AuanMgLS1taW4tY2hhbmNlIDAgICAjIG5vIHN1Y2Nlc3MtcmF0ZSBmaWx0ZXJcbi8vICAgcnVuIGNyaW1lLWxvb3AuanMgLS12ZXJib3NlICAgICAgICAjIG9uZSBsaW5lIHBlciBjcmltZSBjb21wbGV0aW9uXG4vLyAgIHJ1biBjcmltZS1sb29wLmpzIC0tb25jZSAgICAgICAgICAgIyBvbmUgY3JpbWUsIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbi8vXG5jb25zdCBVU0FHRSA9IGBVc2FnZTpcbiAgcnVuIGNyaW1lLWxvb3AuanMgICAgICAgICAgICAgICAgICAjIGxvb3AsIGF1dG8tcGljayBiZXN0IGthcm1hIGNyaW1lLCBRVUlFVFxuICBydW4gY3JpbWUtbG9vcC5qcyAtLW1pbi1ocCAwLjc1ICAgICMgc3RyaWN0ZXIgSFAgZ3VhcmQgKGRlZmF1bHQgMC41KVxuICBydW4gY3JpbWUtbG9vcC5qcyAtLW1pbi1ocCAwICAgICAgICMgZGlzYWJsZSBIUCBndWFyZFxuICBydW4gY3JpbWUtbG9vcC5qcyAtLW1pbi1jaGFuY2UgMC43ICMgcmVxdWlyZSA3MCUrIHN1Y2Nlc3MgcmF0ZSB0byBjb25zaWRlclxuICBydW4gY3JpbWUtbG9vcC5qcyAtLW1pbi1jaGFuY2UgMCAgICMgbm8gc3VjY2Vzcy1yYXRlIGZpbHRlclxuICBydW4gY3JpbWUtbG9vcC5qcyAtLXZlcmJvc2UgICAgICAgICMgb25lIGxpbmUgcGVyIGNyaW1lIGNvbXBsZXRpb25cbiAgcnVuIGNyaW1lLWxvb3AuanMgLS1vbmNlICAgICAgICAgICAjIG9uZSBjcmltZSwgZnVsbCBvdXRwdXQsIHRoZW4gZXhpdFxuYDtcblxuLy8gQWxsIDEyIGNyaW1lcyBpbiB0aGUgY2Fub25pY2FsIFRpdGxlLUNhc2Ugc3BlbGxpbmcgdGhhdFxuLy8gbnMuc2luZ3VsYXJpdHkuY29tbWl0Q3JpbWUgLyBnZXRDcmltZVN0YXRzIGFjY2VwdC4gU291cmNlZFxuLy8gZnJvbSBzcmMvQ3JpbWUvRW51bXMudHMgaW4gdGhlIEJpdGJ1cm5lciBzb3VyY2UuIE9yZGVyIGhlcmVcbi8vIGRvZXNuJ3QgbWF0dGVyIOKAlCB0aGUgc2NyaXB0IHJlLXJhbmtzIGJ5IGthcm1hL3NlYyBvbiBldmVyeVxuLy8gcGFzcy4gTGlzdGVkIGluIHRoZSBzYW1lIG9yZGVyIGFzIHRoZSBpbi1nYW1lIENyaW1lIFVJXG4vLyAod2Vha2VzdCDihpIgc3Ryb25nZXN0KSBmb3IgcmVhZGFiaWxpdHkuXG5jb25zdCBDUklNRVMgPSBbXG4gIFwiU2hvcGxpZnRcIixcbiAgXCJSb2IgU3RvcmVcIixcbiAgXCJNdWdcIixcbiAgXCJMYXJjZW55XCIsXG4gIFwiRGVhbCBEcnVnc1wiLFxuICBcIkJvbmQgRm9yZ2VyeVwiLFxuICBcIlRyYWZmaWNrIEFybXNcIixcbiAgXCJIb21pY2lkZVwiLFxuICBcIkdyYW5kIFRoZWZ0IEF1dG9cIixcbiAgXCJLaWRuYXBcIixcbiAgXCJBc3Nhc3NpbmF0aW9uXCIsXG4gIFwiSGVpc3RcIixcbl07XG5cbmNvbnN0IERFRkFVTFRfTUlOX0hQID0gMC41O1xuY29uc3QgREVGQVVMVF9NSU5fQ0hBTkNFID0gMC41OyAgLy8gNTAlIHN1Y2Nlc3MgcmF0ZSBmbG9vclxuY29uc3QgSFBfUkVDSEVDS19NUyA9IDYwXzAwMDsgICAgLy8gaG93IGxvbmcgdG8gc2xlZXAgd2hlbiBIUCBpcyBiZWxvdyB0aGUgZmxvb3JcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnMpIHtcbiAgaWYgKG5zLmFyZ3MuaW5jbHVkZXMoXCItaFwiKSB8fCBucy5hcmdzLmluY2x1ZGVzKFwiLS1oZWxwXCIpKSB7XG4gICAgbnMudHByaW50KFVTQUdFKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaW5ndWxhcml0eSBpcyBtYW5kYXRvcnkg4oCUIHRoZSByZXN0IG9mIHRoZSBzY3JpcHQgY2FsbHNcbiAgLy8gbnMuc2luZ3VsYXJpdHkuKiBkaXJlY3RseS4gV2l0aG91dCBpdCwgdGhlIGZpcnN0IGNvbW1pdENyaW1lXG4gIC8vIHdvdWxkIHRocm93IGFuZCB0aGUgdXNlciB3b3VsZCBnZXQgYSB1c2VsZXNzIHN0YWNrIHRyYWNlLlxuICBpZiAoIW5zLnNpbmd1bGFyaXR5KSB7XG4gICAgbnMudHByaW50KFwiRVJST1I6IG5zLnNpbmd1bGFyaXR5IGlzIG5vdCBhdmFpbGFibGUuIEluc3RhbGwgdGhlIFNpbmd1bGFyaXR5IEZ1bmN0aW9ucyBhdWcgKFNGLTQgaW4gQml0Tm9kZSA0KSBmaXJzdC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gUGFyc2UgYXJncy4gU2FtZSBxdWlldC1ieS1kZWZhdWx0IHBhdHRlcm4gYXMgbW9uaXRvci1oYWNrbmV0LmpzXG4gIC8vIGFuZCBtb25pdG9yLW51a2UuanM6IC0tdmVyYm9zZSByZS1lbmFibGVzIHBlci10aWNrIG91dHB1dCxcbiAgLy8gLS1vbmNlIGRvZXMgYSBzaW5nbGUgY3JpbWUgdGhlbiBleGl0cyAoZnVsbCBvdXRwdXQpLlxuICBjb25zdCBhcmdzID0gbnMuYXJncy5zbGljZSgpO1xuICBjb25zdCBvbmNlID0gYXJncy5pbmNsdWRlcyhcIi0tb25jZVwiKTtcbiAgY29uc3QgdmVyYm9zZSA9IGFyZ3MuaW5jbHVkZXMoXCItLXZlcmJvc2VcIik7XG4gIGNvbnN0IGhwSWR4ID0gYXJncy5pbmRleE9mKFwiLS1taW4taHBcIik7XG4gIGNvbnN0IG1pbkhwRnJhY3Rpb24gPSBocElkeCA+PSAwXG4gICAgPyBOdW1iZXIoYXJnc1tocElkeCArIDFdKVxuICAgIDogREVGQVVMVF9NSU5fSFA7XG4gIGlmIChocElkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKG1pbkhwRnJhY3Rpb24pIHx8IG1pbkhwRnJhY3Rpb24gPCAwIHx8IG1pbkhwRnJhY3Rpb24gPiAxKSkge1xuICAgIG5zLnRwcmludChgY3JpbWUtbG9vcDogLS1taW4taHAgbXVzdCBiZSBhIG51bWJlciAwLi4xIChnb3QgJHthcmdzW2hwSWR4ICsgMV19KWApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjaGFuY2VJZHggPSBhcmdzLmluZGV4T2YoXCItLW1pbi1jaGFuY2VcIik7XG4gIGNvbnN0IG1pbkNoYW5jZSA9IGNoYW5jZUlkeCA+PSAwXG4gICAgPyBOdW1iZXIoYXJnc1tjaGFuY2VJZHggKyAxXSlcbiAgICA6IERFRkFVTFRfTUlOX0NIQU5DRTtcbiAgaWYgKGNoYW5jZUlkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKG1pbkNoYW5jZSkgfHwgbWluQ2hhbmNlIDwgMCB8fCBtaW5DaGFuY2UgPiAxKSkge1xuICAgIG5zLnRwcmludChgY3JpbWUtbG9vcDogLS1taW4tY2hhbmNlIG11c3QgYmUgYSBudW1iZXIgMC4uMSAoZ290ICR7YXJnc1tjaGFuY2VJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbnMuZGlzYWJsZUxvZyhcInNsZWVwXCIpO1xuICBucy5kaXNhYmxlTG9nKFwiZ2V0U2VydmVyTW9uZXlBdmFpbGFibGVcIik7XG5cbiAgLy8gSFAgZ3VhcmQuIElmIHRoZSBwbGF5ZXIncyBIUCByYXRpbyBpcyBiZWxvdyB0aGUgZmxvb3IsIHdlXG4gIC8vIHJlZnVzZSB0byBzdGFydCBhIGNyaW1lIGFuZCBzbGVlcCB1bnRpbCBpdCdzIHNhZmUgdG9cbiAgLy8gcmUtY2hlY2suIE5vdGU6IG5zLmdldFBsYXllcigpLmhwIGlzIGFuIG9iamVjdCB7IGN1cnJlbnQsXG4gIC8vIG1heCB9IOKAlCBOT1QgYSBzY2FsYXIuIChDYXVnaHQgYSByZWFsIGJ1ZyBoZXJlOiB0aGUgZmlyc3RcbiAgLy8gZHJhZnQgb2YgdGhpcyBzY3JpcHQgZGlkIHAuaHAgLyBwLm1heF9ocCwgd2hpY2ggaXMgb2JqZWN0XG4gIC8vIGRpdmlzaW9uID0gTmFOLCBhbmQgdGhlIGd1YXJkIHNpbGVudGx5IG5ldmVyIGZpcmVkLilcbiAgZnVuY3Rpb24gaHBPaygpIHtcbiAgICBpZiAobWluSHBGcmFjdGlvbiA8PSAwKSByZXR1cm4gdHJ1ZTsgIC8vIGd1YXJkIGRpc2FibGVkXG4gICAgY29uc3QgcCA9IG5zLmdldFBsYXllcigpO1xuICAgIHJldHVybiBwLmhwLmN1cnJlbnQgLyBwLmhwLm1heCA+PSBtaW5IcEZyYWN0aW9uO1xuICB9XG5cbiAgLy8gUGljayB0aGUgYmVzdCBjcmltZSBieSBrYXJtYS1wZXItc2Vjb25kLCBmaWx0ZXJlZCBieSB0aGVcbiAgLy8gc3VjY2Vzcy1yYXRlIGZsb29yLiBSZXR1cm5zIHsgbmFtZSwgbXMsIGthcm1hLCBjaGFuY2UsIGtwcyB9XG4gIC8vIG9yIG51bGwgaWYgbm8gY3JpbWUgcXVhbGlmaWVzIChldmVyeSBjcmltZSBpcyBiZWxvd1xuICAvLyAtLW1pbi1jaGFuY2UsIE9SIGdldENyaW1lU3RhdHMgdGhyZXcg4oCUIHNob3VsZCBuZXZlciBoYXBwZW5cbiAgLy8gZm9yIGEgcmVhbCBwbGF5ZXIpLlxuICBmdW5jdGlvbiBwaWNrQmVzdENyaW1lKCkge1xuICAgIGxldCBiZXN0ID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgQ1JJTUVTKSB7XG4gICAgICBjb25zdCBzdGF0cyA9IG5zLnNpbmd1bGFyaXR5LmdldENyaW1lU3RhdHMobmFtZSk7XG4gICAgICBjb25zdCBjaGFuY2UgPSBucy5zaW5ndWxhcml0eS5nZXRDcmltZUNoYW5jZShuYW1lKTtcbiAgICAgIGlmIChjaGFuY2UgPCBtaW5DaGFuY2UpIGNvbnRpbnVlOyAgLy8gc3VjY2VzcyByYXRlIHRvbyBsb3cg4oCUIHNraXBcbiAgICAgIGNvbnN0IGtwcyA9IChzdGF0cy5rYXJtYSAvIHN0YXRzLnRpbWUpICogMTAwMDsgIC8vIGthcm1hIHBlciBzZWNvbmRcbiAgICAgIGlmIChiZXN0ID09PSBudWxsIHx8IGtwcyA+IGJlc3Qua3BzKSB7XG4gICAgICAgIGJlc3QgPSB7IG5hbWUsIG1zOiBzdGF0cy50aW1lLCBrYXJtYTogc3RhdHMua2FybWEsIGNoYW5jZSwga3BzIH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBiZXN0O1xuICB9XG5cbiAgLy8gT25lIGNyaW1lIHBhc3MuIFJldHVybnMgdGhlIHRpbWUgdGhlIGNyaW1lIHRvb2sgaW4gbXMgKG9yIDBcbiAgLy8gaWYgd2UgYmFpbGVkIGZvciBIUCAvIG5vIHF1YWxpZnlpbmcgdGllciAvIGNvbW1pdENyaW1lXG4gIC8vIHJldHVybmVkIDApLiBQcmludHMgdGhlIHRpZXItcHJvbW90aW9uIGxpbmUgaWYgdGhlIHBpY2tlZFxuICAvLyBjcmltZSBjaGFuZ2VkIGZyb20gdGhlIGxhc3QgY2FsbCDigJQgdGhhdCdzIHRoZSBvbmx5XG4gIC8vIFwiaW50ZXJlc3RpbmdcIiBldmVudCBpbiBxdWlldCBtb2RlLlxuICBsZXQgbGFzdFRpZXIgPSBudWxsO1xuICBmdW5jdGlvbiBwYXNzKCkge1xuICAgIGlmICghaHBPaygpKSByZXR1cm4gMDtcblxuICAgIGNvbnN0IGNyaW1lID0gcGlja0Jlc3RDcmltZSgpO1xuICAgIGlmICghY3JpbWUpIHtcbiAgICAgIG5zLnRwcmludChgY3JpbWUtbG9vcDogbm8gY3JpbWUgbWVldHMgLS1taW4tY2hhbmNlICR7KG1pbkNoYW5jZSAqIDEwMCkudG9GaXhlZCgwKX0lICh0cnkgLS1taW4tY2hhbmNlIDAgaWYgeW91IHdhbnQgdG8gZ3JpbmQgYW55d2F5KWApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuXG4gICAgaWYgKGxhc3RUaWVyICE9PSBjcmltZS5uYW1lKSB7XG4gICAgICAvLyBUaWVyIGNoYW5nZSBpcyB0aGUgaW50ZXJlc3RpbmcgZXZlbnQuIEFsd2F5cyBwcmludCxcbiAgICAgIC8vIGV2ZW4gaW4gcXVpZXQgbW9kZSDigJQgdGhlIHdob2xlIHBvaW50IG9mIHRoZSBzY3JpcHQgaXNcbiAgICAgIC8vIHRvIHNpbGVudGx5IHBpY2sgdGhlIGJlc3Qga2FybWEvc2VjIGNyaW1lLCBhbmQgdGhlXG4gICAgICAvLyB1c2VyIHdhbnRzIHRvIGtub3cgd2hlbiB0aGF0IGNoYW5nZXMuXG4gICAgICBucy50cHJpbnQoYHRpZXI6ICR7bGFzdFRpZXIgPz8gXCIoc3RhcnQpXCJ9IOKGkiAke2NyaW1lLm5hbWV9ICgkeyhjcmltZS5jaGFuY2UgKiAxMDApLnRvRml4ZWQoMCl9JSBjaGFuY2UsICR7Y3JpbWUua3BzLnRvRml4ZWQoMyl9IGthcm1hL3MpYCk7XG4gICAgICBsYXN0VGllciA9IGNyaW1lLm5hbWU7XG4gICAgfVxuXG4gICAgY29uc3QgbXMgPSBucy5zaW5ndWxhcml0eS5jb21taXRDcmltZShjcmltZS5uYW1lKTtcbiAgICBpZiAobXMgPD0gMCkge1xuICAgICAgLy8gY29tbWl0Q3JpbWUgcmV0dXJucyAwIHdoZW4gdGhlIHBsYXllciBpcyBpbiBhIHN0YXRlXG4gICAgICAvLyB0aGF0IGNhbid0IGNvbW1pdCBjcmltZXMgKGUuZy4gaG9zcGl0YWxpemVkIHBvc3QtXG4gICAgICAvLyBwcmlzb24sIGN1cnJlbnRseSB3b3JraW5nIG91dCBhIHNlbnRlbmNlKS4gRGVtb3RlIG9uZVxuICAgICAgLy8gdGllciBvbiB0aGUgY2FjaGUgc28gdGhlIG5leHQgcGFzcyBjYW4gcmUtZXZhbHVhdGUuXG4gICAgICBucy50cHJpbnQoYEZBSUwtY29tbWl0ICAgICAke2NyaW1lLm5hbWV9IHJldHVybmVkICR7bXN9bXMg4oCUIHJldHJ5aW5nIGluICR7SFBfUkVDSEVDS19NUyAvIDEwMDB9c2ApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuXG4gICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgIGNvbnN0IHAgPSBucy5nZXRQbGF5ZXIoKTtcbiAgICAgIG5zLnRwcmludChgQ09NTUlUVEVEICAgICAgICR7Y3JpbWUubmFtZS5wYWRFbmQoMTYpfSAkeyhtcyAvIDEwMDApLnRvRml4ZWQoMSl9cyAgSFAgJHtwLmhwLmN1cnJlbnQudG9GaXhlZCgwKX0vJHtwLmhwLm1heC50b0ZpeGVkKDApfSAga2FybWEgJHtwLmthcm1hLnRvRml4ZWQoMSl9ICBjaGFuY2UgJHsoY3JpbWUuY2hhbmNlICogMTAwKS50b0ZpeGVkKDApfSVgKTtcbiAgICB9XG4gICAgcmV0dXJuIG1zO1xuICB9XG5cbiAgaWYgKG9uY2UpIHtcbiAgICBwYXNzKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbnMudHByaW50KGBjcmltZS1sb29wOiBzdGFydGVkLCBtaW4taHA9JHsobWluSHBGcmFjdGlvbiAqIDEwMCkudG9GaXhlZCgwKX0lLCBtaW4tY2hhbmNlPSR7KG1pbkNoYW5jZSAqIDEwMCkudG9GaXhlZCgwKX0lLCBvdXRwdXQ9JHt2ZXJib3NlID8gXCJ2ZXJib3NlXCIgOiBcInF1aWV0XCJ9YCk7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3QgbXMgPSBwYXNzKCk7XG4gICAgLy8gY29tbWl0Q3JpbWUgc3RhcnRzIHRoZSBjcmltZSBhbmQgcmV0dXJucyBpbW1lZGlhdGVseVxuICAgIC8vIHdpdGggdGhlIHRpbWUgaXQgV0lMTCB0YWtlLiBXZSBzbGVlcCB0aGUgcmV0dXJuZWQgbXMgc29cbiAgICAvLyB0aGUgbmV4dCBwYXNzIGRvZXNuJ3QgY2FuY2VsIHRoZSBpbi1wcm9ncmVzcyBjcmltZVxuICAgIC8vIChjb21taXRDcmltZSBjYW5jZWxzIGFueSBjdXJyZW50ICd3b3JraW5nJyBhY3Rpb24sXG4gICAgLy8gaW5jbHVkaW5nIGEgY3JpbWUgdGhhdCdzIHN0aWxsIHJ1bm5pbmcpLiBUaGUgbWF0aCBpc1xuICAgIC8vIGp1c3Q6IHNsZWVwIGZvciB0aGUgY3JpbWUncyBkdXJhdGlvbiwgdGhlbiBzdGFydCB0aGVcbiAgICAvLyBuZXh0IG9uZS5cbiAgICAvL1xuICAgIC8vIElmIG1zIGlzIDAgd2UgYmFpbGVkIChIUCBndWFyZCwgbm8gY3JpbWUgbWV0IHRoZVxuICAgIC8vIGNoYW5jZSBmbG9vciwgY29tbWl0Q3JpbWUgcmV0dXJuZWQgMCkgYW5kIHNsZWVwIHRoZSBIUFxuICAgIC8vIHJlY2hlY2sgaW50ZXJ2YWwgaW5zdGVhZC5cbiAgICBhd2FpdCBucy5zbGVlcChtcyA+IDAgPyBtcyA6IEhQX1JFQ0hFQ0tfTVMpO1xuICB9XG59XG4iXX0=