// Copilot dynamic workflows for the modernize plugin.
// Each sibling module exports `definition` ({meta, run}); this entry point registers them.
// Ported from anthropics/claude-plugins-official plugins/code-modernization/workflows/*.js (Apache-2.0).
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

import { definition as portfolioAssess } from "./portfolio-assess.mjs";
import { definition as extractRules } from "./extract-rules.mjs";
import { definition as hardenScan } from "./harden-scan.mjs";
import { definition as upliftDeltas } from "./uplift-deltas.mjs";
import { definition as upliftMigrate } from "./uplift-migrate.mjs";
import { definition as reimagineScaffold } from "./reimagine-scaffold.mjs";

export const definitions = [portfolioAssess, extractRules, hardenScan, upliftDeltas, upliftMigrate, reimagineScaffold];

// One definition the runtime rejects must not take the other five down with it:
// define each on its own and register whatever was accepted. The skills fall back
// to running each step in the main session when their workflow is missing.
const workflows = [];
for (const d of definitions) {
    try {
        workflows.push(defineWorkflow(d));
    } catch (err) {
        console.error(`modernize: workflow ${d?.meta?.name ?? "(unnamed)"} was not registered: ${err?.message ?? err}`);
    }
}

await joinSession({ workflows });
