# Converting an upstream command into a Copilot skill

Source: `convert/upstream-snapshot/commands/modernize-<verb>.md`. Target: `plugin/skills/<verb>/SKILL.md`. The front door `modernize.md` becomes `plugin/skills/start/SKILL.md`. The evidence for each rule is in [SPIKE.md](SPIKE.md).

Keep the upstream substance: every step, artifact name, file format, gate, check, rule-card schema and untrusted-content instruction. Change only what Copilot does differently. Don't summarise, and don't drop sections. If something can't be ported, keep the intent and say what is different.

## 1. Frontmatter

```yaml
---
name: assess
description: "What am I dealing with? Inventory, complexity, debt, security and a recommended modernization pattern. Usage: /modernize:assess <system> [--show-secrets] | --portfolio <parent-dir>"
---
```

- `name` is the verb only (`assess`, `extract-rules`, `start`). The folder name must match.
- `description` is the upstream description plus `Usage: /modernize:<verb> <args>` built from upstream `argument-hint`. Stay under 1024 characters and use a quoted YAML string.
- No other keys. `argument-hint`, `arguments` and `allowed-tools` are dropped.

## 2. Arguments

Copilot replaces `$ARGUMENTS` only when the skill is run as a slash command. It doesn't substitute named placeholders. Start every skill with this block, adjusted to the skill's own arguments:

```markdown
## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.
- `<target-stack>`: second word, optional.

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.
```

Then replace every upstream `$system`, `$target_stack`, `$module` and similar placeholder in the body with `<system>`, `<target-stack>`, `<module>` and so on. Lint fails on a leftover `$name` placeholder.

## 3. Scripts → the `modernize-tools` MCP server

Replace `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.py" …` with a call to the matching tool on the `modernize-tools` MCP server. Always pass `workspace` (absolute):

| Upstream | Copilot |
|---|---|
| `build_report.py <system>` | `build_report` {workspace, system} |
| `make_shards.py <system> [pattern] [--all]` | `make_shards` {workspace, system, module_pattern?, all?} |
| `render_rules.py <system>` | `render_rules` {workspace, system} |
| `compare.py <cases.json> [--out]` | `compare` {workspace, cases, out?} |
| `trace_rules.py <system> [--json] [--module M] [--results P…]` | `trace_rules` {workspace, system, json?, module?, results?} |
| `baseline_diff.py <BASELINE.md> --junit P…` | `baseline_diff` {workspace, baseline, results:[…]} |
| `uplift_checks.py <legacy> <work> [catalog]` | `uplift_checks` {workspace, legacy, work, catalog?} |
| `proof_pack.py <system> [module]` | `proof_pack` {workspace, system, module?} |
| map's inline heredoc that fills `topology-viewer.html` | `render_topology` {workspace, system} |
| preflight environment checks | `doctor` {workspace} |

Each tool returns the script's exit code, stdout and stderr. Interpret them exactly as upstream interprets the script's output.

- **Convenience scripts** (`build_report` at the end of a skill): keep upstream's wording. If the call fails, say so in one line and carry on.
- **Essential scripts** (anything whose output a later step depends on): if the `modernize-tools` server isn't available, stop. Tell the user to run `/mcp` to check that `modernize-tools` (or `modernize-tools-win`) is connected, and to see `/modernize:preflight`. Never hand-write what a script computes.

## 4. Asking the user

`AskUserQuestion` becomes the **`ask_user`** tool. Keep upstream's question text, options and limits (for example, at most 4 questions per call). Keep every upstream headless branch: in `copilot -p`, autopilot, or when `ask_user` is unavailable, take the stated default and record it as an open item.

## 5. Subagents

- "spawn / launch the `X` agent / subagent" becomes "delegate to the custom agent **`modernize:X`**". The name must include the `modernize:` prefix; without it, delegation silently fails.
- Independent delegations that upstream runs in parallel: say "delegate these in parallel". Copilot runs subagents concurrently where it can.
- Keep upstream's prompt contents for each delegation, including the instruction to fence untrusted text.

## 6. Dynamic workflows (upstream's Workflow tool)

Upstream runs `code-modernization:modernize-<w>` through Claude Code's Workflow tool, falling back to direct subagents. The Copilot port keeps both paths:

```markdown
**Preferred: dynamic workflow.** If this session has Copilot dynamic workflows (started with `--experimental`), run the `modernize-<w>` dynamic workflow with args `{…}`. Runs start in the background. Wait for the result, then continue from it. To resume a stopped run, open `/workflows` and resume it there.

**Fallback.** If dynamic workflows aren't available, or the run fails, use the direct method below.
```

Remove Claude-specific workflow details: `resumeFromRunId`, `wf_` run ids, `journal.jsonl`, `TaskStop`, the 1000-agent cap. Copilot's equivalents are `/workflows` and its run limits. Keep the fallback method exactly as upstream wrote it.

## 7. Approval gates

Upstream "Enter plan mode if available" becomes:

> **Stop here for explicit approval.** Present the plan and wait for the user to say yes. "No objection" or silence is not approval. If the session is in Plan mode, this is the plan to approve.

Keep every other upstream gate word for word.

## 8. Claude-only things to remove or replace

| Upstream | Copilot |
|---|---|
| `/code-modernization:modernize-<verb>` | `/modernize:<verb>` |
| `/code-modernization:modernize` (front door) | `/modernize:start` |
| reading `${CLAUDE_PLUGIN_ROOT}/commands/<x>.md` and running it inline | invoke the `modernize:<x>` skill |
| `.claude/settings.json`, `permissions.deny`, `Edit(...)` rules, `CLAUDE_CONFIG_DIR`, `~/.claude` | the plugin's `legacy/` guard hook: verify with the `doctor` tool (`guard_self_test: pass`, and `legacy/<system>` in `legacy_protected_roots`) |
| `CLAUDE.md` handoff file | `AGENTS.md` (Copilot reads it natively) |
| progress pane, `/modernize-panel`, `/modernize-sign`, `/modernize-review-pane`, x-ray | remove. `/modernize:status` and `REPORT.html` cover the information |
| telemetry mentions | remove |
| "Claude" as the actor | "Copilot", or "the agent" |

## 9. Checks

`python3 convert/lint.py` must pass. It rejects Claude-only tokens, leftover `$placeholders`, and skill names that don't match their folder.
