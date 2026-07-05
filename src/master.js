/** @param {NS} ns */
//
// master.js — "I just augmented, get me back online" launcher.
//
// Starts (or restarts) every long-lived monitor this repo ships.
// Run it once after every Augmentation and your mid-game automation
// is back in place without you having to remember the per-script
// commands or PIDs.
//
// Idempotent: re-running is safe. If a monitor is already running, we
// kill the old instance and start a fresh one. This means you can run
// `run master.js` any time you tweak a monitor's args — the new copy
// takes over without leaving the old one zombie-allocating RAM.
//
// Output: a clean per-monitor status block (STARTED / RESTARTED /
// already-running / FAILED) and a one-line summary. The summary is
// what to scan when you come back from an aug and want to know
// "is everything up?".
//
// Usage:
//   run master.js                  # default cadence for everything
//   run master.js --once            # print status, don't (re)start anything
//
// Why a master and not just a static recipe in this README:
//   Bitburner loses all running scripts on Augmentation. The recipes
//   in BeginnersGuide.md are "after the aug, run these things" but
//   actually doing that without typos is annoying. master.js encodes
//   the recipe as code and adds the restart-on-collision behavior
//   that makes the post-aug ritual one command.
//
// Why we DON'T add stat-train / crime-loop / share here:
//   Those are personal-economy scripts, not monitors — they each
//   have a different lifecycle (stat-train is a one-shot per reset,
//   crime-loop is a player-driven loop). Adding them would either
//   spawn work the player didn't ask for or steal the player's
//   manual control of when those run. Keep this list to "the
//   background daemons that should be running 24/7".
//
// Files started (in this order — backdoor and nuke first so the
// network is healthy before manager.js starts running HWGW batches):
//   monitor-backdoor.js   (30s, no args)
//   monitor-nuke.js       (60s, no args)
//   monitor-hacknet.js    (60s, no args)
//   monitor-buy.js        (30s, no args)
//   monitor-servers.js    (60s, no args)  — fills the pserv fleet in lockstep with wallet
//                                            (1-to-3 Rule + $100B reserve floor, conservative spend)
//   manager.js            (60s, no args)  — HWGW orchestrator that USES the fleet (fleet-batcher:
//                                            spreads one job's threads across home + pservs +
//                                            rooted-worlds, no single-host fit required)
//
// monitor-servers.js was the largest source of wallet drain before
// the fleet-batcher integration. The conservative defaults
// (--rule 0.03, --reserve 100e9, one buy + one scale per pass)
// were added because the previous defaults (10% of wallet per
// purchase, no reserve floor, multi-server scale walks) drained
// $1.5B+ of wallet against an $8.7M income run. To re-enable
// 4 TB pservs (the previous "soft-cap" tier, costing ~$1.15T for
// 5 servers), pass `--tier soft-cap` explicitly. The 1 TB sweet
// spot is plenty for the fleet-batcher, which uses home + pservs
// + rooted world servers (CSEC, foodnstuff, etc.) as workers.
//
// NOTE: monitor-sync.js is intentionally NOT in this list. The 30s
// auto-loop that re-runs sync-all.js across the whole reachable
// network produces a wall of SKIP-no-root / SYNCED lines per tick,
// which drowns out manager.js's per-tick state transitions. Run
// `sync-all.js` manually after a filesync edit (`run sync-all.js`),
// or `run monitor-sync.js --once` for a one-shot with full output,
// when you actually need it. The filesync dev server (nginx in the
// podman container) is the real-time path for edits to home; the
// 30s re-run was a safety net for state drift and isn't worth
// the terminal noise while you're still tuning the orchestrator.
//
// NOTE: monitor-deploy.js (and deploy.js directly) is intentionally
// NOT in this list at mid-game scale. The per-server hack-loop.js
// fan-out was the right shape for early game (hack level <100,
// home RAM <256 GB) but is now actively HARMFUL at mid-game:
// hack-loop.js runs ON the target server and drains it on a
// continuous loop, so when manager.js fires a hw.js/weaken.js from
// a pserv the target's moneyAvailable is 0 (just drained) and the
// worker returns instantly with nothing to do. If you see
// `deploy.js: DEPLOYED ... hack-loop.js` in your terminal, that
// means a stale `deploy.js` process is still running from an
// earlier session — kill it with `kill <pid>` (find via `ps`).
//
// Belt-and-suspenders: even if a stale deploy.js / monitor-deploy.js
// process is somehow launched (manual `run`, leftover from a pre-
// master.js boot, etc.), the script itself refuses to deploy
// workers when manager.js is running on home, with a clear message
// pointing at --force to override. See src/deploy.js and
// src/monitor-deploy.js for the guard.
//
// To re-enable deploy.js for small-server-only fan-out (e.g. for
// the xp farm or non-batch targets), run it manually with a
// --target filter (and --force if manager.js is up). For now,
// manager.js owns the whole rooted target set and no other script
// should be deploying workers.
const USAGE = `Usage:
run master.js                  # start every long-lived monitor
run master.js --once            # print current monitor status, don't (re)start
`;

