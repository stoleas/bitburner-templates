/** @param {NS} ns */
export async function main(ns) {
  // Target defaults to n00dles. Pass any other hostname as an arg.
  const target = ns.args[0]?.toString() ?? "n00dles";

  // Optional: ensure root. n00dles needs 0 ports, so this always works.
  if (!ns.hasRootAccess(target)) {
    ns.nuke(target);
  }

  const moneyThresh = ns.getServerMaxMoney(target);
  const securityThresh = ns.getServerMinSecurityLevel(target);

  ns.disableLog("sleep");

  while (true) {
    if (ns.getServerSecurityLevel(target) > securityThresh) {
      await ns.weaken(target);
    } else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
      await ns.grow(target);
    } else {
      await ns.hack(target);
    }
  }
}
