/** @param {NS} ns */
export async function main(ns) {
  if (ns.fileExists("Tor Router", "home")) {
    ns.tprint("buy-tor: already installed");
    return;
  }
  if (ns.purchaseProgram("Tor Router")) {
    ns.tprint("buy-tor: Tor Router installed");
  } else {
    ns.tprint("buy-tor: failed (need $100k?)");
  }
}
