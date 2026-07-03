/** @param {NS} ns */
//
// Long-lived daemon that trades the WSE stock market on autopilot.
// Tracks per-symbol forecast (4S Market Data) and trend-follows: if the
// forecast is strongly bullish, hold a long position; if strongly
// bearish AND shorting is unlocked, hold a short. On a forecast flip
// the existing position is liquidated first, then the new side is
// opened. Cash that isn't needed for the next trade is left in the
// wallet — this script never goes "all in".
//
// Why trend-follow instead of buy-and-hold:
//   The WSE is a zero-sum market — every $1 the script wins is $1
//   someone else lost. The expected value of a random long is
//   negative (commission + spread). The 4S forecast is a noisy
//   estimate of "P(price goes up next tick)", and 0.5 is the break-
//   even point once commissions are paid. Sitting flat is therefore
//   BETTER than holding a coin-flip long.
//
// Forecast deadband:
//   The forecast wiggles around 0.5 a lot, especially for low-
//   volatility stocks. We open a position only when forecast crosses
//   --bull / --bear thresholds (default 0.55 / 0.45). A 5-point band
//   around 0.5 is enough to filter noise without being so wide that
//   we miss real moves. The 4S data IS noisy, so even a real signal
//   gets a couple of "noise" ticks — that's why we use a small
//   rolling-average (last 4 ticks) before acting.
//
// 1-to-N Rule (same shape as monitor-hacknet.js):
//   No single trade ever spends more than --rule-fraction of liquid
//   cash (default 25%). This protects the main economy (Hacking
//   scripts, Home RAM) from the script "going all in" on one stock
//   and then sitting in cash for hours. Set --rule-fraction 0 to
//   disable and use only absolute affordability (--reserve).
//
// What you NEED before this is useful:
//   1. WSE Account (visit the World Stock Exchange in the City →
//      buy an account for $200k from the dialog).
//   2. TIX API Access ($5m from the same place). This unlocks
//      ns.stock.buyStock / sellStock / getPosition.
//   3. 4S Market Data TIX API ($25m * BitNode mult). Unlocks
//      ns.stock.getForecast / getVolatility. The script DEGRADES
//      gracefully without it — see "no-4S mode" below — but the
//      forecast is the whole point, so the script is mostly idle
//      in that mode.
//   4. Shorting is unlocked by the "Shorting" aug from the
//      Stock Exchange, or by reaching a high TIX account tier
//      (TIX-1000 at $100t net worth). The script detects
//      shortability by trying to open a tiny short; if it returns
//      0 the side stays long-only.
//
// No-4S mode (forecast disabled):
//   Without 4S, we can't see the forecast, so the script falls back
//   to a simple momentum check: did the price go up or down in the
//   last tick? It's a much weaker signal and produces more churn.
//   The script will print a clear warning at startup. Use it as a
//   placeholder while you save for 4S.
//
// Tick alignment:
//   Stock prices update every 4-6 seconds (4-6s with no bonus time,
//   faster with bonus time accumulated from being offline). The
//   script awaits ns.stock.nextUpdate() between passes, which is the
//   right cadence — it does NOT spin a tight loop polling price.
//
// Per-tick activity:
//   1. Update rolling forecast average (if 4S unlocked).
//   2. For each held symbol, check if forecast has flipped beyond
//      the deadband; if so, close the position at market.
//   3. For each tradable symbol with no position, check if forecast
//      is strongly bullish or bearish; if so, open a position sized
//      to (1-to-N rule * cash).
//
// Cash reserve (--reserve):
//   Always keep at least this much cash in the wallet (default
//   $1m). The script will not buy if the resulting cash would
//   dip below the floor, regardless of the 1-to-N rule. Prevents
//   the script from starving other daemons (share.js, monitor-buy.js).
//
// Output is QUIET by default — only TRADE-LONG/TRADE-SHORT/CLOSED/
// ERROR lines print. --verbose re-enables per-symbol forecast and
// per-tick cash. --once runs a single decision pass with full output
// and exits (diagnostic).
//
// Usage:
//   run monitor-stock.js                       # loop, every stock tick, QUIET
//   run monitor-stock.js --once                # one pass, full output, then exit
//   run monitor-stock.js --verbose             # loop, per-symbol forecast every tick
//   run monitor-stock.js --bull 0.60 --bear 0.40  # tighter deadband
//   run monitor-stock.js --rule-fraction 0.10  # max 10% of wallet per trade
//   run monitor-stock.js --reserve 5000000     # keep $5m cash floor
//   run monitor-stock.js --max-shares 10000    # cap position size in shares
//
const USAGE = `Usage:
 run monitor-stock.js                       # loop, every stock tick, QUIET
 run monitor-stock.js --once                # one pass, full output, then exit
 run monitor-stock.js --verbose             # loop, per-symbol forecast every tick
 run monitor-stock.js --bull 0.60 --bear 0.40  # tighter deadband (default 0.55/0.45)
 run monitor-stock.js --rule-fraction 0.10  # max 10% of wallet per trade (default 0.25)
 run monitor-stock.js --reserve 5000000     # keep $5m cash floor (default 1m)
 run monitor-stock.js --max-shares 10000    # cap position size in shares (default 100k)
`;

