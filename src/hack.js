/** @param {NS} ns */
//
// Single-op worker. Takes target as only arg. One hack() call, then exit.
// Used by manager.js in an HWGW batch — never run this on its own.
//
// RAM cost: ~1.75 GB.
//
// Usage:
//   run hack.js <target>
//   run hack.js phantasy
//
export async function main(ns) {
  const target = ns.args[0]?.toString();
  if (!target) {
    ns.tprint("hack: missing target arg");
    return;
  }
  // We deliberately do NOT wrap ns.hack in a try/catch — let any
  // errors throw, so the manager (and the user) can see the real
  // reason the worker died in the in-game log. If the worker
  // runs for ~1-2s and disappears, look at the hack.js process
  // log: it'll show the actual ns.hack failure.
  await ns.hack(target);
}
