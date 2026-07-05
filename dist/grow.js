/** @param {NS} ns */
//
// Single-op worker. Takes target as only arg. One grow() call, then exit.
// Used by manager.js in an HWGW batch — never run this on its own.
//
// RAM cost: ~1.75 GB.
//
// Usage:
//   run grow.js <target>
//   run grow.js phantasy
//
export async function main(ns) {
    const target = ns.args[0]?.toString();
    if (!target) {
        ns.tprint("grow: missing target arg");
        return;
    }
    await ns.grow(target);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ3Jvdy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9ncm93LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsMEVBQTBFO0FBQzFFLG1FQUFtRTtBQUNuRSxFQUFFO0FBQ0Ysc0JBQXNCO0FBQ3RCLEVBQUU7QUFDRixTQUFTO0FBQ1QseUJBQXlCO0FBQ3pCLHlCQUF5QjtBQUN6QixFQUFFO0FBQ0YsTUFBTSxDQUFDLEtBQUssVUFBVSxJQUFJLENBQUMsRUFBRTtJQUMzQixNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxNQUFNLEVBQUU7UUFDWCxFQUFFLENBQUMsTUFBTSxDQUFDLDBCQUEwQixDQUFDLENBQUM7UUFDdEMsT0FBTztLQUNSO0lBQ0QsTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ3hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQHBhcmFtIHtOU30gbnMgKi9cbi8vXG4vLyBTaW5nbGUtb3Agd29ya2VyLiBUYWtlcyB0YXJnZXQgYXMgb25seSBhcmcuIE9uZSBncm93KCkgY2FsbCwgdGhlbiBleGl0LlxuLy8gVXNlZCBieSBtYW5hZ2VyLmpzIGluIGFuIEhXR1cgYmF0Y2gg4oCUIG5ldmVyIHJ1biB0aGlzIG9uIGl0cyBvd24uXG4vL1xuLy8gUkFNIGNvc3Q6IH4xLjc1IEdCLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gZ3Jvdy5qcyA8dGFyZ2V0PlxuLy8gICBydW4gZ3Jvdy5qcyBwaGFudGFzeVxuLy9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKG5zKSB7XG4gIGNvbnN0IHRhcmdldCA9IG5zLmFyZ3NbMF0/LnRvU3RyaW5nKCk7XG4gIGlmICghdGFyZ2V0KSB7XG4gICAgbnMudHByaW50KFwiZ3JvdzogbWlzc2luZyB0YXJnZXQgYXJnXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBucy5ncm93KHRhcmdldCk7XG59XG4iXX0=