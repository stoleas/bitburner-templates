/** @param {NS} ns */
//
// Single-op worker. Takes target as only arg. One weaken() call, then exit.
// Used by manager.js in an HWGW batch — never run this on its own.
//
// RAM cost: ~1.75 GB.
//
// Usage:
//   run weaken.js <target>
//   run weaken.js phantasy
//
export async function main(ns) {
    const target = ns.args[0]?.toString();
    if (!target) {
        ns.tprint("weaken: missing target arg");
        return;
    }
    await ns.weaken(target);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vha2VuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3dlYWtlbi5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxQkFBcUI7QUFDckIsRUFBRTtBQUNGLDRFQUE0RTtBQUM1RSxtRUFBbUU7QUFDbkUsRUFBRTtBQUNGLHNCQUFzQjtBQUN0QixFQUFFO0FBQ0YsU0FBUztBQUNULDJCQUEyQjtBQUMzQiwyQkFBMkI7QUFDM0IsRUFBRTtBQUNGLE1BQU0sQ0FBQyxLQUFLLFVBQVUsSUFBSSxDQUFDLEVBQUU7SUFDM0IsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxRQUFRLEVBQUUsQ0FBQztJQUN0QyxJQUFJLENBQUMsTUFBTSxFQUFFO1FBQ1gsRUFBRSxDQUFDLE1BQU0sQ0FBQyw0QkFBNEIsQ0FBQyxDQUFDO1FBQ3hDLE9BQU87S0FDUjtJQUNELE1BQU0sRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUMxQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEBwYXJhbSB7TlN9IG5zICovXG4vL1xuLy8gU2luZ2xlLW9wIHdvcmtlci4gVGFrZXMgdGFyZ2V0IGFzIG9ubHkgYXJnLiBPbmUgd2Vha2VuKCkgY2FsbCwgdGhlbiBleGl0LlxuLy8gVXNlZCBieSBtYW5hZ2VyLmpzIGluIGFuIEhXR1cgYmF0Y2gg4oCUIG5ldmVyIHJ1biB0aGlzIG9uIGl0cyBvd24uXG4vL1xuLy8gUkFNIGNvc3Q6IH4xLjc1IEdCLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBydW4gd2Vha2VuLmpzIDx0YXJnZXQ+XG4vLyAgIHJ1biB3ZWFrZW4uanMgcGhhbnRhc3lcbi8vXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihucykge1xuICBjb25zdCB0YXJnZXQgPSBucy5hcmdzWzBdPy50b1N0cmluZygpO1xuICBpZiAoIXRhcmdldCkge1xuICAgIG5zLnRwcmludChcIndlYWtlbjogbWlzc2luZyB0YXJnZXQgYXJnXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBucy53ZWFrZW4odGFyZ2V0KTtcbn1cbiJdfQ==