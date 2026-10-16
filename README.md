# modernize-for-copilot

Guided legacy-code modernization for **GitHub Copilot CLI** and the **GitHub Copilot app**.

Point Copilot at a legacy codebase (COBOL, legacy Java/C++/.NET, monolith web apps) and get back:
- an assessment
- an interactive architecture map
- the business rules mined out of the code
- a plan you approve
- an upgrade, rewrite or rebuild, with independent proof that the new code behaves like the old

This is a community port of Anthropic's [`code-modernization`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-modernization) plugin for Claude Code. It is released under the same Apache 2.0 licence. It is not affiliated with or endorsed by Anthropic or GitHub. See [NOTICE](NOTICE).

> **Status: 1.1.** On Windows, every upstream skill except `reimagine` has run on a real legacy app (eShopLegacyMVC) in Copilot CLI and the Copilot desktop app. All six dynamic workflows and the live status canvas have run in the desktop app, mostly on a small test fixture. The evidence is in [CHANGELOG.md](CHANGELOG.md), [docs/WORKFLOW_LIVE_TESTS.md](docs/WORKFLOW_LIVE_TESTS.md) and [docs/SPIKE.md](docs/SPIKE.md). `/modernize:parity`, new in 1.1, has passed its automated tests but has not yet run against a real migrated system. Read the "Not yet verified" list in the changelog before relying on it, and review every change it proposes: proof that new code behaves like the old is evidence for a person to judge, not a guarantee.

## How it works

The plugin enforces a sequence, because modernization usually fails when steps are skipped:

```
preflight → assess → map → extract-rules → brief → (reimagine | transform | uplift) → verify → harden → parity
```

| Skill | What it does |
|---|---|
| `/modernize:start` | Front door: asks what you want done and gives the first step |
| `/modernize:preflight` | Checks the environment and records where the code lives |
| `/modernize:assess` | Inventory, complexity, debt, security and a recommended pattern |
| `/modernize:map` | Dependencies, data flow, entry points and business flows, as an interactive map |
| `/modernize:extract-rules` | Business rules as testable Given/When/Then cards with `file:line` citations |
| `/modernize:review` | A person confirms or corrects the rules that need judgement |
| `/modernize:brief` | The phased plan a steering committee approves (human approval gate) |
| `/modernize:transform` | Rewrite one module in a new stack, with equivalence tests |
| `/modernize:uplift` | Same-stack version move (e.g. .NET Framework 4.8 → .NET 8), with minimal diffs |
| `/modernize:reimagine` | Greenfield rebuild from the extracted intent |
| `/modernize:verify` | Independent proof: one verdict per module |
| `/modernize:parity` | **New in 1.1.** Black-box proof: the same requests sent to the legacy and new systems, every difference and contract break reported, for a person to sign off. See [docs/PARITY.md](docs/PARITY.md) |
| `/modernize:harden` | Security scan of the legacy system with a reviewable patch |
| `/modernize:status` | Where you are and the next step |

Specialist custom agents do the heavy reading and checking: `legacy-analyst`, `business-rules-extractor`, `architecture-critic`, `security-auditor`, `test-engineer`, `version-delta-analyst`, `uplift-migrator` and `scaffolder`.

## Install

**Copilot CLI** (checked with 1.0.98):

```sh
copilot plugin marketplace add samuelnyamukapa/modernize-for-copilot
copilot plugin install modernize@modernize-for-copilot
```

**Copilot desktop app:** the app and the CLI share installed plugins, so installing in one is enough. To do it in the app, open Customize, add the marketplace `samuelnyamukapa/modernize-for-copilot` (Manage marketplaces), then install **modernize** from it.

**Updating:** `copilot plugin marketplace update modernize-for-copilot`, then `copilot plugin update modernize@modernize-for-copilot`. In the app: Customize › Installed › modernize › **Update plugin**. On Windows, close every Copilot window (CLI and app) first: a running session can keep the plugin folder busy, and the update then fails with "being used by another process".

**Working on the plugin itself:** `copilot --plugin-dir <clone>/plugin` loads a clone into one CLI session. In the app, add the clone's folder as a marketplace (Manage marketplaces accepts a local path); the app reads it in place, so edits take effect in the next session. Uninstall the marketplace copy first in either case, or the plugin loads twice.

