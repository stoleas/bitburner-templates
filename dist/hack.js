/** @param {NS} ns */
//
// Single-op worker. Takes target as only arg. One hack() call, then exit.
// Used by manager.js in an HWGW batch — never run this on its own.
//
// RAM cost: ~1.75 GB.
//
// Usage:
//   run hack.js <target>
//   run hack.js phantasy
//
export async function main(ns) {
    const target = ns.args[0]?.toString();
    if (!target) {
        ns.tprint("hack: missing target arg");
        return;
    }
    // We deliberately do NOT wrap ns.hack in a try/catch — let any
    // errors throw, so the manager (and the user) can see the real
    // reason the worker died in the in-game log. If the worker
    // runs for ~1-2s and disappears, look at the hack.js process
    // log: it'll show the actual ns.hack failure.
    await ns.hack(target);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9oYWNrLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsMEVBQTBFO0FBQzFFLG1FQUFtRTtBQUNuRSxFQUFFO0FBQ0Ysc0JBQXNCO0FBQ3RCLEVBQUU7QUFDRixTQUFTO0FBQ1QseUJBQXlCO0FBQ3pCLHlCQUF5QjtBQUN6QixFQUFFO0FBQ0YsTUFBTSxDQUFDLEtBQUssVUFBVSxJQUFJLENBQUMsRUFBRTtJQUMzQixNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxNQUFNLEVBQUU7UUFDWCxFQUFFLENBQUMsTUFBTSxDQUFDLDBCQUEwQixDQUFDLENBQUM7UUFDdEMsT0FBTztLQUNSO0lBQ0QsK0RBQStEO0lBQy9ELCtEQUErRDtJQUMvRCwyREFBMkQ7SUFDM0QsNkRBQTZEO0lBQzdELDhDQUE4QztJQUM5QyxNQUFNLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDeEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBAcGFyYW0ge05TfSBucyAqL1xuLy9cbi8vIFNpbmdsZS1vcCB3b3JrZXIuIFRha2VzIHRhcmdldCBhcyBvbmx5IGFyZy4gT25lIGhhY2soKSBjYWxsLCB0aGVuIGV4aXQuXG4vLyBVc2VkIGJ5IG1hbmFnZXIuanMgaW4gYW4gSFdHVyBiYXRjaCDigJQgbmV2ZXIgcnVuIHRoaXMgb24gaXRzIG93bi5cbi8vXG4vLyBSQU0gY29zdDogfjEuNzUgR0IuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIHJ1biBoYWNrLmpzIDx0YXJnZXQ+XG4vLyAgIHJ1biBoYWNrLmpzIHBoYW50YXN5XG4vL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4obnMpIHtcbiAgY29uc3QgdGFyZ2V0ID0gbnMuYXJnc1swXT8udG9TdHJpbmcoKTtcbiAgaWYgKCF0YXJnZXQpIHtcbiAgICBucy50cHJpbnQoXCJoYWNrOiBtaXNzaW5nIHRhcmdldCBhcmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFdlIGRlbGliZXJhdGVseSBkbyBOT1Qgd3JhcCBucy5oYWNrIGluIGEgdHJ5L2NhdGNoIOKAlCBsZXQgYW55XG4gIC8vIGVycm9ycyB0aHJvdywgc28gdGhlIG1hbmFnZXIgKGFuZCB0aGUgdXNlcikgY2FuIHNlZSB0aGUgcmVhbFxuICAvLyByZWFzb24gdGhlIHdvcmtlciBkaWVkIGluIHRoZSBpbi1nYW1lIGxvZy4gSWYgdGhlIHdvcmtlclxuICAvLyBydW5zIGZvciB+MS0ycyBhbmQgZGlzYXBwZWFycywgbG9vayBhdCB0aGUgaGFjay5qcyBwcm9jZXNzXG4gIC8vIGxvZzogaXQnbGwgc2hvdyB0aGUgYWN0dWFsIG5zLmhhY2sgZmFpbHVyZS5cbiAgYXdhaXQgbnMuaGFjayh0YXJnZXQpO1xufVxuIl19