// Each entry: [script, default-interval-ms, extra-args...]
// The deploy interval is a flag because it's the most likely knob
// the player wants to tune (15s during a hack-fest, 60s when idle).
// Other monitors use their own hard-coded defaults — we don't surface
// them as flags because that would just bloat the usage line for no
// payoff; if you want a non-default for one, edit the table.
const MONITORS = [
  ["monitor-backdoor.js", 30_000, []],
  ["monitor-nuke.js",     60_000, []],
  ["monitor-hacknet.js",  60_000, []],
  ["monitor-buy.js",      30_000, []],
  ["monitor-servers.js",  60_000, []],
  ["manager.js",          60_000, []],
];

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  ns.disableLog("sleep");

  const once = ns.args.includes("--once");

  // Sanity check: every script must be on home before we try to
  // run it. Without this, a missing file would silently no-op via
  // ns.run() returning 0 and we'd print a confusing FAILED later
  // instead of a clear "file not on home" up front.
  const missing = MONITORS
    .filter(([script]) => !ns.fileExists(script, "home"))
    .map(([s]) => s);
  if (missing.length > 0) {
    ns.tprint(`master: missing on home (push via filesync first): ${missing.join(", ")}`);
    return;
  }

  // For each monitor: kill any existing instance, then start a fresh
  // one. We need to kill BEFORE start so a re-run while old monitors
  // are still alive doesn't double-allocate RAM.
  //
  // ns.ps("home") returns all processes. We match by script filename
  // (not PID — PIDs change every run).
  function restart(script, extraArgs) {
    const alive = ns.ps("home").filter((p) => p.filename === script);
    const wasRunning = alive.length > 0;
    for (const p of alive) ns.kill(p.pid);

    // ns.run returns 0 on failure (no RAM, missing file, etc.). We
    // surface that as FAILED in the status table.
    const pid = ns.run(script, 1, ...extraArgs);
    if (pid === 0) {
      return { script, status: "FAILED", pid: 0, wasRunning };
    }
    return {
      script,
      status: wasRunning ? "RESTARTED" : "STARTED",
      pid,
      wasRunning,
    };
  }

  if (once) {
    // Diagnostic mode: don't (re)start anything, just show what's
    // currently running on home. Useful for "did the previous
    // master.js call actually take?" debugging.
    ns.tprint("master: status snapshot (no (re)start):");
    for (const [script] of MONITORS) {
      const alive = ns.ps("home").filter((p) => p.filename === script);
      if (alive.length === 0) {
        ns.tprint(`  ${script.padEnd(22)}  not running`);
      } else {
        for (const p of alive) {
          ns.tprint(`  ${script.padEnd(22)}  running  pid=${p.pid}  args=[${p.args.join(" ") || ""}]`);
        }
      }
    }
    return;
  }

  const results = [];
  for (const [script, _defaultMs, extraArgs] of MONITORS) {
    results.push(restart(script, extraArgs));
  }

  // Status table.
  ns.tprint("master: (re)started monitors —");
  for (const r of results) {
    const tag = `${r.status.padEnd(9)} ${r.script.padEnd(22)} pid=${r.pid}`;
    if (r.status === "FAILED") {
      ns.tprint(`  FAIL  ${r.script}  (ns.run returned 0 — out of home RAM?)`);
    } else if (r.wasRunning) {
      ns.tprint(`  ${tag}  (replaced previous instance)`);
    } else {
      ns.tprint(`  ${tag}`);
    }
  }

  // One-line summary — the thing to scan after an aug.
  const ok = results.filter((r) => r.status !== "FAILED").length;
  const fail = results.length - ok;
  const started = results.filter((r) => r.status === "STARTED").length;
  const restarted = results.filter((r) => r.status === "RESTARTED").length;
  ns.tprint(
    `master: done — ${ok}/${results.length} ok ` +
    `(started=${started} restarted=${restarted} failed=${fail})`
  );

  // If everything failed, it's almost always a home-RAM issue.
  // Print a one-liner hint so the user knows where to look.
  if (ok === 0) {
    ns.tprint(`master: hint — check home RAM with 'mem' in the terminal`);
  }
}
