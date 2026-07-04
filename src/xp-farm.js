/** @param {NS} ns */
//
// xp-farm.js — pure hacking-XP loop.
//
// Runs on home (or any worker with spare RAM) at max threads, calling
// ns.hack() on a small target in a tight loop. hack() XP scales with
// money stolen, so we want a target with:
//
//   - Low requiredHackingSkill (so we can run it always)
//   - Decent moneyMax (so each hack is non-trivial)
//   - Low security (so the script isn't throttled)
//
// Targets, in order of preference:
//   n00dles     (hack req 1, moneyMax $1.75k, sec 1)   — first choice
//   foodnstuff  (hack req 1, moneyMax $2M, sec 10)      — fallback when n00dles is too small
//
// We do NOT batch — this script's job is to maximize hack() invocations,
// not minimize security drift. The HWGW manager handles security on the
// real targets; xp-farm is a separate process on a separate target.
//
// RAM cost: this script's own RAM, ~2-3 GB. Run with max threads on the
// calling server (default: home).
//
// Usage:
//   run xp-farm.js             # n00dles (default)
//   run xp-farm.js foodnstuff  # explicit target
//
// Note: don't add this to master.js supervision. xp-farm is a personal-
// economy loop the player controls manually; auto-restart on aug would
// make it impossible to stop grinding when you want to focus elsewhere.
//
const TARGETS_BY_FALLBACK = ["n00dles", "foodnstuff"];

export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("hack");
  const wanted = ns.args[0]?.toString();
  const target = wanted ?? TARGETS_BY_FALLBACK[0];

  // Make sure we have root. n00dles and foodnstuff both need 0 ports,
  // so a single nuke is enough.
  if (!ns.hasRootAccess(target)) ns.nuke(target);

  // RAM cost: xp-farm script itself. Run with max threads on the
  // calling server (typically home). We use Math.floor on the
  // free/thread ratio to avoid wasting a whole thread's RAM.
  const ramPerThread = ns.getScriptRam("xp-farm.js", "home");
  const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  const threads = Math.max(1, Math.floor(free / ramPerThread));
  if (threads < 1 || ramPerThread <= 0) {
    ns.tprint(`xp-farm: no free RAM on home (${free.toFixed(2)} GB free, needs ${ramPerThread.toFixed(2)} GB) — exiting`);
    return;
  }

  // ns.hack is blocking; we just call it in a tight loop. Each call
  // lasts hackTime(target) ms. We don't batch — this script's job is
  // to maximize hack() invocations, not minimize security drift.
  ns.tprint(`xp-farm: target=${target} threads=${threads} ram=${(threads * ramPerThread).toFixed(1)}GB`);
  while (true) {
    await ns.hack(target);
  }
}
