/** @param {NS} ns */
//
// manager-dryrun.js — diagnostic companion to manager.js.
//
// Runs planBatch() for each target in TARGETS, prints the resulting
// 4-job plan, and reports total RAM needed per target. Does NOT
// launch anything. Use this to verify the batch math is sane before
// starting manager.js.
//
// Useful when:
//   - You just augmented and want to confirm which targets are now
//     in reach and what each batch looks like
//   - The cluster is small and you want to see which targets SKIP-ram
//   - You're tuning MONEY_FRACTION and want to see thread/RAM impact
//
// Output:
//
//   manager-dryrun: planning batches (no launches)
//   manager-dryrun: cluster=N servers, total=NGGB, free=NGGB
//     phantasy        target=phantasy hack=N w=N grow=N ram=NGGB
//     omega-net       target=omega-net hack=N w=N grow=N ram=NGGB
//     ...
//
// Usage:
//   run manager-dryrun.js
//
import { planBatch, listWorkers } from "/lib/hwgw.js";

const TARGETS = [
  "phantasy", "omega-net", "max-hardware", "silver-helix",
  "netlink", "computek", "rho-construction", "catalyst", "I.I.I.I",
];

export async function main(ns) {
  ns.tprint("manager-dryrun: planning batches (no launches)");
  const workers = listWorkers(ns);
  let totalClusterRam = 0;
  let totalFree = 0;
  for (const w of workers) {
    const max = ns.getServerMaxRam(w);
    const used = ns.getServerUsedRam(w);
    totalClusterRam += max;
    totalFree += (max - used);
  }
  ns.tprint(`manager-dryrun: cluster=${workers.length} servers, total=${totalClusterRam.toFixed(0)}GB, free=${totalFree.toFixed(0)}GB`);

  for (const target of TARGETS) {
    const s = ns.getServer(target);
    if (!s.hasAdminRights) {
      ns.tprint(`  ${target.padEnd(20)}  SKIP  no root`);
      continue;
    }
    if (s.requiredHackingSkill > ns.getPlayer().skills.hacking) {
      ns.tprint(`  ${target.padEnd(20)}  SKIP  need hack ${s.requiredHackingSkill}, have ${ns.getPlayer().skills.hacking}`);
      continue;
    }
    if (!s.moneyMax || s.moneyMax <= 0) {
      ns.tprint(`  ${target.padEnd(20)}  SKIP  moneyMax=0`);
      continue;
    }
    try {
      const plan = planBatch(ns, target, { moneyFraction: 0.10 });
      ns.tprint(`  ${target.padEnd(20)}  ${plan.summary}`);
    } catch (e) {
      ns.tprint(`  ${target.padEnd(20)}  ERR   ${e.message}`);
    }
  }
}
