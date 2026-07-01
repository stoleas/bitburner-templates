/** @param {NS} ns */
export async function main(ns) {
  const defaults = [
    "n00dles", "foodnstuff", "sigma-cosmetics", "max-hardware",
    "joesguns", "hong-fang-tea", "phantasy", "omega-net",
  ];
  // Filter out the --targets marker, keep the rest as the host list.
  const argTargets = ns.args.filter((a) => a !== "--targets");
  const list = argTargets.length > 0 ? argTargets : defaults;

  // (program filename on home, opener function on ns)
  const openers = [
    { file: "BruteSSH.exe",  open: (h) => ns.brutessh(h) },
    { file: "FTPCrack.exe",  open: (h) => ns.ftpcrack(h) },
    { file: "relaySMTP.exe", open: (h) => ns.relaysmtp(h) },
    { file: "HTTPWorm.exe",  open: (h) => ns.httpworm(h) },
    { file: "SQLInject.exe", open: (h) => ns.sqlinject(h) },
  ];

  let nuked = 0, skipped = 0, failed = 0;

  for (const host of list) {
    if (ns.hasRootAccess(host)) {
      ns.tprint(`SKIP ${host} (already rooted)`);
      skipped++;
      continue;
    }

    const needed = ns.getServerNumPortsRequired(host);
    for (const op of openers) {
      if (ns.fileExists(op.file, "home")) op.open(host);
    }

    // Re-check root; if nuke succeeded we're done. If not, we don't have
    // enough ports opened.
    if (ns.hasRootAccess(host)) {
      ns.tprint(`NUKED ${host}`);
      nuked++;
    } else {
      ns.tprint(`FAIL  ${host} (need ${needed} ports — missing port-opener programs on home)`);
      failed++;
    }
  }

  ns.tprint(`done: nuked=${nuked} skipped=${skipped} failed=${failed}`);
}
