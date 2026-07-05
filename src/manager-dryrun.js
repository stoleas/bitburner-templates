/** @param {NS} ns */
//
// manager-dryrun.js — diagnostic companion to manager.js.
//
// Runs planBatch() for each target in TARGETS, prints the resulting
// 4-job plan, the total RAM needed, AND which hosts in the fleet
// would carry which threads. Does NOT launch anything. Use this
// to verify the batch math is sane AND the fleet can carry the
// batch before starting manager.js.
//
// Useful when:
//   - You just augmented and want to confirm which targets are now
//     in reach and what each batch looks like
//   - The cluster is small and you want to see which targets SKIP-ram
//   - You're tuning MONEY_FRACTION and want to see thread/RAM impact
//   - You want to verify the fleet pattern is actually spreading
//     (not concentrating on home)
//
// Output:
//
//   manager-dryrun: planning batches (no launches)
//   manager-dryrun: cluster=N servers, total=NGGB, free=NGGB
//     phantasy        target=phantasy OK healthy money=0.99×max sec=100.0/100.0
//                     hack=N w=N grow=N ram=NGGB pipe=N fleet=[home:N, pserv-0:N, ...]
//     omega-net       target=omega-net UNHEALTHY money=0.00×max sec=100.0/100.0
//                     (will drain before normal HWGW)
//     ...
//
// Usage:
//   run manager-dryrun.js
//
import {
  planBatch,
  listWorkers,
  buildFleet,
  fleetFree,
  totalBatchRam,
  shareRamCap,
  isHealthy,
  isPrepped,
  FLEET_DEFAULTS,
} from "/lib/hwgw.js";

const TARGETS = [
  "phantasy", "omega-net", "max-hardware", "silver-helix",
  "netlink", "computek", "rho-construction", "catalyst", "I.I.I.I",
];

// Simulate the fleet-batcher's allocation without firing anything,
// so the dryrun shows the per-host spread. Returns a Map<host,
// threads-of-this-job>. This is a read-only mirror of the allocate()
// function in lib/hwgw.js — duplicated here so the dryrun doesn't
// mutate the cluster (no real ns.exec).
function simulateAllocate(fleet, script, threads, scriptRam) {
  const out = new Map();
  let remaining = threads;
  for (const { h, r } of fleet) {
    if (remaining <= 0) break;
    const free = Math.max(0, scriptRam.freeRamOf(h) - r);
    const canFit = Math.floor(free / scriptRam.perScript);
    if (canFit <= 0) continue;
    const put = Math.min(canFit, remaining);
    out.set(h, (out.get(h) || 0) + put);
    remaining -= put;
  }
  return out;
}

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

  // Build the same fleet the manager would use. The dryrun's
  // simulateAllocate is a read-only mirror of allocate(); both use
  // the same fleet shape.
  const fleet = buildFleet(ns);
  const fleetFreeRam = fleetFree(ns, fleet);
  const shareCap = shareRamCap(ns, fleet);
  ns.tprint(`manager-dryrun: fleet=${fleet.length} hosts, fleetFree=${fleetFreeRam.toFixed(0)}GB, shareCap=${shareCap.toFixed(0)}GB (1/3)`);

  // Pull script RAM costs once; same as totalBatchRam() does.
  const hackRam = ns.getScriptRam("hack.js", "home");
  const weakenRam = ns.getScriptRam("weaken.js", "home");
  const growRam = ns.getScriptRam("grow.js", "home");
  const scriptRamOf = (s) => s === "hack.js" ? hackRam : s === "weaken.js" ? weakenRam : growRam;
  const freeRamOf = (h) => ns.getServerMaxRam(h) - ns.getServerUsedRam(h);

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
    // isHealthy/isPrepped diagnostic. The production manager
    // refuses to fire HWGW on unhealthy targets — the dryrun
    // shows the live state so you can see WHICH targets need
    // drain/prep before normal HWGW resumes.
    const healthy = isHealthy(ns, target, 0.10, 0.5, 5);
    const prepped = isPrepped(ns, target);
    const healthTag = prepped ? "PREPPED" : (healthy ? "OK" : "UNHEALTHY");
    const healthDetail = `money=${(s.moneyAvailable / Math.max(1, s.moneyMax)).toFixed(2)}×max sec=${s.hackDifficulty.toFixed(1)}/${s.minDifficulty.toFixed(1)}`;
    try {
      const plan = planBatch(ns, target, { moneyFraction: 0.10 });
      const batchRam = totalBatchRam(ns, plan);
      // Pipe depth: how many batches can run in parallel given
      // the per-target share cap. From skeesler/bitburner-commander:
      // `concurrent = floor(shareCap / batchRam)`. Each batch takes
      // 1 weakenTime to complete; the pipe lets the cluster fire
      // `concurrent` batches over the same wall-clock window.
      const pipe = batchRam > 0 ? Math.max(1, Math.floor(shareCap / batchRam)) : 1;
      const fit = batchRam <= fleetFreeRam * FLEET_DEFAULTS.FLEET_HEADROOM_FRACTION;
      // Show the per-job fleet spread. Hack and grow are usually
      // small enough to fit on home; weaken is the job that
      // typically spreads across the cluster. We show all 4.
      const fleetSummary = [];
      for (const job of plan.jobs) {
        const spread = simulateAllocate(fleet, job.script, job.threads, {
          perScript: scriptRamOf(job.script),
          freeRamOf,
        });
        const parts = [...spread.entries()]
          .map(([h, t]) => `${h.split("-").pop()}:${t}`)  // shorten "pserv-0" to "0"
          .join(",");
        fleetSummary.push(`${job.script.replace(".js", "")}=[${parts || "none"}]`);
      }
      const fitTag = fit ? "OK" : "SKIP-fleet";
      const pipeTag = `pipe=${pipe}×`;
      const actionTag = healthy ? "" : " (DRAIN before HWGW)";
      ns.tprint(`  ${target.padEnd(20)}  ${healthTag.padEnd(10)} ${healthDetail}${actionTag}`);
      ns.tprint(`  ${"".padEnd(20)}  ${plan.summary} ${pipeTag}${fitTag} fleet=[${fleetSummary.join(" ")}]`);
    } catch (e) {
      ns.tprint(`  ${target.padEnd(20)}  ${healthTag.padEnd(10)} ${healthDetail}  ERR   ${e.message}`);
    }
  }
}
