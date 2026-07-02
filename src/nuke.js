/** @param {NS} ns */
//
// Open every required port on every reachable server, then ns.nuke it.
// Idempotent — safe to re-run. Scans the whole network reachable from
// home by default, so newly-purchased servers / freshly-unlocked paths
// get nuked without editing a list.
//
// Usage:
//   run nuke.js                       # BFS the network, nuke every reachable host
//   run nuke.js --targets neo-net CSEC  # pin to specific servers
//   run nuke.js --quiet               # only print NUKED / FAIL / summary (suppress SKIP lines)
//
// Out-of-level targets are reported (so you can see what you're
// missing) but not acted on — nuke() silently fails on under-levelled
// hosts, so we filter before trying. Servers you don't have the
// port-opener programs for are also reported (with a count of how
// many you're missing) and skipped. Pass --quiet to suppress the
// SKIP-* noise and only see NUKED / FAIL / summary.
//
const USAGE = `Usage:
  run nuke.js                          # BFS the network, nuke every reachable host
  run nuke.js --targets neo-net CSEC   # pin to specific servers
  run nuke.js --quiet                  # only print NUKED / FAIL / summary
`;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  // Parse args. --targets <list...> takes the rest as the target list.
  const args = ns.args.slice();
  const quiet = args.includes("--quiet");
  const targetsIdx = args.indexOf("--targets");
  const pinned = targetsIdx >= 0 ? args.slice(targetsIdx + 1) : null;

  // Opener programs on home and the matching NS functions.
  const openers = [
    { file: "BruteSSH.exe",  open: (h) => ns.brutessh(h) },
    { file: "FTPCrack.exe",  open: (h) => ns.ftpcrack(h) },
    { file: "relaySMTP.exe", open: (h) => ns.relaysmtp(h) },
    { file: "HTTPWorm.exe",  open: (h) => ns.httpworm(h) },
    { file: "SQLInject.exe", open: (h) => ns.sqlinject(h) },
  ];

  // Build the target list. Pinned mode skips the BFS.
  let hosts;
  if (pinned) {
    hosts = pinned;
  } else {
    const seen = new Set(["home"]);
    const queue = ["home"];
    while (queue.length > 0) {
      const h = queue.shift();
      for (const n of ns.scan(h)) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    hosts = [...seen].sort();
  }

  const myHack = ns.getPlayer().skills.hacking;

  const counters = {
    "NUKED": 0,
    "SKIP-rooted": 0,
    "SKIP-self": 0,
    "SKIP-purchased": 0,
    "SKIP-hack": 0,
    "SKIP-port": 0,
    "FAIL-notfound": 0,
    "FAIL-nuke": 0,
  };

  for (const host of hosts) {
    if (host === "home") {
      if (!quiet) ns.tprint(`SKIP-self      home`);
      counters["SKIP-self"]++;
      continue;
    }

    if (ns.hasRootAccess(host)) {
      if (!quiet) ns.tprint(`SKIP-rooted    ${host}  (already rooted)`);
      counters["SKIP-rooted"]++;
      continue;
    }

    // Check the server exists in the network.
    // getServerNumPortsRequired returns -1 for unknown hostnames.
    const needed = ns.getServerNumPortsRequired(host);
    if (needed < 0) {
      // FAIL lines are always printed — they signal a real issue
      // (typo in --targets, or a server that needs a backdoor first).
      ns.tprint(`FAIL-notfound  ${host}  (host not in network — BFS may need a purchase or a backdoor)`);
      counters["FAIL-notfound"]++;
      continue;
    }

    // Filter out purchased servers — you own those, you don't "nuke" them.
    // getServer() works on unknown hosts in Bitburner, so this is safe.
    const s = ns.getServer(host);
    if (s.purchasedByPlayer) {
      if (!quiet) ns.tprint(`SKIP-purchased ${host}`);
      counters["SKIP-purchased"]++;
      continue;
    }

    // Hack-level check. nuke() silently fails under-levelled, so we filter.
    // We still *report* the level block, so the user can see what they're
    // missing — but we don't try to nuke.
    const reqHack = ns.getServerRequiredHackingLevel(host);
    if (reqHack > myHack) {
      if (!quiet) ns.tprint(`SKIP-hack      ${host}  (need hack ${reqHack}, you have ${myHack})`);
      counters["SKIP-hack"]++;
      continue;
    }

    // Open every port we have a program for.
    const haveOpeners = openers.filter((o) => ns.fileExists(o.file, "home"));
    for (const op of haveOpeners) op.open(host);

    if (haveOpeners.length < needed) {
      if (!quiet) ns.tprint(`SKIP-port      ${host}  (need ${needed} port-opener programs, you have ${haveOpeners.length}: ${haveOpeners.map((o) => o.file).join(", ") || "none"})`);
      counters["SKIP-port"]++;
      continue;
    }

    // Try to nuke.
    ns.nuke(host);
    if (ns.hasRootAccess(host)) {
      ns.tprint(`NUKED          ${host}`);
      counters["NUKED"]++;
    } else {
      // FAIL-nuke is always printed (rare, indicates a bug).
      ns.tprint(`FAIL-nuke      ${host}  (ports opened, hack sufficient, but nuke failed — bug?)`);
      counters["FAIL-nuke"]++;
    }
  }

  // In quiet mode, suppress the summary line entirely when nothing
  // interesting happened. We only print it if at least one NUKED
  // (the whole point of running this) or any FAIL- (real issue).
  // In verbose mode, always print the summary — it's the per-run
  // report you can scroll back through.
  const summary = Object.entries(counters)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const interesting = counters.NUKED > 0 || counters["FAIL-notfound"] > 0 || counters["FAIL-nuke"] > 0;
  if (!quiet || interesting) {
    ns.tprint(`done: ${summary} (scanned ${hosts.length} hosts)`);
  }
}
