/** @param {NS} ns */
//
// Watch the dark-web TOR router for new port-opener programs arriving
// on home, then auto-run nuke.js + deploy.js so the new money target
// (currently phantasy) gets rooted and a worker gets fanned out to it
// without you babysitting the terminal.
//
// Usage:
//   run monitor-buy.js
//
// Polls every 30s. When a new *.exe in the opener list appears on
// home, it kicks off nuke.js, waits for that to finish, then runs
// deploy.js. Idempotent: re-running this script is safe.
//
// The opener list is what nuke.js looks for; we only fire when a new
// member of that list lands.
//
const USAGE = `Usage:
  run monitor-buy.js
`;

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
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  ns.disableLog("sleep");
  ns.tprint(`monitor-buy: watching for ${OPENER_PROGRAMS.join(", ")}`);
  // Track which openers we already have so we only fire on the *new* one.
  const have = new Set(OPENER_PROGRAMS.filter((p) => ns.fileExists(p, "home")));

  // How long to keep retrying ns.run(DEPLOY) after nuke.js finishes.
  // nuke.js frees its own RAM as it exits, but monitor-buy itself is
  // still on home holding RAM — so the first deploy call can race and
  // fail. 15s × 200ms = ~75 attempts is plenty.
  const DEPLOY_RETRY_TIMEOUT_MS = 15_000;
  const DEPLOY_RETRY_INTERVAL_MS = 200;

  while (true) {
    for (const p of OPENER_PROGRAMS) {
      if (have.has(p)) continue;
      if (!ns.fileExists(p, "home")) continue;
      // New opener landed!
      have.add(p);
      ns.tprint(`monitor-buy: ${p} arrived on home — running ${NUKE} then ${DEPLOY}`);
      const nukePid = ns.run(NUKE);
      if (nukePid === 0) {
        ns.tprint(`monitor-buy: failed to start ${NUKE} (not enough RAM?) — will retry on next poll`);
        have.delete(p);
        continue;
      }
      // Wait for nuke.js to finish so deploy.js sees the new roots.
      while (ns.isRunning(nukePid)) await ns.sleep(500);
      ns.tprint(`monitor-buy: ${NUKE} done — starting ${DEPLOY}`);
      // Retry ns.run(DEPLOY) until it lands or we time out. The first
      // call can fail when monitor-buy's own RAM footprint competes
      // with deploy.js for free home RAM right as nuke.js is exiting.
      const deployDeadline = Date.now() + DEPLOY_RETRY_TIMEOUT_MS;
      let deployPid = 0;
      while (deployPid === 0 && Date.now() < deployDeadline) {
        deployPid = ns.run(DEPLOY);
        if (deployPid === 0) await ns.sleep(DEPLOY_RETRY_INTERVAL_MS);
      }
      if (deployPid === 0) {
        ns.tprint(`monitor-buy: failed to start ${DEPLOY} after ${DEPLOY_RETRY_TIMEOUT_MS / 1000}s — rerun manually`);
      } else {
        ns.tprint(`monitor-buy: ${DEPLOY} started (pid ${deployPid}). Exiting.`);
        return;
      }
    }
    await ns.sleep(POLL_MS);
  }
}
