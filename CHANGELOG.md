# Changelog

## 1.0.0 (2026-10-16)

Since 0.1.0, every dynamic workflow has run live, and upstream's live pane is back as a canvas in the Copilot desktop app.

### Added

- **The live status canvas, `modernize-status`** (Copilot desktop app). It is a page served on `127.0.0.1` and shown beside the session. It shows:
  - per system: the track, the next command, each step with its age, and the module treemap from `topology.json`, which lights up as the session reads files;
  - the brief and its approval, the `verify` verdicts and sign-off, and the `harden` counts.

  It also has two places where a person writes:
  - **a review deck**, which writes `RULE_REVIEWS.json` and `RULE_REVIEWS.md` in `/modernize:review`'s format;
  - **a sign-off form**, which fills in the brief's `Approved by:`, `Date:` and `Approval covers:` lines, or the cells of `VERIFICATION.md`'s sign-off table, and nothing else.

  The agent can call three actions: `summary`, `show_system` and `refresh`. `/modernize:status` opens the canvas in the app; in the CLI it shows the table only.

  The page:
  - never runs commands, and never writes under `legacy/`;
  - escapes everything it shows;
  - needs a random token for every request;
  - accepts only JSON POSTs of up to 64 KB, addressed to its own host and, when the browser sends an `Origin`, from its own origin;
  - is served under a strict Content Security Policy.
- **`.github/workflows/release.yml`**, run by hand from the Actions tab. It tags the version in `plugin.json` and publishes a GitHub Release, with that version's section of this file as its notes.

### Changed

- **No `--experimental` in the app:** the skills now say the Copilot desktop app runs dynamic workflows as it is. The CLI still needs `--experimental`.
- **Windows updates:** the MCP server and both extensions now move out of the plugin folder when they start. A process whose working directory is the plugin folder stops Windows from updating or uninstalling the plugin (os error 32). Updating *to* 1.0.0 needs every Copilot window closed first, because the 0.1.0 processes hold the folder.
- **CI:**
  - each Node test has a timeout;
  - failures show up as annotations;
  - the canvas declaration is checked against the real `@github/copilot-sdk`.

### Verified

- **All six dynamic workflows ran live** in the Copilot desktop app on Windows, in about 66 workflow agents in all:
  - `harden-scan` ran on eShop on the night of 15 Oct;
  - the other five ran on a small .NET Framework fixture on 16 Oct, each on its first attempt;
  - nothing under `legacy/` changed.

  Run ids and results are in [docs/WORKFLOW_LIVE_TESTS.md](https://github.com/samuelnyamukapa/modernize-for-copilot/blob/main/docs/WORKFLOW_LIVE_TESTS.md).

  | Workflow | Result |
  |---|---|
  | `portfolio-assess` | one row per system |
  | `extract-rules-mine` | 6 rules confirmed, written by `render_rules` |
  | `uplift-deltas` | 14 deltas, 1 dropped by a referee |
  | `uplift-migrate` | two projects built on net8.0 |
  | `reimagine-scaffold` | two services, each written only to its own folder |
  | `harden-scan` | 16 findings judged, none unverified |
- **The canvas, live in the app.** The build tested is 1.0.0's, except for the fix to the bug below. It was loaded from a local folder, because the installed 0.1.0 was locked. In that test it was:
  - opened by the agent with `open_canvas`, when asked for it;
  - showed eShop's full state;
  - lit a module tile when the session read one of its files;
  - wrote a rule verdict;
  - updated by itself when a brief appeared, then wrote a test sign-off;
  - answered the `summary` action.

  The test found two bugs:
  - a test folder was shown as a system; fixed;
  - the locked install (see Windows updates above).
- **CardDemo (COBOL):** `assess` (about 51K lines: 106 COBOL programs and copybooks, plus 55 JCL jobs), and `map --no-describe` (166 modules, 189 edges).
- **A fresh install of 1.0.0** from the marketplace, with Copilot CLI 1.0.98 on Linux and an empty Copilot home: 13 skills and both extensions.
- **CI on Ubuntu and Windows:**
  - the guard self-test and structure lint;
  - 21 MCP and guard tests, 96 workflow tests and 55 canvas tests;
  - 259 upstream script tests, 17 of which are skipped on Windows (`convert/windows-test-gaps.txt`);
  - the check against the real SDK.

  The converter drift check runs on Ubuntu only.

### Not yet verified

- **The `reimagine` skill end to end.** Its `modernize-reimagine-scaffold` workflow ran live, but from a hand-written spec.
- **CardDemo past `map`:** rules, brief and transform on COBOL.
- **The modernize workflows in Copilot CLI** with `--experimental`. Only the spike's probe workflow has run there.
- **`/modernize:status` opening the canvas itself.** In the live test the agent was asked for the canvas directly.
- **An in-place update from 0.1.0 to 1.0.0 in the app.** It needs every Copilot window closed first; see above.
- **Whether open sessions still block updates on Windows.** The MCP server is started through the `py` launcher, which waits for the server and may keep the plugin folder busy even after the server leaves it. Until this is checked, close every Copilot window before updating on Windows.
- **The canvas on macOS and Linux.** It was tested on Windows only.

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
