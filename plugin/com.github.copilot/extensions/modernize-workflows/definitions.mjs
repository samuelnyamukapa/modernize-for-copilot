// The six workflow definitions ({meta, run}), in registration order. No SDK import, so tests
// and convert/check_sdk.mjs can load them outside Copilot.
// Ported from anthropics/claude-plugins-official plugins/code-modernization/workflows/*.js (Apache-2.0).
import { definition as portfolioAssess } from "./portfolio-assess.mjs";
import { definition as extractRules } from "./extract-rules.mjs";
import { definition as hardenScan } from "./harden-scan.mjs";
import { definition as upliftDeltas } from "./uplift-deltas.mjs";
import { definition as upliftMigrate } from "./uplift-migrate.mjs";
import { definition as reimagineScaffold } from "./reimagine-scaffold.mjs";

export const definitions = [portfolioAssess, extractRules, hardenScan, upliftDeltas, upliftMigrate, reimagineScaffold];
