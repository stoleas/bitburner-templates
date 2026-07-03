/** @param {NS} ns */
//
// Backdoor status monitor.
//
// Bitburner requires you to type `backdoor` in the terminal at the
// target server's shell. NS scripts can't initiate that — only the
// terminal can. So this script doesn't START backdoors; it just
// reports the backdoor state of every reachable server so you know:
//
//   - which servers are eligible (rooted, hackable, not yet backdoored)
//     and waiting for you to type `connect <host> ; backdoor`
//   - which servers already have a backdoor
//   - which servers you can't backdoor yet (no root, under-levelled,
//     need a port-opener program you don't have)
//
// On startup it prints the full status table. Then it polls every
// POLL_MS and only re-prints when state changes (a new server gets
// backdoored, or a new server becomes reachable), so a long-running
// monitor doesn't spam your terminal.
//
// Output defaults to QUIET — change prints are suppressed unless a
// new READY server appeared (the actionable event). Pass --verbose
// to see every state change. --once prints the full table once and
// exits, ignoring the quiet default (it's a diagnostic run).
//
// Usage:
//   run monitor-backdoor.js                       # one full table on startup, then poll, QUIET (default)
//   run monitor-backdoor.js --once                # print once, exit (full output)
//   run monitor-backdoor.js --include-backdoored  # also list backdoored servers in the table
//   run monitor-backdoor.js --no-path             # suppress the home→host path block (off by default)
//   run monitor-backdoor.js --verbose             # re-enable all state-change prints (default is quiet)
//
const USAGE = `Usage:
 run monitor-backdoor.js                       # one full table on startup, then poll, QUIET (default)
 run monitor-backdoor.js --once                # print once and exit (full output)
 run monitor-backdoor.js --include-backdoored  # also list backdoored servers in the table
 run monitor-backdoor.js --no-path             # suppress the home→host path block (off by default)
 run monitor-backdoor.js --verbose             # re-enable all state-change prints (default is quiet)
`;
// Bitburner requires you to walk the path one hop at a time. The READY
// line includes the `connect <a>; connect <b>; ...; backdoor` chain
// you can copy-paste directly into the terminal.
//
// Faction-relevant servers (in roughly unlock order):
//   CSEC, avmnite-04, I.I.I.I, runtheNET, The-Cave, foodnstuff,
//   sigma-cosmetics, joesguns, hong-fang-tea, max-hardware, n00dles,
//   phantasy. The "eligible" section of the table will be the actionable
//   list — those are the ones to connect+backdoor in the terminal.
//
// Note: this script does NOT need to be running for backdoors to work.
// It's purely a "what's the state of my network" panel. Idempotent.
//

