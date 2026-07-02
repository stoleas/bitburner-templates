/** @param {NS} ns */
//
// Sync every .js file from home to every reachable server in the
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
//
const USAGE = `Usage:
  run sync-all.js              # push new + remove deleted (default)
  run sync-all.js --keep-stale # push new, but DON'T remove anything
`;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  const keepStale = ns.args.includes("--keep-stale");

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
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
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

  for (const host of hosts) {
    if (host === SOURCE) {
      counters["SKIP-self"]++;
      continue;
    }

    // Skip unrooted hosts — scp/rm will fail anyway, but we report
    // the reason distinctly so you can see what's blocked.
    if (!ns.hasRootAccess(host)) {
      ns.tprint(`SKIP-no-root    ${host}`);
      counters["SKIP-no-root"]++;
      continue;
    }

    // Push every home file to the host.
    const pushOk = ns.scp([...homeFiles], host, SOURCE);
    if (!pushOk) {
      ns.tprint(`FAIL-scp        ${host}  (scp returned false)`);
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
          ns.tprint(`SKIP-running    ${host}/${f}  (worker is using it; kill the process and re-run)`);
          counters["SKIP-running"]++;
          continue;
        }
        if (ns.rm(f, host)) {
          ns.tprint(`REMOVED         ${host}/${f}  (no longer on home)`);
          counters["REMOVED"]++;
          removed++;
        } else {
          ns.tprint(`FAIL-rm         ${host}/${f}`);
          counters["FAIL-rm"]++;
        }
      }
    }

    ns.tprint(`SYNCED          ${host}  (${homeFiles.size} pushed${removed > 0 ? `, ${removed} removed` : ""})`);
    counters["SYNCED"]++;
  }

  const summary = Object.entries(counters)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  ns.tprint(`sync-all: done: ${summary} (scanned ${hosts.length} hosts)`);
}
