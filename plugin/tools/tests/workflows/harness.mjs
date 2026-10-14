// Mock of the Copilot dynamic-workflow context (`ctx`) for unit tests.
// Mirrors the documented semantics in docs/copilot-sdk-workflows-reference.md:
//   - ctx.agent resolves to text, parsed JSON (with schema), or null on failure
//   - identical (prompt, options) calls are memoised into one result
//   - ctx.parallel / ctx.pipeline turn a thrown thunk into null
// Workflow modules export `definition` ({meta, run}); tests call definition.run(ctx).

export function makeCtx({ args = {}, agent } = {}) {
    const calls = [];
    const logs = [];
    const phases = [];
    const memo = new Map();
    const ctx = {
        runId: "test-run",
        args,
        signal: new AbortController().signal,
        calls,
        logs,
        phases,
        async agent(prompt, options = {}) {
            for (const k of Object.keys(options)) {
                if (!["label", "schema", "model", "agent", "reasoningEffort", "contextTier"].includes(k)) {
                    throw new Error(`ctx.agent: unsupported option ${k}`);
                }
            }
            const key = JSON.stringify([prompt, options]);
            if (memo.has(key)) return memo.get(key);
            const p = (async () => {
                calls.push({ prompt, options });
                try {
                    const out = agent ? await agent(prompt, options, calls.length - 1) : null;
                    return out === undefined ? null : out;
                } catch {
                    return null;
                }
            })();
            memo.set(key, p);
            return p;
        },
        async parallel(thunks) {
            if (thunks.length > 4096) throw new Error("ctx.parallel: more than 4096 items");
            return Promise.all(thunks.map(async (t) => {
                try { return await t(); } catch { return null; }
            }));
        },
        async pipeline(items, ...stages) {
            return Promise.all(items.map(async (item, index) => {
                let prev = item;
                for (const stage of stages) {
                    try { prev = await stage(prev, item, index); } catch { return null; }
                }
                return prev;
            }));
        },
        phase(title) { phases.push(title); },
        log(message) { logs.push(String(message)); },
        async step(_key, producer) { return producer(); },
        async pause() {},
        async workflow() { throw new Error("nested workflows are not supported"); },
    };
    return ctx;
}

/** Agent names used by the plugin; a call to any other name returns null, as Copilot does. */
export const PLUGIN_AGENTS = new Set([
    "modernize:legacy-analyst", "modernize:business-rules-extractor", "modernize:architecture-critic",
    "modernize:security-auditor", "modernize:test-engineer", "modernize:version-delta-analyst",
    "modernize:uplift-migrator", "modernize:scaffolder",
]);