const POLL_MS = 30_000;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  ns.disableLog("sleep");
  ns.disableLog("scan");
  ns.disableLog("getServer");

  const args = (ns.args || []).map(String);
  const once = args.includes("--once");
  const includeBackdoored = args.includes("--include-backdoored");
  // Default ON: show the home→host path + copy-paste chain. Pass
  // --no-path to suppress (useful when running on a long-lived monitor
  // where every change would otherwise re-print a 6-line block per
  // server). This is the inverse of the old --show-path flag.
  const showPath = !args.includes("--no-path");
  // Default quiet: change prints only fire when a new READY server
  // appeared. --verbose opts back into all state-change prints. --once
  // always prints full (it's a diagnostic run).
  const verbose = args.includes("--verbose");

  // BFS the reachable network. We also build a `parent` map so we
  // can reconstruct the path from home to any host — useful for
  // printing the `connect <a>; connect <b>; ...` chain for a server
  // that's more than one hop from home.
  function bfsFromHome() {
    const seen = new Set(["home"]);
    const parent = new Map([["home", null]]);
    const queue = ["home"];
    while (queue.length > 0) {
      const h = queue.shift();
      for (const n of ns.scan(h)) {
        if (!seen.has(n)) {
          seen.add(n);
          parent.set(n, h);
          queue.push(n);
        }
      }
    }
    return { seen, parent };
  }

  // Reconstruct the path from home to `host` as an array, e.g.
  // ["home", "CSEC", "avmnite-04", "I.I.I.I", "max-hardware"].
  // Returns null if the host is unreachable.
  function pathTo(parent, host) {
    if (!parent.has(host)) return null;
    const path = [];
    let cur = host;
    while (cur !== null) {
      path.push(cur);
      cur = parent.get(cur);
    }
    return path.reverse();
  }

  // Format a connect chain as a copy-paste-able command body.
  // Path of length 1 (just `home` itself) returns "".
  // Path of length 2+ returns "connect a; connect b".
  // (We don't include `home;` because the terminal prompt already
  // shows `[home /]>` — the user pastes the whole one-liner under
  // the prompt and Bitburner executes it from the current shell.)
  function connectChain(path) {
    if (!path || path.length <= 1) return "";
    const hops = path.slice(1).map((h) => `connect ${h}`).join("; ");
    return hops;
  }

  // Get a per-server status line. Returns null if the server is
  // not interesting to display (e.g. home).
  function statusOf(host, me) {
    if (host === "home") return null;
    const s = ns.getServer(host);
    const reqHack = s.requiredHackingSkill ?? 0;
    const ports = s.numOpenPortsRequired ?? s.requiredOpenPorts ?? 0;
    const backdoored = s.backdoorInstalled === true;
    const rooted = s.hasAdminRights === true;
    const purchased = s.purchasedByPlayer === true;
    const minSec = s.minDifficulty ?? null;
    const maxMoney = s.moneyMax ?? 0;
    const hasMoney = maxMoney > 0;
    // Backdoor is only meaningful on faction-relevant servers:
    // rooted, hackable by us, with money OR is one of the named
    // faction-trigger servers. (Money-bearing is a decent heuristic —
    // CSEC, avmnite-04, runtheNET, I.I.I.I, The-Cave are all moneyMax=0
    // but those names will still surface as "eligible" because
    // we explicitly list them below.)
    const namedFactionHosts = new Set([
      "CSEC", "avmnite-04", "I.I.I.I", "runtheNET", "The-Cave",
      "The Black Hand", "NiteSec", "BitRunners",
    ]);
    const isFaction = namedFactionHosts.has(host);
    // Already backdoored.
    if (backdoored) {
      if (!includeBackdoored) return null;
      return `DONE         ${host}`;
    }
    // Player can't backdoor their own purchased servers.
    if (purchased) return null;
    // Must be rooted. Otherwise it has nothing to backdoor anyway.
    if (!rooted) {
      // If we COULD root it (hack sufficient, port opener sufficient),
      // surface as "blocked-root"; if not, "blocked-unkillable".
      if (reqHack > me) {
        return `BLOCK-hack   ${host}  (need hack ${reqHack}, have ${me})`;
      }
      if (ports > 0) {
        return `BLOCK-ports  ${host}  (need ${ports} port-opener, root this with nuke.js)`;
      }
      // Hackable + no ports needed but unrooted — odd, but possible.
      return `BLOCK-root   ${host}  (rooted=false; try re-running nuke.js)`;
    }
    // Out-of-level, rooted but can't be backdoored until level up.
    if (reqHack > me) {
      return `BLOCK-hack   ${host}  (rooted, need hack ${reqHack}, have ${me})`;
    }
    // Eligible! You can `connect <host>` and run `backdoor` in the
    // terminal. Note: faction hosts (CSEC etc.) have moneyMax=0,
    // which is why we explicitly treat them as eligible.
    if (!hasMoney && !isFaction) {
      // Not a money server and not a named faction host — probably
      // some no-cash server we don't care about.
      return `SKIP-nomoney ${host}  (no money, not a faction-trigger)`;
    }
    // Eligible! Return a structured marker so printTable can build
    // the line with the actual `connect <a>; connect <b>; ...` path
    // — Bitburner requires you to walk the path one hop at a time.
    return `READY        ${host}`;
  }

  // Print the full table once, with a counter summary.
  // `parent` is the BFS parent map, used to reconstruct the path
  // from home to each READY host. Without it, the user can't
  // connect to anything more than one hop from home.
  function printTable(reason, parent) {
    const me = ns.getPlayer().skills.hacking;
    const hosts = [...parent.keys()].filter((h) => h !== "home").sort();
    const lines = [];
    const counters = { READY: 0, DONE: 0 };
    for (const h of hosts) {
      const line = statusOf(h, me);
      if (!line) continue;
      const isReady = line.startsWith("READY");
      const isDone = line.startsWith("DONE");
      if (isReady) {
        counters.READY++;
        const path = pathTo(parent, h);
        const chain = connectChain(path);
        if (showPath) {
          // Show the path as a single-line arrow chain (readable,
          // copy-pasteable for the chat-prompt format), then the
          // actual terminal one-liner beneath it. The bitburner
          // terminal accepts `; `-chained commands separated by
          // spaces, so the user can copy-paste the second line
          // straight into the terminal.
          lines.push(`  READY        ${h}`);
          lines.push(`                  path: ${path.join(" → ")}`);
          lines.push(`                  [home /]> ${chain} ; backdoor`);
        } else {
          // Compact: include the chain as a comment so it's clear
          // these are sequential terminal commands, not chained.
          lines.push(`  READY        ${h}  →  connect <...>; backdoor (one per line, see default path block)`);
        }
      } else if (isDone) {
        counters.DONE++;
      }
    }
    // Header. We print the table even when empty so the user knows
    // the script is alive and there's nothing to backdoor.
    const header = reason ? `monitor-backdoor (${reason}):` : `monitor-backdoor:`;
    ns.tprint(header);
    if (lines.length === 0) {
      ns.tprint(`  (no READY servers; everything is backdoored, blocked, or out-of-level)`);
    } else {
      for (const l of lines) ns.tprint(l);
    }
    const summaryParts = [`READY=${counters.READY}`];
    if (includeBackdoored) summaryParts.push(`DONE=${counters.DONE}`);
    summaryParts.push(`scanned ${hosts.length + 1} hosts`);  // +1 for home
    ns.tprint(`  ${summaryParts.join(" ")}`);
    return lines;
  }

  // Poll loop: re-print the table only when something changes.
  // Change-detection needs the FULL status (including BLOCK- and
  // SKIP-), not just READY, because the most common state change is
  // BLOCK-hack → READY (player levels up and a server becomes
  // backdoorable) or READY → DONE (player just backdoored a server).
  // The print function still filters to READY-only output.
  //
  // In quiet mode (the default), we suppress the change print when
  // the new snapshot still has READY=0 — the "interesting" event is
  // a new backdoorable server appearing, not incidental BLOCK-hack
  // status-line churn. --verbose opts back into all state changes.
  function fullSnapshot() {
    const me = ns.getPlayer().skills.hacking;
    const { seen, parent } = bfsFromHome();
    const m = new Map();
    let readyCount = 0;
    for (const h of seen) {
      const l = statusOf(h, me);
      if (l) {
        m.set(h, l);
        if (l.startsWith("READY")) readyCount++;
      }
    }
    return { status: m, parent, readyCount };
  }

  // Initial table.
  let last = fullSnapshot();
  printTable("startup", last.parent);

  if (once) return;

  while (true) {
    await ns.sleep(POLL_MS);
    const next = fullSnapshot();
    let changed = next.status.size !== last.status.size;
    if (!changed) {
      for (const [h, l] of next.status) {
        if (last.status.get(h) !== l) { changed = true; break; }
      }
    }
    if (changed) {
      // In quiet mode, only re-print when the new snapshot has a
      // READY server. Otherwise the change is just incidental
      // BLOCK-hack churn that the user already knows about.
      if (verbose || next.readyCount > 0) {
        last = next;
        printTable("change", next.parent);
      } else {
        // Update last so we don't keep firing on the same no-op
        // change. Without this, every poll would re-detect the
        // churn and the gate would re-evaluate.
        last = next;
      }
    }
  }
}
