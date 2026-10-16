// Copilot dynamic workflows for the modernize plugin.
// Each sibling module exports `definition` ({meta, run}); this entry point registers them.
// Ported from anthropics/claude-plugins-official plugins/code-modernization/workflows/*.js (Apache-2.0).
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

import { definitions } from "./definitions.mjs";
import os from "node:os";

// Copilot may start this process inside the plugin folder. Windows cannot delete or rename a
// folder that is a process's working directory, so an open session would block plugin updates
// and uninstall ("os error 32"). Nothing here needs a working directory: move out of it.
try {
    process.chdir(os.tmpdir());
} catch {
    // keep the directory we were given
}

// One definition the SDK rejects must not take the other five down with it: define each
// on its own and register whatever was accepted. (Copilot then registers them in one
// request, which is why convert/check_sdk.mjs keeps every argsSchema in GitHub's documented
// shape.) The skills fall back to running each step in the main session when their
// workflow is missing.
const workflows = [];
for (const d of definitions) {
    try {
        workflows.push(defineWorkflow(d));
    } catch (err) {
        console.error(`modernize: workflow ${d?.meta?.name ?? "(unnamed)"} was not registered: ${err?.message ?? err}`);
    }
}

await joinSession({ workflows });
