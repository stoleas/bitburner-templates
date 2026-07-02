# Bitburner — Unlock Everything

A practical roadmap for taking a fresh save from "just bought the game" to
"every faction, every aug, every BitNode-1 ending." The scripts in `src/`
implement the early/mid-game pieces; this doc is the destination map.

## What this template ships

| File                  | Role                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| `src/nuke.js`         | Open every port you have programs for and `nuke` the whole reachable network.         |
| `src/buy-monitor.js`  | Watch the darkweb for new `*.exe` (port-openers, AutoLink, DeepScan) and auto-chain.  |
| `src/deploy.js`       | Fan a worker script out to every rooted, in-level, non-purchased target server.       |
| `src/n00dles.js`      | Single-target early-game H/G/W loop (target = arg, defaults to `n00dles`).            |
| `src/early-hack.ts`   | Same as `n00dles.js` but auto-discovers all valid targets and BFS-rescans.            |
| `src/hack-loop.ts`    | HWGW batched loop with deterministic sleeps (tutorial's "sleeve-stable" pattern).     |
| `src/stat-train.js`   | Singularity-driven stat training (gym + university, with city auto-travel).           |
| `src/script-ram.js`   | Diagnostic: list every running script, threads, and per-host RAM totals.              |
| `src/template.ts`     | Hello-world stub for the Remote API.                                                   |

Dev infra: `npm run watch` does TypeScript transpile + local filesync + the
in-game `bitburner-filesync` (port 12525). `start.sh` brings the whole
loop up (Podman game container + tmux filesync).

## Unlock phases

### Phase 1 — Get rooted (hack ≤ ~50)

1. `run nuke.js`                # root every reachable host you can.
2. `run early-hack.js`          # auto-prep + hack all in-level targets.
3. **Buy from the darkweb** as you can afford it. `buy-monitor.js` will
   detect each new `.exe` landing on home and re-run `nuke.js` +
   `deploy.js`, so you don't have to babysit the terminal.

   Priority order (cheapest / biggest unlock first):
   - `BruteSSH.exe`     (50k)
   - `FTPCrack.exe`     (1.5M)
   - `relaySMTP.exe`    (5M)
   - `HTTPWorm.exe`     (30M)
   - `SQLInject.exe`    (250M)
   - `AutoLink.exe`     (not a port-opener, but lets `scan-analyze` reach
     back across the network — handy once CSEC/avmnite-04 etc. are in range)

4. `run stat-train.js hack`    # hacking from a university is +5/20min or so;
   park the character at `Sector12RothmanUniversity` and let it ride while
   you do other things.

5. Backdoor CSEC, avmnite-04, I.I.I.I, runtheNET, The-Cave, foodnstuff,
   sigma-cosmetics, joesguns, hong-fang-tea, max-hardware, n00dles, —
   each one unlocks factions and factions unlock augs.

### Phase 2 — Factions + rep (the `ns.share()` phase)

Joining a faction takes reputation, and reputation takes *time* unless
you actively farm it. Two accelerators:

1. **`ns.share()` for faction rep.** Every 10 seconds of sharing gives a
   multiplier to *faction reputation gain*. A small daemon that loops
   `ns.share()` on home (and fans copies out to rooted purchased servers
   / `home` RAM) keeps the boost permanently active while you idle. Cheap
   RAM cost (~4 GB on home) for a big rep multiplier.

2. **Install programs at factions.** Once you have a faction invitation,
   install the right program (`nuke`, `autoLink`, etc.) for a +1 rep per
   install — small but free.

The chain that justifies `ns.share()`: faster faction rep → faster faction
augment installs (NeuroFlux Governor in particular is a permanent
multiplier that compounds every reset) → much faster everything else.

### Phase 3 — Augments (the real mid-game)

This is where the numbers start mattering:

- **NeuroFlux Governor** is the single most important aug. It's a
  permanent, stackable multiplier you buy from the BN faction every reset.
  Install it as soon as you can afford it; *never* soft-reset before
  buying it.
- Source factions (in roughly this order, easier to harder):
  - `NetSec`     — CSEC backdoor
  - `Tian Di Hui`— Hong-Fang-Tea backdoor
  - `Slum Snakes`— join via crime, easy rep
  - `The Black Hand` — BitRunners backdoor
  - `BitRunners` — by hacking
  - `The Dark Army` — Joesguns backdoor
  - `Daedalus`   — requires 100% factions joined + Red Pill in BN-1
- Once you can afford them: `CodonForge`, `NeuroFlux`, `CashRoot`,
  `QL`, `CRTX42-LEAF`, `PCMatrix`, `Neuralns`. Each stacks.

### Phase 4 — Home RAM, purchased servers, and the share-power loop

Home RAM is the bottleneck for `ns.share()` output. Three knobs:

1. **Buy home RAM upgrades** when you can afford them. Early-game, every
   8 GB quadruples your share-power contribution.
2. **Buy/purchase servers up to your home RAM cap** (one purchased server
   per 8 GB of home). Each one is a host you can `ns.share()` on.
3. **Cluster size and Hacknet** are the "passive income" axis. By mid-game
   you can skip Hacknet entirely in favor of stocks + hacking.

### Phase 5 — Hacknet → Stocks → Bladeburner

- **Hacknet Nodes** are the very early passive income. They taper off.
- **Stock Market** (WSE + TIX) becomes the main money maker once you have
  4Sigs / 4S Market Data aug. Buy low, short the opposite, repeat.
- **Bladeburner** is a Blade-Runner-style minigame that's a huge source of
  blade-burner-specific augs (Str/Def/Dex/Agi multipliers, stamina, etc.).
  Worth unlocking as soon as it's offered; runs in the background.

### Phase 6 — BitNodes (the meta-game)

Each `BitNode X.exe` you destroy is a permanent +1% multiplier to some
stat, and resets the rest of the game. The plan:

- **BN-1** (the default) — finish it. The "Red Pill" aug from Daedalus is
  only obtainable here.
- **BN-2** — +1% hacking XP. Good second run.
- **BN-4** — gives the **Singularity API** permanently from then on.
  Huge QoL: `ns.singularity` lets you automate *everything* (work,
  crime, programs, faction work, sleeves).
- **BN-5** — int +1%. Intelligence is overpowered.
- **BN-6** — Whittaker's chain. Hard.
- **BN-12** — Sleeve augs. Sleeves are your second set of bodies; with
  the right augs you can run an entire operation in parallel.
- **BN-13** — +1% to all stats from every source forever. Insane.

The meta-rule: don't reset into a new BitNode until you've bought every
augment the current BN factions will sell you, and run **Stanek's
gift-from-the-future** algorithms until your BN multiplier is maxed.

## Daily loop (the boring-but-correct version)

```
run buy-monitor.js                  # one-shot, in tmux
run nuke.js                         # after each new darkweb program
run deploy.js hack-loop.js          # fan the batched loop to every rooted host
run early-hack.js                   # auto-discover + prep any new targets
run stat-train.js hack              # background university work
# share daemon, if added
```

When you can afford a Hacknet Node, buy one. When you can afford a
home RAM upgrade, buy one. When you can afford a stock-portfolio
aug, buy it. The boring path is the right path; the wilder
`ns.formulas`-tuned batcher scripts save you maybe 20% throughput, not
the 5×-and-completion the Reddit posts imply.

## Scripting TODO (in roughly priority order)

- [ ] `src/share.js` — small `ns.share()` daemon on home + fan-out to
      rooted purchased servers; refreshes every 9s so the 10s boost
      never lapses.
- [ ] `src/hwsg.js` — `hack-loop.js` but with `ns.formulas.hacking.*`
      to size thread counts exactly. ~30% more efficient than the
      fixed-ratio version in `hack-loop.ts`.
- [ ] `src/stocks.js` — TIX long/short loop with 4S market-data
      precondition. Doesn't run until 4S Market Data is installed.
- [ ] `src/bladeburner.js` — `ns.bladeburner` automation. Pick the
      highest-XP-to-stamina-cost action and run it.
- [ ] `src/sleeves.js` — once SF-12 is unlocked, run a sleeve that
      trains stats and one that does Bladeburner.
- [ ] `src/augments.js` — once `ns.singularity` is permanent, an
      "install everything I can afford" re-runnable script.

## Sources / further reading

- The in-game tutorial's "First Script" and "Hack & Grow" sections.
- The Beginners Guide on the official wiki (networks, nuke flow).
- The Bitburner Discord's `#strategy` for the current meta on
  BitNode order and aug prioritization.
