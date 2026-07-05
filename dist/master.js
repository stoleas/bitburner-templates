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
    ["monitor-nuke.js", 60_000, []],
    ["monitor-hacknet.js", 60_000, []],
    ["monitor-buy.js", 30_000, []],
    ["monitor-servers.js", 60_000, []],
    ["manager.js", 60_000, []],
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
        for (const p of alive)
            ns.kill(p.pid);
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
            }
            else {
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
        }
        else if (r.wasRunning) {
            ns.tprint(`  ${tag}  (replaced previous instance)`);
        }
        else {
            ns.tprint(`  ${tag}`);
        }
    }
    // One-line summary — the thing to scan after an aug.
    const ok = results.filter((r) => r.status !== "FAILED").length;
    const fail = results.length - ok;
    const started = results.filter((r) => r.status === "STARTED").length;
    const restarted = results.filter((r) => r.status === "RESTARTED").length;
    ns.tprint(`master: done — ${ok}/${results.length} ok ` +
        `(started=${started} restarted=${restarted} failed=${fail})`);
    // If everything failed, it's almost always a home-RAM issue.
    // Print a one-liner hint so the user knows where to look.
    if (ok === 0) {
        ns.tprint(`master: hint — check home RAM with 'mem' in the terminal`);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFzdGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21hc3Rlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLCtEQUErRDtBQUMvRCxFQUFFO0FBQ0YsaUVBQWlFO0FBQ2pFLG9FQUFvRTtBQUNwRSxpRUFBaUU7QUFDakUsb0JBQW9CO0FBQ3BCLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUsc0VBQXNFO0FBQ3RFLHFFQUFxRTtBQUNyRSxnRUFBZ0U7QUFDaEUsRUFBRTtBQUNGLGtFQUFrRTtBQUNsRSxtRUFBbUU7QUFDbkUsK0RBQStEO0FBQy9ELHVCQUF1QjtBQUN2QixFQUFFO0FBQ0YsU0FBUztBQUNULG9FQUFvRTtBQUNwRSw2RUFBNkU7QUFDN0UsRUFBRTtBQUNGLDREQUE0RDtBQUM1RCxxRUFBcUU7QUFDckUsbUVBQW1FO0FBQ25FLHFFQUFxRTtBQUNyRSxrRUFBa0U7QUFDbEUsZ0RBQWdEO0FBQ2hELEVBQUU7QUFDRix5REFBeUQ7QUFDekQsaUVBQWlFO0FBQ2pFLG9FQUFvRTtBQUNwRSxrRUFBa0U7QUFDbEUsK0RBQStEO0FBQy9ELDZEQUE2RDtBQUM3RCxxREFBcUQ7QUFDckQsRUFBRTtBQUNGLGdFQUFnRTtBQUNoRSxxRUFBcUU7QUFDckUseUNBQXlDO0FBQ3pDLHlDQUF5QztBQUN6Qyx5Q0FBeUM7QUFDekMseUNBQXlDO0FBQ3pDLDBGQUEwRjtBQUMxRixxR0FBcUc7QUFDckcsa0dBQWtHO0FBQ2xHLDhGQUE4RjtBQUM5Rix5RkFBeUY7QUFDekYsRUFBRTtBQUNGLG1FQUFtRTtBQUNuRSwyREFBMkQ7QUFDM0QsK0RBQStEO0FBQy9ELDhEQUE4RDtBQUM5RCxnRUFBZ0U7QUFDaEUsNkRBQTZEO0FBQzdELGlFQUFpRTtBQUNqRSxnRUFBZ0U7QUFDaEUsaUVBQWlFO0FBQ2pFLDhEQUE4RDtBQUM5RCxFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLGdFQUFnRTtBQUNoRSxtRUFBbUU7QUFDbkUsZ0VBQWdFO0FBQ2hFLG9FQUFvRTtBQUNwRSxtRUFBbUU7QUFDbkUsbUVBQW1FO0FBQ25FLGlFQUFpRTtBQUNqRSw4REFBOEQ7QUFDOUQsaUVBQWlFO0FBQ2pFLEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsa0VBQWtFO0FBQ2xFLCtEQUErRDtBQUMvRCw2REFBNkQ7QUFDN0QsNERBQTREO0FBQzVELG1FQUFtRTtBQUNuRSxrRUFBa0U7QUFDbEUsMERBQTBEO0FBQzFELGdFQUFnRTtBQUNoRSw2REFBNkQ7QUFDN0QsK0RBQStEO0FBQy9ELEVBQUU7QUFDRixxRUFBcUU7QUFDckUsa0VBQWtFO0FBQ2xFLDZEQUE2RDtBQUM3RCxtRUFBbUU7QUFDbkUseURBQXlEO0FBQ3pELHVDQUF1QztBQUN2QyxFQUFFO0FBQ0YsaUVBQWlFO0FBQ2pFLDREQUE0RDtBQUM1RCw4REFBOEQ7QUFDOUQsa0VBQWtFO0FBQ2xFLCtCQUErQjtBQUMvQixNQUFNLEtBQUssR0FBRzs7O0NBR2IsQ0FBQztBQUVGLDJEQUEyRDtBQUMzRCxrRUFBa0U7QUFDbEUsb0VBQW9FO0FBQ3BFLHNFQUFzRTtBQUN0RSxvRUFBb0U7QUFDcEUsNkRBQTZEO0FBQzdELE1BQU0sUUFBUSxHQUFHO0lBQ2YsQ0FBQyxxQkFBcUIsRUFBRSxNQUFNLEVBQUUsRUFBRSxDQUFDO0lBQ25DLENBQUMsaUJBQWlCLEVBQU0sTUFBTSxFQUFFLEVBQUUsQ0FBQztJQUNuQyxDQUFDLG9CQUFvQixFQUFHLE1BQU0sRUFBRSxFQUFFLENBQUM7SUFDbkMsQ0FBQyxnQkFBZ0IsRUFBTyxNQUFNLEVBQUUsRUFBRSxDQUFDO0lBQ25DLENBQUMsb0JBQW9CLEVBQUcsTUFBTSxFQUFFLEVBQUUsQ0FBQztJQUNuQyxDQUFDLFlBQVksRUFBVyxNQUFNLEVBQUUsRUFBRSxDQUFDO0NBQ3BDLENBQUM7QUFFRixNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDeEQsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQixPQUFPO0tBQ1I7SUFDRCxFQUFFLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBRXZCLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBRXhDLDhEQUE4RDtJQUM5RCxnRUFBZ0U7SUFDaEUsK0RBQStEO0lBQy9ELGtEQUFrRDtJQUNsRCxNQUFNLE9BQU8sR0FBRyxRQUFRO1NBQ3JCLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUM7U0FDcEQsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDbkIsSUFBSSxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtRQUN0QixFQUFFLENBQUMsTUFBTSxDQUFDLHNEQUFzRCxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUN0RixPQUFPO0tBQ1I7SUFFRCxtRUFBbUU7SUFDbkUsbUVBQW1FO0lBQ25FLCtDQUErQztJQUMvQyxFQUFFO0lBQ0YsbUVBQW1FO0lBQ25FLHFDQUFxQztJQUNyQyxTQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUztRQUNoQyxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztRQUNqRSxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztRQUNwQyxLQUFLLE1BQU0sQ0FBQyxJQUFJLEtBQUs7WUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUV0QywrREFBK0Q7UUFDL0QsOENBQThDO1FBQzlDLE1BQU0sR0FBRyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxHQUFHLFNBQVMsQ0FBQyxDQUFDO1FBQzVDLElBQUksR0FBRyxLQUFLLENBQUMsRUFBRTtZQUNiLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLFVBQVUsRUFBRSxDQUFDO1NBQ3pEO1FBQ0QsT0FBTztZQUNMLE1BQU07WUFDTixNQUFNLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFNBQVM7WUFDNUMsR0FBRztZQUNILFVBQVU7U0FDWCxDQUFDO0lBQ0osQ0FBQztJQUVELElBQUksSUFBSSxFQUFFO1FBQ1IsOERBQThEO1FBQzlELDBEQUEwRDtRQUMxRCw0Q0FBNEM7UUFDNUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyx5Q0FBeUMsQ0FBQyxDQUFDO1FBQ3JELEtBQUssTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLFFBQVEsRUFBRTtZQUMvQixNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztZQUNqRSxJQUFJLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO2dCQUN0QixFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsZUFBZSxDQUFDLENBQUM7YUFDbEQ7aUJBQU07Z0JBQ0wsS0FBSyxNQUFNLENBQUMsSUFBSSxLQUFLLEVBQUU7b0JBQ3JCLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLEdBQUcsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO2lCQUM5RjthQUNGO1NBQ0Y7UUFDRCxPQUFPO0tBQ1I7SUFFRCxNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUM7SUFDbkIsS0FBSyxNQUFNLENBQUMsTUFBTSxFQUFFLFVBQVUsRUFBRSxTQUFTLENBQUMsSUFBSSxRQUFRLEVBQUU7UUFDdEQsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7S0FDMUM7SUFFRCxnQkFBZ0I7SUFDaEIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxnQ0FBZ0MsQ0FBQyxDQUFDO0lBQzVDLEtBQUssTUFBTSxDQUFDLElBQUksT0FBTyxFQUFFO1FBQ3ZCLE1BQU0sR0FBRyxHQUFHLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ3hFLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxRQUFRLEVBQUU7WUFDekIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQyxNQUFNLDBDQUEwQyxDQUFDLENBQUM7U0FDMUU7YUFBTSxJQUFJLENBQUMsQ0FBQyxVQUFVLEVBQUU7WUFDdkIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEdBQUcsZ0NBQWdDLENBQUMsQ0FBQztTQUNyRDthQUFNO1lBQ0wsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEdBQUcsRUFBRSxDQUFDLENBQUM7U0FDdkI7S0FDRjtJQUVELHFEQUFxRDtJQUNyRCxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUMvRCxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUNyRSxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLFdBQVcsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUN6RSxFQUFFLENBQUMsTUFBTSxDQUNQLGtCQUFrQixFQUFFLElBQUksT0FBTyxDQUFDLE1BQU0sTUFBTTtRQUM1QyxZQUFZLE9BQU8sY0FBYyxTQUFTLFdBQVcsSUFBSSxHQUFHLENBQzdELENBQUM7SUFFRiw2REFBNkQ7SUFDN0QsMERBQTBEO0lBQzFELElBQUksRUFBRSxLQUFLLENBQUMsRUFBRTtRQUNaLEVBQUUsQ0FBQyxNQUFNLENBQUMsMERBQTBELENBQUMsQ0FBQztLQUN2RTtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyBtYXN0ZXIuanMg4oCUIFwiSSBqdXN0IGF1Z21lbnRlZCwgZ2V0IG1lIGJhY2sgb25saW5lXCIgbGF1bmNoZXIuXG4vL1xuLy8gU3RhcnRzIChvciByZXN0YXJ0cykgZXZlcnkgbG9uZy1saXZlZCBtb25pdG9yIHRoaXMgcmVwbyBzaGlwcy5cbi8vIFJ1biBpdCBvbmNlIGFmdGVyIGV2ZXJ5IEF1Z21lbnRhdGlvbiBhbmQgeW91ciBtaWQtZ2FtZSBhdXRvbWF0aW9uXG4vLyBpcyBiYWNrIGluIHBsYWNlIHdpdGhvdXQgeW91IGhhdmluZyB0byByZW1lbWJlciB0aGUgcGVyLXNjcmlwdFxuLy8gY29tbWFuZHMgb3IgUElEcy5cbi8vXG4vLyBJZGVtcG90ZW50OiByZS1ydW5uaW5nIGlzIHNhZmUuIElmIGEgbW9uaXRvciBpcyBhbHJlYWR5IHJ1bm5pbmcsIHdlXG4vLyBraWxsIHRoZSBvbGQgaW5zdGFuY2UgYW5kIHN0YXJ0IGEgZnJlc2ggb25lLiBUaGlzIG1lYW5zIHlvdSBjYW4gcnVuXG4vLyBgcnVuIG1hc3Rlci5qc2AgYW55IHRpbWUgeW91IHR3ZWFrIGEgbW9uaXRvcidzIGFyZ3Mg4oCUIHRoZSBuZXcgY29weVxuLy8gdGFrZXMgb3ZlciB3aXRob3V0IGxlYXZpbmcgdGhlIG9sZCBvbmUgem9tYmllLWFsbG9jYXRpbmcgUkFNLlxuLy9cbi8vIE91dHB1dDogYSBjbGVhbiBwZXItbW9uaXRvciBzdGF0dXMgYmxvY2sgKFNUQVJURUQgLyBSRVNUQVJURUQgL1xuLy8gYWxyZWFkeS1ydW5uaW5nIC8gRkFJTEVEKSBhbmQgYSBvbmUtbGluZSBzdW1tYXJ5LiBUaGUgc3VtbWFyeSBpc1xuLy8gd2hhdCB0byBzY2FuIHdoZW4geW91IGNvbWUgYmFjayBmcm9tIGFuIGF1ZyBhbmQgd2FudCB0byBrbm93XG4vLyBcImlzIGV2ZXJ5dGhpbmcgdXA/XCIuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBtYXN0ZXIuanMgICAgICAgICAgICAgICAgICAjIGRlZmF1bHQgY2FkZW5jZSBmb3IgZXZlcnl0aGluZ1xuLy8gICBydW4gbWFzdGVyLmpzIC0tb25jZSAgICAgICAgICAgICMgcHJpbnQgc3RhdHVzLCBkb24ndCAocmUpc3RhcnQgYW55dGhpbmdcbi8vXG4vLyBXaHkgYSBtYXN0ZXIgYW5kIG5vdCBqdXN0IGEgc3RhdGljIHJlY2lwZSBpbiB0aGlzIFJFQURNRTpcbi8vICAgQml0YnVybmVyIGxvc2VzIGFsbCBydW5uaW5nIHNjcmlwdHMgb24gQXVnbWVudGF0aW9uLiBUaGUgcmVjaXBlc1xuLy8gICBpbiBCZWdpbm5lcnNHdWlkZS5tZCBhcmUgXCJhZnRlciB0aGUgYXVnLCBydW4gdGhlc2UgdGhpbmdzXCIgYnV0XG4vLyAgIGFjdHVhbGx5IGRvaW5nIHRoYXQgd2l0aG91dCB0eXBvcyBpcyBhbm5veWluZy4gbWFzdGVyLmpzIGVuY29kZXNcbi8vICAgdGhlIHJlY2lwZSBhcyBjb2RlIGFuZCBhZGRzIHRoZSByZXN0YXJ0LW9uLWNvbGxpc2lvbiBiZWhhdmlvclxuLy8gICB0aGF0IG1ha2VzIHRoZSBwb3N0LWF1ZyByaXR1YWwgb25lIGNvbW1hbmQuXG4vL1xuLy8gV2h5IHdlIERPTidUIGFkZCBzdGF0LXRyYWluIC8gY3JpbWUtbG9vcCAvIHNoYXJlIGhlcmU6XG4vLyAgIFRob3NlIGFyZSBwZXJzb25hbC1lY29ub215IHNjcmlwdHMsIG5vdCBtb25pdG9ycyDigJQgdGhleSBlYWNoXG4vLyAgIGhhdmUgYSBkaWZmZXJlbnQgbGlmZWN5Y2xlIChzdGF0LXRyYWluIGlzIGEgb25lLXNob3QgcGVyIHJlc2V0LFxuLy8gICBjcmltZS1sb29wIGlzIGEgcGxheWVyLWRyaXZlbiBsb29wKS4gQWRkaW5nIHRoZW0gd291bGQgZWl0aGVyXG4vLyAgIHNwYXduIHdvcmsgdGhlIHBsYXllciBkaWRuJ3QgYXNrIGZvciBvciBzdGVhbCB0aGUgcGxheWVyJ3Ncbi8vICAgbWFudWFsIGNvbnRyb2wgb2Ygd2hlbiB0aG9zZSBydW4uIEtlZXAgdGhpcyBsaXN0IHRvIFwidGhlXG4vLyAgIGJhY2tncm91bmQgZGFlbW9ucyB0aGF0IHNob3VsZCBiZSBydW5uaW5nIDI0LzdcIi5cbi8vXG4vLyBGaWxlcyBzdGFydGVkIChpbiB0aGlzIG9yZGVyIOKAlCBiYWNrZG9vciBhbmQgbnVrZSBmaXJzdCBzbyB0aGVcbi8vIG5ldHdvcmsgaXMgaGVhbHRoeSBiZWZvcmUgbWFuYWdlci5qcyBzdGFydHMgcnVubmluZyBIV0dXIGJhdGNoZXMpOlxuLy8gICBtb25pdG9yLWJhY2tkb29yLmpzICAgKDMwcywgbm8gYXJncylcbi8vICAgbW9uaXRvci1udWtlLmpzICAgICAgICg2MHMsIG5vIGFyZ3MpXG4vLyAgIG1vbml0b3ItaGFja25ldC5qcyAgICAoNjBzLCBubyBhcmdzKVxuLy8gICBtb25pdG9yLWJ1eS5qcyAgICAgICAgKDMwcywgbm8gYXJncylcbi8vICAgbW9uaXRvci1zZXJ2ZXJzLmpzICAgICg2MHMsIG5vIGFyZ3MpICDigJQgZmlsbHMgdGhlIHBzZXJ2IGZsZWV0IGluIGxvY2tzdGVwIHdpdGggd2FsbGV0XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKDEtdG8tMyBSdWxlICsgJDEwMEIgcmVzZXJ2ZSBmbG9vciwgY29uc2VydmF0aXZlIHNwZW5kKVxuLy8gICBtYW5hZ2VyLmpzICAgICAgICAgICAgKDYwcywgbm8gYXJncykgIOKAlCBIV0dXIG9yY2hlc3RyYXRvciB0aGF0IFVTRVMgdGhlIGZsZWV0IChmbGVldC1iYXRjaGVyOlxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwcmVhZHMgb25lIGpvYidzIHRocmVhZHMgYWNyb3NzIGhvbWUgKyBwc2VydnMgK1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJvb3RlZC13b3JsZHMsIG5vIHNpbmdsZS1ob3N0IGZpdCByZXF1aXJlZClcbi8vXG4vLyBtb25pdG9yLXNlcnZlcnMuanMgd2FzIHRoZSBsYXJnZXN0IHNvdXJjZSBvZiB3YWxsZXQgZHJhaW4gYmVmb3JlXG4vLyB0aGUgZmxlZXQtYmF0Y2hlciBpbnRlZ3JhdGlvbi4gVGhlIGNvbnNlcnZhdGl2ZSBkZWZhdWx0c1xuLy8gKC0tcnVsZSAwLjAzLCAtLXJlc2VydmUgMTAwZTksIG9uZSBidXkgKyBvbmUgc2NhbGUgcGVyIHBhc3MpXG4vLyB3ZXJlIGFkZGVkIGJlY2F1c2UgdGhlIHByZXZpb3VzIGRlZmF1bHRzICgxMCUgb2Ygd2FsbGV0IHBlclxuLy8gcHVyY2hhc2UsIG5vIHJlc2VydmUgZmxvb3IsIG11bHRpLXNlcnZlciBzY2FsZSB3YWxrcykgZHJhaW5lZFxuLy8gJDEuNUIrIG9mIHdhbGxldCBhZ2FpbnN0IGFuICQ4LjdNIGluY29tZSBydW4uIFRvIHJlLWVuYWJsZVxuLy8gNCBUQiBwc2VydnMgKHRoZSBwcmV2aW91cyBcInNvZnQtY2FwXCIgdGllciwgY29zdGluZyB+JDEuMTVUIGZvclxuLy8gNSBzZXJ2ZXJzKSwgcGFzcyBgLS10aWVyIHNvZnQtY2FwYCBleHBsaWNpdGx5LiBUaGUgMSBUQiBzd2VldFxuLy8gc3BvdCBpcyBwbGVudHkgZm9yIHRoZSBmbGVldC1iYXRjaGVyLCB3aGljaCB1c2VzIGhvbWUgKyBwc2VydnNcbi8vICsgcm9vdGVkIHdvcmxkIHNlcnZlcnMgKENTRUMsIGZvb2Ruc3R1ZmYsIGV0Yy4pIGFzIHdvcmtlcnMuXG4vL1xuLy8gTk9URTogbW9uaXRvci1zeW5jLmpzIGlzIGludGVudGlvbmFsbHkgTk9UIGluIHRoaXMgbGlzdC4gVGhlIDMwc1xuLy8gYXV0by1sb29wIHRoYXQgcmUtcnVucyBzeW5jLWFsbC5qcyBhY3Jvc3MgdGhlIHdob2xlIHJlYWNoYWJsZVxuLy8gbmV0d29yayBwcm9kdWNlcyBhIHdhbGwgb2YgU0tJUC1uby1yb290IC8gU1lOQ0VEIGxpbmVzIHBlciB0aWNrLFxuLy8gd2hpY2ggZHJvd25zIG91dCBtYW5hZ2VyLmpzJ3MgcGVyLXRpY2sgc3RhdGUgdHJhbnNpdGlvbnMuIFJ1blxuLy8gYHN5bmMtYWxsLmpzYCBtYW51YWxseSBhZnRlciBhIGZpbGVzeW5jIGVkaXQgKGBydW4gc3luYy1hbGwuanNgKSxcbi8vIG9yIGBydW4gbW9uaXRvci1zeW5jLmpzIC0tb25jZWAgZm9yIGEgb25lLXNob3Qgd2l0aCBmdWxsIG91dHB1dCxcbi8vIHdoZW4geW91IGFjdHVhbGx5IG5lZWQgaXQuIFRoZSBmaWxlc3luYyBkZXYgc2VydmVyIChuZ2lueCBpbiB0aGVcbi8vIHBvZG1hbiBjb250YWluZXIpIGlzIHRoZSByZWFsLXRpbWUgcGF0aCBmb3IgZWRpdHMgdG8gaG9tZTsgdGhlXG4vLyAzMHMgcmUtcnVuIHdhcyBhIHNhZmV0eSBuZXQgZm9yIHN0YXRlIGRyaWZ0IGFuZCBpc24ndCB3b3J0aFxuLy8gdGhlIHRlcm1pbmFsIG5vaXNlIHdoaWxlIHlvdSdyZSBzdGlsbCB0dW5pbmcgdGhlIG9yY2hlc3RyYXRvci5cbi8vXG4vLyBOT1RFOiBtb25pdG9yLWRlcGxveS5qcyAoYW5kIGRlcGxveS5qcyBkaXJlY3RseSkgaXMgaW50ZW50aW9uYWxseVxuLy8gTk9UIGluIHRoaXMgbGlzdCBhdCBtaWQtZ2FtZSBzY2FsZS4gVGhlIHBlci1zZXJ2ZXIgaGFjay1sb29wLmpzXG4vLyBmYW4tb3V0IHdhcyB0aGUgcmlnaHQgc2hhcGUgZm9yIGVhcmx5IGdhbWUgKGhhY2sgbGV2ZWwgPDEwMCxcbi8vIGhvbWUgUkFNIDwyNTYgR0IpIGJ1dCBpcyBub3cgYWN0aXZlbHkgSEFSTUZVTCBhdCBtaWQtZ2FtZTpcbi8vIGhhY2stbG9vcC5qcyBydW5zIE9OIHRoZSB0YXJnZXQgc2VydmVyIGFuZCBkcmFpbnMgaXQgb24gYVxuLy8gY29udGludW91cyBsb29wLCBzbyB3aGVuIG1hbmFnZXIuanMgZmlyZXMgYSBody5qcy93ZWFrZW4uanMgZnJvbVxuLy8gYSBwc2VydiB0aGUgdGFyZ2V0J3MgbW9uZXlBdmFpbGFibGUgaXMgMCAoanVzdCBkcmFpbmVkKSBhbmQgdGhlXG4vLyB3b3JrZXIgcmV0dXJucyBpbnN0YW50bHkgd2l0aCBub3RoaW5nIHRvIGRvLiBJZiB5b3Ugc2VlXG4vLyBgZGVwbG95LmpzOiBERVBMT1lFRCAuLi4gaGFjay1sb29wLmpzYCBpbiB5b3VyIHRlcm1pbmFsLCB0aGF0XG4vLyBtZWFucyBhIHN0YWxlIGBkZXBsb3kuanNgIHByb2Nlc3MgaXMgc3RpbGwgcnVubmluZyBmcm9tIGFuXG4vLyBlYXJsaWVyIHNlc3Npb24g4oCUIGtpbGwgaXQgd2l0aCBga2lsbCA8cGlkPmAgKGZpbmQgdmlhIGBwc2ApLlxuLy9cbi8vIEJlbHQtYW5kLXN1c3BlbmRlcnM6IGV2ZW4gaWYgYSBzdGFsZSBkZXBsb3kuanMgLyBtb25pdG9yLWRlcGxveS5qc1xuLy8gcHJvY2VzcyBpcyBzb21laG93IGxhdW5jaGVkIChtYW51YWwgYHJ1bmAsIGxlZnRvdmVyIGZyb20gYSBwcmUtXG4vLyBtYXN0ZXIuanMgYm9vdCwgZXRjLiksIHRoZSBzY3JpcHQgaXRzZWxmIHJlZnVzZXMgdG8gZGVwbG95XG4vLyB3b3JrZXJzIHdoZW4gbWFuYWdlci5qcyBpcyBydW5uaW5nIG9uIGhvbWUsIHdpdGggYSBjbGVhciBtZXNzYWdlXG4vLyBwb2ludGluZyBhdCAtLWZvcmNlIHRvIG92ZXJyaWRlLiBTZWUgc3JjL2RlcGxveS5qcyBhbmRcbi8vIHNyYy9tb25pdG9yLWRlcGxveS5qcyBmb3IgdGhlIGd1YXJkLlxuLy9cbi8vIFRvIHJlLWVuYWJsZSBkZXBsb3kuanMgZm9yIHNtYWxsLXNlcnZlci1vbmx5IGZhbi1vdXQgKGUuZy4gZm9yXG4vLyB0aGUgeHAgZmFybSBvciBub24tYmF0Y2ggdGFyZ2V0cyksIHJ1biBpdCBtYW51YWxseSB3aXRoIGFcbi8vIC0tdGFyZ2V0IGZpbHRlciAoYW5kIC0tZm9yY2UgaWYgbWFuYWdlci5qcyBpcyB1cCkuIEZvciBub3csXG4vLyBtYW5hZ2VyLmpzIG93bnMgdGhlIHdob2xlIHJvb3RlZCB0YXJnZXQgc2V0IGFuZCBubyBvdGhlciBzY3JpcHRcbi8vIHNob3VsZCBiZSBkZXBsb3lpbmcgd29ya2Vycy5cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxucnVuIG1hc3Rlci5qcyAgICAgICAgICAgICAgICAgICMgc3RhcnQgZXZlcnkgbG9uZy1saXZlZCBtb25pdG9yXG5ydW4gbWFzdGVyLmpzIC0tb25jZSAgICAgICAgICAgICMgcHJpbnQgY3VycmVudCBtb25pdG9yIHN0YXR1cywgZG9uJ3QgKHJlKXN0YXJ0XG5gO1xuXG4vLyBFYWNoIGVudHJ5OiBbc2NyaXB0LCBkZWZhdWx0LWludGVydmFsLW1zLCBleHRyYS1hcmdzLi4uXVxuLy8gVGhlIGRlcGxveSBpbnRlcnZhbCBpcyBhIGZsYWcgYmVjYXVzZSBpdCdzIHRoZSBtb3N0IGxpa2VseSBrbm9iXG4vLyB0aGUgcGxheWVyIHdhbnRzIHRvIHR1bmUgKDE1cyBkdXJpbmcgYSBoYWNrLWZlc3QsIDYwcyB3aGVuIGlkbGUpLlxuLy8gT3RoZXIgbW9uaXRvcnMgdXNlIHRoZWlyIG93biBoYXJkLWNvZGVkIGRlZmF1bHRzIOKAlCB3ZSBkb24ndCBzdXJmYWNlXG4vLyB0aGVtIGFzIGZsYWdzIGJlY2F1c2UgdGhhdCB3b3VsZCBqdXN0IGJsb2F0IHRoZSB1c2FnZSBsaW5lIGZvciBub1xuLy8gcGF5b2ZmOyBpZiB5b3Ugd2FudCBhIG5vbi1kZWZhdWx0IGZvciBvbmUsIGVkaXQgdGhlIHRhYmxlLlxuY29uc3QgTU9OSVRPUlMgPSBbXG4gIFtcIm1vbml0b3ItYmFja2Rvb3IuanNcIiwgMzBfMDAwLCBbXV0sXG4gIFtcIm1vbml0b3ItbnVrZS5qc1wiLCAgICAgNjBfMDAwLCBbXV0sXG4gIFtcIm1vbml0b3ItaGFja25ldC5qc1wiLCAgNjBfMDAwLCBbXV0sXG4gIFtcIm1vbml0b3ItYnV5LmpzXCIsICAgICAgMzBfMDAwLCBbXV0sXG4gIFtcIm1vbml0b3Itc2VydmVycy5qc1wiLCAgNjBfMDAwLCBbXV0sXG4gIFtcIm1hbmFnZXIuanNcIiwgICAgICAgICAgNjBfMDAwLCBbXV0sXG5dO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuICBucy5kaXNhYmxlTG9nKFwic2xlZXBcIik7XG5cbiAgY29uc3Qgb25jZSA9IG5zLmFyZ3MuaW5jbHVkZXMoXCItLW9uY2VcIik7XG5cbiAgLy8gU2FuaXR5IGNoZWNrOiBldmVyeSBzY3JpcHQgbXVzdCBiZSBvbiBob21lIGJlZm9yZSB3ZSB0cnkgdG9cbiAgLy8gcnVuIGl0LiBXaXRob3V0IHRoaXMsIGEgbWlzc2luZyBmaWxlIHdvdWxkIHNpbGVudGx5IG5vLW9wIHZpYVxuICAvLyBucy5ydW4oKSByZXR1cm5pbmcgMCBhbmQgd2UnZCBwcmludCBhIGNvbmZ1c2luZyBGQUlMRUQgbGF0ZXJcbiAgLy8gaW5zdGVhZCBvZiBhIGNsZWFyIFwiZmlsZSBub3Qgb24gaG9tZVwiIHVwIGZyb250LlxuICBjb25zdCBtaXNzaW5nID0gTU9OSVRPUlNcbiAgICAuZmlsdGVyKChbc2NyaXB0XSkgPT4gIW5zLmZpbGVFeGlzdHMoc2NyaXB0LCBcImhvbWVcIikpXG4gICAgLm1hcCgoW3NdKSA9PiBzKTtcbiAgaWYgKG1pc3NpbmcubGVuZ3RoID4gMCkge1xuICAgIG5zLnRwcmludChgbWFzdGVyOiBtaXNzaW5nIG9uIGhvbWUgKHB1c2ggdmlhIGZpbGVzeW5jIGZpcnN0KTogJHttaXNzaW5nLmpvaW4oXCIsIFwiKX1gKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBGb3IgZWFjaCBtb25pdG9yOiBraWxsIGFueSBleGlzdGluZyBpbnN0YW5jZSwgdGhlbiBzdGFydCBhIGZyZXNoXG4gIC8vIG9uZS4gV2UgbmVlZCB0byBraWxsIEJFRk9SRSBzdGFydCBzbyBhIHJlLXJ1biB3aGlsZSBvbGQgbW9uaXRvcnNcbiAgLy8gYXJlIHN0aWxsIGFsaXZlIGRvZXNuJ3QgZG91YmxlLWFsbG9jYXRlIFJBTS5cbiAgLy9cbiAgLy8gbnMucHMoXCJob21lXCIpIHJldHVybnMgYWxsIHByb2Nlc3Nlcy4gV2UgbWF0Y2ggYnkgc2NyaXB0IGZpbGVuYW1lXG4gIC8vIChub3QgUElEIOKAlCBQSURzIGNoYW5nZSBldmVyeSBydW4pLlxuICBmdW5jdGlvbiByZXN0YXJ0KHNjcmlwdCwgZXh0cmFBcmdzKSB7XG4gICAgY29uc3QgYWxpdmUgPSBucy5wcyhcImhvbWVcIikuZmlsdGVyKChwKSA9PiBwLmZpbGVuYW1lID09PSBzY3JpcHQpO1xuICAgIGNvbnN0IHdhc1J1bm5pbmcgPSBhbGl2ZS5sZW5ndGggPiAwO1xuICAgIGZvciAoY29uc3QgcCBvZiBhbGl2ZSkgbnMua2lsbChwLnBpZCk7XG5cbiAgICAvLyBucy5ydW4gcmV0dXJucyAwIG9uIGZhaWx1cmUgKG5vIFJBTSwgbWlzc2luZyBmaWxlLCBldGMuKS4gV2VcbiAgICAvLyBzdXJmYWNlIHRoYXQgYXMgRkFJTEVEIGluIHRoZSBzdGF0dXMgdGFibGUuXG4gICAgY29uc3QgcGlkID0gbnMucnVuKHNjcmlwdCwgMSwgLi4uZXh0cmFBcmdzKTtcbiAgICBpZiAocGlkID09PSAwKSB7XG4gICAgICByZXR1cm4geyBzY3JpcHQsIHN0YXR1czogXCJGQUlMRURcIiwgcGlkOiAwLCB3YXNSdW5uaW5nIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBzY3JpcHQsXG4gICAgICBzdGF0dXM6IHdhc1J1bm5pbmcgPyBcIlJFU1RBUlRFRFwiIDogXCJTVEFSVEVEXCIsXG4gICAgICBwaWQsXG4gICAgICB3YXNSdW5uaW5nLFxuICAgIH07XG4gIH1cblxuICBpZiAob25jZSkge1xuICAgIC8vIERpYWdub3N0aWMgbW9kZTogZG9uJ3QgKHJlKXN0YXJ0IGFueXRoaW5nLCBqdXN0IHNob3cgd2hhdCdzXG4gICAgLy8gY3VycmVudGx5IHJ1bm5pbmcgb24gaG9tZS4gVXNlZnVsIGZvciBcImRpZCB0aGUgcHJldmlvdXNcbiAgICAvLyBtYXN0ZXIuanMgY2FsbCBhY3R1YWxseSB0YWtlP1wiIGRlYnVnZ2luZy5cbiAgICBucy50cHJpbnQoXCJtYXN0ZXI6IHN0YXR1cyBzbmFwc2hvdCAobm8gKHJlKXN0YXJ0KTpcIik7XG4gICAgZm9yIChjb25zdCBbc2NyaXB0XSBvZiBNT05JVE9SUykge1xuICAgICAgY29uc3QgYWxpdmUgPSBucy5wcyhcImhvbWVcIikuZmlsdGVyKChwKSA9PiBwLmZpbGVuYW1lID09PSBzY3JpcHQpO1xuICAgICAgaWYgKGFsaXZlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBucy50cHJpbnQoYCAgJHtzY3JpcHQucGFkRW5kKDIyKX0gIG5vdCBydW5uaW5nYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKGNvbnN0IHAgb2YgYWxpdmUpIHtcbiAgICAgICAgICBucy50cHJpbnQoYCAgJHtzY3JpcHQucGFkRW5kKDIyKX0gIHJ1bm5pbmcgIHBpZD0ke3AucGlkfSAgYXJncz1bJHtwLmFyZ3Muam9pbihcIiBcIikgfHwgXCJcIn1dYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICBmb3IgKGNvbnN0IFtzY3JpcHQsIF9kZWZhdWx0TXMsIGV4dHJhQXJnc10gb2YgTU9OSVRPUlMpIHtcbiAgICByZXN1bHRzLnB1c2gocmVzdGFydChzY3JpcHQsIGV4dHJhQXJncykpO1xuICB9XG5cbiAgLy8gU3RhdHVzIHRhYmxlLlxuICBucy50cHJpbnQoXCJtYXN0ZXI6IChyZSlzdGFydGVkIG1vbml0b3JzIOKAlFwiKTtcbiAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMpIHtcbiAgICBjb25zdCB0YWcgPSBgJHtyLnN0YXR1cy5wYWRFbmQoOSl9ICR7ci5zY3JpcHQucGFkRW5kKDIyKX0gcGlkPSR7ci5waWR9YDtcbiAgICBpZiAoci5zdGF0dXMgPT09IFwiRkFJTEVEXCIpIHtcbiAgICAgIG5zLnRwcmludChgICBGQUlMICAke3Iuc2NyaXB0fSAgKG5zLnJ1biByZXR1cm5lZCAwIOKAlCBvdXQgb2YgaG9tZSBSQU0/KWApO1xuICAgIH0gZWxzZSBpZiAoci53YXNSdW5uaW5nKSB7XG4gICAgICBucy50cHJpbnQoYCAgJHt0YWd9ICAocmVwbGFjZWQgcHJldmlvdXMgaW5zdGFuY2UpYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5zLnRwcmludChgICAke3RhZ31gKTtcbiAgICB9XG4gIH1cblxuICAvLyBPbmUtbGluZSBzdW1tYXJ5IOKAlCB0aGUgdGhpbmcgdG8gc2NhbiBhZnRlciBhbiBhdWcuXG4gIGNvbnN0IG9rID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIuc3RhdHVzICE9PSBcIkZBSUxFRFwiKS5sZW5ndGg7XG4gIGNvbnN0IGZhaWwgPSByZXN1bHRzLmxlbmd0aCAtIG9rO1xuICBjb25zdCBzdGFydGVkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIuc3RhdHVzID09PSBcIlNUQVJURURcIikubGVuZ3RoO1xuICBjb25zdCByZXN0YXJ0ZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gci5zdGF0dXMgPT09IFwiUkVTVEFSVEVEXCIpLmxlbmd0aDtcbiAgbnMudHByaW50KFxuICAgIGBtYXN0ZXI6IGRvbmUg4oCUICR7b2t9LyR7cmVzdWx0cy5sZW5ndGh9IG9rIGAgK1xuICAgIGAoc3RhcnRlZD0ke3N0YXJ0ZWR9IHJlc3RhcnRlZD0ke3Jlc3RhcnRlZH0gZmFpbGVkPSR7ZmFpbH0pYFxuICApO1xuXG4gIC8vIElmIGV2ZXJ5dGhpbmcgZmFpbGVkLCBpdCdzIGFsbW9zdCBhbHdheXMgYSBob21lLVJBTSBpc3N1ZS5cbiAgLy8gUHJpbnQgYSBvbmUtbGluZXIgaGludCBzbyB0aGUgdXNlciBrbm93cyB3aGVyZSB0byBsb29rLlxuICBpZiAob2sgPT09IDApIHtcbiAgICBucy50cHJpbnQoYG1hc3RlcjogaGludCDigJQgY2hlY2sgaG9tZSBSQU0gd2l0aCAnbWVtJyBpbiB0aGUgdGVybWluYWxgKTtcbiAgfVxufVxuIl19