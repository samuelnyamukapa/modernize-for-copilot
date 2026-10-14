# Changelog

## 0.1.0 (unreleased)

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

- On Windows with Copilot CLI and eShopLegacyMVC (.NET Framework 4.7.2): `start`, `preflight`, `assess`, `map`, `extract-rules` (without workflows) and `review`.
- The marketplace install with Copilot CLI 1.0.98.
- CI on Ubuntu and Windows: guard self-test, structure lint, converter drift, 20 MCP and guard tests, 259 upstream script tests, 96 workflow tests, and a check against the real `@github/copilot-sdk`.

### Not yet verified

- The six workflows in a live `--experimental` session.
- The Copilot desktop app.
- `brief`, `uplift`, `transform`, `reimagine`, `verify` and `harden` end to end.
