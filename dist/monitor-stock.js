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
const DEFAULT_BULL = 0.55; // open long if rolling forecast > bull
const DEFAULT_BEAR = 0.45; // open short if rolling forecast < bear
const DEFAULT_RULE = 0.25; // 1-to-N: max 25% of wallet per trade
const DEFAULT_RESERVE = 1e6; // $1m cash floor the script won't cross
const DEFAULT_MAX_SHARES = 100_000; // per-symbol cap, prevents over-sizing into illiquid names
const FORECAST_WINDOW = 4; // # of ticks in the rolling average; 4 = ~20s of data
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
    const held = {}; // { sym: { side: "L"|"S", shares, avgPrice } }
    function recordForecast(sym, f) {
        if (!Number.isFinite(f))
            return; // 4S returned NaN — skip the tick for this symbol
        if (!forecastHistory[sym])
            forecastHistory[sym] = [];
        const hist = forecastHistory[sym];
        hist.push(f);
        if (hist.length > FORECAST_WINDOW)
            hist.shift();
        lastForecast[sym] = f;
    }
    function rollingForecast(sym) {
        const h = forecastHistory[sym];
        if (!h || h.length === 0)
            return null;
        let s = 0;
        for (const v of h)
            s += v;
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
        if (symbols.length === 0)
            return false;
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
        if (!h)
            return false;
        if (h.side === "L") {
            const px = ns.stock.sellStock(sym, h.shares);
            if (px > 0) {
                const pnl = (px - h.avgPrice) * h.shares;
                ns.tprint(`CLOSED-long    ${sym.padEnd(4)} ${h.shares}@$${px.toFixed(2)}  pnl=$${pnl.toFixed(0)}  (${reason})`);
            }
            else {
                ns.tprint(`FAIL-sell       ${sym} ${h.shares} shares — order rejected`);
            }
        }
        else {
            const px = ns.stock.sellShort(sym, h.shares);
            if (px > 0) {
                // For a short, profit = (entry - exit) * shares.
                const pnl = (h.avgPrice - px) * h.shares;
                ns.tprint(`CLOSED-short   ${sym.padEnd(4)} ${h.shares}@$${px.toFixed(2)}  pnl=$${pnl.toFixed(0)}  (${reason})`);
            }
            else {
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
        if (!Number.isFinite(ask) || ask <= 0)
            return false;
        const symMax = ns.stock.getMaxShares(sym);
        const sharesByRule = Math.floor(spendable / ask);
        const sharesByCap = Math.min(maxShares, symMax);
        let shares = Math.max(0, Math.min(sharesByRule, sharesByCap));
        if (shares <= 0)
            return false;
        // Re-check the actual cost against the wallet (spread + impact).
        const cost = ns.stock.getPurchaseCost(sym, shares, "L");
        if (!Number.isFinite(cost) || cost <= 0)
            return false;
        if (cost > cash - reserve) {
            // Re-size to what we can actually afford.
            const affordable = Math.max(0, Math.floor(((cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1)) / ask));
            shares = Math.max(0, Math.min(affordable, sharesByCap));
            if (shares <= 0)
                return false;
        }
        const px = ns.stock.buyStock(sym, shares);
        if (px <= 0)
            return false;
        held[sym] = { side: "L", shares, avgPrice: px };
        ns.tprint(`TRADE-long     ${sym.padEnd(4)} ${shares}@$${px.toFixed(2)}  cost=$${(px * shares).toFixed(0)}  forecast=${(rollingForecast(sym) ?? 0).toFixed(3)}`);
        return true;
    }
    function openShort(sym) {
        const cash = ns.getServerMoneyAvailable("home");
        const spendable = Math.max(0, cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1);
        const bid = ns.stock.getBidPrice(sym);
        if (!Number.isFinite(bid) || bid <= 0)
            return false;
        const symMax = ns.stock.getMaxShares(sym);
        const sharesByRule = Math.floor(spendable / bid);
        const sharesByCap = Math.min(maxShares, symMax);
        let shares = Math.max(0, Math.min(sharesByRule, sharesByCap));
        if (shares <= 0)
            return false;
        const cost = ns.stock.getPurchaseCost(sym, shares, "S");
        if (!Number.isFinite(cost) || cost <= 0)
            return false;
        if (cost > cash - reserve) {
            const affordable = Math.max(0, Math.floor(((cash - reserve) * (ruleFraction > 0 ? ruleFraction : 1)) / bid));
            shares = Math.max(0, Math.min(affordable, sharesByCap));
            if (shares <= 0)
                return false;
        }
        const px = ns.stock.buyShort(sym, shares);
        if (px <= 0)
            return false;
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
            if (shL > 0)
                held[sym] = { side: "L", shares: shL, avgPrice: avgL };
            else if (shS > 0)
                held[sym] = { side: "S", shares: shS, avgPrice: avgS };
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
            }
            else {
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
            if (!h)
                continue;
            if (!forecastReady(sym))
                continue; // not enough data — don't touch
            const rf = rollingForecast(sym);
            // A long is happy when forecast is above --bull. A short is
            // happy when forecast is below --bear. Anything in between
            // is "noise" — hold. Past the deadband in the OTHER
            // direction is the liquidation trigger.
            if (h.side === "L" && rf < bear) {
                if (closePosition(sym, `forecast ${rf.toFixed(3)} < ${bear}`))
                    counters.closed++;
            }
            else if (h.side === "S" && rf > bull) {
                if (closePosition(sym, `forecast ${rf.toFixed(3)} > ${bull}`))
                    counters.closed++;
            }
        }
        // Step 4: open new positions on tradable symbols with no
        // current position and a ready forecast.
        for (const sym of symbols) {
            if (held[sym])
                continue; // already in a position
            if (!forecastReady(sym)) {
                counters.skipped++;
                continue;
            }
            const rf = rollingForecast(sym);
            if (rf > bull) {
                if (openLong(sym))
                    counters.opened++;
            }
            else if (rf < bear && shortable) {
                if (openShort(sym))
                    counters.opened++;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvci1zdG9jay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9tb25pdG9yLXN0b2NrLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsbUVBQW1FO0FBQ25FLHdFQUF3RTtBQUN4RSxrRUFBa0U7QUFDbEUscUVBQXFFO0FBQ3JFLGtFQUFrRTtBQUNsRSxtRUFBbUU7QUFDbkUsNENBQTRDO0FBQzVDLEVBQUU7QUFDRiw0Q0FBNEM7QUFDNUMsa0VBQWtFO0FBQ2xFLDhEQUE4RDtBQUM5RCwrREFBK0Q7QUFDL0Qsb0VBQW9FO0FBQ3BFLG9FQUFvRTtBQUNwRSwwQ0FBMEM7QUFDMUMsRUFBRTtBQUNGLHFCQUFxQjtBQUNyQiwrREFBK0Q7QUFDL0QscUVBQXFFO0FBQ3JFLHFFQUFxRTtBQUNyRSxvRUFBb0U7QUFDcEUsb0VBQW9FO0FBQ3BFLCtEQUErRDtBQUMvRCxrREFBa0Q7QUFDbEQsRUFBRTtBQUNGLGtEQUFrRDtBQUNsRCxvRUFBb0U7QUFDcEUsZ0VBQWdFO0FBQ2hFLG1FQUFtRTtBQUNuRSxpRUFBaUU7QUFDakUsNkRBQTZEO0FBQzdELEVBQUU7QUFDRix1Q0FBdUM7QUFDdkMsaUVBQWlFO0FBQ2pFLGtEQUFrRDtBQUNsRCw4REFBOEQ7QUFDOUQsb0RBQW9EO0FBQ3BELDZEQUE2RDtBQUM3RCxpRUFBaUU7QUFDakUsZ0VBQWdFO0FBQ2hFLGlFQUFpRTtBQUNqRSxxQkFBcUI7QUFDckIsMkRBQTJEO0FBQzNELDhEQUE4RDtBQUM5RCx5REFBeUQ7QUFDekQsa0VBQWtFO0FBQ2xFLG1DQUFtQztBQUNuQyxFQUFFO0FBQ0Ysa0NBQWtDO0FBQ2xDLG9FQUFvRTtBQUNwRSxtRUFBbUU7QUFDbkUsa0VBQWtFO0FBQ2xFLGtFQUFrRTtBQUNsRSx1Q0FBdUM7QUFDdkMsRUFBRTtBQUNGLGtCQUFrQjtBQUNsQixvRUFBb0U7QUFDcEUsZ0VBQWdFO0FBQ2hFLHFFQUFxRTtBQUNyRSxpRUFBaUU7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QUNoRSw4REFBOEQ7SUFDOUQsZ0VBQWdFO0lBQ2hFLE9BQU8sSUFBSSxFQUFFO1FBQ1gsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQzVCLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztLQUNqQjtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyBMb25nLWxpdmVkIGRhZW1vbiB0aGF0IHRyYWRlcyB0aGUgV1NFIHN0b2NrIG1hcmtldCBvbiBhdXRvcGlsb3QuXG4vLyBUcmFja3MgcGVyLXN5bWJvbCBmb3JlY2FzdCAoNFMgTWFya2V0IERhdGEpIGFuZCB0cmVuZC1mb2xsb3dzOiBpZiB0aGVcbi8vIGZvcmVjYXN0IGlzIHN0cm9uZ2x5IGJ1bGxpc2gsIGhvbGQgYSBsb25nIHBvc2l0aW9uOyBpZiBzdHJvbmdseVxuLy8gYmVhcmlzaCBBTkQgc2hvcnRpbmcgaXMgdW5sb2NrZWQsIGhvbGQgYSBzaG9ydC4gT24gYSBmb3JlY2FzdCBmbGlwXG4vLyB0aGUgZXhpc3RpbmcgcG9zaXRpb24gaXMgbGlxdWlkYXRlZCBmaXJzdCwgdGhlbiB0aGUgbmV3IHNpZGUgaXNcbi8vIG9wZW5lZC4gQ2FzaCB0aGF0IGlzbid0IG5lZWRlZCBmb3IgdGhlIG5leHQgdHJhZGUgaXMgbGVmdCBpbiB0aGVcbi8vIHdhbGxldCDigJQgdGhpcyBzY3JpcHQgbmV2ZXIgZ29lcyBcImFsbCBpblwiLlxuLy9cbi8vIFdoeSB0cmVuZC1mb2xsb3cgaW5zdGVhZCBvZiBidXktYW5kLWhvbGQ6XG4vLyAgIFRoZSBXU0UgaXMgYSB6ZXJvLXN1bSBtYXJrZXQg4oCUIGV2ZXJ5ICQxIHRoZSBzY3JpcHQgd2lucyBpcyAkMVxuLy8gICBzb21lb25lIGVsc2UgbG9zdC4gVGhlIGV4cGVjdGVkIHZhbHVlIG9mIGEgcmFuZG9tIGxvbmcgaXNcbi8vICAgbmVnYXRpdmUgKGNvbW1pc3Npb24gKyBzcHJlYWQpLiBUaGUgNFMgZm9yZWNhc3QgaXMgYSBub2lzeVxuLy8gICBlc3RpbWF0ZSBvZiBcIlAocHJpY2UgZ29lcyB1cCBuZXh0IHRpY2spXCIsIGFuZCAwLjUgaXMgdGhlIGJyZWFrLVxuLy8gICBldmVuIHBvaW50IG9uY2UgY29tbWlzc2lvbnMgYXJlIHBhaWQuIFNpdHRpbmcgZmxhdCBpcyB0aGVyZWZvcmVcbi8vICAgQkVUVEVSIHRoYW4gaG9sZGluZyBhIGNvaW4tZmxpcCBsb25nLlxuLy9cbi8vIEZvcmVjYXN0IGRlYWRiYW5kOlxuLy8gICBUaGUgZm9yZWNhc3Qgd2lnZ2xlcyBhcm91bmQgMC41IGEgbG90LCBlc3BlY2lhbGx5IGZvciBsb3ctXG4vLyAgIHZvbGF0aWxpdHkgc3RvY2tzLiBXZSBvcGVuIGEgcG9zaXRpb24gb25seSB3aGVuIGZvcmVjYXN0IGNyb3NzZXNcbi8vICAgLS1idWxsIC8gLS1iZWFyIHRocmVzaG9sZHMgKGRlZmF1bHQgMC41NSAvIDAuNDUpLiBBIDUtcG9pbnQgYmFuZFxuLy8gICBhcm91bmQgMC41IGlzIGVub3VnaCB0byBmaWx0ZXIgbm9pc2Ugd2l0aG91dCBiZWluZyBzbyB3aWRlIHRoYXRcbi8vICAgd2UgbWlzcyByZWFsIG1vdmVzLiBUaGUgNFMgZGF0YSBJUyBub2lzeSwgc28gZXZlbiBhIHJlYWwgc2lnbmFsXG4vLyAgIGdldHMgYSBjb3VwbGUgb2YgXCJub2lzZVwiIHRpY2tzIOKAlCB0aGF0J3Mgd2h5IHdlIHVzZSBhIHNtYWxsXG4vLyAgIHJvbGxpbmctYXZlcmFnZSAobGFzdCA0IHRpY2tzKSBiZWZvcmUgYWN0aW5nLlxuLy9cbi8vIDEtdG8tTiBSdWxlIChzYW1lIHNoYXBlIGFzIG1vbml0b3ItaGFja25ldC5qcyk6XG4vLyAgIE5vIHNpbmdsZSB0cmFkZSBldmVyIHNwZW5kcyBtb3JlIHRoYW4gLS1ydWxlLWZyYWN0aW9uIG9mIGxpcXVpZFxuLy8gICBjYXNoIChkZWZhdWx0IDI1JSkuIFRoaXMgcHJvdGVjdHMgdGhlIG1haW4gZWNvbm9teSAoSGFja2luZ1xuLy8gICBzY3JpcHRzLCBIb21lIFJBTSkgZnJvbSB0aGUgc2NyaXB0IFwiZ29pbmcgYWxsIGluXCIgb24gb25lIHN0b2NrXG4vLyAgIGFuZCB0aGVuIHNpdHRpbmcgaW4gY2FzaCBmb3IgaG91cnMuIFNldCAtLXJ1bGUtZnJhY3Rpb24gMCB0b1xuLy8gICBkaXNhYmxlIGFuZCB1c2Ugb25seSBhYnNvbHV0ZSBhZmZvcmRhYmlsaXR5ICgtLXJlc2VydmUpLlxuLy9cbi8vIFdoYXQgeW91IE5FRUQgYmVmb3JlIHRoaXMgaXMgdXNlZnVsOlxuLy8gICAxLiBXU0UgQWNjb3VudCAodmlzaXQgdGhlIFdvcmxkIFN0b2NrIEV4Y2hhbmdlIGluIHRoZSBDaXR5IOKGklxuLy8gICAgICBidXkgYW4gYWNjb3VudCBmb3IgJDIwMGsgZnJvbSB0aGUgZGlhbG9nKS5cbi8vICAgMi4gVElYIEFQSSBBY2Nlc3MgKCQ1bSBmcm9tIHRoZSBzYW1lIHBsYWNlKS4gVGhpcyB1bmxvY2tzXG4vLyAgICAgIG5zLnN0b2NrLmJ1eVN0b2NrIC8gc2VsbFN0b2NrIC8gZ2V0UG9zaXRpb24uXG4vLyAgIDMuIDRTIE1hcmtldCBEYXRhIFRJWCBBUEkgKCQyNW0gKiBCaXROb2RlIG11bHQpLiBVbmxvY2tzXG4vLyAgICAgIG5zLnN0b2NrLmdldEZvcmVjYXN0IC8gZ2V0Vm9sYXRpbGl0eS4gVGhlIHNjcmlwdCBERUdSQURFU1xuLy8gICAgICBncmFjZWZ1bGx5IHdpdGhvdXQgaXQg4oCUIHNlZSBcIm5vLTRTIG1vZGVcIiBiZWxvdyDigJQgYnV0IHRoZVxuLy8gICAgICBmb3JlY2FzdCBpcyB0aGUgd2hvbGUgcG9pbnQsIHNvIHRoZSBzY3JpcHQgaXMgbW9zdGx5IGlkbGVcbi8vICAgICAgaW4gdGhhdCBtb2RlLlxuLy8gICA0LiBTaG9ydGluZyBpcyB1bmxvY2tlZCBieSB0aGUgXCJTaG9ydGluZ1wiIGF1ZyBmcm9tIHRoZVxuLy8gICAgICBTdG9jayBFeGNoYW5nZSwgb3IgYnkgcmVhY2hpbmcgYSBoaWdoIFRJWCBhY2NvdW50IHRpZXJcbi8vICAgICAgKFRJWC0xMDAwIGF0ICQxMDB0IG5ldCB3b3J0aCkuIFRoZSBzY3JpcHQgZGV0ZWN0c1xuLy8gICAgICBzaG9ydGFiaWxpdHkgYnkgdHJ5aW5nIHRvIG9wZW4gYSB0aW55IHNob3J0OyBpZiBpdCByZXR1cm5zXG4vLyAgICAgIDAgdGhlIHNpZGUgc3RheXMgbG9uZy1vbmx5LlxuLy9cbi8vIE5vLTRTIG1vZGUgKGZvcmVjYXN0IGRpc2FibGVkKTpcbi8vICAgV2l0aG91dCA0Uywgd2UgY2FuJ3Qgc2VlIHRoZSBmb3JlY2FzdCwgc28gdGhlIHNjcmlwdCBmYWxscyBiYWNrXG4vLyAgIHRvIGEgc2ltcGxlIG1vbWVudHVtIGNoZWNrOiBkaWQgdGhlIHByaWNlIGdvIHVwIG9yIGRvd24gaW4gdGhlXG4vLyAgIGxhc3QgdGljaz8gSXQncyBhIG11Y2ggd2Vha2VyIHNpZ25hbCBhbmQgcHJvZHVjZXMgbW9yZSBjaHVybi5cbi8vICAgVGhlIHNjcmlwdCB3aWxsIHByaW50IGEgY2xlYXIgd2FybmluZyBhdCBzdGFydHVwLiBVc2UgaXQgYXMgYVxuLy8gICBwbGFjZWhvbGRlciB3aGlsZSB5b3Ugc2F2ZSBmb3IgNFMuXG4vL1xuLy8gVGljayBhbGlnbm1lbnQ6XG4vLyAgIFN0b2NrIHByaWNlcyB1cGRhdGUgZXZlcnkgNC02IHNlY29uZHMgKDQtNnMgd2l0aCBubyBib251cyB0aW1lLFxuLy8gICBmYXN0ZXIgd2l0aCBib251cyB0aW1lIGFjY3VtdWxhdGVkIGZyb20gYmVpbmcgb2ZmbGluZSkuIFRoZVxuLy8gICBzY3JpcHQgYXdhaXRzIG5zLnN0b2NrLm5leHRVcGRhdGUoKSBiZXR3ZWVuIHBhc3Nlcywgd2hpY2ggaXMgdGhlXG4vLyAgIHJpZ2h0IGNhZGVuY2Ug4oCUIGl0IGRvZXMgTk9UIHNwaW4gYSB0aWdodCBsb29wIHBvbGxpbmcgcHJpY2UuXG4vL1xuLy8gUGVyLXRpY2sgYWN0aXZpdHk6XG4vLyAgIDEuIFVwZGF0ZSByb2xsaW5nIGZvcmVjYXN0IGF2ZXJhZ2UgKGlmIDRTIHVubG9ja2VkKS5cbi8vICAgMi4gRm9yIGVhY2ggaGVsZCBzeW1ib2wsIGNoZWNrIGlmIGZvcmVjYXN0IGhhcyBmbGlwcGVkIGJleW9uZFxuLy8gICAgICB0aGUgZGVhZGJhbmQ7IGlmIHNvLCBjbG9zZSB0aGUgcG9zaXRpb24gYXQgbWFya2V0LlxuLy8gICAzLiBGb3IgZWFjaCB0cmFkYWJsZSBzeW1ib2wgd2l0aCBubyBwb3NpdGlvbiwgY2hlY2sgaWYgZm9yZWNhc3Rcbi8vICAgICAgaXMgc3Ryb25nbHkgYnVsbGlzaCBvciBiZWFyaXNoOyBpZiBzbywgb3BlbiBhIHBvc2l0aW9uIHNpemVkXG4vLyAgICAgIHRvICgxLXRvLU4gcnVsZSAqIGNhc2gpLlxuLy9cbi8vIENhc2ggcmVzZXJ2ZSAoLS1yZXNlcnZlKTpcbi8vICAgQWx3YXlzIGtlZXAgYXQgbGVhc3QgdGhpcyBtdWNoIGNhc2ggaW4gdGhlIHdhbGxldCAoZGVmYXVsdFxuLy8gICAkMW0pLiBUaGUgc2NyaXB0IHdpbGwgbm90IGJ1eSBpZiB0aGUgcmVzdWx0aW5nIGNhc2ggd291bGRcbi8vICAgZGlwIGJlbG93IHRoZSBmbG9vciwgcmVnYXJkbGVzcyBvZiB0aGUgMS10by1OIHJ1bGUuIFByZXZlbnRzXG4vLyAgIHRoZSBzY3JpcHQgZnJvbSBzdGFydmluZyBvdGhlciBkYWVtb25zIChzaGFyZS5qcywgbW9uaXRvci1idXkuanMpLlxuLy9cbi8vIE91dHB1dCBpcyBRVUlFVCBieSBkZWZhdWx0IOKAlCBvbmx5IFRSQURFLUxPTkcvVFJBREUtU0hPUlQvQ0xPU0VEL1xuLy8gRVJST1IgbGluZXMgcHJpbnQuIC0tdmVyYm9zZSByZS1lbmFibGVzIHBlci1zeW1ib2wgZm9yZWNhc3QgYW5kXG4vLyBwZXItdGljayBjYXNoLiAtLW9uY2UgcnVucyBhIHNpbmdsZSBkZWNpc2lvbiBwYXNzIHdpdGggZnVsbCBvdXRwdXRcbi8vIGFuZCBleGl0cyAoZGlhZ25vc3RpYykuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBtb25pdG9yLXN0b2NrLmpzICAgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IHN0b2NrIHRpY2ssIFFVSUVUXG4vLyAgIHJ1biBtb25pdG9yLXN0b2NrLmpzIC0tb25jZSAgICAgICAgICAgICAgICAjIG9uZSBwYXNzLCBmdWxsIG91dHB1dCwgdGhlbiBleGl0XG4vLyAgIHJ1biBtb25pdG9yLXN0b2NrLmpzIC0tdmVyYm9zZSAgICAgICAgICAgICAjIGxvb3AsIHBlci1zeW1ib2wgZm9yZWNhc3QgZXZlcnkgdGlja1xuLy8gICBydW4gbW9uaXRvci1zdG9jay5qcyAtLWJ1bGwgMC42MCAtLWJlYXIgMC40MCAgIyB0aWdodGVyIGRlYWRiYW5kXG4vLyAgIHJ1biBtb25pdG9yLXN0b2NrLmpzIC0tcnVsZS1mcmFjdGlvbiAwLjEwICAjIG1heCAxMCUgb2Ygd2FsbGV0IHBlciB0cmFkZVxuLy8gICBydW4gbW9uaXRvci1zdG9jay5qcyAtLXJlc2VydmUgNTAwMDAwMCAgICAgIyBrZWVwICQ1bSBjYXNoIGZsb29yXG4vLyAgIHJ1biBtb25pdG9yLXN0b2NrLmpzIC0tbWF4LXNoYXJlcyAxMDAwMCAgICAjIGNhcCBwb3NpdGlvbiBzaXplIGluIHNoYXJlc1xuLy9cbmNvbnN0IFVTQUdFID0gYFVzYWdlOlxuIHJ1biBtb25pdG9yLXN0b2NrLmpzICAgICAgICAgICAgICAgICAgICAgICAjIGxvb3AsIGV2ZXJ5IHN0b2NrIHRpY2ssIFFVSUVUXG4gcnVuIG1vbml0b3Itc3RvY2suanMgLS1vbmNlICAgICAgICAgICAgICAgICMgb25lIHBhc3MsIGZ1bGwgb3V0cHV0LCB0aGVuIGV4aXRcbiBydW4gbW9uaXRvci1zdG9jay5qcyAtLXZlcmJvc2UgICAgICAgICAgICAgIyBsb29wLCBwZXItc3ltYm9sIGZvcmVjYXN0IGV2ZXJ5IHRpY2tcbiBydW4gbW9uaXRvci1zdG9jay5qcyAtLWJ1bGwgMC42MCAtLWJlYXIgMC40MCAgIyB0aWdodGVyIGRlYWRiYW5kIChkZWZhdWx0IDAuNTUvMC40NSlcbiBydW4gbW9uaXRvci1zdG9jay5qcyAtLXJ1bGUtZnJhY3Rpb24gMC4xMCAgIyBtYXggMTAlIG9mIHdhbGxldCBwZXIgdHJhZGUgKGRlZmF1bHQgMC4yNSlcbiBydW4gbW9uaXRvci1zdG9jay5qcyAtLXJlc2VydmUgNTAwMDAwMCAgICAgIyBrZWVwICQ1bSBjYXNoIGZsb29yIChkZWZhdWx0IDFtKVxuIHJ1biBtb25pdG9yLXN0b2NrLmpzIC0tbWF4LXNoYXJlcyAxMDAwMCAgICAjIGNhcCBwb3NpdGlvbiBzaXplIGluIHNoYXJlcyAoZGVmYXVsdCAxMDBrKVxuYDtcblxuLy8gRGVmYXVsdHMuIE5vdGUgdGhlIGRlYWRiYW5kIGlzIElOVEVOVElPTkFMTFkgc21hbGwg4oCUIHRoZSA0U1xuLy8gZm9yZWNhc3QgaXMgYSBwcm9iYWJpbGl0eSBpbiBbMCwxXSB3aXRoIGEga25vd24gbWVhbiBvZiAwLjUsIHNvXG4vLyBhbnl0aGluZyBwYXN0IMKxMC4wNSBpcyBhIHJlYWwgc2lnbmFsLCBub3Qgbm9pc2UuIFRpZ2h0ZW5pbmcgZnVydGhlclxuLy8gKGUuZy4gMC42LzAuNCkgdHJhZGVzIGZld2VyIHRyYWRlcyBmb3IgaGlnaGVyIGNvbnZpY3Rpb24uXG5jb25zdCBERUZBVUxUX0JVTEwgPSAwLjU1OyAgICAgLy8gb3BlbiBsb25nIGlmIHJvbGxpbmcgZm9yZWNhc3QgPiBidWxsXG5jb25zdCBERUZBVUxUX0JFQVIgPSAwLjQ1OyAgICAgLy8gb3BlbiBzaG9ydCBpZiByb2xsaW5nIGZvcmVjYXN0IDwgYmVhclxuY29uc3QgREVGQVVMVF9SVUxFID0gMC4yNTsgICAgIC8vIDEtdG8tTjogbWF4IDI1JSBvZiB3YWxsZXQgcGVyIHRyYWRlXG5jb25zdCBERUZBVUxUX1JFU0VSVkUgPSAxZTY7ICAgLy8gJDFtIGNhc2ggZmxvb3IgdGhlIHNjcmlwdCB3b24ndCBjcm9zc1xuY29uc3QgREVGQVVMVF9NQVhfU0hBUkVTID0gMTAwXzAwMDsgIC8vIHBlci1zeW1ib2wgY2FwLCBwcmV2ZW50cyBvdmVyLXNpemluZyBpbnRvIGlsbGlxdWlkIG5hbWVzXG5jb25zdCBGT1JFQ0FTVF9XSU5ET1cgPSA0OyAgICAgLy8gIyBvZiB0aWNrcyBpbiB0aGUgcm9sbGluZyBhdmVyYWdlOyA0ID0gfjIwcyBvZiBkYXRhXG5jb25zdCBNSU5fUlVMRSA9IDA7XG5jb25zdCBNQVhfUlVMRSA9IDE7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGlmIChucy5hcmdzLmluY2x1ZGVzKFwiLWhcIikgfHwgbnMuYXJncy5pbmNsdWRlcyhcIi0taGVscFwiKSkge1xuICAgIG5zLnRwcmludChVU0FHRSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR2F0ZTogVElYIEFQSSBpcyB0aGUgb25seSB0aGluZyB0aGF0IGFjdHVhbGx5IHVubG9ja3MgdHJhZGluZy5cbiAgLy8gV1NFIGFsb25lIGlzIGZvciB0aGUgVUk7IFRJWCBpcyB0aGUgTlMgb25lLiBUaGUgc2NyaXB0IHJldHVybnNcbiAgLy8gYSBjbGVhciBtZXNzYWdlIGluc3RlYWQgb2YgbGV0dGluZyB0aGUgZmlyc3QgbnMuc3RvY2suYnV5U3RvY2tcbiAgLy8gdGhyb3cgYSBzdGFjayB0cmFjZSB0aGUgdXNlciBoYXMgdG8gZGVjb2RlLlxuICBpZiAoIW5zLnN0b2NrLmhhc1RpeEFwaUFjY2VzcygpKSB7XG4gICAgbnMudHByaW50KFwiRVJST1I6IFRJWCBBUEkgbm90IHVubG9ja2VkLiBCdXkgVElYIEFQSSBhY2Nlc3MgZm9yICQ1bSBmcm9tIHRoZSBXU0UgYmVmb3JlIHJ1bm5pbmcgdGhpcyBzY3JpcHQuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIW5zLnN0b2NrLmhhc1dzZUFjY291bnQoKSkge1xuICAgIG5zLnRwcmludChcIkVSUk9SOiBObyBXU0UgYWNjb3VudC4gQnV5IG9uZSBmcm9tIHRoZSBXb3JsZCBTdG9jayBFeGNoYW5nZSBkaWFsb2cgYmVmb3JlIHJ1bm5pbmcgdGhpcyBzY3JpcHQuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFBhcnNlIGFyZ3MuIFNhbWUgcGF0dGVybiBhcyB0aGUgcmVzdCBvZiB0aGUgZGFlbW9uIGZhbWlseTpcbiAgLy8gLS1vbmNlIGlzIGRpYWdub3N0aWMsIC0tdmVyYm9zZSBvcHRzIGluIHRvIHBlci10aWNrIHBlci1zeW1ib2xcbiAgLy8gb3V0cHV0LCB0aGUgcmVzdCBhcmUga25vYnMuXG4gIGNvbnN0IGFyZ3MgPSBucy5hcmdzLnNsaWNlKCk7XG4gIGNvbnN0IG9uY2UgPSBhcmdzLmluY2x1ZGVzKFwiLS1vbmNlXCIpO1xuICBjb25zdCB2ZXJib3NlID0gYXJncy5pbmNsdWRlcyhcIi0tdmVyYm9zZVwiKTtcbiAgY29uc3QgYnVsbElkeCA9IGFyZ3MuaW5kZXhPZihcIi0tYnVsbFwiKTtcbiAgY29uc3QgYnVsbCA9IGJ1bGxJZHggPj0gMCA/IE51bWJlcihhcmdzW2J1bGxJZHggKyAxXSkgOiBERUZBVUxUX0JVTEw7XG4gIGlmIChidWxsSWR4ID49IDAgJiYgKCFOdW1iZXIuaXNGaW5pdGUoYnVsbCkgfHwgYnVsbCA8PSAwLjUgfHwgYnVsbCA+PSAxKSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1zdG9jazogLS1idWxsIG11c3QgYmUgYSBudW1iZXIgMC41Li4xIChnb3QgJHthcmdzW2J1bGxJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGJlYXJJZHggPSBhcmdzLmluZGV4T2YoXCItLWJlYXJcIik7XG4gIGNvbnN0IGJlYXIgPSBiZWFySWR4ID49IDAgPyBOdW1iZXIoYXJnc1tiZWFySWR4ICsgMV0pIDogREVGQVVMVF9CRUFSO1xuICBpZiAoYmVhcklkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKGJlYXIpIHx8IGJlYXIgPCAwIHx8IGJlYXIgPj0gMC41KSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1zdG9jazogLS1iZWFyIG11c3QgYmUgYSBudW1iZXIgMC4uMC41IChnb3QgJHthcmdzW2JlYXJJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChidWxsIDw9IGJlYXIpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc3RvY2s6IC0tYnVsbCAoJHtidWxsfSkgbXVzdCBiZSA+IC0tYmVhciAoJHtiZWFyfSlgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcnVsZUlkeCA9IGFyZ3MuaW5kZXhPZihcIi0tcnVsZS1mcmFjdGlvblwiKTtcbiAgY29uc3QgcnVsZUZyYWN0aW9uID0gcnVsZUlkeCA+PSAwID8gTnVtYmVyKGFyZ3NbcnVsZUlkeCArIDFdKSA6IERFRkFVTFRfUlVMRTtcbiAgaWYgKHJ1bGVJZHggPj0gMCAmJiAoIU51bWJlci5pc0Zpbml0ZShydWxlRnJhY3Rpb24pIHx8IHJ1bGVGcmFjdGlvbiA8IE1JTl9SVUxFIHx8IHJ1bGVGcmFjdGlvbiA+IE1BWF9SVUxFKSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1zdG9jazogLS1ydWxlLWZyYWN0aW9uIG11c3QgYmUgYSBudW1iZXIgJHtNSU5fUlVMRX0uLiR7TUFYX1JVTEV9IChnb3QgJHthcmdzW3J1bGVJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlc2VydmVJZHggPSBhcmdzLmluZGV4T2YoXCItLXJlc2VydmVcIik7XG4gIGNvbnN0IHJlc2VydmUgPSByZXNlcnZlSWR4ID49IDAgPyBOdW1iZXIoYXJnc1tyZXNlcnZlSWR4ICsgMV0pIDogREVGQVVMVF9SRVNFUlZFO1xuICBpZiAocmVzZXJ2ZUlkeCA+PSAwICYmICghTnVtYmVyLmlzRmluaXRlKHJlc2VydmUpIHx8IHJlc2VydmUgPCAwKSkge1xuICAgIG5zLnRwcmludChgbW9uaXRvci1zdG9jazogLS1yZXNlcnZlIG11c3QgYmUgYSBub24tbmVnYXRpdmUgbnVtYmVyIChnb3QgJHthcmdzW3Jlc2VydmVJZHggKyAxXX0pYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG1heFNoYXJlc0lkeCA9IGFyZ3MuaW5kZXhPZihcIi0tbWF4LXNoYXJlc1wiKTtcbiAgY29uc3QgbWF4U2hhcmVzID0gbWF4U2hhcmVzSWR4ID49IDAgPyBNYXRoLmZsb29yKE51bWJlcihhcmdzW21heFNoYXJlc0lkeCArIDFdKSkgOiBERUZBVUxUX01BWF9TSEFSRVM7XG4gIGlmIChtYXhTaGFyZXNJZHggPj0gMCAmJiAoIU51bWJlci5pc0Zpbml0ZShtYXhTaGFyZXMpIHx8IG1heFNoYXJlcyA8IDApKSB7XG4gICAgbnMudHByaW50KGBtb25pdG9yLXN0b2NrOiAtLW1heC1zaGFyZXMgbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBudW1iZXIgKGdvdCAke2FyZ3NbbWF4U2hhcmVzSWR4ICsgMV19KWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGhhczRTID0gbnMuc3RvY2suaGFzNFNEYXRhVGl4QXBpKCk7XG4gIGlmICghaGFzNFMpIHtcbiAgICAvLyBUaGUgc2NyaXB0IHN0aWxsIHJ1bnMgYnV0IGRlZ3JhZGVzIHRvIGEgbW9tZW50dW0gY2hlY2suXG4gICAgLy8gV29ydGggd2FybmluZyBsb3VkbHk6IDRTIGlzIHRoZSBvbmx5IHdheSB0byBtYWtlIHRoaXMgc2NyaXB0XG4gICAgLy8gYWN0dWFsbHkgcHJvZml0YWJsZSwgYW5kIGEgcXVpZXQgdXNlciB3aWxsIGFzc3VtZSB0aGUgc2NyaXB0XG4gICAgLy8gaXMgXCJ3b3JraW5nXCIgd2hpbGUgaXQgY2h1cm5zIG9uIG5vaXNlLlxuICAgIG5zLnRwcmludChcIldBUk46IDRTIE1hcmtldCBEYXRhIFRJWCBBUEkgbm90IHVubG9ja2VkIOKAlCBydW5uaW5nIGluIG1vbWVudHVtLWZhbGxiYWNrIG1vZGUgKG11Y2ggd2Vha2VyIHNpZ25hbClcIik7XG4gIH1cblxuICBucy5kaXNhYmxlTG9nKFwic2xlZXBcIik7XG4gIG5zLmRpc2FibGVMb2coXCJnZXRTZXJ2ZXJNb25leUF2YWlsYWJsZVwiKTtcblxuICAvLyBQZXItc3ltYm9sIHJvbGxpbmcgZm9yZWNhc3Qgd2luZG93LiBmb3JlY2FzdEhpc3Rvcnlbc3ltXSBpcyBhblxuICAvLyBhcnJheSBvZiB0aGUgbW9zdCByZWNlbnQgTiBmb3JlY2FzdHMgKG1vc3QgcmVjZW50IGF0IHRoZSBFTkQpLlxuICAvLyBPbiBhIGZyZXNoIHN0YXJ0IHRoZSBhcnJheSBmaWxscyB1cCBvdmVyIEZPUkVDQVNUX1dJTkRPVyB0aWNrc1xuICAvLyBiZWZvcmUgdGhlIHNjcmlwdCBpcyB3aWxsaW5nIHRvIGFjdCDigJQgd2l0aG91dCB0aGF0LCB0aGUgZmlyc3RcbiAgLy8gdGljayB3b3VsZCBiZSBcInJvbGxpbmcgYXZnID0gdGhlIHNpbmdsZSBtb3N0IHJlY2VudCBzYW1wbGVcIixcbiAgLy8gd2hpY2ggaXMgdGhlIG5vaXNpZXN0IHBvc3NpYmxlIHJlYWQuXG4gIGNvbnN0IGZvcmVjYXN0SGlzdG9yeSA9IHt9O1xuICAvLyBDYWNoZWQgXCJsYXN0IGZvcmVjYXN0XCIgZm9yIHRoZSB2ZXJib3NlIGxvZzsga2VwdCBzZXBhcmF0ZWx5IGZyb21cbiAgLy8gdGhlIHJvbGxpbmcgYXZlcmFnZSBiZWNhdXNlIHRoZSB2ZXJib3NlIGxpbmUgc2hvd3MgYm90aC5cbiAgY29uc3QgbGFzdEZvcmVjYXN0ID0ge307XG4gIC8vIFN0aWNreSBcIndoYXQgcG9zaXRpb24gaXMgY3VycmVudGx5IGhlbGRcIiDigJQgbmVlZGVkIGZvciB0aGUgY2xvc2VcbiAgLy8gcGF0aC4gbnMuc3RvY2suZ2V0UG9zaXRpb24gYWxzbyByZXR1cm5zIHRoaXMgYnV0IGNhY2hpbmcgaXQgaGVyZVxuICAvLyBsZXRzIHVzIHByaW50IGEgc2luZ2xlIGxpbmUgcGVyIGRlY2lzaW9uLlxuICBjb25zdCBoZWxkID0ge307ICAvLyB7IHN5bTogeyBzaWRlOiBcIkxcInxcIlNcIiwgc2hhcmVzLCBhdmdQcmljZSB9IH1cblxuICBmdW5jdGlvbiByZWNvcmRGb3JlY2FzdChzeW0sIGYpIHtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShmKSkgcmV0dXJuOyAgLy8gNFMgcmV0dXJuZWQgTmFOIOKAlCBza2lwIHRoZSB0aWNrIGZvciB0aGlzIHN5bWJvbFxuICAgIGlmICghZm9yZWNhc3RIaXN0b3J5W3N5bV0pIGZvcmVjYXN0SGlzdG9yeVtzeW1dID0gW107XG4gICAgY29uc3QgaGlzdCA9IGZvcmVjYXN0SGlzdG9yeVtzeW1dO1xuICAgIGhpc3QucHVzaChmKTtcbiAgICBpZiAoaGlzdC5sZW5ndGggPiBGT1JFQ0FTVF9XSU5ET1cpIGhpc3Quc2hpZnQoKTtcbiAgICBsYXN0Rm9yZWNhc3Rbc3ltXSA9IGY7XG4gIH1cblxuICBmdW5jdGlvbiByb2xsaW5nRm9yZWNhc3Qoc3ltKSB7XG4gICAgY29uc3QgaCA9IGZvcmVjYXN0SGlzdG9yeVtzeW1dO1xuICAgIGlmICghaCB8fCBoLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgbGV0IHMgPSAwO1xuICAgIGZvciAoY29uc3QgdiBvZiBoKSBzICs9IHY7XG4gICAgcmV0dXJuIHMgLyBoLmxlbmd0aDtcbiAgfVxuXG4gIC8vIFwiSGF2ZSB3ZSBzZWVuIGVub3VnaCBzYW1wbGVzIHRvIHRydXN0IHRoZSBhdmVyYWdlP1wiIFVudGlsIHRoZVxuICAvLyB3aW5kb3cgaXMgZnVsbCB3ZSBzaXQgZmxhdC4gVGhlIGZpcnN0IGZldyB0aWNrcyBhZnRlciBsYXVuY2hcbiAgLy8gd291bGQgb3RoZXJ3aXNlIGJlIGxvdy1xdWFsaXR5IHRyYWRlcy5cbiAgZnVuY3Rpb24gZm9yZWNhc3RSZWFkeShzeW0pIHtcbiAgICByZXR1cm4gZm9yZWNhc3RIaXN0b3J5W3N5bV0gJiYgZm9yZWNhc3RIaXN0b3J5W3N5bV0ubGVuZ3RoID49IEZPUkVDQVNUX1dJTkRPVztcbiAgfVxuXG4gIC8vIFNob3J0cyBhcmVuJ3QgYWx3YXlzIHVubG9ja2VkLiBXZSBwcm9iZSBPTkNFIG9uIHN0YXJ0dXAgYnlcbiAgLy8gdHJ5aW5nIHRvIG9wZW4gYSAxLXNoYXJlIHNob3J0IG9uIHRoZSBmaXJzdCB0cmFkYWJsZSBzeW1ib2w7XG4gIC8vIGlmIGJ1eVNob3J0IHJldHVybnMgMCB0aGUgc2lkZSBpcyBsb2NrZWQuIFdlIGltbWVkaWF0ZWx5IGNsb3NlXG4gIC8vIHRoZSBwcm9iZSBhbmQgcmVtZW1iZXIgdGhlIHJlc3VsdC4gUHJvYmluZyBldmVyeSB0aWNrIHdvdWxkXG4gIC8vIHNwYW0gdGhlIGxvZzsgdGhlIGFuc3dlciBkb2Vzbid0IGNoYW5nZSBhdCBydW50aW1lLlxuICBmdW5jdGlvbiBkZXRlY3RTaG9ydGFibGUoc3ltYm9scykge1xuICAgIGlmIChzeW1ib2xzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHByb2JlID0gc3ltYm9sc1swXTtcbiAgICBjb25zdCBwcmljZSA9IG5zLnN0b2NrLmdldEFza1ByaWNlKHByb2JlKTtcbiAgICBjb25zdCBiZWZvcmUgPSBucy5nZXRTZXJ2ZXJNb25leUF2YWlsYWJsZShcImhvbWVcIik7XG4gICAgY29uc3QgZ290ID0gbnMuc3RvY2suYnV5U2hvcnQocHJvYmUsIDEpO1xuICAgIGlmIChnb3QgPT09IDApIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gR290IHRoZSBzaG9ydCDigJQgY2xvc2UgaXQgaW1tZWRpYXRlbHkuXG4gICAgbnMuc3RvY2suc2VsbFNob3J0KHByb2JlLCAxKTtcbiAgICAvLyBTb21lIHF1aWNrLXJldmVydDogd2UgZG9uJ3QgYm90aGVyIHJlc3RvcmluZyB0aGUgY2FzaC4gVGhlXG4gICAgLy8gY29zdCBvZiBhIDEtc2hhcmUgc2hvcnQgYXQgdGhlIGFzayBpcyB+JHByaWNlIGFuZCB0aGVcbiAgICAvLyBjb21taXNzaW9uIGlzIHNtYWxsOyBsb3NpbmcgJHByaWNlIHRvIGxlYXJuIFwieWVzLCBJIGNhblxuICAgIC8vIHNob3J0XCIgaXMgY2hlYXAuIChBbHRlcm5hdGl2ZTogcmVhZCBnZXRTYWxlR2FpbiBmb3IgdGhlXG4gICAgLy8gZXhhY3QgY2xvc2UgY29zdCwgYnV0IHRoZSByZXN1bHQgaXMgdGhlIHNhbWUgZWl0aGVyIHdheS4pXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBMaXF1aWRhdGlvbjogY2xvc2UgdGhlIGhlbGQgcG9zaXRpb24gYXQgbWFya2V0LCBsb2cgYSBsaW5lLlxuICAvLyBSZXR1cm5zIHRydWUgaWYgdGhlcmUgV0FTIGEgcG9zaXRpb24gdG8gY2xvc2UuIFVzZXMgdGhlIGNhY2hlZFxuICAvLyBcImhlbGRcIiBtYXAgYmVjYXVzZSB0aGUgQVBJIGlzIHNsaWdodGx5IGF3a3dhcmQgKGdldFBvc2l0aW9uXG4gIC8vIHJldHVybnMgYSA0LXR1cGxlIHdlIGhhdmUgdG8gdW5wYWNrKS5cbiAgZnVuY3Rpb24gY2xvc2VQb3NpdGlvbihzeW0sIHJlYXNvbikge1xuICAgIGNvbnN0IGggPSBoZWxkW3N5bV07XG4gICAgaWYgKCFoKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGguc2lkZSA9PT0gXCJMXCIpIHtcbiAgICAgIGNvbnN0IHB4ID0gbnMuc3RvY2suc2VsbFN0b2NrKHN5bSwgaC5zaGFyZXMpO1xuICAgICAgaWYgKHB4ID4gMCkge1xuICAgICAgICBjb25zdCBwbmwgPSAocHggLSBoLmF2Z1ByaWNlKSAqIGguc2hhcmVzO1xuICAgICAgICBucy50cHJpbnQoYENMT1NFRC1sb25nICAgICR7c3ltLnBhZEVuZCg0KX0gJHtoLnNoYXJlc31AJCR7cHgudG9GaXhlZCgyKX0gIHBubD0kJHtwbmwudG9GaXhlZCgwKX0gICgke3JlYXNvbn0pYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBucy50cHJpbnQoYEZBSUwtc2VsbCAgICAgICAke3N5bX0gJHtoLnNoYXJlc30gc2hhcmVzIOKAlCBvcmRlciByZWplY3RlZGApO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBweCA9IG5zLnN0b2NrLnNlbGxTaG9ydChzeW0sIGguc2hhcmVzKTtcbiAgICAgIGlmIChweCA+IDApIHtcbiAgICAgICAgLy8gRm9yIGEgc2hvcnQsIHByb2ZpdCA9IChlbnRyeSAtIGV4aXQpICogc2hhcmVzLlxuICAgICAgICBjb25zdCBwbmwgPSAoaC5hdmdQcmljZSAtIHB4KSAqIGguc2hhcmVzO1xuICAgICAgICBucy50cHJpbnQoYENMT1NFRC1zaG9ydCAgICR7c3ltLnBhZEVuZCg0KX0gJHtoLnNoYXJlc31AJCR7cHgudG9GaXhlZCgyKX0gIHBubD0kJHtwbmwudG9GaXhlZCgwKX0gICgke3JlYXNvbn0pYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBucy50cHJpbnQoYEZBSUwtc2VsbFNob3J0ICAke3N5bX0gJHtoLnNoYXJlc30gc2hhcmVzIOKAlCBvcmRlciByZWplY3RlZGApO1xuICAgICAgfVxuICAgIH1cbiAgICBkZWxldGUgaGVsZFtzeW1dO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gT3BlbiBhIGxvbmcgb3Igc2hvcnQuIFJldHVybnMgdHJ1ZSBvbiBzdWNjZXNzLiBTaXppbmc6XG4gIC8vICAgLSBUYWtlIHRoZSBzbWFsbGVyIG9mIChydWxlLWZyYWN0aW9uICogd2FsbGV0LCBtYXgtc2hhcmVzICpcbiAgLy8gICAgIGFzayBwcmljZSkuXG4gIC8vICAgLSBUaGVuIGJvdW5kIGl0IGJ5IHRoZSBzeW1ib2wncyBtYXgtc2hhcmVzIGxpbWl0IGFuZCB0aGUgY2FzaFxuICAvLyAgICAgYWN0dWFsbHkgYXZhaWxhYmxlIChucy5zdG9jay5nZXRQdXJjaGFzZUNvc3QgaXMgdGhlIG9ubHlcbiAgLy8gICAgIGhvbmVzdCB3YXkgdG8ga25vdyBob3cgbXVjaCBhIHBvc2l0aW9uIGNvc3RzIOKAlCBpdCBhY2NvdW50c1xuICAvLyAgICAgZm9yIHNwcmVhZCBhbmQgbGFyZ2Utb3JkZXIgcHJpY2UgaW1wYWN0KS5cbiAgLy8gICAtIEZsb29yIGF0IDEgc2hhcmUgKHRoZSBBUEkgcmVxdWlyZXMgcG9zaXRpdmUpLlxuICBmdW5jdGlvbiBvcGVuTG9uZyhzeW0pIHtcbiAgICBjb25zdCBjYXNoID0gbnMuZ2V0U2VydmVyTW9uZXlBdmFpbGFibGUoXCJob21lXCIpO1xuICAgIGNvbnN0IHNwZW5kYWJsZSA9IE1hdGgubWF4KDAsIGNhc2ggLSByZXNlcnZlKSAqIChydWxlRnJhY3Rpb24gPiAwID8gcnVsZUZyYWN0aW9uIDogMSk7XG4gICAgY29uc3QgYXNrID0gbnMuc3RvY2suZ2V0QXNrUHJpY2Uoc3ltKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShhc2spIHx8IGFzayA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3Qgc3ltTWF4ID0gbnMuc3RvY2suZ2V0TWF4U2hhcmVzKHN5bSk7XG4gICAgY29uc3Qgc2hhcmVzQnlSdWxlID0gTWF0aC5mbG9vcihzcGVuZGFibGUgLyBhc2spO1xuICAgIGNvbnN0IHNoYXJlc0J5Q2FwID0gTWF0aC5taW4obWF4U2hhcmVzLCBzeW1NYXgpO1xuICAgIGxldCBzaGFyZXMgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihzaGFyZXNCeVJ1bGUsIHNoYXJlc0J5Q2FwKSk7XG4gICAgaWYgKHNoYXJlcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgLy8gUmUtY2hlY2sgdGhlIGFjdHVhbCBjb3N0IGFnYWluc3QgdGhlIHdhbGxldCAoc3ByZWFkICsgaW1wYWN0KS5cbiAgICBjb25zdCBjb3N0ID0gbnMuc3RvY2suZ2V0UHVyY2hhc2VDb3N0KHN5bSwgc2hhcmVzLCBcIkxcIik7XG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoY29zdCkgfHwgY29zdCA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGNvc3QgPiBjYXNoIC0gcmVzZXJ2ZSkge1xuICAgICAgLy8gUmUtc2l6ZSB0byB3aGF0IHdlIGNhbiBhY3R1YWxseSBhZmZvcmQuXG4gICAgICBjb25zdCBhZmZvcmRhYmxlID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoKGNhc2ggLSByZXNlcnZlKSAqIChydWxlRnJhY3Rpb24gPiAwID8gcnVsZUZyYWN0aW9uIDogMSkpIC8gYXNrKSk7XG4gICAgICBzaGFyZXMgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihhZmZvcmRhYmxlLCBzaGFyZXNCeUNhcCkpO1xuICAgICAgaWYgKHNoYXJlcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IHB4ID0gbnMuc3RvY2suYnV5U3RvY2soc3ltLCBzaGFyZXMpO1xuICAgIGlmIChweCA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgaGVsZFtzeW1dID0geyBzaWRlOiBcIkxcIiwgc2hhcmVzLCBhdmdQcmljZTogcHggfTtcbiAgICBucy50cHJpbnQoYFRSQURFLWxvbmcgICAgICR7c3ltLnBhZEVuZCg0KX0gJHtzaGFyZXN9QCQke3B4LnRvRml4ZWQoMil9ICBjb3N0PSQkeyhweCAqIHNoYXJlcykudG9GaXhlZCgwKX0gIGZvcmVjYXN0PSR7KHJvbGxpbmdGb3JlY2FzdChzeW0pID8/IDApLnRvRml4ZWQoMyl9YCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBmdW5jdGlvbiBvcGVuU2hvcnQoc3ltKSB7XG4gICAgY29uc3QgY2FzaCA9IG5zLmdldFNlcnZlck1vbmV5QXZhaWxhYmxlKFwiaG9tZVwiKTtcbiAgICBjb25zdCBzcGVuZGFibGUgPSBNYXRoLm1heCgwLCBjYXNoIC0gcmVzZXJ2ZSkgKiAocnVsZUZyYWN0aW9uID4gMCA/IHJ1bGVGcmFjdGlvbiA6IDEpO1xuICAgIGNvbnN0IGJpZCA9IG5zLnN0b2NrLmdldEJpZFByaWNlKHN5bSk7XG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoYmlkKSB8fCBiaWQgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHN5bU1heCA9IG5zLnN0b2NrLmdldE1heFNoYXJlcyhzeW0pO1xuICAgIGNvbnN0IHNoYXJlc0J5UnVsZSA9IE1hdGguZmxvb3Ioc3BlbmRhYmxlIC8gYmlkKTtcbiAgICBjb25zdCBzaGFyZXNCeUNhcCA9IE1hdGgubWluKG1heFNoYXJlcywgc3ltTWF4KTtcbiAgICBsZXQgc2hhcmVzID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2hhcmVzQnlSdWxlLCBzaGFyZXNCeUNhcCkpO1xuICAgIGlmIChzaGFyZXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGNvc3QgPSBucy5zdG9jay5nZXRQdXJjaGFzZUNvc3Qoc3ltLCBzaGFyZXMsIFwiU1wiKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjb3N0KSB8fCBjb3N0IDw9IDApIHJldHVybiBmYWxzZTtcbiAgICBpZiAoY29zdCA+IGNhc2ggLSByZXNlcnZlKSB7XG4gICAgICBjb25zdCBhZmZvcmRhYmxlID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoKGNhc2ggLSByZXNlcnZlKSAqIChydWxlRnJhY3Rpb24gPiAwID8gcnVsZUZyYWN0aW9uIDogMSkpIC8gYmlkKSk7XG4gICAgICBzaGFyZXMgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihhZmZvcmRhYmxlLCBzaGFyZXNCeUNhcCkpO1xuICAgICAgaWYgKHNoYXJlcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IHB4ID0gbnMuc3RvY2suYnV5U2hvcnQoc3ltLCBzaGFyZXMpO1xuICAgIGlmIChweCA8PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgaGVsZFtzeW1dID0geyBzaWRlOiBcIlNcIiwgc2hhcmVzLCBhdmdQcmljZTogcHggfTtcbiAgICBucy50cHJpbnQoYFRSQURFLXNob3J0ICAgICR7c3ltLnBhZEVuZCg0KX0gJHtzaGFyZXN9QCQke3B4LnRvRml4ZWQoMil9ICBjb3N0PSQkeyhweCAqIHNoYXJlcykudG9GaXhlZCgwKX0gIGZvcmVjYXN0PSR7KHJvbGxpbmdGb3JlY2FzdChzeW0pID8/IDApLnRvRml4ZWQoMyl9YCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBSZWZyZXNoIHRoZSBoZWxkIG1hcCBmcm9tIHRoZSBBUEkuIENhbGxlZCBvbmNlIHBlciB0aWNrIGJlZm9yZVxuICAvLyBkZWNpc2lvbnMuIFdlIHVzZSB0aGUgQVBJIGFzIHRoZSBzb3VyY2Ugb2YgdHJ1dGggKGluIGNhc2UgYVxuICAvLyBzZWxsIGhhcHBlbmVkIGVsc2V3aGVyZSkgYW5kIG92ZXJ3cml0ZSBvdXIgY2FjaGUuXG4gIGZ1bmN0aW9uIHJlZnJlc2hIZWxkKHN5bWJvbHMpIHtcbiAgICBoZWxkLmxlbmd0aCA9IDA7XG4gICAgZm9yIChjb25zdCBzeW0gb2Ygc3ltYm9scykge1xuICAgICAgY29uc3QgW3NoTCwgYXZnTCwgc2hTLCBhdmdTXSA9IG5zLnN0b2NrLmdldFBvc2l0aW9uKHN5bSk7XG4gICAgICBpZiAoc2hMID4gMCkgaGVsZFtzeW1dID0geyBzaWRlOiBcIkxcIiwgc2hhcmVzOiBzaEwsIGF2Z1ByaWNlOiBhdmdMIH07XG4gICAgICBlbHNlIGlmIChzaFMgPiAwKSBoZWxkW3N5bV0gPSB7IHNpZGU6IFwiU1wiLCBzaGFyZXM6IHNoUywgYXZnUHJpY2U6IGF2Z1MgfTtcbiAgICB9XG4gIH1cblxuICAvLyBUaGUgZGVjaXNpb24gcGFzcy4gT25lIHBlciBzdG9jayB0aWNrLlxuICAvLyAgIDEuIFJlZnJlc2ggaGVsZCBwb3NpdGlvbnMgZnJvbSB0aGUgQVBJLlxuICAvLyAgIDIuIEZvciBlYWNoIHN5bWJvbCwgcmVjb3JkIHRoZSBsYXRlc3QgZm9yZWNhc3QgKDRTIG1vZGUpIG9yXG4gIC8vICAgICAgbGFzdCBwcmljZSB0aWNrIChtb21lbnR1bSBtb2RlKS5cbiAgLy8gICAzLiBGb3IgZWFjaCBoZWxkIHN5bWJvbCwgY2hlY2sgdGhlIHJvbGxpbmcgZm9yZWNhc3QgYWdhaW5zdFxuICAvLyAgICAgIHRoZSBkZWFkYmFuZCBhbmQgbGlxdWlkYXRlIGlmIGl0IGZsaXBwZWQuXG4gIC8vICAgNC4gRm9yIGVhY2ggdHJhZGFibGUgc3ltYm9sIHdpdGggbm8gcG9zaXRpb24gYW5kIGFcbiAgLy8gICAgICByZWFkeSBmb3JlY2FzdCwgb3BlbiBhIGxvbmcvc2hvcnQgaWYgdGhlIHNpZ25hbCBpcyBzdHJvbmdcbiAgLy8gICAgICBlbm91Z2guXG4gIGZ1bmN0aW9uIHBhc3Moc2hvcnRhYmxlKSB7XG4gICAgY29uc3Qgc3ltYm9scyA9IG5zLnN0b2NrLmdldFN5bWJvbHMoKTtcbiAgICByZWZyZXNoSGVsZChzeW1ib2xzKTtcbiAgICBjb25zdCBjb3VudGVycyA9IHsgdXBkYXRlZDogMCwgY2xvc2VkOiAwLCBvcGVuZWQ6IDAsIHNraXBwZWQ6IDAgfTtcblxuICAgIGZvciAoY29uc3Qgc3ltIG9mIHN5bWJvbHMpIHtcbiAgICAgIGlmIChoYXM0Uykge1xuICAgICAgICBjb25zdCBmID0gbnMuc3RvY2suZ2V0Rm9yZWNhc3Qoc3ltKTtcbiAgICAgICAgcmVjb3JkRm9yZWNhc3Qoc3ltLCBmKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIE1vbWVudHVtIGZhbGxiYWNrOiBQKGZvcmVjYXN0ID0gMC41KSBhdCBldmVyeSB0aWNrLCBidXRcbiAgICAgICAgLy8gd2UgQ0FOIHNlZSBpZiB0aGUgcHJpY2UgbW92ZWQgdXAgb3IgZG93biB2cyB0aGUgcHJldmlvdXNcbiAgICAgICAgLy8gdGljay4gQSBcIjBcIiBtb3ZlIG9yIGZpcnN0LXRpY2sgKG5vIHByZXZpb3VzKSBnZXRzIGFcbiAgICAgICAgLy8gbmV1dHJhbCAwLjUuIFRoaXMgcHJvZHVjZXMgbG90cyBvZiBub2lzZSB0cmFkZXMsIHdoaWNoXG4gICAgICAgIC8vIGlzIHdoeSA0UyBpcyBzbyBpbXBvcnRhbnQuXG4gICAgICAgIGNvbnN0IGN1ciA9IG5zLnN0b2NrLmdldFByaWNlKHN5bSk7XG4gICAgICAgIGNvbnN0IHByZXYgPSBsYXN0Rm9yZWNhc3Rbc3ltXSA/PyBjdXI7XG4gICAgICAgIGNvbnN0IG1vdmVkID0gY3VyIC0gcHJldjtcbiAgICAgICAgY29uc3QgZiA9IDAuNSArIE1hdGgubWF4KC0wLjUsIE1hdGgubWluKDAuNSwgbW92ZWQgLyBNYXRoLm1heCgxLCBwcmV2KSAqIDEwKSk7XG4gICAgICAgIHJlY29yZEZvcmVjYXN0KHN5bSwgZik7XG4gICAgICB9XG4gICAgICBjb3VudGVycy51cGRhdGVkKys7XG4gICAgfVxuXG4gICAgaWYgKHZlcmJvc2UpIHtcbiAgICAgIGZvciAoY29uc3Qgc3ltIG9mIHN5bWJvbHMpIHtcbiAgICAgICAgY29uc3QgcmYgPSByb2xsaW5nRm9yZWNhc3Qoc3ltKTtcbiAgICAgICAgY29uc3QgbGYgPSBsYXN0Rm9yZWNhc3Rbc3ltXTtcbiAgICAgICAgY29uc3Qgc2lkZSA9IGhlbGRbc3ltXSA/IGAke2hlbGRbc3ltXS5zaWRlfUAke2hlbGRbc3ltXS5hdmdQcmljZS50b0ZpeGVkKDIpfWAgOiBcImZsYXRcIjtcbiAgICAgICAgbnMudHByaW50KGBmb3JlY2FzdCAke3N5bS5wYWRFbmQoNCl9IHJvbGw9JHsocmYgPz8gMCkudG9GaXhlZCgzKX0gbGFzdD0keyhsZiA/PyAwKS50b0ZpeGVkKDMpfSBwb3M9JHtzaWRlfSB3YWxsZXQ9JCR7bnMuZ2V0U2VydmVyTW9uZXlBdmFpbGFibGUoXCJob21lXCIpLnRvRml4ZWQoMCl9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gU3RlcCAzOiBjbG9zZSBwb3NpdGlvbnMgd2hvc2UgZm9yZWNhc3QgaGFzIGZsaXBwZWQuXG4gICAgZm9yIChjb25zdCBzeW0gb2Ygc3ltYm9scykge1xuICAgICAgY29uc3QgaCA9IGhlbGRbc3ltXTtcbiAgICAgIGlmICghaCkgY29udGludWU7XG4gICAgICBpZiAoIWZvcmVjYXN0UmVhZHkoc3ltKSkgY29udGludWU7ICAvLyBub3QgZW5vdWdoIGRhdGEg4oCUIGRvbid0IHRvdWNoXG4gICAgICBjb25zdCByZiA9IHJvbGxpbmdGb3JlY2FzdChzeW0pO1xuICAgICAgLy8gQSBsb25nIGlzIGhhcHB5IHdoZW4gZm9yZWNhc3QgaXMgYWJvdmUgLS1idWxsLiBBIHNob3J0IGlzXG4gICAgICAvLyBoYXBweSB3aGVuIGZvcmVjYXN0IGlzIGJlbG93IC0tYmVhci4gQW55dGhpbmcgaW4gYmV0d2VlblxuICAgICAgLy8gaXMgXCJub2lzZVwiIOKAlCBob2xkLiBQYXN0IHRoZSBkZWFkYmFuZCBpbiB0aGUgT1RIRVJcbiAgICAgIC8vIGRpcmVjdGlvbiBpcyB0aGUgbGlxdWlkYXRpb24gdHJpZ2dlci5cbiAgICAgIGlmIChoLnNpZGUgPT09IFwiTFwiICYmIHJmIDwgYmVhcikge1xuICAgICAgICBpZiAoY2xvc2VQb3NpdGlvbihzeW0sIGBmb3JlY2FzdCAke3JmLnRvRml4ZWQoMyl9IDwgJHtiZWFyfWApKSBjb3VudGVycy5jbG9zZWQrKztcbiAgICAgIH0gZWxzZSBpZiAoaC5zaWRlID09PSBcIlNcIiAmJiByZiA+IGJ1bGwpIHtcbiAgICAgICAgaWYgKGNsb3NlUG9zaXRpb24oc3ltLCBgZm9yZWNhc3QgJHtyZi50b0ZpeGVkKDMpfSA+ICR7YnVsbH1gKSkgY291bnRlcnMuY2xvc2VkKys7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gU3RlcCA0OiBvcGVuIG5ldyBwb3NpdGlvbnMgb24gdHJhZGFibGUgc3ltYm9scyB3aXRoIG5vXG4gICAgLy8gY3VycmVudCBwb3NpdGlvbiBhbmQgYSByZWFkeSBmb3JlY2FzdC5cbiAgICBmb3IgKGNvbnN0IHN5bSBvZiBzeW1ib2xzKSB7XG4gICAgICBpZiAoaGVsZFtzeW1dKSBjb250aW51ZTsgIC8vIGFscmVhZHkgaW4gYSBwb3NpdGlvblxuICAgICAgaWYgKCFmb3JlY2FzdFJlYWR5KHN5bSkpIHtcbiAgICAgICAgY291bnRlcnMuc2tpcHBlZCsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJmID0gcm9sbGluZ0ZvcmVjYXN0KHN5bSk7XG4gICAgICBpZiAocmYgPiBidWxsKSB7XG4gICAgICAgIGlmIChvcGVuTG9uZyhzeW0pKSBjb3VudGVycy5vcGVuZWQrKztcbiAgICAgIH0gZWxzZSBpZiAocmYgPCBiZWFyICYmIHNob3J0YWJsZSkge1xuICAgICAgICBpZiAob3BlblNob3J0KHN5bSkpIGNvdW50ZXJzLm9wZW5lZCsrO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjb3VudGVycztcbiAgfVxuXG4gIC8vIERldGVjdCBzaG9ydGluZyBvbmNlIGF0IHN0YXJ0dXAuIERvbmUgT1VUU0lERSBwYXNzKCkgYmVjYXVzZVxuICAvLyBwcm9iaW5nIGV2ZXJ5IHRpY2sgaXMgd2FzdGVmdWwgYW5kIG5vaXN5LlxuICBjb25zdCBzeW1ib2xzMCA9IG5zLnN0b2NrLmdldFN5bWJvbHMoKTtcbiAgY29uc3Qgc2hvcnRhYmxlID0gZGV0ZWN0U2hvcnRhYmxlKHN5bWJvbHMwKTtcbiAgaWYgKHZlcmJvc2UpIHtcbiAgICBucy50cHJpbnQoYG1vbml0b3Itc3RvY2s6IHNob3J0YWJsZT0ke3Nob3J0YWJsZX0sIDRTPSR7aGFzNFN9LCBzeW1ib2xzPSR7c3ltYm9sczAubGVuZ3RofSwgcmVzZXJ2ZT0kJHtyZXNlcnZlLnRvRml4ZWQoMCl9LCBydWxlPSR7KHJ1bGVGcmFjdGlvbiAqIDEwMCkudG9GaXhlZCgwKX0lYCk7XG4gIH1cbiAgLy8gLS1vbmNlIG1lYW5zIFwiZG8gYSBzaW5nbGUgZGVjaXNpb24gcGFzcyBhbmQgZXhpdFwiLiAtLW9uY2UgaXMgYVxuICAvLyBkaWFnbm9zdGljIOKAlCB0aGUgc2NyaXB0IG1heSBjbG9zZSBwb3NpdGlvbnMgZXZlbiBvbiB0aGUgZmlyc3RcbiAgLy8gdGljaywgd2hpY2ggaXMgZmluZSAoYW5kIHN1cnByaXNpbmcpLiBUaGUgaW50ZW50IG9mIC0tb25jZSBpc1xuICAvLyBcInNob3cgbWUgd2hhdCB3b3VsZCBoYXBwZW5cIiBub3QgXCJiZSBzYWZlXCIuXG4gIGlmIChvbmNlKSB7XG4gICAgcGFzcyhzaG9ydGFibGUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIG5zLnRwcmludChgbW9uaXRvci1zdG9jazogc3RhcnRlZCwgc2hvcnRhYmxlPSR7c2hvcnRhYmxlfSwgNFM9JHtoYXM0U30sIGJ1bGw9JHtidWxsfSwgYmVhcj0ke2JlYXJ9LCBydWxlPSR7KHJ1bGVGcmFjdGlvbiAqIDEwMCkudG9GaXhlZCgwKX0lLCByZXNlcnZlPSQke3Jlc2VydmUudG9GaXhlZCgwKX0sIG91dHB1dD0ke3ZlcmJvc2UgPyBcInZlcmJvc2VcIiA6IFwicXVpZXRcIn1gKTtcbiAgLy8gTWFpbiBsb29wLiBUaGUgY2FkZW5jZSBpcyBzZXQgYnkgbnMuc3RvY2submV4dFVwZGF0ZSgpLCB3aGljaFxuICAvLyByZXNvbHZlcyBvbmNlIHBlciBzdG9jayB0aWNrICh+NC02cyByZWFsIHRpbWUsIGZhc3RlciB3aXRoXG4gIC8vIGJvbnVzIHRpbWUpLiBXZSBkb24ndCBzbGVlcCBhIGZpeGVkIGludGVydmFsIGJlY2F1c2UgKGEpIHRoZVxuICAvLyBnYW1lIGFscmVhZHkgdGVsbHMgdXMgd2hlbiBhIG5ldyB0aWNrIGlzIHJlYWR5LCBhbmQgKGIpIHRpZ2h0XG4gIC8vIGZpeGVkLWludGVydmFsIHBvbGxpbmcgd291bGQgYnVybiBSQU0gYW5kIHByb2R1Y2UgZHVwbGljYXRlXG4gIC8vIHNpZ25hbHMgKHRoZSBmb3JlY2FzdCBhbmQgcHJpY2Ugb25seSBjaGFuZ2Ugb24gYSBzdG9jayB0aWNrKS5cbiAgd2hpbGUgKHRydWUpIHtcbiAgICBhd2FpdCBucy5zdG9jay5uZXh0VXBkYXRlKCk7XG4gICAgcGFzcyhzaG9ydGFibGUpO1xuICB9XG59XG4iXX0=