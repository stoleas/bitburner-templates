/** @param {NS} ns */
//
// Watch the dark-web TOR router for new port-opener programs arriving
// on home, then auto-run nuke.js + deploy.js so the new money target
// (currently phantasy) gets rooted and a worker gets fanned out to it
// without you babysitting the terminal.
//
// Usage:
//   run buy-monitor.js
//
// Polls every 30s. When a new *.exe in the opener list appears on
// home, it kicks off nuke.js, waits for that to finish, then runs
// deploy.js. Idempotent: re-running this script is safe.
//
// The opener list is what nuke.js looks for; we only fire when a new
// member of that list lands.
//
const POLL_MS = 30_000;
const NUKE = "nuke.js";
const DEPLOY = "deploy.js";

const OPENER_PROGRAMS = [
  "BruteSSH.exe",
  "FTPCrack.exe",
  "relaySMTP.exe",
  "HTTPWorm.exe",
  "SQLInject.exe",
  // Not port-openers, but useful unlocks — AutoLink lets scan-analyze
  // connect directly, ServerProfiler/Deepscan give better visibility.
  // Any new file on home fires the nuke+deploy chain.
  "AutoLink.exe",
  "ServerProfiler.exe",
  "DeepscanV1.exe",
  "DeepscanV2.exe",
];

export async function main(ns) {
  ns.disableLog("sleep");
  ns.tprint(`buy-monitor: watching for ${OPENER_PROGRAMS.join(", ")}`);
  // Track which openers we already have so we only fire on the *new* one.
  const have = new Set(OPENER_PROGRAMS.filter((p) => ns.fileExists(p, "home")));

  while (true) {
    for (const p of OPENER_PROGRAMS) {
      if (have.has(p)) continue;
      if (!ns.fileExists(p, "home")) continue;
      // New opener landed!
      have.add(p);
      ns.tprint(`buy-monitor: ${p} arrived on home — running ${NUKE} then ${DEPLOY}`);
      const nukePid = ns.run(NUKE);
      if (nukePid === 0) {
        ns.tprint(`buy-monitor: failed to start ${NUKE} (not enough RAM?) — will retry on next poll`);
        have.delete(p);
        continue;
      }
      // Wait for nuke.js to finish so deploy.js sees the new roots.
      while (ns.isRunning(nukePid)) await ns.sleep(500);
      ns.tprint(`buy-monitor: ${NUKE} done — starting ${DEPLOY}`);
      const deployPid = ns.run(DEPLOY);
      if (deployPid === 0) {
        ns.tprint(`buy-monitor: failed to start ${DEPLOY} — rerun manually`);
      } else {
        ns.tprint(`buy-monitor: ${DEPLOY} started (pid ${deployPid}). Exiting.`);
        return;
      }
    }
    await ns.sleep(POLL_MS);
  }
}
