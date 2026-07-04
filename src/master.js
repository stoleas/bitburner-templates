/** @param {NS} ns */
//
// master.js — "I just augmented, get me back online" launcher.
//
// Starts (or restarts) every long-lived monitor this repo ships, plus
// monitor-deploy (the polling version of deploy.js) on a 30s cadence.
// Run it once after every Augmentation and your early-game automation
// is back in place without you having to remember the seven `run`
// commands or the per-script PIDs.
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
//   run master.js                          # default cadence for everything
//   run master.js --deploy-interval 60000  # override monitor-deploy cadence
//   run master.js --once                    # print status, don't (re)start anything
//
// Why a master and not just a static recipe in this README:
//   Bitburner loses all running scripts on Augmentation. The recipes
//   in BeginnersGuide.md are "after the aug, run these seven things"
//   but actually doing that without typos is annoying. master.js
//   encodes the recipe as code and adds the restart-on-collision
//   behavior that makes the post-aug ritual one command.
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
// network is healthy before deploy fans workers out):
//   monitor-backdoor.js   (30s, no args)
//   monitor-nuke.js       (60s, no args)
//   monitor-hacknet.js    (60s, no args)
//   monitor-buy.js        (30s, no args)
//   monitor-servers.js    (60s, no args)  — fills the pserv fleet in lockstep with wallet
//   manager.js            (60s, no args)  — HWGW orchestrator that USES the fleet
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
// NOTE: monitor-deploy.js is intentionally NOT in this list at
// mid-game scale. The per-server hack-loop.js fan-out that
// monitor-deploy.js drives was the right shape for early game
// (hack level <100, home RAM <256 GB) but is now actively HARMFUL
// at mid-game: hack-loop.js runs ON the target server and drains
// it on a continuous loop, so when manager.js fires a hw.js/weaken.js
// from a pserv the target's moneyAvailable is 0 (just drained) and
// the worker returns instantly with nothing to do. You see workers
// appear on pservs and disappear in 1-2 seconds — that's the symptom.
//
// To re-enable monitor-deploy.js for small-server-only fan-out
// (e.g. for the xp farm or non-batch targets), pass --target
// filter via deploy.js itself. For now, manager.js owns the
// whole rooted target set.
const USAGE = `Usage:
run master.js                          # start every long-lived monitor
run master.js --deploy-interval 60000  # override monitor-deploy poll cadence (ms)
run master.js --once                    # print current monitor status, don't (re)start
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

  // Parse --deploy-interval <ms>. We mutate the MONITORS row for
  // monitor-deploy.js in place so the rest of the function just
  // walks the table.
  const depIdx = ns.args.indexOf("--deploy-interval");
  if (depIdx >= 0) {
    const v = Number(ns.args[depIdx + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      ns.tprint(`master: --deploy-interval must be a positive number (got ${ns.args[depIdx + 1]})`);
      return;
    }
    // Replace the row. We keep the same shape ([name, default, args])
    // so the loop body doesn't need a special case for deploy.
    const row = MONITORS.find((r) => r[0] === "monitor-deploy.js");
    row[2] = ["--interval", String(v)];
  }
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