// Defaults. Note the deadband is INTENTIONALLY small — the 4S
// forecast is a probability in [0,1] with a known mean of 0.5, so
// anything past ±0.05 is a real signal, not noise. Tightening further
// (e.g. 0.6/0.4) trades fewer trades for higher conviction.
const DEFAULT_BULL = 0.55;     // open long if rolling forecast > bull
const DEFAULT_BEAR = 0.45;     // open short if rolling forecast < bear
const DEFAULT_RULE = 0.25;     // 1-to-N: max 25% of wallet per trade
const DEFAULT_RESERVE = 1e6;   // $1m cash floor the script won't cross
const DEFAULT_MAX_SHARES = 100_000;  // per-symbol cap, prevents over-sizing into illiquid names
const FORECAST_WINDOW = 4;     // # of ticks in the rolling average; 4 = ~20s of data
const MIN_RULE = 0;
const MAX_RULE = 1;

export async function main(ns) {
  if (ns.args.includes("-h") || ns.args.includes("--help")) {
    ns.tprint(USAGE);
    return;
  }

  // Gate: TIX API is the only thing that actually unlocks trading.
  // WSE alone is for the UI; TIX is the NS one. The script returns
  // a clear message instead of letting the first ns.stock.buyStock
  // throw a stack trace the user has to decode.
  if (!ns.stock.hasTixApiAccess()) {
    ns.tprint("ERROR: TIX API not unlocked. Buy TIX API access for $5m from the WSE before running this script.");
    return;
  }
  if (!ns.stock.hasWseAccount()) {
    ns.tprint("ERROR: No WSE account. Buy one from the World Stock Exchange dialog before running this script.");
    return;
  }

  // Parse args. Same pattern as the rest of the daemon family:
  // --once is diagnostic, --verbose opts in to per-tick per-symbol
  // output, the rest are knobs.
  const args = ns.args.slice();
  const once = args.includes("--once");
  const verbose = args.includes("--verbose");
  const bullIdx = args.indexOf("--bull");
  const bull = bullIdx >= 0 ? Number(args[bullIdx + 1]) : DEFAULT_BULL;
  if (bullIdx >= 0 && (!Number.isFinite(bull) || bull <= 0.5 || bull >= 1)) {
    ns.tprint(`monitor-stock: --bull must be a number 0.5..1 (got ${args[bullIdx + 1]})`);
    return;
  }
  const bearIdx = args.indexOf("--bear");
  const bear = bearIdx >= 0 ? Number(args[bearIdx + 1]) : DEFAULT_BEAR;
  if (bearIdx >= 0 && (!Number.isFinite(bear) || bear < 0 || bear >= 0.5)) {
    ns.tprint(`monitor-stock: --bear must be a number 0..0.5 (got ${args[bearIdx + 1]})`);
    return;
  }
  if (bull <= bear) {
    ns.tprint(`monitor-stock: --bull (${bull}) must be > --bear (${bear})`);
    return;
  }
  const ruleIdx = args.indexOf("--rule-fraction");
  const ruleFraction = ruleIdx >= 0 ? Number(args[ruleIdx + 1]) : DEFAULT_RULE;
  if (ruleIdx >= 0 && (!Number.isFinite(ruleFraction) || ruleFraction < MIN_RULE || ruleFraction > MAX_RULE)) {
    ns.tprint(`monitor-stock: --rule-fraction must be a number ${MIN_RULE}..${MAX_RULE} (got ${args[ruleIdx + 1]})`);
    return;
  }
  const reserveIdx = args.indexOf("--reserve");
  const reserve = reserveIdx >= 0 ? Number(args[reserveIdx + 1]) : DEFAULT_RESERVE;
  if (reserveIdx >= 0 && (!Number.isFinite(reserve) || reserve < 0)) {
    ns.tprint(`monitor-stock: --reserve must be a non-negative number (got ${args[reserveIdx + 1]})`);
    return;
  }
  const maxSharesIdx = args.indexOf("--max-shares");
  const maxShares = maxSharesIdx >= 0 ? Math.floor(Number(args[maxSharesIdx + 1])) : DEFAULT_MAX_SHARES;
  if (maxSharesIdx >= 0 && (!Number.isFinite(maxShares) || maxShares < 0)) {
    ns.tprint(`monitor-stock: --max-shares must be a non-negative number (got ${args[maxSharesIdx + 1]})`);
    return;
  }

  const has4S = ns.stock.has4SDataTixApi();
  if (!has4S) {
    // The script still runs but degrades to a momentum check.
    // Worth warning loudly: 4S is the only way to make this script
    // actually profitable, and a quiet user will assume the script
    // is "working" while it churns on noise.
    ns.tprint("WARN: 4S Market Data TIX API not unlocked — running in momentum-fallback mode (much weaker signal)");
  }

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");

  // Per-symbol rolling forecast window. forecastHistory[sym] is an
  // array of the most recent N forecasts (most recent at the END).
  // On a fresh start the array fills up over FORECAST_WINDOW ticks
  // before the script is willing to act — without that, the first
  // tick would be "rolling avg = the single most recent sample",
  // which is the noisiest possible read.
  const forecastHistory = {};
  // Cached "last forecast" for the verbose log; kept separately from
  // the rolling average because the verbose line shows both.
  const lastForecast = {};
  // Sticky "what position is currently held" — needed for the close
  // path. ns.stock.getPosition also returns this but caching it here
  // lets us print a single line per decision.
  const held = {};  // { sym: { side: "L"|"S", shares, avgPrice } }

  function recordForecast(sym, f) {
    if (!Number.isFinite(f)) return;  // 4S returned NaN — skip the tick for this symbol
    if (!forecastHistory[sym]) forecastHistory[sym] = [];
    const hist = forecastHistory[sym];
    hist.push(f);
    if (hist.length > FORECAST_WINDOW) hist.shift();
    lastForecast[sym] = f;
  }

  function rollingForecast(sym) {
    const h = forecastHistory[sym];
    if (!h || h.length === 0) return null;
    let s = 0;
    for (const v of h) s += v;
    return s / h.length;
  }

  // "Have we seen enough samples to trust the average?" Until the
  // window is full we sit flat. The first few ticks after launch
  // would otherwise be low-quality trades.
  function forecastReady(sym) {
    return forecastHistory[sym] && forecastHistory[sym].length >= FORECAST_WINDOW;
  }

  // Shorts aren't always unlocked. We probe ONCE on startup by
  // trying to open a 1-share short on the first tradable symbol;
  // if buyShort returns 0 the side is locked. We immediately close
  // the probe and remember the result. Probing every tick would
  // spam the log; the answer doesn't change at runtime.
  function detectShortable(symbols) {
    if (symbols.length === 0) return false;
    const probe = symbols[0];
    const price = ns.stock.getAskPrice(probe);
    const before = ns.getServerMoneyAvailable("home");
    const got = ns.stock.buyShort(probe, 1);
    if (got === 0) {
      return false;
    }
    // Got the short — close it immediately.
    ns.stock.sellShort(probe, 1);
    // Some quick-revert: we don't bother restoring the cash. The
    // cost of a 1-share short at the ask is ~$price and the
    // commission is small; losing $price to learn "yes, I can
    // short" is cheap. (Alternative: read getSaleGain for the
    // exact close cost, but the result is the same either way.)
    return true;
  }

  // Liquidation: close the held position at market, log a line.
  // Returns true if there WAS a position to close. Uses the cached
  // "held" map because the API is slightly awkward (getPosition
  // returns a 4-tuple we have to unpack).
  function closePosition(sym, reason) {
    const h = held[sym];
    if (!h) return false;
    if (h.side === "L") {
      const px = ns.stock.sellStock(sym, h.shares);
      if (px > 0) {
        const pnl = (px - h.avgPrice) * h.shares;
        ns.tprint(`CLOSED-long    ${sym.padEnd(4)} ${h.shares}@$${px.toFixed(2)}  pnl=$${pnl.toFixed(0)}  (${reason})`);
      } else {
        ns.tprint(`FAIL-sell       ${sym} ${h.shares} shares — order rejected`);
      }
    } else {
      const px = ns.stock.sellShort(sym, h.shares);
      if (px > 0) {
        // For a short, profit = (entry - exit) * shares.
        const pnl = (h.avgPrice - px) * h.shares;
        ns.tprint(`CLOSED-short   ${sym.padEnd(4)} ${h.shares}@$${px.toFixed(2)}  pnl=$${pnl.toFixed(0)}  (${reason})`);
      } else {
        ns.tprint(`FAIL-sellShort  ${sym} ${h.shares} shares — order rejected`);
      }
    }
    delete held[sym];
    return true;
  }

  // Open a long or short. Returns true on success. Sizing:
  //   - Take the smaller of (rule-fraction * wallet, max-shares *
  //     ask price).
  //   - Then bound it by the symbol's max-shares limit and the cash
  //     actually available (ns.stock.getPurchaseCost is the only
  //     honest way to know how much a position costs — it accounts
  //     for spread and large-order price impact).
  //   - Floor at 1 share (the API requires positive).
  function openLong(sym) {
    const cash = ns.getServerMoneyAvailable("home");
    const spendable = Math.max(0, cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1);
    const ask = ns.stock.getAskPrice(sym);
    if (!Number.isFinite(ask) || ask <= 0) return false;
    const symMax = ns.stock.getMaxShares(sym);
    const sharesByRule = Math.floor(spendable / ask);
    const sharesByCap = Math.min(maxShares, symMax);
    let shares = Math.max(0, Math.min(sharesByRule, sharesByCap));
    if (shares <= 0) return false;
    // Re-check the actual cost against the wallet (spread + impact).
    const cost = ns.stock.getPurchaseCost(sym, shares, "L");
    if (!Number.isFinite(cost) || cost <= 0) return false;
    if (cost > cash - reserve) {
      // Re-size to what we can actually afford.
      const affordable = Math.max(0, Math.floor(((cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1)) / ask));
      shares = Math.max(0, Math.min(affordable, sharesByCap));
      if (shares <= 0) return false;
    }
    const px = ns.stock.buyStock(sym, shares);
    if (px <= 0) return false;
    held[sym] = { side: "L", shares, avgPrice: px };
    ns.tprint(`TRADE-long     ${sym.padEnd(4)} ${shares}@$${px.toFixed(2)}  cost=$${(px * shares).toFixed(0)}  forecast=${(rollingForecast(sym) ?? 0).toFixed(3)}`);
    return true;
  }

  function openShort(sym) {
    const cash = ns.getServerMoneyAvailable("home");
    const spendable = Math.max(0, cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1);
    const bid = ns.stock.getBidPrice(sym);
    if (!Number.isFinite(bid) || bid <= 0) return false;
    const symMax = ns.stock.getMaxShares(sym);
    const sharesByRule = Math.floor(spendable / bid);
    const sharesByCap = Math.min(maxShares, symMax);
    let shares = Math.max(0, Math.min(sharesByRule, sharesByCap));
    if (shares <= 0) return false;
    const cost = ns.stock.getPurchaseCost(sym, shares, "S");
    if (!Number.isFinite(cost) || cost <= 0) return false;
    if (cost > cash - reserve) {
      const affordable = Math.max(0, Math.floor(((cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1)) / bid));
      shares = Math.max(0, Math.min(affordable, sharesByCap));
      if (shares <= 0) return false;
    }
    const px = ns.stock.buyShort(sym, shares);
    if (px <= 0) return false;
    held[sym] = { side: "S", shares, avgPrice: px };
    ns.tprint(`TRADE-short    ${sym.padEnd(4)} ${shares}@$${px.toFixed(2)}  cost=$${(px * shares).toFixed(0)}  forecast=${(rollingForecast(sym) ?? 0).toFixed(3)}`);
    return true;
  }

  // Refresh the held map from the API. Called once per tick before
  // decisions. We use the API as the source of truth (in case a
  // sell happened elsewhere) and overwrite our cache.
  function refreshHeld(symbols) {
    held.length = 0;
    for (const sym of symbols) {
      const [shL, avgL, shS, avgS] = ns.stock.getPosition(sym);
      if (shL > 0) held[sym] = { side: "L", shares: shL, avgPrice: avgL };
      else if (shS > 0) held[sym] = { side: "S", shares: shS, avgPrice: avgS };
    }
  }

  // The decision pass. One per stock tick.
  //   1. Refresh held positions from the API.
  //   2. For each symbol, record the latest forecast (4S mode) or
  //      last price tick (momentum mode).
  //   3. For each held symbol, check the rolling forecast against
  //      the deadband and liquidate if it flipped.
  //   4. For each tradable symbol with no position and a
  //      ready forecast, open a long/short if the signal is strong
  //      enough.
  function pass(shortable) {
    const symbols = ns.stock.getSymbols();
    refreshHeld(symbols);
    const counters = { updated: 0, closed: 0, opened: 0, skipped: 0 };

    for (const sym of symbols) {
      if (has4S) {
        const f = ns.stock.getForecast(sym);
        recordForecast(sym, f);
      } else {
        // Momentum fallback: P(forecast = 0.5) at every tick, but
        // we CAN see if the price moved up or down vs the previous
        // tick. A "0" move or first-tick (no previous) gets a
        // neutral 0.5. This produces lots of noise trades, which
        // is why 4S is so important.
        const cur = ns.stock.getPrice(sym);
        const prev = lastForecast[sym] ?? cur;
        const moved = cur - prev;
        const f = 0.5 + Math.max(-0.5, Math.min(0.5, moved / Math.max(1, prev) * 10));
        recordForecast(sym, f);
      }
      counters.updated++;
    }

    if (verbose) {
      for (const sym of symbols) {
        const rf = rollingForecast(sym);
        const lf = lastForecast[sym];
        const side = held[sym] ? `${held[sym].side}@${held[sym].avgPrice.toFixed(2)}` : "flat";
        ns.tprint(`forecast ${sym.padEnd(4)} roll=${(rf ?? 0).toFixed(3)} last=${(lf ?? 0).toFixed(3)} pos=${side} wallet=$${ns.getServerMoneyAvailable("home").toFixed(0)}`);
      }
    }

    // Step 3: close positions whose forecast has flipped.
    for (const sym of symbols) {
      const h = held[sym];
      if (!h) continue;
      if (!forecastReady(sym)) continue;  // not enough data — don't touch
      const rf = rollingForecast(sym);
      // A long is happy when forecast is above --bull. A short is
      // happy when forecast is below --bear. Anything in between
      // is "noise" — hold. Past the deadband in the OTHER
      // direction is the liquidation trigger.
      if (h.side === "L" && rf < bear) {
        if (closePosition(sym, `forecast ${rf.toFixed(3)} < ${bear}`)) counters.closed++;
      } else if (h.side === "S" && rf > bull) {
        if (closePosition(sym, `forecast ${rf.toFixed(3)} > ${bull}`)) counters.closed++;
      }
    }

    // Step 4: open new positions on tradable symbols with no
    // current position and a ready forecast.
    for (const sym of symbols) {
      if (held[sym]) continue;  // already in a position
      if (!forecastReady(sym)) {
        counters.skipped++;
        continue;
      }
      const rf = rollingForecast(sym);
      if (rf > bull) {
        if (openLong(sym)) counters.opened++;
      } else if (rf < bear && shortable) {
        if (openShort(sym)) counters.opened++;
      }
    }

    return counters;
  }

  // Detect shorting once at startup. Done OUTSIDE pass() because
  // probing every tick is wasteful and noisy.
  const symbols0 = ns.stock.getSymbols();
  const shortable = detectShortable(symbols0);
  if (verbose) {
    ns.tprint(`monitor-stock: shortable=${shortable}, 4S=${has4S}, symbols=${symbols0.length}, reserve=$${reserve.toFixed(0)}, rule=${(ruleFraction * 100).toFixed(0)}%`);
  }
  // --once means "do a single decision pass and exit". --once is a
  // diagnostic — the script may close positions even on the first
  // tick, which is fine (and surprising). The intent of --once is
  // "show me what would happen" not "be safe".
  if (once) {
    pass(shortable);
    return;
  }

  ns.tprint(`monitor-stock: started, shortable=${shortable}, 4S=${has4S}, bull=${bull}, bear=${bear}, rule=${(ruleFraction * 100).toFixed(0)}%, reserve=$${reserve.toFixed(0)}, output=${verbose ? "verbose" : "quiet"}`);
  // Main loop. The cadence is set by ns.stock.nextUpdate(), which
  // resolves once per stock tick (~4-6s real time, faster with
  // bonus time). We don't sleep a fixed interval because (a) the
  // game already tells us when a new tick is ready, and (b) tight
  // fixed-interval polling would burn RAM and produce duplicate
  // signals (the forecast and price only change on a stock tick).
  while (true) {
    await ns.stock.nextUpdate();
    pass(shortable);
  }
}
