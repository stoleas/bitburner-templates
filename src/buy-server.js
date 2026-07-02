/** @param {NS} ns */
//
// Purchase a cloud (purchased) server. Idempotent on hostname
// collisions: Bitburner auto-appends -0, -1, etc. if the name is taken.
//
// Usage:
//   run buy-server.js           # default 64GB, hostname "pserv"
//   run buy-server.js 128       # 128GB
//   run buy-server.js 1024      # 1TB (bigger than any Tech Vendor offers)
//
// RAM must be a power of 2 (1, 2, 4, 8, ..., up to 2^20 = 1,048,576 GB).
// ns.cloud.purchaseServer() silently returns "" on invalid input —
// we pre-validate so failures are visible.
//
// Cost formula (per bitburner-src/src/Server/ServerPurchases.ts):
//   cost = ram * 55,000 * CloudServerCost_mult * CloudServerSoftcap^upg
// where upg = max(0, log2(ram) - 6). At default multipliers and ram<=64
// GB that's just ram * $55k.
//
const USAGE = `Usage:
  run buy-server.js           # default 64GB, hostname "pserv"
  run buy-server.js 128       # 128GB
  run buy-server.js 1024      # 1TB (bigger than any Tech Vendor offers)
`;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }
  // First positional arg is RAM in GB. Default 64 if missing.
  // Reject non-integer / negative / non-numeric input loudly so a
  // typo doesn't silently buy the default.
  const HOSTNAME = "pserv";
  const rawRam = ns.args[0];
  const RAM = rawRam === undefined ? 64 : Number(rawRam);

  if (!Number.isInteger(RAM)) {
    ns.tprint(`buy-server: RAM must be an integer (got ${rawRam})`);
    return;
  }
  if (RAM < 1 || (RAM & (RAM - 1)) !== 0) {
    ns.tprint(`buy-server: RAM must be a power of 2 (got ${RAM})`);
    return;
  }
  if (RAM > 1_048_576) {
    ns.tprint(`buy-server: RAM exceeds max 2^20 GB (got ${RAM})`);
    return;
  }

  // Report cost up front so a misconfigured run doesn't silently fail.
  // getServerCost returns Infinity for invalid RAM (which we've already
  // ruled out) and for ram > CloudServerMaxRam.
  const cost = ns.cloud.getServerCost(RAM);
  if (!isFinite(cost)) {
    ns.tprint(`buy-server: getServerCost returned ${cost} for ram=${RAM} (likely above CloudServerMaxRam)`);
    return;
  }
  const money = ns.getServerMoneyAvailable("home");
  ns.tprint(`buy-server: planning to buy ${HOSTNAME} with ${RAM} GB for $${cost.toLocaleString()} (home has $${money.toLocaleString()})`);

  if (money < cost) {
    ns.tprint(`buy-server: SKIP-funds    need $${(cost - money).toLocaleString()} more`);
    return;
  }

  // Hit it.
  const result = ns.cloud.purchaseServer(HOSTNAME, RAM);
  if (result === "") {
    ns.tprint(`buy-server: FAILED        (purchaseServer returned "" — limit hit, or other error)`);
    return;
  }

  ns.tprint(`buy-server: BOUGHT       ${result}  (${RAM} GB for $${cost.toLocaleString()})`);
}
