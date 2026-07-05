/** @param {NS} ns */
//
// sync-all.js — Sync every .js file from home to every reachable server in the
// network. Use this after editing scripts in src/ to push updates
// out to the fleet without restarting the workers (already-running
// processes keep their old in-memory copy; only on next launch do
// they pick up the new file).
//
// Idempotent. scp overwrites the destination copy. Files that exist
// on remote servers but NOT on home are REMOVED — so renaming or
// deleting a script in src/ cleans up everywhere.
//
// Drawbacks (intentional):
//   - Pushes files to every rooted server, even ones that don't need
//     the script. Cheap (one tick per host) but adds noise.
//   - Doesn't *run* anything — pair with deploy.js for that, or kill
//     + scp + exec manually.
//   - Files with a stale in-memory worker don't auto-reload. Kill the
//     old process before re-running deploy.js if you need the new
//     version to take effect immediately.
//   - Removal fails silently on files a running script is using —
//     the script reports SKIP-running for those. Kill the worker
//     and re-run to actually clear them.
//
// Usage:
//   run sync-all.js              # push new + remove deleted (default)
//   run sync-all.js --keep-stale # push new, but DON'T remove anything
//   run sync-all.js --quiet      # suppress per-host lines (used by monitor-sync.js)
//
const USAGE = `Usage:
  run sync-all.js              # push new + remove deleted (default)
  run sync-all.js --keep-stale # push new, but DON'T remove anything
  run sync-all.js --quiet      # suppress per-host SKIP/SYNCED lines
`;
export async function main(ns) {
    if (ns.args.includes("-h") || ns.args.includes("--help")) {
        ns.tprint(USAGE);
        return;
    }
    const keepStale = ns.args.includes("--keep-stale");
    // --quiet suppresses per-host SKIP/SYNCED/REMOVED lines but keeps
    // the summary. monitor-sync.js passes this by default on its 30s
    // loop so the terminal doesn't get flooded. Errors (FAIL-scp,
    // FAIL-rm) and the start/end banners still print — the user
    // always wants to see when something went wrong.
    const quiet = ns.args.includes("--quiet");
    const SOURCE = "home";
    const homeFiles = new Set(ns.ls(SOURCE, ".js").filter((f) => !f.endsWith(".d.ts")));
    if (homeFiles.size === 0) {
        ns.tprint(`sync-all: no .js files on ${SOURCE} — is filesync connected?`);
        return;
    }
    ns.tprint(`sync-all: pushing ${homeFiles.size} files to every reachable server: ${[...homeFiles].join(", ")}`);
    // BFS from home.
    const seen = new Set([SOURCE]);
    const queue = [SOURCE];
    while (queue.length > 0) {
        const h = queue.shift();
        for (const n of ns.scan(h)) {
            if (!seen.has(n)) {
                seen.add(n);
                queue.push(n);
            }
        }
    }
    const counters = {
        "SYNCED": 0,
        "REMOVED": 0,
        "SKIP-self": 0,
        "SKIP-no-root": 0,
        "SKIP-running": 0,
        "FAIL-scp": 0,
        "FAIL-rm": 0,
    };
    // Sort for stable, alphabetical output.
    const hosts = [...seen].sort();
    // Cache the set of running scripts per host. isRunning is 1 GB
    // RAM per call, so we batch by listing all processes once per
    // host and checking filenames against the deletion set.
    function runningFilenamesOn(host) {
        return new Set(ns.ps(host).map((p) => p.filename));
    }
    // Convenience: per-host printers that respect --quiet. Start/end
    // banners and the summary still print via ns.tprint directly.
    const print = (line) => { if (!quiet)
        ns.tprint(line); };
    for (const host of hosts) {
        if (host === SOURCE) {
            counters["SKIP-self"]++;
            continue;
        }
        // Skip unrooted hosts — scp/rm will fail anyway, but we report
        // the reason distinctly so you can see what's blocked.
        if (!ns.hasRootAccess(host)) {
            print(`SKIP-no-root    ${host}`);
            counters["SKIP-no-root"]++;
            continue;
        }
        // Push every home file to the host.
        const pushOk = ns.scp([...homeFiles], host, SOURCE);
        if (!pushOk) {
            print(`FAIL-scp        ${host}  (scp returned false)`);
            counters["FAIL-scp"]++;
            // Don't try to remove on a host we couldn't write to — skip
            // the whole host. Symmetric: if the scp fails, treat the
            // remote as unreachable.
            continue;
        }
        // Find stale files: on remote but not on home.
        const remoteFiles = ns.ls(host, ".js");
        const stale = remoteFiles.filter((f) => !homeFiles.has(f));
        let removed = 0;
        if (!keepStale && stale.length > 0) {
            const running = runningFilenamesOn(host);
            for (const f of stale) {
                if (running.has(f)) {
                    print(`SKIP-running    ${host}/${f}  (worker is using it; kill the process and re-run)`);
                    counters["SKIP-running"]++;
                    continue;
                }
                if (ns.rm(f, host)) {
                    print(`REMOVED         ${host}/${f}  (no longer on home)`);
                    counters["REMOVED"]++;
                    removed++;
                }
                else {
                    print(`FAIL-rm         ${host}/${f}`);
                    counters["FAIL-rm"]++;
                }
            }
        }
        print(`SYNCED          ${host}  (${homeFiles.size} pushed${removed > 0 ? `, ${removed} removed` : ""})`);
        counters["SYNCED"]++;
    }
    const summary = Object.entries(counters)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    ns.tprint(`sync-all: done: ${summary} (scanned ${hosts.length} hosts)`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1hbGwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc3luYy1hbGwuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscUJBQXFCO0FBQ3JCLEVBQUU7QUFDRiwrRUFBK0U7QUFDL0Usa0VBQWtFO0FBQ2xFLG1FQUFtRTtBQUNuRSxrRUFBa0U7QUFDbEUsOEJBQThCO0FBQzlCLEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsaUVBQWlFO0FBQ2pFLGtEQUFrRDtBQUNsRCxFQUFFO0FBQ0YsMkJBQTJCO0FBQzNCLHFFQUFxRTtBQUNyRSw0REFBNEQ7QUFDNUQscUVBQXFFO0FBQ3JFLDZCQUE2QjtBQUM3QixzRUFBc0U7QUFDdEUsa0VBQWtFO0FBQ2xFLDBDQUEwQztBQUMxQyxrRUFBa0U7QUFDbEUsaUVBQWlFO0FBQ2pFLHlDQUF5QztBQUN6QyxFQUFFO0FBQ0YsU0FBUztBQUNULHVFQUF1RTtBQUN2RSx1RUFBdUU7QUFDdkUscUZBQXFGO0FBQ3JGLEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7OztDQUliLENBQUM7QUFFRixNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDeEQsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQixPQUFPO0tBQ1I7SUFDRCxNQUFNLFNBQVMsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQztJQUNuRCxrRUFBa0U7SUFDbEUsaUVBQWlFO0lBQ2pFLDhEQUE4RDtJQUM5RCw0REFBNEQ7SUFDNUQsaURBQWlEO0lBQ2pELE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBRTFDLE1B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SUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO29CQUN0QyxRQUFRLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztpQkFDdkI7YUFDRjtTQUNGO1FBRUQsS0FBSyxDQUFDLG1CQUFtQixJQUFJLE1BQU0sU0FBUyxDQUFDLElBQUksVUFBVSxPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ3pHLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO0tBQ3RCO0lBRUQsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUM7U0FDckMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7U0FDekIsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1NBQzVCLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNiLEVBQUUsQ0FBQyxNQUFNLENBQUMsbUJBQW1CLE9BQU8sYUFBYSxLQUFLLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQztBQUMxRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gc3luYy1hbGwuanMg4oCUIFN5bmMgZXZlcnkgLmpzIGZpbGUgZnJvbSBob21lIHRvIGV2ZXJ5IHJlYWNoYWJsZSBzZXJ2ZXIgaW4gdGhlXG4vLyBuZXR3b3JrLiBVc2UgdGhpcyBhZnRlciBlZGl0aW5nIHNjcmlwdHMgaW4gc3JjLyB0byBwdXNoIHVwZGF0ZXNcbi8vIG91dCB0byB0aGUgZmxlZXQgd2l0aG91dCByZXN0YXJ0aW5nIHRoZSB3b3JrZXJzIChhbHJlYWR5LXJ1bm5pbmdcbi8vIHByb2Nlc3NlcyBrZWVwIHRoZWlyIG9sZCBpbi1tZW1vcnkgY29weTsgb25seSBvbiBuZXh0IGxhdW5jaCBkb1xuLy8gdGhleSBwaWNrIHVwIHRoZSBuZXcgZmlsZSkuXG4vL1xuLy8gSWRlbXBvdGVudC4gc2NwIG92ZXJ3cml0ZXMgdGhlIGRlc3RpbmF0aW9uIGNvcHkuIEZpbGVzIHRoYXQgZXhpc3Rcbi8vIG9uIHJlbW90ZSBzZXJ2ZXJzIGJ1dCBOT1Qgb24gaG9tZSBhcmUgUkVNT1ZFRCDigJQgc28gcmVuYW1pbmcgb3Jcbi8vIGRlbGV0aW5nIGEgc2NyaXB0IGluIHNyYy8gY2xlYW5zIHVwIGV2ZXJ5d2hlcmUuXG4vL1xuLy8gRHJhd2JhY2tzIChpbnRlbnRpb25hbCk6XG4vLyAgIC0gUHVzaGVzIGZpbGVzIHRvIGV2ZXJ5IHJvb3RlZCBzZXJ2ZXIsIGV2ZW4gb25lcyB0aGF0IGRvbid0IG5lZWRcbi8vICAgICB0aGUgc2NyaXB0LiBDaGVhcCAob25lIHRpY2sgcGVyIGhvc3QpIGJ1dCBhZGRzIG5vaXNlLlxuLy8gICAtIERvZXNuJ3QgKnJ1biogYW55dGhpbmcg4oCUIHBhaXIgd2l0aCBkZXBsb3kuanMgZm9yIHRoYXQsIG9yIGtpbGxcbi8vICAgICArIHNjcCArIGV4ZWMgbWFudWFsbHkuXG4vLyAgIC0gRmlsZXMgd2l0aCBhIHN0YWxlIGluLW1lbW9yeSB3b3JrZXIgZG9uJ3QgYXV0by1yZWxvYWQuIEtpbGwgdGhlXG4vLyAgICAgb2xkIHByb2Nlc3MgYmVmb3JlIHJlLXJ1bm5pbmcgZGVwbG95LmpzIGlmIHlvdSBuZWVkIHRoZSBuZXdcbi8vICAgICB2ZXJzaW9uIHRvIHRha2UgZWZmZWN0IGltbWVkaWF0ZWx5LlxuLy8gICAtIFJlbW92YWwgZmFpbHMgc2lsZW50bHkgb24gZmlsZXMgYSBydW5uaW5nIHNjcmlwdCBpcyB1c2luZyDigJRcbi8vICAgICB0aGUgc2NyaXB0IHJlcG9ydHMgU0tJUC1ydW5uaW5nIGZvciB0aG9zZS4gS2lsbCB0aGUgd29ya2VyXG4vLyAgICAgYW5kIHJlLXJ1biB0byBhY3R1YWxseSBjbGVhciB0aGVtLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gc3luYy1hbGwuanMgICAgICAgICAgICAgICMgcHVzaCBuZXcgKyByZW1vdmUgZGVsZXRlZCAoZGVmYXVsdClcbi8vICAgcnVuIHN5bmMtYWxsLmpzIC0ta2VlcC1zdGFsZSAjIHB1c2ggbmV3LCBidXQgRE9OJ1QgcmVtb3ZlIGFueXRoaW5nXG4vLyAgIHJ1biBzeW5jLWFsbC5qcyAtLXF1aWV0ICAgICAgIyBzdXBwcmVzcyBwZXItaG9zdCBsaW5lcyAodXNlZCBieSBtb25pdG9yLXN5bmMuanMpXG4vL1xuY29uc3QgVVNBR0UgPSBgVXNhZ2U6XG4gIHJ1biBzeW5jLWFsbC5qcyAgICAgICAgICAgICAgIyBwdXNoIG5ldyArIHJlbW92ZSBkZWxldGVkIChkZWZhdWx0KVxuICBydW4gc3luYy1hbGwuanMgLS1rZWVwLXN0YWxlICMgcHVzaCBuZXcsIGJ1dCBET04nVCByZW1vdmUgYW55dGhpbmdcbiAgcnVuIHN5bmMtYWxsLmpzIC0tcXVpZXQgICAgICAjIHN1cHByZXNzIHBlci1ob3N0IFNLSVAvU1lOQ0VEIGxpbmVzXG5gO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBpZiAobnMuYXJncy5pbmNsdWRlcyhcIi1oXCIpIHx8IG5zLmFyZ3MuaW5jbHVkZXMoXCItLWhlbHBcIikpIHtcbiAgICBucy50cHJpbnQoVVNBR0UpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBrZWVwU3RhbGUgPSBucy5hcmdzLmluY2x1ZGVzKFwiLS1rZWVwLXN0YWxlXCIpO1xuICAvLyAtLXF1aWV0IHN1cHByZXNzZXMgcGVyLWhvc3QgU0tJUC9TWU5DRUQvUkVNT1ZFRCBsaW5lcyBidXQga2VlcHNcbiAgLy8gdGhlIHN1bW1hcnkuIG1vbml0b3Itc3luYy5qcyBwYXNzZXMgdGhpcyBieSBkZWZhdWx0IG9uIGl0cyAzMHNcbiAgLy8gbG9vcCBzbyB0aGUgdGVybWluYWwgZG9lc24ndCBnZXQgZmxvb2RlZC4gRXJyb3JzIChGQUlMLXNjcCxcbiAgLy8gRkFJTC1ybSkgYW5kIHRoZSBzdGFydC9lbmQgYmFubmVycyBzdGlsbCBwcmludCDigJQgdGhlIHVzZXJcbiAgLy8gYWx3YXlzIHdhbnRzIHRvIHNlZSB3aGVuIHNvbWV0aGluZyB3ZW50IHdyb25nLlxuICBjb25zdCBxdWlldCA9IG5zLmFyZ3MuaW5jbHVkZXMoXCItLXF1aWV0XCIpO1xuXG4gIGNvbnN0IFNPVVJDRSA9IFwiaG9tZVwiO1xuICBjb25zdCBob21lRmlsZXMgPSBuZXcgU2V0KG5zLmxzKFNPVVJDRSwgXCIuanNcIikuZmlsdGVyKChmKSA9PiAhZi5lbmRzV2l0aChcIi5kLnRzXCIpKSk7XG4gIGlmIChob21lRmlsZXMuc2l6ZSA9PT0gMCkge1xuICAgIG5zLnRwcmludChgc3luYy1hbGw6IG5vIC5qcyBmaWxlcyBvbiAke1NPVVJDRX0g4oCUIGlzIGZpbGVzeW5jIGNvbm5lY3RlZD9gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgbnMudHByaW50KGBzeW5jLWFsbDogcHVzaGluZyAke2hvbWVGaWxlcy5zaXplfSBmaWxlcyB0byBldmVyeSByZWFjaGFibGUgc2VydmVyOiAke1suLi5ob21lRmlsZXNdLmpvaW4oXCIsIFwiKX1gKTtcblxuICAvLyBCRlMgZnJvbSBob21lLlxuICBjb25zdCBzZWVuID0gbmV3IFNldChbU09VUkNFXSk7XG4gIGNvbnN0IHF1ZXVlID0gW1NPVVJDRV07XG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgaCA9IHF1ZXVlLnNoaWZ0KCk7XG4gICAgZm9yIChjb25zdCBuIG9mIG5zLnNjYW4oaCkpIHtcbiAgICAgIGlmICghc2Vlbi5oYXMobikpIHsgc2Vlbi5hZGQobik7IHF1ZXVlLnB1c2gobik7IH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBjb3VudGVycyA9IHtcbiAgICBcIlNZTkNFRFwiOiAwLFxuICAgIFwiUkVNT1ZFRFwiOiAwLFxuICAgIFwiU0tJUC1zZWxmXCI6IDAsXG4gICAgXCJTS0lQLW5vLXJvb3RcIjogMCxcbiAgICBcIlNLSVAtcnVubmluZ1wiOiAwLFxuICAgIFwiRkFJTC1zY3BcIjogMCxcbiAgICBcIkZBSUwtcm1cIjogMCxcbiAgfTtcblxuICAvLyBTb3J0IGZvciBzdGFibGUsIGFscGhhYmV0aWNhbCBvdXRwdXQuXG4gIGNvbnN0IGhvc3RzID0gWy4uLnNlZW5dLnNvcnQoKTtcblxuICAvLyBDYWNoZSB0aGUgc2V0IG9mIHJ1bm5pbmcgc2NyaXB0cyBwZXIgaG9zdC4gaXNSdW5uaW5nIGlzIDEgR0JcbiAgLy8gUkFNIHBlciBjYWxsLCBzbyB3ZSBiYXRjaCBieSBsaXN0aW5nIGFsbCBwcm9jZXNzZXMgb25jZSBwZXJcbiAgLy8gaG9zdCBhbmQgY2hlY2tpbmcgZmlsZW5hbWVzIGFnYWluc3QgdGhlIGRlbGV0aW9uIHNldC5cbiAgZnVuY3Rpb24gcnVubmluZ0ZpbGVuYW1lc09uKGhvc3QpIHtcbiAgICByZXR1cm4gbmV3IFNldChucy5wcyhob3N0KS5tYXAoKHApID0+IHAuZmlsZW5hbWUpKTtcbiAgfVxuXG4gIC8vIENvbnZlbmllbmNlOiBwZXItaG9zdCBwcmludGVycyB0aGF0IHJlc3BlY3QgLS1xdWlldC4gU3RhcnQvZW5kXG4gIC8vIGJhbm5lcnMgYW5kIHRoZSBzdW1tYXJ5IHN0aWxsIHByaW50IHZpYSBucy50cHJpbnQgZGlyZWN0bHkuXG4gIGNvbnN0IHByaW50ID0gKGxpbmUpID0+IHsgaWYgKCFxdWlldCkgbnMudHByaW50KGxpbmUpOyB9O1xuXG4gIGZvciAoY29uc3QgaG9zdCBvZiBob3N0cykge1xuICAgIGlmIChob3N0ID09PSBTT1VSQ0UpIHtcbiAgICAgIGNvdW50ZXJzW1wiU0tJUC1zZWxmXCJdKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBTa2lwIHVucm9vdGVkIGhvc3RzIOKAlCBzY3Avcm0gd2lsbCBmYWlsIGFueXdheSwgYnV0IHdlIHJlcG9ydFxuICAgIC8vIHRoZSByZWFzb24gZGlzdGluY3RseSBzbyB5b3UgY2FuIHNlZSB3aGF0J3MgYmxvY2tlZC5cbiAgICBpZiAoIW5zLmhhc1Jvb3RBY2Nlc3MoaG9zdCkpIHtcbiAgICAgIHByaW50KGBTS0lQLW5vLXJvb3QgICAgJHtob3N0fWApO1xuICAgICAgY291bnRlcnNbXCJTS0lQLW5vLXJvb3RcIl0rKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIFB1c2ggZXZlcnkgaG9tZSBmaWxlIHRvIHRoZSBob3N0LlxuICAgIGNvbnN0IHB1c2hPayA9IG5zLnNjcChbLi4uaG9tZUZpbGVzXSwgaG9zdCwgU09VUkNFKTtcbiAgICBpZiAoIXB1c2hPaykge1xuICAgICAgcHJpbnQoYEZBSUwtc2NwICAgICAgICAke2hvc3R9ICAoc2NwIHJldHVybmVkIGZhbHNlKWApO1xuICAgICAgY291bnRlcnNbXCJGQUlMLXNjcFwiXSsrO1xuICAgICAgLy8gRG9uJ3QgdHJ5IHRvIHJlbW92ZSBvbiBhIGhvc3Qgd2UgY291bGRuJ3Qgd3JpdGUgdG8g4oCUIHNraXBcbiAgICAgIC8vIHRoZSB3aG9sZSBob3N0LiBTeW1tZXRyaWM6IGlmIHRoZSBzY3AgZmFpbHMsIHRyZWF0IHRoZVxuICAgICAgLy8gcmVtb3RlIGFzIHVucmVhY2hhYmxlLlxuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gRmluZCBzdGFsZSBmaWxlczogb24gcmVtb3RlIGJ1dCBub3Qgb24gaG9tZS5cbiAgICBjb25zdCByZW1vdGVGaWxlcyA9IG5zLmxzKGhvc3QsIFwiLmpzXCIpO1xuICAgIGNvbnN0IHN0YWxlID0gcmVtb3RlRmlsZXMuZmlsdGVyKChmKSA9PiAhaG9tZUZpbGVzLmhhcyhmKSk7XG5cbiAgICBsZXQgcmVtb3ZlZCA9IDA7XG4gICAgaWYgKCFrZWVwU3RhbGUgJiYgc3RhbGUubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgcnVubmluZyA9IHJ1bm5pbmdGaWxlbmFtZXNPbihob3N0KTtcbiAgICAgIGZvciAoY29uc3QgZiBvZiBzdGFsZSkge1xuICAgICAgICBpZiAocnVubmluZy5oYXMoZikpIHtcbiAgICAgICAgICBwcmludChgU0tJUC1ydW5uaW5nICAgICR7aG9zdH0vJHtmfSAgKHdvcmtlciBpcyB1c2luZyBpdDsga2lsbCB0aGUgcHJvY2VzcyBhbmQgcmUtcnVuKWApO1xuICAgICAgICAgIGNvdW50ZXJzW1wiU0tJUC1ydW5uaW5nXCJdKys7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG5zLnJtKGYsIGhvc3QpKSB7XG4gICAgICAgICAgcHJpbnQoYFJFTU9WRUQgICAgICAgICAke2hvc3R9LyR7Zn0gIChubyBsb25nZXIgb24gaG9tZSlgKTtcbiAgICAgICAgICBjb3VudGVyc1tcIlJFTU9WRURcIl0rKztcbiAgICAgICAgICByZW1vdmVkKys7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcHJpbnQoYEZBSUwtcm0gICAgICAgICAke2hvc3R9LyR7Zn1gKTtcbiAgICAgICAgICBjb3VudGVyc1tcIkZBSUwtcm1cIl0rKztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHByaW50KGBTWU5DRUQgICAgICAgICAgJHtob3N0fSAgKCR7aG9tZUZpbGVzLnNpemV9IHB1c2hlZCR7cmVtb3ZlZCA+IDAgPyBgLCAke3JlbW92ZWR9IHJlbW92ZWRgIDogXCJcIn0pYCk7XG4gICAgY291bnRlcnNbXCJTWU5DRURcIl0rKztcbiAgfVxuXG4gIGNvbnN0IHN1bW1hcnkgPSBPYmplY3QuZW50cmllcyhjb3VudGVycylcbiAgICAuZmlsdGVyKChbXywgdl0pID0+IHYgPiAwKVxuICAgIC5tYXAoKFtrLCB2XSkgPT4gYCR7a309JHt2fWApXG4gICAgLmpvaW4oXCIgXCIpO1xuICBucy50cHJpbnQoYHN5bmMtYWxsOiBkb25lOiAke3N1bW1hcnl9IChzY2FubmVkICR7aG9zdHMubGVuZ3RofSBob3N0cylgKTtcbn1cbiJdfQ==