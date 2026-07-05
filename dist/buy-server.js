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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnV5LXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9idXktc2VydmVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsOERBQThEO0FBQzlELHdFQUF3RTtBQUN4RSxFQUFFO0FBQ0YsU0FBUztBQUNULGlFQUFpRTtBQUNqRSx3Q0FBd0M7QUFDeEMsMkVBQTJFO0FBQzNFLEVBQUU7QUFDRix5RUFBeUU7QUFDekUsbUVBQW1FO0FBQ25FLDJDQUEyQztBQUMzQyxFQUFFO0FBQ0Ysa0VBQWtFO0FBQ2xFLHdFQUF3RTtBQUN4RSx3RUFBd0U7QUFDeEUsNkJBQTZCO0FBQzdCLEVBQUU7QUFDRixNQUFNLEtBQUssR0FBRzs7OztDQUliLENBQUM7QUFFRixNQUFNLENBQUMsS0FBSyxVQUFVLElBQUksQ0FBQyxFQUFFO0lBQzNCLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDeEQsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQixPQUFPO0tBQ1I7SUFDRCw0REFBNEQ7SUFDNUQsZ0VBQWdFO0lBQ2hFLHlDQUF5QztJQUN6QyxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUM7SUFDekIsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMxQixNQUFNLEdBQUcsR0FBRyxNQUFNLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUV2RCxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsRUFBRTtRQUMxQixFQUFFLENBQUMsTUFBTSxDQUFDLDJDQUEyQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1FBQ2hFLE9BQU87S0FDUjtJQUNELElBQUksR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRTtRQUN0QyxFQUFFLENBQUMsTUFBTSxDQUFDLDZDQUE2QyxHQUFHLEdBQUcsQ0FBQyxDQUFDO1FBQy9ELE9BQU87S0FDUjtJQUNELElBQUksR0FBRyxHQUFHLFNBQVMsRUFBRTtRQUNuQixFQUFFLENBQUMsTUFBTSxDQUFDLDRDQUE0QyxHQUFHLEdBQUcsQ0FBQyxDQUFDO1FBQzlELE9BQU87S0FDUjtJQUVELHFFQUFxRTtJQUNyRSxzRUFBc0U7SUFDdEUsOENBQThDO0lBQzlDLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3pDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUU7UUFDbkIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxzQ0FBc0MsSUFBSSxZQUFZLEdBQUcsbUNBQW1DLENBQUMsQ0FBQztRQUN4RyxPQUFPO0tBQ1I7SUFDRCxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUMsdUJBQXVCLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDakQsRUFBRSxDQUFDLE1BQU0sQ0FBQywrQkFBK0IsUUFBUSxTQUFTLEdBQUcsWUFBWSxJQUFJLENBQUMsY0FBYyxFQUFFLGVBQWUsS0FBSyxDQUFDLGNBQWMsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUV4SSxJQUFJLEtBQUssR0FBRyxJQUFJLEVBQUU7UUFDaEIsRUFBRSxDQUFDLE1BQU0sQ0FBQyxtQ0FBbUMsQ0FBQyxJQUFJLEdBQUcsS0FBSyxDQUFDLENBQUMsY0FBYyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ3JGLE9BQU87S0FDUjtJQUVELFVBQVU7SUFDVixNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsS0FBSyxDQUFDLGNBQWMsQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDdEQsSUFBSSxNQUFNLEtBQUssRUFBRSxFQUFFO1FBQ2pCLEVBQUUsQ0FBQyxNQUFNLENBQUMsb0ZBQW9GLENBQUMsQ0FBQztRQUNoRyxPQUFPO0tBQ1I7SUFFRCxFQUFFLENBQUMsTUFBTSxDQUFDLDRCQUE0QixNQUFNLE1BQU0sR0FBRyxZQUFZLElBQUksQ0FBQyxjQUFjLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDN0YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIFB1cmNoYXNlIGEgY2xvdWQgKHB1cmNoYXNlZCkgc2VydmVyLiBJZGVtcG90ZW50IG9uIGhvc3RuYW1lXG4vLyBjb2xsaXNpb25zOiBCaXRidXJuZXIgYXV0by1hcHBlbmRzIC0wLCAtMSwgZXRjLiBpZiB0aGUgbmFtZSBpcyB0YWtlbi5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIGJ1eS1zZXJ2ZXIuanMgICAgICAgICAgICMgZGVmYXVsdCA2NEdCLCBob3N0bmFtZSBcInBzZXJ2XCJcbi8vICAgcnVuIGJ1eS1zZXJ2ZXIuanMgMTI4ICAgICAgICMgMTI4R0Jcbi8vICAgcnVuIGJ1eS1zZXJ2ZXIuanMgMTAyNCAgICAgICMgMVRCIChiaWdnZXIgdGhhbiBhbnkgVGVjaCBWZW5kb3Igb2ZmZXJzKVxuLy9cbi8vIFJBTSBtdXN0IGJlIGEgcG93ZXIgb2YgMiAoMSwgMiwgNCwgOCwgLi4uLCB1cCB0byAyXjIwID0gMSwwNDgsNTc2IEdCKS5cbi8vIG5zLmNsb3VkLnB1cmNoYXNlU2VydmVyKCkgc2lsZW50bHkgcmV0dXJucyBcIlwiIG9uIGludmFsaWQgaW5wdXQg4oCUXG4vLyB3ZSBwcmUtdmFsaWRhdGUgc28gZmFpbHVyZXMgYXJlIHZpc2libGUuXG4vL1xuLy8gQ29zdCBmb3JtdWxhIChwZXIgYml0YnVybmVyLXNyYy9zcmMvU2VydmVyL1NlcnZlclB1cmNoYXNlcy50cyk6XG4vLyAgIGNvc3QgPSByYW0gKiA1NSwwMDAgKiBDbG91ZFNlcnZlckNvc3RfbXVsdCAqIENsb3VkU2VydmVyU29mdGNhcF51cGdcbi8vIHdoZXJlIHVwZyA9IG1heCgwLCBsb2cyKHJhbSkgLSA2KS4gQXQgZGVmYXVsdCBtdWx0aXBsaWVycyBhbmQgcmFtPD02NFxuLy8gR0IgdGhhdCdzIGp1c3QgcmFtICogJDU1ay5cbi8vXG5jb25zdCBVU0FHRSA9IGBVc2FnZTpcbiAgcnVuIGJ1eS1zZXJ2ZXIuanMgICAgICAgICAgICMgZGVmYXVsdCA2NEdCLCBob3N0bmFtZSBcInBzZXJ2XCJcbiAgcnVuIGJ1eS1zZXJ2ZXIuanMgMTI4ICAgICAgICMgMTI4R0JcbiAgcnVuIGJ1eS1zZXJ2ZXIuanMgMTAyNCAgICAgICMgMVRCIChiaWdnZXIgdGhhbiBhbnkgVGVjaCBWZW5kb3Igb2ZmZXJzKVxuYDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnMpIHtcbiAgaWYgKG5zLmFyZ3MuaW5jbHVkZXMoXCItaFwiKSB8fCBucy5hcmdzLmluY2x1ZGVzKFwiLS1oZWxwXCIpKSB7XG4gICAgbnMudHByaW50KFVTQUdFKTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRmlyc3QgcG9zaXRpb25hbCBhcmcgaXMgUkFNIGluIEdCLiBEZWZhdWx0IDY0IGlmIG1pc3NpbmcuXG4gIC8vIFJlamVjdCBub24taW50ZWdlciAvIG5lZ2F0aXZlIC8gbm9uLW51bWVyaWMgaW5wdXQgbG91ZGx5IHNvIGFcbiAgLy8gdHlwbyBkb2Vzbid0IHNpbGVudGx5IGJ1eSB0aGUgZGVmYXVsdC5cbiAgY29uc3QgSE9TVE5BTUUgPSBcInBzZXJ2XCI7XG4gIGNvbnN0IHJhd1JhbSA9IG5zLmFyZ3NbMF07XG4gIGNvbnN0IFJBTSA9IHJhd1JhbSA9PT0gdW5kZWZpbmVkID8gNjQgOiBOdW1iZXIocmF3UmFtKTtcblxuICBpZiAoIU51bWJlci5pc0ludGVnZXIoUkFNKSkge1xuICAgIG5zLnRwcmludChgYnV5LXNlcnZlcjogUkFNIG11c3QgYmUgYW4gaW50ZWdlciAoZ290ICR7cmF3UmFtfSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFJBTSA8IDEgfHwgKFJBTSAmIChSQU0gLSAxKSkgIT09IDApIHtcbiAgICBucy50cHJpbnQoYGJ1eS1zZXJ2ZXI6IFJBTSBtdXN0IGJlIGEgcG93ZXIgb2YgMiAoZ290ICR7UkFNfSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFJBTSA+IDFfMDQ4XzU3Nikge1xuICAgIG5zLnRwcmludChgYnV5LXNlcnZlcjogUkFNIGV4Y2VlZHMgbWF4IDJeMjAgR0IgKGdvdCAke1JBTX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gUmVwb3J0IGNvc3QgdXAgZnJvbnQgc28gYSBtaXNjb25maWd1cmVkIHJ1biBkb2Vzbid0IHNpbGVudGx5IGZhaWwuXG4gIC8vIGdldFNlcnZlckNvc3QgcmV0dXJucyBJbmZpbml0eSBmb3IgaW52YWxpZCBSQU0gKHdoaWNoIHdlJ3ZlIGFscmVhZHlcbiAgLy8gcnVsZWQgb3V0KSBhbmQgZm9yIHJhbSA+IENsb3VkU2VydmVyTWF4UmFtLlxuICBjb25zdCBjb3N0ID0gbnMuY2xvdWQuZ2V0U2VydmVyQ29zdChSQU0pO1xuICBpZiAoIWlzRmluaXRlKGNvc3QpKSB7XG4gICAgbnMudHByaW50KGBidXktc2VydmVyOiBnZXRTZXJ2ZXJDb3N0IHJldHVybmVkICR7Y29zdH0gZm9yIHJhbT0ke1JBTX0gKGxpa2VseSBhYm92ZSBDbG91ZFNlcnZlck1heFJhbSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbW9uZXkgPSBucy5nZXRTZXJ2ZXJNb25leUF2YWlsYWJsZShcImhvbWVcIik7XG4gIG5zLnRwcmludChgYnV5LXNlcnZlcjogcGxhbm5pbmcgdG8gYnV5ICR7SE9TVE5BTUV9IHdpdGggJHtSQU19IEdCIGZvciAkJHtjb3N0LnRvTG9jYWxlU3RyaW5nKCl9IChob21lIGhhcyAkJHttb25leS50b0xvY2FsZVN0cmluZygpfSlgKTtcblxuICBpZiAobW9uZXkgPCBjb3N0KSB7XG4gICAgbnMudHByaW50KGBidXktc2VydmVyOiBTS0lQLWZ1bmRzICAgIG5lZWQgJCR7KGNvc3QgLSBtb25leSkudG9Mb2NhbGVTdHJpbmcoKX0gbW9yZWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEhpdCBpdC5cbiAgY29uc3QgcmVzdWx0ID0gbnMuY2xvdWQucHVyY2hhc2VTZXJ2ZXIoSE9TVE5BTUUsIFJBTSk7XG4gIGlmIChyZXN1bHQgPT09IFwiXCIpIHtcbiAgICBucy50cHJpbnQoYGJ1eS1zZXJ2ZXI6IEZBSUxFRCAgICAgICAgKHB1cmNoYXNlU2VydmVyIHJldHVybmVkIFwiXCIg4oCUIGxpbWl0IGhpdCwgb3Igb3RoZXIgZXJyb3IpYCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbnMudHByaW50KGBidXktc2VydmVyOiBCT1VHSFQgICAgICAgJHtyZXN1bHR9ICAoJHtSQU19IEdCIGZvciAkJHtjb3N0LnRvTG9jYWxlU3RyaW5nKCl9KWApO1xufVxuIl19