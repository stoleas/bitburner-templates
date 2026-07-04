/** @param {NS} ns */
//
// Single-op worker. Takes target as only arg. One grow() call, then exit.
// Used by manager.js in an HWGW batch — never run this on its own.
//
// RAM cost: ~1.75 GB.
//
// Usage:
//   run grow.js <target>
//   run grow.js phantasy
//
export async function main(ns) {
  const target = ns.args[0]?.toString();
  if (!target) {
    ns.tprint("grow: missing target arg");
    return;
  }
  await ns.grow(target);
}
