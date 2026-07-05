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
    if (!ns.hasRootAccess(target))
        ns.nuke(target);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoieHAtZmFybS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy94cC1mYXJtLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YscUNBQXFDO0FBQ3JDLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUscUVBQXFFO0FBQ3JFLDBDQUEwQztBQUMxQyxFQUFFO0FBQ0YseURBQXlEO0FBQ3pELG9EQUFvRDtBQUNwRCxtREFBbUQ7QUFDbkQsRUFBRTtBQUNGLG1DQUFtQztBQUNuQyxzRUFBc0U7QUFDdEUsNkZBQTZGO0FBQzdGLEVBQUU7QUFDRix5RUFBeUU7QUFDekUsd0VBQXdFO0FBQ3hFLG9FQUFvRTtBQUNwRSxFQUFFO0FBQ0Ysd0VBQXdFO0FBQ3hFLGtDQUFrQztBQUNsQyxFQUFFO0FBQ0YsU0FBUztBQUNULG1EQUFtRDtBQUNuRCxpREFBaUQ7QUFDakQsRUFBRTtBQUNGLHdFQUF3RTtBQUN4RSx1RUFBdUU7QUFDdkUsd0VBQXdFO0FBQ3hFLEVBQUU7QUFDRixNQUFNLG1CQUFtQixHQUFHLENBQUMsU0FBUyxFQUFFLFlBQVksQ0FBQyxDQUFDO0FBRXRELE1BQU0sQ0FBQyxLQUFLLFVBQVUsSUFBSSxDQUFDLEVBQUU7SUFDM0IsRUFBRSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN2QixFQUFFLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3RCLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsUUFBUSxFQUFFLENBQUM7SUFDdEMsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLG1CQUFtQixDQUFDLENBQUMsQ0FBQyxDQUFDO0lBRWhELG9FQUFvRTtJQUNwRSw4QkFBOEI7SUFDOUIsSUFBSSxDQUFDLEVBQUUsQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDO1FBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUUvQywrREFBK0Q7SUFDL0QsNERBQTREO0lBQzVELDJEQUEyRDtJQUMzRCxNQUFNLFlBQVksR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLFlBQVksRUFBRSxNQUFNLENBQUMsQ0FBQztJQUMzRCxNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN0RSxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksR0FBRyxZQUFZLENBQUMsQ0FBQyxDQUFDO0lBQzdELElBQUksT0FBTyxHQUFHLENBQUMsSUFBSSxZQUFZLElBQUksQ0FBQyxFQUFFO1FBQ3BDLEVBQUUsQ0FBQyxNQUFNLENBQUMsaUNBQWlDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLG1CQUFtQixZQUFZLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3RILE9BQU87S0FDUjtJQUVELGtFQUFrRTtJQUNsRSxtRUFBbUU7SUFDbkUsK0RBQStEO0lBQy9ELEVBQUUsQ0FBQyxNQUFNLENBQUMsbUJBQW1CLE1BQU0sWUFBWSxPQUFPLFFBQVEsQ0FBQyxPQUFPLEdBQUcsWUFBWSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2RyxPQUFPLElBQUksRUFBRTtRQUNYLE1BQU0sRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztLQUN2QjtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyB4cC1mYXJtLmpzIOKAlCBwdXJlIGhhY2tpbmctWFAgbG9vcC5cbi8vXG4vLyBSdW5zIG9uIGhvbWUgKG9yIGFueSB3b3JrZXIgd2l0aCBzcGFyZSBSQU0pIGF0IG1heCB0aHJlYWRzLCBjYWxsaW5nXG4vLyBucy5oYWNrKCkgb24gYSBzbWFsbCB0YXJnZXQgaW4gYSB0aWdodCBsb29wLiBoYWNrKCkgWFAgc2NhbGVzIHdpdGhcbi8vIG1vbmV5IHN0b2xlbiwgc28gd2Ugd2FudCBhIHRhcmdldCB3aXRoOlxuLy9cbi8vICAgLSBMb3cgcmVxdWlyZWRIYWNraW5nU2tpbGwgKHNvIHdlIGNhbiBydW4gaXQgYWx3YXlzKVxuLy8gICAtIERlY2VudCBtb25leU1heCAoc28gZWFjaCBoYWNrIGlzIG5vbi10cml2aWFsKVxuLy8gICAtIExvdyBzZWN1cml0eSAoc28gdGhlIHNjcmlwdCBpc24ndCB0aHJvdHRsZWQpXG4vL1xuLy8gVGFyZ2V0cywgaW4gb3JkZXIgb2YgcHJlZmVyZW5jZTpcbi8vICAgbjAwZGxlcyAgICAgKGhhY2sgcmVxIDEsIG1vbmV5TWF4ICQxLjc1aywgc2VjIDEpICAg4oCUIGZpcnN0IGNob2ljZVxuLy8gICBmb29kbnN0dWZmICAoaGFjayByZXEgMSwgbW9uZXlNYXggJDJNLCBzZWMgMTApICAgICAg4oCUIGZhbGxiYWNrIHdoZW4gbjAwZGxlcyBpcyB0b28gc21hbGxcbi8vXG4vLyBXZSBkbyBOT1QgYmF0Y2gg4oCUIHRoaXMgc2NyaXB0J3Mgam9iIGlzIHRvIG1heGltaXplIGhhY2soKSBpbnZvY2F0aW9ucyxcbi8vIG5vdCBtaW5pbWl6ZSBzZWN1cml0eSBkcmlmdC4gVGhlIEhXR1cgbWFuYWdlciBoYW5kbGVzIHNlY3VyaXR5IG9uIHRoZVxuLy8gcmVhbCB0YXJnZXRzOyB4cC1mYXJtIGlzIGEgc2VwYXJhdGUgcHJvY2VzcyBvbiBhIHNlcGFyYXRlIHRhcmdldC5cbi8vXG4vLyBSQU0gY29zdDogdGhpcyBzY3JpcHQncyBvd24gUkFNLCB+Mi0zIEdCLiBSdW4gd2l0aCBtYXggdGhyZWFkcyBvbiB0aGVcbi8vIGNhbGxpbmcgc2VydmVyIChkZWZhdWx0OiBob21lKS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgcnVuIHhwLWZhcm0uanMgICAgICAgICAgICAgIyBuMDBkbGVzIChkZWZhdWx0KVxuLy8gICBydW4geHAtZmFybS5qcyBmb29kbnN0dWZmICAjIGV4cGxpY2l0IHRhcmdldFxuLy9cbi8vIE5vdGU6IGRvbid0IGFkZCB0aGlzIHRvIG1hc3Rlci5qcyBzdXBlcnZpc2lvbi4geHAtZmFybSBpcyBhIHBlcnNvbmFsLVxuLy8gZWNvbm9teSBsb29wIHRoZSBwbGF5ZXIgY29udHJvbHMgbWFudWFsbHk7IGF1dG8tcmVzdGFydCBvbiBhdWcgd291bGRcbi8vIG1ha2UgaXQgaW1wb3NzaWJsZSB0byBzdG9wIGdyaW5kaW5nIHdoZW4geW91IHdhbnQgdG8gZm9jdXMgZWxzZXdoZXJlLlxuLy9cbmNvbnN0IFRBUkdFVFNfQllfRkFMTEJBQ0sgPSBbXCJuMDBkbGVzXCIsIFwiZm9vZG5zdHVmZlwiXTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnMpIHtcbiAgbnMuZGlzYWJsZUxvZyhcInNsZWVwXCIpO1xuICBucy5kaXNhYmxlTG9nKFwiaGFja1wiKTtcbiAgY29uc3Qgd2FudGVkID0gbnMuYXJnc1swXT8udG9TdHJpbmcoKTtcbiAgY29uc3QgdGFyZ2V0ID0gd2FudGVkID8/IFRBUkdFVFNfQllfRkFMTEJBQ0tbMF07XG5cbiAgLy8gTWFrZSBzdXJlIHdlIGhhdmUgcm9vdC4gbjAwZGxlcyBhbmQgZm9vZG5zdHVmZiBib3RoIG5lZWQgMCBwb3J0cyxcbiAgLy8gc28gYSBzaW5nbGUgbnVrZSBpcyBlbm91Z2guXG4gIGlmICghbnMuaGFzUm9vdEFjY2Vzcyh0YXJnZXQpKSBucy5udWtlKHRhcmdldCk7XG5cbiAgLy8gUkFNIGNvc3Q6IHhwLWZhcm0gc2NyaXB0IGl0c2VsZi4gUnVuIHdpdGggbWF4IHRocmVhZHMgb24gdGhlXG4gIC8vIGNhbGxpbmcgc2VydmVyICh0eXBpY2FsbHkgaG9tZSkuIFdlIHVzZSBNYXRoLmZsb29yIG9uIHRoZVxuICAvLyBmcmVlL3RocmVhZCByYXRpbyB0byBhdm9pZCB3YXN0aW5nIGEgd2hvbGUgdGhyZWFkJ3MgUkFNLlxuICBjb25zdCByYW1QZXJUaHJlYWQgPSBucy5nZXRTY3JpcHRSYW0oXCJ4cC1mYXJtLmpzXCIsIFwiaG9tZVwiKTtcbiAgY29uc3QgZnJlZSA9IG5zLmdldFNlcnZlck1heFJhbShcImhvbWVcIikgLSBucy5nZXRTZXJ2ZXJVc2VkUmFtKFwiaG9tZVwiKTtcbiAgY29uc3QgdGhyZWFkcyA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IoZnJlZSAvIHJhbVBlclRocmVhZCkpO1xuICBpZiAodGhyZWFkcyA8IDEgfHwgcmFtUGVyVGhyZWFkIDw9IDApIHtcbiAgICBucy50cHJpbnQoYHhwLWZhcm06IG5vIGZyZWUgUkFNIG9uIGhvbWUgKCR7ZnJlZS50b0ZpeGVkKDIpfSBHQiBmcmVlLCBuZWVkcyAke3JhbVBlclRocmVhZC50b0ZpeGVkKDIpfSBHQikg4oCUIGV4aXRpbmdgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBucy5oYWNrIGlzIGJsb2NraW5nOyB3ZSBqdXN0IGNhbGwgaXQgaW4gYSB0aWdodCBsb29wLiBFYWNoIGNhbGxcbiAgLy8gbGFzdHMgaGFja1RpbWUodGFyZ2V0KSBtcy4gV2UgZG9uJ3QgYmF0Y2gg4oCUIHRoaXMgc2NyaXB0J3Mgam9iIGlzXG4gIC8vIHRvIG1heGltaXplIGhhY2soKSBpbnZvY2F0aW9ucywgbm90IG1pbmltaXplIHNlY3VyaXR5IGRyaWZ0LlxuICBucy50cHJpbnQoYHhwLWZhcm06IHRhcmdldD0ke3RhcmdldH0gdGhyZWFkcz0ke3RocmVhZHN9IHJhbT0keyh0aHJlYWRzICogcmFtUGVyVGhyZWFkKS50b0ZpeGVkKDEpfUdCYCk7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgYXdhaXQgbnMuaGFjayh0YXJnZXQpO1xuICB9XG59XG4iXX0=