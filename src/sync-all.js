/** @param {NS} ns */
//
// Sync every .js file from home to every reachable server in the
// network. Use this after editing scripts in src/ to push updates
// out to the fleet without restarting the workers (already-running
// processes keep their old in-memory copy; only on next launch do
// they pick up the new file).
//
// Idempotent. scp overwrites the destination copy.
//
// Drawbacks (intentional):
//   - Pushes files to every rooted server, even ones that don't need
//     the script. Cheap (one tick per host) but adds noise.
//   - Doesn't *run* anything — pair with deploy.js for that, or kill
//     + scp + exec manually.
//   - Files with a stale in-memory worker don't auto-reload. Kill the
//     old process before re-running deploy.js if you need the new
//     version to take effect immediately.
//
// Usage:
//   run sync-all.js
//
export async function main(ns) {
  const SOURCE = "home";
  const files = ns.ls(SOURCE, ".js").filter((f) => !f.endsWith(".d.ts"));
  if (files.length === 0) {
    ns.tprint(`sync-all: no .js files on ${SOURCE} — is filesync connected?`);
    return;
  }
  ns.tprint(`sync-all: pushing ${files.length} files to every reachable server: ${files.join(", ")}`);

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
    "SKIP-self": 0,
    "SKIP-no-root": 0,
    "FAIL-scp": 0,
  };

  // Sort for stable, alphabetical output.
  const hosts = [...seen].sort();

  for (const host of hosts) {
    if (host === SOURCE) {
      counters["SKIP-self"]++;
      continue;
    }

    // Skip unrooted hosts — scp will fail anyway, but we report the
    // reason distinctly so you can see what's blocked.
    if (!ns.hasRootAccess(host)) {
      ns.tprint(`SKIP-no-root    ${host}`);
      counters["SKIP-no-root"]++;
      continue;
    }

    if (!ns.scp(files, host, SOURCE)) {
      ns.tprint(`FAIL-scp        ${host}  (scp returned false)`);
      counters["FAIL-scp"]++;
      continue;
    }

    ns.tprint(`SYNCED          ${host}  (${files.length} files)`);
    counters["SYNCED"]++;
  }

  const summary = Object.entries(counters)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  ns.tprint(`sync-all: done: ${summary} (scanned ${hosts.length} hosts)`);
}
