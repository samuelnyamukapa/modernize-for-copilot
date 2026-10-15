# Changelog

## 0.1.0 (2026-10-16)

First release of the GitHub Copilot port of Anthropic's [`code-modernization`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-modernization) plugin (upstream v1.0.0, commit `8bd00f0`, Apache-2.0).

### What's in it

- **13 skills**, invoked as `/modernize:<step>`: `start`, `preflight`, `assess`, `map`, `status`, `extract-rules`, `review`, `brief`, `transform`, `uplift`, `reimagine`, `verify`, `harden`.
- **8 custom agents**, converted from upstream by `convert/sync.py`: `legacy-analyst`, `business-rules-extractor`, `architecture-critic`, `security-auditor`, `test-engineer`, `version-delta-analyst`, `uplift-migrator` and `scaffolder`.
- **`modernize-tools` MCP server** (Python, standard library only). It wraps upstream's scripts (`build_report`, `make_shards`, `render_rules`, `compare`, `trace_rules`, `baseline_diff`, `uplift_checks`, `proof_pack`) and adds `render_topology` and `doctor`.
- **`legacy/` guard**: a `preToolUse` hook that blocks writes to the legacy source. It also blocks writes to the real folder behind a symlink or junction, and build tools pointed at it. It runs for the main agent, subagents and workflow agents, on bash and PowerShell.
- **Six dynamic workflows** (Copilot `--experimental`): `modernize-portfolio-assess`, `modernize-extract-rules-mine`, `modernize-harden-scan`, `modernize-uplift-deltas`, `modernize-uplift-migrate` and `modernize-reimagine-scaffold`. Every skill that uses one falls back to direct subagents when workflows are off.

### Changes from upstream

- Claude Code commands became Copilot skills. `AskUserQuestion` became `ask_user`, and plan-mode gates became `ask_user` approvals.
- The workflows were rewritten for Copilot's workflow API. Token-budget gates were removed, because Copilot doesn't expose a budget to workflows; subagent-count limits remain.
- Telemetry was removed.
- The rules header no longer claims a referee checked every citation when the referee pass didn't run.

### Verified

- **End to end on Windows** with eShopLegacyMVC (.NET Framework 4.7.2), in Copilot CLI and the Copilot desktop app:
  - `start`, `preflight`, `assess` and `map`;
  - `extract-rules` (without workflows): 33 rules;
  - `review`, and `brief`, whose plan is backed by an Upgrade Assistant run;
  - `uplift` Phase 1 pilot: legacy built and hosted from a scratch copy, 63 characterization tests passing on net472 and net8.0, byte-identical output;
  - `transform` on one module, then `verify` (deterministic verdicts), `harden` and `status`.
- **CardDemo (COBOL):** `start` and `preflight`.
- **The `modernize-harden-scan` dynamic workflow, live:** 5 finders, 16 findings judged, none unverified.
- **The guard:** it blocked writes to `legacy/` in the main agent, subagents and workflow agents, and the source tree stayed unchanged throughout. Three false positives found on the way are fixed.
- **Installing** from the marketplace with Copilot CLI 1.0.98, and in the desktop app with no extra setup.
- **CI on Ubuntu and Windows:**
  - guard self-test, structure lint and converter drift;
  - MCP and guard tests, 259 upstream script tests and 96 workflow tests;
  - a check against the real `@github/copilot-sdk`.

### Not yet verified

- Five workflows have not run live: `modernize-portfolio-assess`, `modernize-extract-rules-mine`, `modernize-uplift-deltas`, `modernize-uplift-migrate` and `modernize-reimagine-scaffold`. Their tests use a mock workflow context. Each skill falls back to direct subagents when its workflow is unavailable.
- `reimagine` has not been run end to end.
