// Spike probe: checks that a plugin-shipped dynamic workflow registers, fans out,
// and can address the plugin's custom agent by name.
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

const NAMES = ["probe-echo", "modernize-probe:probe-echo"];

const probeFanout = defineWorkflow({
    meta: {
        name: "probe-fanout",
        description:
            "Spike probe for modernize-for-copilot. Runs two subagents in parallel per candidate agent name " +
            "and reports which names resolve. args: {} (none).",
        phases: [{ title: "Fan out" }, { title: "Report" }],
        limits: { maxTotalSubagents: 8 },
    },
    run: async (ctx) => {
        ctx.phase("Fan out");
        const tasks = [];
        for (const name of NAMES) {
            for (const i of [1, 2]) {
                tasks.push(() =>
                    ctx.agent("Run your probe.", { agent: name, label: `${name}#${i}` }).then(
                        (reply) => ({ name, i, reply }),
                    ),
                );
            }
        }
        // A thunk that throws resolves to null, so a bad agent name shows up as null, not a crash.
        const results = await ctx.parallel(tasks);

        ctx.phase("Report");
        const byName = {};
        results.forEach((r, idx) => {
            const name = NAMES[Math.floor(idx / 2)];
            byName[name] = byName[name] || [];
            byName[name].push(r === null ? "FAILED" : r.reply === null ? "NULL" : String(r.reply).slice(0, 200));
        });
        ctx.log(`probe-fanout run ${ctx.runId} finished`);
        return { runId: ctx.runId, byName };
    },
});

await joinSession({ workflows: [probeFanout] });
