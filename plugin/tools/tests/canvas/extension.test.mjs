// The canvas extension's entry point with a stubbed SDK: it declares one canvas with its actions,
// follows the session events, and open() returns a loopback URL that carries a token.
//   node --test plugin/tools/tests/canvas/extension.test.mjs
// The Copilot SDK is not installed here, so a module hook swaps in a stub that records calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";

import { makeWorkspace, rmrf, rulesMd, STANDARD_RULES, CANVAS } from "./fixtures.mjs";

const STUB = `
export function createCanvas(options) {
    (globalThis.__canvasCreated ??= []).push(options);
    return { declaration: { id: options.id }, options };
}
export async function joinSession(config) {
    globalThis.__canvasJoined = config;
    const handlers = new Map();
    globalThis.__canvasHandlers = handlers;
    return { on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); } };
}`;
const HOOKS = `
export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
    }
    return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(HOOKS));

await import(new URL("extension.mjs", CANVAS));
const { ACTIVITY_EVENTS, toActivity, newActivityState, pathsIn } = await import(new URL("activity.mjs", CANVAS));

const created = globalThis.__canvasCreated;
const joined = globalThis.__canvasJoined;
const handlers = globalThis.__canvasHandlers;
const opts = created[0];

test("one canvas, declared through createCanvas and passed to joinSession", () => {
    assert.equal(created.length, 1);
    assert.equal(joined.canvases.length, 1);
    assert.equal(joined.canvases[0].declaration.id, "modernize-status");
    assert.equal(opts.id, "modernize-status");
    assert.equal(opts.displayName, "Modernize");
    assert.ok(opts.description.length > 20 && opts.description.trim().split(/(?<=\.)\s+/).length === 1, "one sentence");
    assert.deepEqual(opts.inputSchema, { type: "object", properties: { system: opts.inputSchema.properties.system } });
    assert.equal(opts.inputSchema.properties.system.type, "string");
    assert.equal(typeof opts.open, "function");
});

test("actions: summary, show_system, refresh; none in the reserved canvas. namespace", () => {
    assert.deepEqual(opts.actions.map((a) => a.name), ["summary", "show_system", "refresh"]);
    for (const a of opts.actions) {
        assert.ok(!a.name.startsWith("canvas."));
        assert.equal(typeof a.handler, "function");
        assert.equal(a.inputSchema.type, "object");
        assert.ok(!("anyOf" in a.inputSchema || "oneOf" in a.inputSchema || "allOf" in a.inputSchema));
    }
});

test("the session events it follows are subscribed", () => {
    assert.deepEqual([...handlers.keys()].sort(), [...ACTIVITY_EVENTS].sort());
    for (const t of ["workflow.run_started", "workflow.run_updated", "workflow.run_settled"]) assert.ok(handlers.has(t), t);
    handlers.get("tool.execution_start")({ type: "tool.execution_start", data: null }); // a malformed event is ignored, not thrown
});

test("open: starts one server per workspace on 127.0.0.1 with a token, reused on the next open; actions work", async () => {
    const ws = makeWorkspace({ "analysis/billing/PREFLIGHT.md": "x", "analysis/billing/BUSINESS_RULES.md": rulesMd(STANDARD_RULES), "legacy/billing/a.cbl": "x" });
    try {
        const ctx = { sessionId: "s", extensionId: "e", canvasId: "modernize-status", instanceId: "i1", input: { system: "billing" }, session: { workingDirectory: ws } };
        const first = await opts.open(ctx);
        assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}&system=billing$/);
        assert.equal(first.title, `Modernize — ${path.basename(ws)}`);
        assert.match(first.status, /^1 system · billing: /);
        const second = await opts.open({ ...ctx, instanceId: "i2", input: { system: "../../etc" } });
        assert.equal(new URL(second.url).port, new URL(first.url).port, "the server is reused");
        assert.equal(new URL(second.url).searchParams.get("system"), null, "an invalid system is ignored");
        const page = await fetch(first.url);
        assert.equal(page.status, 200);
        const action = (name) => opts.actions.find((a) => a.name === name).handler;
        const summary = await action("summary")({ ...ctx, actionName: "summary", input: {} });
        assert.equal(summary.systems[0].system, "billing");
        assert.equal(summary.systems[0].next.command, "/modernize:assess billing");
        assert.deepEqual(await action("show_system")({ ...ctx, input: { system: "billing" } }), { ok: true, system: "billing" });
        assert.equal((await action("show_system")({ ...ctx, input: { system: "a/b" } })).ok, false);
        assert.deepEqual(await action("refresh")({ ...ctx, input: {} }), { ok: true });
        const other = makeWorkspace({});
        try {
            assert.equal((await action("show_system")({ ...ctx, session: { workingDirectory: other }, input: { system: "billing" } })).ok, false, "not open there");
        } finally {
            rmrf(other);
        }
    } finally {
        rmrf(ws);
    }
});

test("activity: tool calls name the file and tile; writes, agents, workflows and skills are compact items", () => {
    const state = newActivityState();
    const locate = (p) => (p.replace(/\\/g, "/").includes("legacy/billing/") ? { system: "billing", area: "legacy", rel: p.replace(/\\/g, "/").split("legacy/billing/")[1] } : null);
    const read = toActivity({ type: "tool.execution_start", timestamp: "2026-10-16T10:00:00Z", data: { toolCallId: "1", toolName: "view", arguments: { path: "legacy\\billing\\src\\FEES.cbl" } } }, state, locate);
    assert.deepEqual(read, { at: "2026-10-16T10:00:00Z", kind: "tool", status: "start", label: "view legacy/billing/src/FEES.cbl", touches: [{ system: "billing", area: "legacy", rel: "src/FEES.cbl", mode: "read" }] });
    const shell = toActivity({ type: "tool.execution_start", data: { toolCallId: "2", toolName: "bash", arguments: { command: "grep -n FEE legacy/billing/src/FEES.cbl > out.txt" }, shellToolInfo: { hasWriteFileRedirection: true, possiblePaths: [] } } }, state, locate);
    assert.equal(shell.touches[0].mode, "write");
    const edit = toActivity({ type: "tool.execution_start", data: { toolCallId: "3", toolName: "edit", arguments: { path: "modernized/billing/FEES/Fees.java" } } }, state, locate);
    assert.equal(edit.label, "edit");
    assert.equal(toActivity({ type: "tool.execution_complete", data: { toolCallId: "1", success: true } }, state, locate), null, "a plain success adds nothing");
    assert.equal(toActivity({ type: "tool.execution_complete", data: { toolCallId: "3", success: false } }, state, locate).label, "edit failed");
    assert.equal(toActivity({ type: "subagent.started", agentId: "a", data: { agentDisplayName: "legacy-analyst", agentName: "modernize:legacy-analyst", toolCallId: "x" } }, state).label, "legacy-analyst started");
    assert.equal(toActivity({ type: "subagent.failed", data: { agentName: "x", error: "boom\nline2", toolCallId: "x" } }, state).label, "x failed: boom line2");
    assert.equal(toActivity({ type: "workflow.run_started", data: { runId: "r", workflowName: "modernize-harden-scan", attempt: 1 } }, state).label, "modernize-harden-scan started");
    assert.equal(toActivity({ type: "workflow.run_updated", timestamp: "2026-10-16T10:00:00Z", data: { runId: "r", revision: 1 } }, state).label, "modernize-harden-scan running");
    assert.equal(toActivity({ type: "workflow.run_updated", timestamp: "2026-10-16T10:00:01Z", data: { runId: "r", revision: 2 } }, state), null, "updates are throttled");
    assert.deepEqual(toActivity({ type: "workflow.run_settled", data: { runId: "r", status: "completed" } }, state).label, "modernize-harden-scan completed");
    assert.equal(toActivity({ type: "skill.invoked", data: { name: "modernize:status", content: "", path: "" } }, state).label, "skill modernize:status");
    assert.equal(toActivity({ type: "assistant.message", data: {} }, state), null);
    assert.ok(pathsIn({ a: ["x/y", { b: "c\\d e/f" }] }).includes("e/f"));
});
