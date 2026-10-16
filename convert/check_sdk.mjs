// Run every workflow definition through the real Copilot SDK's defineWorkflow, which checks
// limits and phases, and check each argsSchema root is a plain object as in GitHub's example.
// Copilot registers all six in one request, so one it rejects would drop them all.
// Then build the live status canvas with the real SDK's createCanvas and check its declaration:
// what goes over the wire, action names outside the reserved `canvas.` namespace, plain object
// schemas, and a handler bound for every declared action.
//   cd convert && npm install --no-save --ignore-scripts @github/copilot-sdk@1 && node check_sdk.mjs
import { defineWorkflow, createCanvas } from "@github/copilot-sdk/extension";
import { definitions } from "../plugin/com.github.copilot/extensions/modernize-workflows/definitions.mjs";
import { canvasOptions, CANVAS_ID } from "../plugin/com.github.copilot/extensions/modernize-canvas/canvas.mjs";

let failed = 0;
const plainObject = (s) => s && typeof s === "object" && s.type === "object" && !("anyOf" in s || "oneOf" in s || "allOf" in s);

for (const d of definitions) {
    try {
        defineWorkflow(d);
        const s = d.meta.argsSchema;
        if (s && !plainObject(s)) {
            throw new Error("argsSchema root must be a plain { type: \"object\" } schema");
        }
        console.log(`ok ${d.meta.name}`);
    } catch (err) {
        failed++;
        console.log(`::error::${d.meta?.name ?? "(unnamed)"}: ${err.message}`);
    }
}

try {
    if (typeof createCanvas !== "function") throw new Error("this SDK has no createCanvas");
    const hub = { model: () => ({ workspace: { name: "x" }, systems: [] }), open: async () => ({}), show: () => false, refresh: () => false };
    const canvas = createCanvas(canvasOptions(hub));
    const decl = canvas.declaration;
    const problems = [];
    if (decl.id !== CANVAS_ID) problems.push(`id is ${decl.id}`);
    if (!decl.displayName) problems.push("no displayName");
    if (!decl.description || decl.description.trim().split(/(?<=\.)\s+/).length !== 1) problems.push("description must be one sentence");
    if (decl.inputSchema && !plainObject(decl.inputSchema)) problems.push("inputSchema root must be a plain { type: \"object\" } schema");
    if (typeof canvas.open !== "function") problems.push("no open handler");
    const names = (decl.actions ?? []).map((a) => a.name);
    if (new Set(names).size !== names.length) problems.push("duplicate action names");
    for (const a of decl.actions ?? []) {
        if (a.name.startsWith("canvas.")) problems.push(`action ${a.name} uses the reserved canvas. prefix`);
        if ("handler" in a) problems.push(`action ${a.name}: the handler leaked into the wire declaration`);
        if (a.inputSchema && !plainObject(a.inputSchema)) problems.push(`action ${a.name}: inputSchema root must be a plain object schema`);
        if (canvas.actionHandlers && typeof canvas.actionHandlers.get(a.name) !== "function") problems.push(`action ${a.name} has no handler`);
    }
    JSON.stringify(decl); // the declaration must serialize for session.create / session.resume
    if (problems.length) throw new Error(problems.join("; "));
    console.log(`ok canvas ${decl.id} (${names.join(", ")})`);
} catch (err) {
    failed++;
    console.log(`::error::canvas ${CANVAS_ID}: ${err.message}`);
}

process.exit(failed ? 1 : 0);
