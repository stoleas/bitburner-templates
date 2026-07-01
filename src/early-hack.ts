import { NS } from "@ns";

/**
 * Early-game hack loop with automatic target discovery.
 *
 * On startup and every RESCAN_INTERVAL_MS, the script BFS-scans the
 * network from `home` and picks every server that is:
 *   - rooted (ns.hasRootAccess)
 *   - not player-owned (purchasedByPlayer === false)
 *   - has money to steal (moneyMax > 0)
 *   - within your hacking level
 *
 * Each target is then prepped with `weaken` / `grow` and hacked, the same
 * way the explicit-args version works.
 *
 * Usage:
 *   run early-hack.js                       # auto-discover all targets
 *   run early-hack.js foodnstuff            # pin to one target (parallel-safe)
 *
 * The script runs H/G/W in series (one op at a time, awaited). To scale
 * out, run multiple instances against different targets, e.g.:
 *   run early-hack.js n00dles
 *   run early-hack.js foodnstuff
 *   run early-hack.js sigma-cosmetics
 * Each instance has its own runtime mutex, so they run in parallel
 * without violating the "no concurrent calls" rule.
 *
 * Workflow:
 *   1. run nuke.js                       # root everything reachable
 *   2. run early-hack.js foodnstuff      # one instance per target
 *
 * When `nuke.js` roots a new server, the auto-discover mode picks it
 * up on the next rescan (~30 s by default) without needing a restart.
 *
 * RAM cost: ~2.0 GB. The extra cost vs. the args version comes from
 * BFS traversal + the per-target Server objects held in memory.
 */

const RESCAN_INTERVAL_MS = 30_000;
const STATUS_INTERVAL_MS = 1_000;
const SECURITY_SLACK = 0.5;
const MONEY_THRESHOLD = 0.75;

/** BFS the network from `start`, returning every reachable hostname. */
function enumerateNetwork(ns: NS, start: string): string[] {
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const host = queue.shift()!;
    for (const neighbor of ns.scan(host)) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return [...seen];
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("sleep");
  ns.disableLog("scan");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("getServerSecurityLevel");
  ns.disableLog("getServerMaxMoney");
  ns.disableLog("getServerMinSecurityLevel");
  ns.disableLog("getServerRequiredHackingLevel");
  ns.disableLog("getServer");
  ns.disableLog("hack");
  ns.disableLog("grow");
  ns.disableLog("weaken");

  const myLevel = ns.getPlayer().skills.hacking;
  let lastRescan = 0;
  let lastStatus = 0;
  let targets: string[] = [];
  const lastOp = new Map<string, string>();

  // Build the target list from the live network. We keep this idempotent
  // so a re-scan that finds the same set does no work.
  function discover(): string[] {
    const hosts = enumerateNetwork(ns, "home");
    const out: string[] = [];
    for (const host of hosts) {
      if (host === "home") continue;
      const s = ns.getServer(host);
      if (!s.hasAdminRights) continue;        // not rooted
      if (s.purchasedByPlayer) continue;       // your own purchased server
      if (!s.moneyMax || s.moneyMax <= 0) continue;  // not a money-bearing server
      const req = s.requiredHackingSkill ?? 0;
      if (req > myLevel) continue;             // can't hack yet
      out.push(host);
    }
    // Stable order: by required hacking skill ascending, then name. This
    // keeps the easy money first and the status line stable.
    out.sort((a, b) => {
      const ra = ns.getServerRequiredHackingLevel(a);
      const rb = ns.getServerRequiredHackingLevel(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
    return out;
  }

  while (true) {
    const now = Date.now();

    // Re-scan periodically (and once on startup, when lastRescan === 0).
    if (now - lastRescan >= RESCAN_INTERVAL_MS) {
      const next = discover();
      // Drop cached lastOp entries for targets that disappeared.
      const nextSet = new Set(next);
      for (const k of lastOp.keys()) {
        if (!nextSet.has(k)) lastOp.delete(k);
      }
      // First-time notice when the set changes.
      if (next.length !== targets.length ||
          next.some((t, i) => t !== targets[i])) {
        ns.tprint(`targets (${next.length}): ${next.join(", ")}`);
        targets = next;
      }
      lastRescan = now;
    }

    // Run one H/G/W op per target per loop pass, in series.
    //
    // IMPORTANT: Bitburner's NS runtime serializes NS calls per script. The
    // earlier "Promise.all" version still triggered "Concurrent calls"
    // errors because the runtime's mutex extends across all NS calls
    // (including getServerX), and a second call dispatched before the
    // first one's promise truly resolves will throw. To stay safe we
    // await each op in turn. The game itself still processes the op on
    // the target server in its own time — only the *script's local
    // dispatch loop* is serial.
    //
    // For true cross-target parallelism in the future, the right pattern
    // is to spawn one script instance per target via ns.exec, not to fan
    // out from a single orchestrator. (See README for that follow-up.)
    for (const target of targets) {
      const sec = ns.getServerSecurityLevel(target);
      const minSec = ns.getServerMinSecurityLevel(target);
      let op: "weaken" | "grow" | "hack";
      if (sec > minSec + SECURITY_SLACK) op = "weaken";
      else {
        const money = ns.getServerMoneyAvailable(target);
        const max = ns.getServerMaxMoney(target);
        if (money < max * MONEY_THRESHOLD) op = "grow";
        else op = "hack";
      }
      lastOp.set(target, op);
      if (op === "weaken")      await ns.weaken(target);
      else if (op === "grow")   await ns.grow(target);
      else                      await ns.hack(target);
    }

    // One consolidated status line per second.
    if (now - lastStatus >= STATUS_INTERVAL_MS) {
      const parts = targets.map((t) => {
        const money = ns.getServerMoneyAvailable(t);
        const max = ns.getServerMaxMoney(t);
        const op = lastOp.get(t) ?? "—";
        return `${t}: money=${money.toFixed(0)}/${max} op=${op}`;
      });
      ns.print(parts.length > 0 ? parts.join(" | ") : "no targets");
      lastStatus = now;
    }

    await ns.sleep(50);
  }
}
