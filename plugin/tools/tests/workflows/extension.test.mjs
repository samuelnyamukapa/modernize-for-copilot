// Tests for the extension entry point: it registers every workflow, survives one bad
// definition, and the workflow names line up with the skills that run them.
//   node --test plugin/tools/tests/workflows/extension.test.mjs
// The Copilot SDK is not installed here, so a module hook swaps in a stub that records calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STUB = `
export function defineWorkflow(d) {
    if (d?.meta?.name && d.meta.name === globalThis.__modernizeFailName) throw new Error("rejected by test");
    (globalThis.__modernizeDefined ??= []).push(d);
    return { name: d.meta.name };
}
export async function joinSession(options) {
    globalThis.__modernizeJoined = options;
    return {};
}`;
const HOOKS = `
export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
    }
    return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(HOOKS));

const EXT = new URL("../../../com.github.copilot/extensions/modernize-workflows/extension.mjs", import.meta.url);
const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

let loads = 0;
async function load(failName) {
    globalThis.__modernizeDefined = [];
    globalThis.__modernizeJoined = undefined;
    globalThis.__modernizeFailName = failName;
    const errors = [];
    const original = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
        await import(`${EXT.href}?load=${++loads}`); // a fresh query string re-runs the module
    } finally {
        console.error = original;
    }
    return { defined: globalThis.__modernizeDefined, joined: globalThis.__modernizeJoined, errors };
}

test("registers all six workflows in one joinSession call, with unique modernize- names", async () => {
    const { defined, joined, errors } = await load(undefined);
    assert.deepEqual(errors, []);
    assert.equal(joined.workflows.length, 6);
    const names = defined.map((d) => d.meta.name);
    assert.equal(new Set(names).size, names.length);
    for (const n of names) assert.ok(n.startsWith("modernize-") && /^[a-z-]+$/.test(n), n);
    for (const d of defined) assert.equal(typeof d.run, "function");
});

test("one rejected definition is skipped and the other five still register", async () => {
    const { joined, errors } = await load("modernize-harden-scan");
    assert.equal(joined.workflows.length, 5);
    assert.ok(!joined.workflows.some((w) => w.name === "modernize-harden-scan"));
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("modernize-harden-scan was not registered: rejected by test"), errors[0]);
});

test("every workflow is run by a skill, and every workflow a skill names exists", async () => {
    const { defined } = await load(undefined);
    const registered = new Set(defined.map((d) => d.meta.name));
    const named = new Set();
    for (const dir of readdirSync(SKILLS)) {
        const file = `${SKILLS}${dir}/SKILL.md`;
        if (!existsSync(file)) continue;
        for (const m of readFileSync(file, "utf8").matchAll(/`(modernize-[a-z-]+)`/g)) {
            // Not workflows: the MCP server's two names and the live status canvas's id.
            if (!["modernize-tools", "modernize-tools-win", "modernize-status"].includes(m[1])) named.add(m[1]);
        }
    }
    assert.deepEqual([...named].sort(), [...registered].sort());
});
