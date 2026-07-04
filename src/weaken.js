/** @param {NS} ns */
//
// Single-op worker. Takes target as only arg. One weaken() call, then exit.
// Used by manager.js in an HWGW batch — never run this on its own.
//
// RAM cost: ~1.75 GB.
//
// Usage:
//   run weaken.js <target>
//   run weaken.js phantasy
//
export async function main(ns) {
  const target = ns.args[0]?.toString();
  if (!target) {
    ns.tprint("weaken: missing target arg");
    return;
  }
  await ns.weaken(target);
}
