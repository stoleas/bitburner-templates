/** @param {NS} ns */
//
// List every script running on every server, with its PID, threads, and
// RAM cost. Helps diagnose "why is home out of RAM" or "what's eating
// 5 GB on foo".
//
export async function main(ns) {
  // Probe: ns.ps(host) returns all processes on a server.
  // ns.getScriptRam(script, host) returns the cost per thread.
  const hosts = ["home", ...ns.scan("home")];
  // BFS-expand so we get servers a couple hops out (not exhaustive — the
  // full network is huge, but the workers are usually within 2 hops of home).
  const seen = new Set(hosts);
  const queue = [...hosts];
  while (queue.length > 0) {
    const h = queue.shift();
    for (const n of ns.scan(h)) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }

  let totalRam = 0;
  const lines = [];
  for (const host of seen) {
    const procs = ns.ps(host);
    if (procs.length === 0) continue;
    for (const p of procs) {
      const ramPerThread = ns.getScriptRam(p.filename, host);
      const ram = ramPerThread * p.threads;
      totalRam += ram;
      lines.push({
        host,
        pid: p.pid,
        filename: p.filename,
        threads: p.threads,
        ramPerThread,
        ram,
        args: p.args,
      });
    }
  }

  // Sort: home first, then by RAM descending.
  lines.sort((a, b) => {
    if (a.host === "home" && b.host !== "home") return -1;
    if (b.host === "home" && a.host !== "home") return 1;
    return b.ram - a.ram;
  });

  ns.tprint("Script                          Host                PID    Threads   RAM");
  ns.tprint("-".repeat(80));
  for (const l of lines) {
    const fn = l.filename.padEnd(30);
    const host = l.host.padEnd(20);
    const pid = String(l.pid).padEnd(7);
    const threads = String(l.threads).padEnd(9);
    const ram = `${l.ram.toFixed(2)} GB`;
    ns.tprint(`${fn}${host}${pid}${threads}${ram}`);
  }
  ns.tprint("-".repeat(80));
  ns.tprint(`Total: ${lines.length} scripts, ${totalRam.toFixed(2)} GB`);
  // Per-host totals
  const byHost = new Map();
  for (const l of lines) {
    byHost.set(l.host, (byHost.get(l.host) ?? 0) + l.ram);
  }
  ns.tprint("By host:");
  for (const [host, ram] of [...byHost.entries()].sort((a, b) => b[1] - a[1])) {
    const max = ns.getServerMaxRam(host);
    const used = ns.getServerUsedRam(host);
    ns.tprint(`  ${host.padEnd(20)} ${ram.toFixed(2)} / ${max.toFixed(2)} GB used`);
  }
}
