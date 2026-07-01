import { NS } from "@ns";

/**
 * Proper HWGW batched hack loop.
 *
 * Each operation's runtime is deterministic given the current target state,
 * so we can `sleep` exactly the gap between operations. This is the
 * "sleeve-stable" loop the in-game tutorial walks you toward.
 *
 * Ideal target: a server you've prepped to min security and max money, then
 * run this on a home/server with enough RAM for many threads. Tune thread
 * counts with `ns.hackAnalyzeThreads` / `ns.growthAnalyze`; once you have
 * the Formulas API, prefer `ns.formulas.hacking.*` for exact sizing.
 *
 * Note: this script is a *worker*. The classic pattern is one orchestrator
 * script on `home` that calls `ns.exec("hack-loop.js", target, threads)` so
 * the heavy work runs on the target server.
 */
export async function main(ns: NS): Promise<void> {
  const target = "foodnstuff";

  // Ensure root access. foodnstuff requires 0 port opens, so a single nuke works.
  if (!ns.hasRootAccess(target)) {
    ns.nuke(target);
  }

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("getServerSecurityLevel");

  // Cache runtimes — they only change if the target's security or our
  // hacking level changes, which is fine to re-read on each iteration.
  while (true) {
    const hackTime = ns.getHackTime(target);
    const growTime = ns.getGrowTime(target);
    const weakenTime = ns.getWeakenTime(target);

    // h → w → g → w sequence keeps the server's security oscillating
    // close to its minimum and money close to its maximum.
    await ns.hack(target);
    await ns.sleep(weakenTime - hackTime - 50);
    await ns.weaken(target);
    await ns.sleep(growTime - weakenTime - 50);
    await ns.grow(target);
    await ns.sleep(weakenTime - growTime - 50);
    await ns.weaken(target);
    await ns.sleep(hackTime - 50);
  }
}