Commands are typed as `/modernize:<step> <system>`, for example `/modernize:assess billing`.

**Requirements:**
- Python 3.9+ on `PATH`. The bundled scripts use the standard library only.
- `git` on `PATH`, which Copilot needs to install plugins from a marketplace.
- For the fan-out commands, Copilot dynamic workflows. The Copilot app has them; in the CLI, start with `copilot --experimental`. Without them, the commands fall back to direct subagents.

## Live status in the Copilot app

In the Copilot desktop app the plugin adds a **Modernize** canvas beside the session. `/modernize:status` opens it, or ask Copilot to *open the modernize-status canvas*. For each system it shows:

- the steps done, with what is stale;
- a map of the code (from `topology.json`, or the legacy folders before the map exists), coloured by progress, with tiles lighting up as agents read or write them;
- the brief's phases and approval, the built modules with their PROVEN / PARTLY PROVEN / NOT PROVEN verdicts, and the security counts;
- what needs a person, and the one next command, with a Copy button.

A person can also answer the rules waiting for review there (written to `RULE_REVIEWS.json`, as `/modernize:review` does), and sign the brief's approval block and the verify sign-off. The canvas never runs a command and never writes outside `analysis/<system>/`. It is served from `127.0.0.1` only, and every request needs a random token. In the CLI nothing changes.

## Additions beyond the upstream plugin

Most of this plugin is a port of upstream. These parts are new:

- **`/modernize:parity`** (new in 1.1). It sends the same requests to the running legacy and new systems and reports every difference. It checks the OpenAPI and WSDL contracts for breaking changes. It uses a delta ledger of approved differences, and a person signs the result. `status`, `verify` and the canvas suggest it at the right time. Guide: [docs/PARITY.md](docs/PARITY.md).
- **The live status canvas** for the Copilot desktop app (new in 1.0). It replaces upstream's progress pane, and its readers are adapted from upstream's.
- **The `legacy/` guard hook**, in place of Claude Code's permission rules. It blocks writes to the legacy code from the main agent, subagents and workflow agents.
- **Two extra tools** on the `modernize-tools` server: `render_topology` builds the interactive map, and `doctor` reports the runtime and runs the guard self-test.

## Troubleshooting

- **`Unknown command: /assess`**: plugin skills are namespaced. Type `/modernize:assess`.
- **Update or uninstall fails with "being used by another process" (os error 32)**: close every Copilot session, in the CLI and the app, then retry.
- **Edits to `legacy/` aren't blocked**: run `copilot plugin list`, and reinstall if you installed two plugins from the same local folder (they share an install directory). Ask Copilot to *call the modernize-tools doctor tool*. It should report `guard_self_test: pass`.
- **Marketplace add fails with "git is not installed"**: install Git for Windows (`winget install --id Git.Git -e`) and reopen the terminal.

## Repository layout

| Path | What |
|---|---|
| `plugin/` | The installable plugin (Agent Plugins 1.0 layout) |
| `convert/` | `sync.py` regenerates the mechanical parts from a pinned upstream commit; `lint.py` checks the result |
| `spike/` | Throwaway probe plugin used to confirm Copilot capabilities |
| `docs/` | Porting plan, spike results, live test results and the smoke-test guide |

## Contributing

Before opening a pull request, run what CI runs: `python3 plugin/tools/guard.py --self-test`, `python3 convert/lint.py`, `python3 -m unittest discover -s plugin/tools/tests`, `python3 -m unittest discover -s plugin/scripts/tests`, `node convert/ci_node_tests.mjs "plugin/tools/tests/workflows/*.test.mjs" "plugin/tools/tests/canvas/*.test.mjs"`, and `python3 convert/sync.py` followed by `git diff --exit-code` (the converter drift check). CI also checks the extensions against the real SDK: `npm install --no-save --no-package-lock --ignore-scripts @github/copilot-sdk@1` in `convert/`, then `node check_sdk.mjs`. Files under `plugin/scripts`, `plugin/assets` and `plugin/com.github.copilot/agents` are generated by `convert/sync.py`. Change the converter, not the output.
