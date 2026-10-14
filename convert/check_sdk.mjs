// Run every workflow definition through the real Copilot SDK's defineWorkflow, which checks
// limits and phases, and check each argsSchema root is a plain object as in GitHub's example.
// Copilot registers all six in one request, so one it rejects would drop them all.
//   cd convert && npm install --no-save --ignore-scripts @github/copilot-sdk@1 && node check_sdk.mjs
import { defineWorkflow } from "@github/copilot-sdk/extension";
import { definitions } from "../plugin/com.github.copilot/extensions/modernize-workflows/definitions.mjs";

let failed = 0;
for (const d of definitions) {
    try {
        defineWorkflow(d);
        const s = d.meta.argsSchema;
        if (s && (s.type !== "object" || "anyOf" in s || "oneOf" in s || "allOf" in s)) {
            throw new Error("argsSchema root must be a plain { type: \"object\" } schema");
        }
        console.log(`ok ${d.meta.name}`);
    } catch (err) {
        failed++;
        console.log(`::error::${d.meta?.name ?? "(unnamed)"}: ${err.message}`);
    }
}
process.exit(failed ? 1 : 0);
