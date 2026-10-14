# Porting plan: code-modernization → GitHub Copilot CLI and the Copilot app

**Source:** `anthropics/claude-plugins-official`, `plugins/code-modernization` v1.0.0 (upstream commit `8bd00f0`, 13 Oct 2026), Apache 2.0
**Targets:** GitHub Copilot CLI (tested against 1.0.97) and the GitHub Copilot app (desktop, built on the CLI)
**Prepared:** 14 Oct 2026

---

## 1. Summary

The port is smaller than it looks. About 70% of the plugin is either portable as is or a mechanical conversion. The rest falls into three groups:

- **Two pieces need real rework.** The 13 slash commands use Claude-only argument placeholders, `${CLAUDE_PLUGIN_ROOT}` script paths and the `AskUserQuestion` tool. The "never edit `legacy/`" guarantee depends on Claude Code permission rules.
- **One piece has a close equivalent.** The 6 orchestration workflows (`workflows/*.js`) target Claude Code's Workflow tool. Copilot now has **Dynamic Workflows** (`defineWorkflow`, `ctx.agent`, `ctx.parallel`, `ctx.pipeline`, `ctx.phase`, `ctx.log`, journaled steps, resume and limits), and its API maps almost one-to-one. Copilot's version is experimental, so the commands keep their existing non-workflow fallback.
- **One piece should be dropped for v1.** This is the live progress pane plus telemetry: about 11k lines of TypeScript, early access even in Claude Code. A Copilot app "canvas" extension could replace the pane later.

**Recommended shape:** a standalone repo that ships one plugin in the **Agent Plugins 1.0** layout, which the CLI, the Copilot app and VS Code all load. It contains:

- skills for the commands
- custom agents
- a small stdio MCP server that runs the Python scripts
- a `preToolUse` hook that guards `legacy/`
- an extension carrying the dynamic workflows

Distribution is a `marketplace.json`. Direct path installs now print a deprecation warning.

**Effort:**
- A usable v0.1 (discovery, rules, brief, transform, verify; no fan-out workflows) takes roughly **3–4 working days**.
- Full parity, including uplift and reimagine on dynamic workflows and end-to-end proof on two sample systems, takes roughly **8–10 working days**.

---

## 2. What is in the plugin today

| Part | Files | Size | Claude coupling | Port verdict |
|---|---|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | 1 | `userConfig` (7 options, mostly for the pane) | Rewrite (small) |
| Commands | `commands/*.md` | 13 | `$system`-style args, `CLAUDE_PLUGIN_ROOT`, AskUserQuestion, Workflow, "plan mode", `.claude/settings.json` | **Convert to skills + rewrite sections** |
| Agents | `agents/*.md` | 8 | `tools:` uses Claude tool names | **Near-verbatim.** Copilot accepts `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `Task` as aliases |
| Workflows | `workflows/*.js` | 6 (~2,000 lines) | Claude Workflow runtime globals | **Port to Copilot Dynamic Workflows** |
| Scripts | `scripts/*.py` | 8 + telemetry | Only telemetry touches `CLAUDE_*` | **Keep as is.** Stdlib only |
| Script tests | `scripts/tests/*.py` | 7 | `test_telemetry.py` only | Keep (325 pass today). Drop the telemetry test |
| Pane + hooks | `hooks/**/*.ts(x)`, `hooks.json` | 18 + 10 tests (~11k lines) | Claude Code function hooks (early access) | **Drop for v1** |
| Telemetry | `scripts/telemetry.*`, hook entries | 2 | Claude Code's telemetry channel | **Drop** |
| Assets | `assets/` | topology viewer, report template, mermaid, images | None | Keep |

How often the commands rely on Claude features:

| Feature | Commands using it |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` script calls | 11 of 13 |
| AskUserQuestion | 5 |
| Workflow tool (6 workflows) | 5 |
| "plan mode if available" | 4 |
| `.claude/settings.json` permission checks | 2 (preflight Check 7, uplift) |
| A `CLAUDE.md` handoff file | 2 (reimagine, status) |

---

## 3. Target platform facts that shape the design

**Plugin format.** Both the CLI and the app load **Agent Plugins 1.0**:
- `plugin.json` with `$schema` at the root
- portable `skills/`
- Copilot-only components under `com.github.copilot/` (`agents/`, `commands/`, `hooks/`, `rules/`, and extensions)

The CLI also reads legacy manifests, including `.claude-plugin/plugin.json` as a last-resort location. The unchanged plugin installs today (verified here: `copilot plugin install` succeeded), but its commands, args and script paths won't behave.

**Custom agents.** `.agent.md` files support `name`, `description`, `tools`, `model`, `user-invocable` and `disable-model-invocation`. A tool alias table maps Claude names (Read → `read`, Bash → `execute`, Grep/Glob → `search`, Edit/Write → `edit`, Task → `agent`).

**Skills.** Invoked as `/skill-name` or picked up automatically from the description. Skills are the portable equivalent of a slash command.

**Subagents and parallelism.** The main agent delegates to custom agents. `/fleet` runs subagents in parallel and can use custom agents.

**Dynamic Workflows.** Available in the CLI and the app; experimental, enabled with `--experimental` or `/experimental on`.
- **Packaging:** an `extension.mjs` registers workflows with `defineWorkflow({ meta: { name, description, phases, argsSchema, limits }, run })`.
- **Context API:** `ctx.agent(prompt, { label, schema, agent, model, reasoningEffort })`, `ctx.parallel`, `ctx.pipeline`, `ctx.step`, `ctx.pause`, `ctx.phase` and `ctx.log`.
- **Failure handling:** a failed agent resolves to `null`.
- **Running it:** from a prompt by name, or from a terminal with `copilot workflow run <name> --args @file.json`.
- **Plan restriction:** not available to Pro/Pro+ subscribers on legacy annual request-based plans.

**Asking the user.** The CLI exposes an `ask_user` tool, which replaces AskUserQuestion.

**Approval modes.** Interactive, Plan and Autopilot exist in both the CLI (Shift+Tab, `--plan`) and the app.

**Hooks.** Copilot supports these events: `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `subagentStart` and `subagentStop`, among others. A `preToolUse` hook can return a `permissionDecision`.

**Script paths.** No plugin-root environment variable is documented for skills or agent bodies. `PLUGIN_ROOT` is set for **stdio MCP servers** a plugin ships, so routing the scripts through an MCP server avoids the path problem entirely.

**Copilot app specifics.** Each local session runs in its own git worktree and branch, which suits the plugin's `analysis/` and `modernized/` outputs. Plugins come from the same marketplaces as the CLI.

**Not testable from this environment.** Copilot sessions can't authenticate here, so every assumption marked **[spike]** below must be confirmed on your machine in Phase 0.

---

## 4. Target layout

```
copilot-code-modernization/
├── plugin.json                         # Agent Plugins 1.0 manifest ($schema, name, version, extensions)
├── mcp.json                            # stdio MCP server "modernize-tools"
├── skills/
│   ├── modernize/SKILL.md              # front door
│   ├── modernize-preflight/SKILL.md
│   ├── modernize-assess/SKILL.md
│   ├── modernize-map/SKILL.md
│   ├── modernize-extract-rules/SKILL.md
│   ├── modernize-review/SKILL.md
│   ├── modernize-brief/SKILL.md
│   ├── modernize-transform/SKILL.md
│   ├── modernize-uplift/SKILL.md
│   ├── modernize-reimagine/SKILL.md
│   ├── modernize-verify/SKILL.md
│   ├── modernize-harden/SKILL.md
│   └── modernize-status/SKILL.md
├── com.github.copilot/
│   ├── agents/                         # 8 × <name>.agent.md
│   ├── hooks/hooks.json                # preToolUse legacy/ write guard
│   └── extensions/modernize-workflows/extension.mjs   # 6 dynamic workflows
├── tools/                              # MCP server + scripts (unchanged python)
│   ├── server.py                       # stdlib-only MCP stdio server
│   ├── guard.py                        # preToolUse hook
│   └── scripts/…                       # baseline_diff, build_report, compare, make_shards,
│                                       # proof_pack, render_rules, trace_rules, uplift_checks
├── assets/                             # topology viewer, report template, mermaid
├── convert/                            # upstream → Copilot converter (see §6)
├── tests/                              # python unit tests + structural lint
├── .github/plugin/marketplace.json
├── .github/workflows/ci.yml
├── LICENSE  NOTICE  README.md  CHANGELOG.md
```

---

## 5. Component-by-component mapping

### 5.1 Commands → skills

Convert each `commands/<name>.md` into `skills/<name>/SKILL.md`. Changes per file:

1. **Frontmatter.**
   - Keep `name` and `description`.
   - Fold `argument-hint` into the description so users see the usage.
   - Drop `arguments:`.
2. **Arguments.** Replace `$system`, `$target_stack`, `$module` and `$ARGUMENTS` with an "Inputs" block. The block tells the agent to parse the user's message after `/modernize-x`, validate the system name (`[A-Za-z0-9_-]+`), and use `ask_user` for anything missing. **[spike]** Check whether Copilot passes trailing text to a skill invoked as `/name args`.
3. **Script calls.** Replace `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/X.py" …` with a call to the matching MCP tool, for example `modernize-tools.build_report(system=…)`. Do this in all 11 commands.
4. **Questions.** Replace `AskUserQuestion` with `ask_user`. Keep the existing "headless: pick defaults and record open items" branches, because Autopilot and `copilot -p` have no one to answer.
5. **Approval gates.** Replace "plan mode if available" with "stop and wait for an explicit yes". In brief, transform, uplift and reimagine, recommend starting in Plan mode. Keep the rule that "no objection" is not approval.
6. **Workflows.** Replace "Workflow tool: `code-modernization:…`" with "if dynamic workflows are available, run the `modernize-…` workflow with args …; otherwise use the direct-subagent method below". Each command keeps its own fallback.
7. **Command references.** Replace `/code-modernization:modernize-x` with `/modernize-x`. Remove the pane references (`/modernize-review-pane`, "progress pane").

Per-command notes:

| Skill | Difficulty | Specific work |
|---|---|---|
| modernize (front door) | Medium | Replace its inline "read and run `modernize-preflight.md`" with "invoke the `modernize-preflight` skill". |
| modernize-preflight | Medium | Rewrite Check 7. Instead of parsing `.claude/settings.json` deny rules, verify that the guard hook is installed and active, which `guard.py --selftest` does through MCP. Detect Copilot CLI version and `--experimental` availability. |
| modernize-assess | Medium | Portfolio mode becomes the `modernize-portfolio-assess` workflow, with a sequential fallback. The 3 parallel subagents become custom-agent delegations. |
| modernize-map | Medium | The inline Python heredoc that injects `topology-viewer.html` becomes an MCP tool, `render_topology`. Per-node `legacy-analyst` batches of 8 use delegation or `/fleet`. |
| modernize-extract-rules | **High** | The preferred path is the workflow. Drop Claude's `wf_` run ID, `journal.jsonl` and `TaskStop` text in favour of Copilot run IDs, `/workflows` and resume. Method B stays as the fallback. |
| modernize-review | Medium | Its whole UX is the pop-up. Use `ask_user` with up to 4 rules per call. Otherwise it is unchanged. |
| modernize-brief | Low–Med | The plan-mode wording, plus the optional single `version-delta-analyst` delegation. |
| modernize-transform | Medium | Two approval gates, `test-engineer` and `architecture-critic` delegations, and `compare` through MCP. |
| modernize-uplift | **High** | Two workflows, four agents, a pilot-first gate and the circuit breaker. Rewrite the "Bash permissions" guidance for Copilot (`--deny-tool`, hook). |
| modernize-reimagine | **High** | Two checkpoints, five agent types, one workflow. The handoff `CLAUDE.md` becomes **`AGENTS.md`**, which Copilot reads natively. |
| modernize-verify | Low–Med | Script-driven. Five MCP tool calls. |
| modernize-harden | Med–High | Workflow with refute and confirm judges. The fallback is a single `security-auditor`, which loses adversarial verification; the README should say so. |
| modernize-status | Low | MCP `build_report`. Check for `AGENTS.md` instead of `CLAUDE.md`. |

### 5.2 Agents → custom agents

Copy each `agents/<n>.md` to `com.github.copilot/agents/<n>.agent.md`:
- Keep `name`, `description` and `tools`. The Claude tool names are accepted aliases. Normalise them anyway (`read, search, execute, edit`) for clarity.
- Leave `user-invocable` at its default, `true`, so users can also pick these agents directly from `/agent`. `uplift-migrator` and `scaffolder` are the exceptions: set them to `user-invocable: false`, because they must only run inside an orchestrated batch.
- Rewrite the `uplift-migrator` sentence "use Write/Edit, not Bash, because permission rules can see them" so it refers to the guard hook.
- Replace the `/code-modernization:` references.
- Bodies must stay under Copilot's 30,000-character limit. They do today.

Write scopes stay enforced by the prompt, as in upstream, and the guard hook backs them up for `legacy/`.

### 5.3 Scripts → `modernize-tools` MCP server

`tools/server.py` is a stdlib-only MCP stdio server, so there are no pip installs. It exposes one tool per script, with typed parameters:

| Tool | Script |
|---|---|
| `build_report` | build_report.py |
| `make_shards` | make_shards.py |
| `render_rules` | render_rules.py |
| `compare` | compare.py |
| `trace_rules` | trace_rules.py |
| `baseline_diff` | baseline_diff.py |
| `uplift_checks` | uplift_checks.py |
| `proof_pack` | proof_pack.py |

It also adds `render_topology`, replacing map's heredoc, and `guard_selftest`.

How it runs:
- It resolves the scripts via `PLUGIN_ROOT`, which Copilot sets for plugin stdio servers.
- It runs them with the user's `python3` and returns stdout, stderr and the exit code.

Why this route:
- It removes every `${CLAUDE_PLUGIN_ROOT}` dependency.
- It works the same in the CLI, the app and VS Code.
- It gives the agent a narrow, typed surface instead of free-form shell.

Fallback: if MCP is disabled by enterprise policy, the skill bodies document the raw `python3 <path>` command, with the plugin path discovered by `copilot plugin list`. **[spike]** Confirm `PLUGIN_ROOT` is set and the server starts in the app as well as the CLI.

### 5.4 Legacy write protection → `preToolUse` hook

Claude Code enforces "never edit `legacy/`" with `permissions.deny` rules. The Copilot equivalent is `com.github.copilot/hooks/hooks.json`, which runs `tools/guard.py` on `preToolUse`. The guard:
- denies edit and create tools whose path resolves under `legacy/`, following symlinks, because preflight symlinks the real code into `legacy/`
- denies shell commands that would mutate that tree: `sed -i`, `git apply`, `>`, `rm`, `mv` and `cp` targeting it
- returns `permissionDecision: deny` with a reason the agent can read

The guard is configurable through an env var or `analysis/.modernize.json` for a non-default `legacyDir`. **[spike]** Confirm three things:
1. the exact deny output field
2. that the hook fires for subagent tool calls
3. that it fires inside dynamic-workflow agents

If (2) or (3) fails, the documentation tells users to also launch with `--deny-tool` patterns, and preflight warns about it.

### 5.5 Workflows → Copilot Dynamic Workflows

Create one `extension.mjs` that registers six workflows:

- `modernize-portfolio-assess`
- `modernize-extract-rules-mine`
- `modernize-harden-scan`
- `modernize-uplift-deltas`
- `modernize-uplift-migrate`
- `modernize-reimagine-scaffold`

API mapping:

| Claude Workflow | Copilot Dynamic Workflow |
|---|---|
| `export const meta = {name, description, whenToUse, phases}` | `defineWorkflow({ meta: { name, description, phases: [{title}], argsSchema, limits } })` |
| top-level body + `return` | `run: async (ctx) => { … return result }` |
| `args` (string or JSON) | `ctx.args` (always object; keep the existing normaliser and validators) |
| `agent(p, {agentType:'code-modernization:x', label, schema})` | `ctx.agent(p, { agent: '<x>', label, schema })` **[spike: exact name for a plugin agent]** |
| `agent(…, {phase})` | `ctx.phase(title)` at run-level transitions; label per item |
| `parallel(thunks)` | `ctx.parallel(thunks)` (a thrown thunk becomes `null`, as before) |
| `pipeline(items, fn)` | `ctx.pipeline(items, stage1, …)`; stages get `(previous, item, index)` |
| `log()` | `ctx.log()` |
| `budget.total` / `budget.remaining()` (extract-rules) | `meta.limits.maxTotalSubagents` plus a local spawn counter for the reserve logic |
| `resumeFromRunId` | Copilot native resume (`/workflows` → R, or `session.workflow.resume`) |

All the deterministic logic carries over as plain JavaScript. That includes de-duplication, referee folding, COCOMO, the batching graph with cycle detection, the 4→8→16 escalation and the circuit breaker. The `fence()` untrusted-input wrapper and the `UNTRUSTED` suffix also carry over unchanged.

One semantic difference matters. Identical `ctx.agent` calls are memoised, so every fan-out must give each call a unique `label`. Upstream already labels them; the port must keep that.

### 5.6 Things dropped or deferred

| Item | Decision | Why |
|---|---|---|
| Live progress pane, x-ray reads, review deck, sign dialog, fleet view (`hooks/**/*.ts`) | Defer to v2 | Built on Claude Code function hooks and terminal panes. The nearest Copilot surface is an app canvas extension, which is new work. `/modernize-status` and `REPORT.html` cover the information. |
| Telemetry (`scripts/telemetry.*`, 5 hook entries, `test_telemetry.py`) | Drop | It reports through Claude Code's telemetry channel. Re-adding usage counts would need consent and an endpoint. |
| `userConfig` options | Drop, except `legacyDir` | The rest only configure the pane. `legacyDir` becomes a workspace setting the guard and skills read. |
| `/modernize-panel`, `/modernize-sign`, `/modernize-review-pane` | Drop | Pane-only. `/modernize-review` still writes `RULE_REVIEWS.json`, and the brief's approval block is still filled in by a person. |

---

## 6. Approach: converter plus overrides, not a hand fork

Upstream is active, with v1.0.0 committed on 13 Oct 2026. A hand-edited fork would drift on day one. Instead:

- `convert/sync.py` pulls a pinned upstream commit and does the mechanical work:
  - frontmatter
  - `$var` rewriting
  - `CLAUDE_PLUGIN_ROOT` to MCP tool calls
  - command name references
  - agent renames
  - copying scripts and assets
- `convert/overrides/` holds the hand-written sections: preflight Check 7, uplift permissions, workflow invocation blocks, and the extension.
- CI fails if a converted file still contains a Claude-only token: `CLAUDE_PLUGIN_ROOT`, `AskUserQuestion`, `Workflow tool`, `.claude/settings`, `/code-modernization:`.
- Pulling a new upstream release then means re-running the converter and reviewing the diff.

---

## 7. Phased plan

| Phase | Outcome | Est. | Who |
|---|---|---|---|
| **0. Spike** | All **[spike]** items confirmed on a real Copilot CLI and app install | 0.5 day | You run a checklist script I prepare (~20 min), or I drive it with computer use |
| **1. Scaffold** | Repo, Agent Plugins manifest, marketplace, LICENSE/NOTICE, CI, converter skeleton, 8 agents converted | 1 day | Me |
| **2. Tools + guard** | MCP server with all script tools, `render_topology`, guard hook with self-test, Python tests green | 1 day | Me |
| **3a. Discovery skills** | modernize, preflight, assess (single), map, status, working end to end on a sample | 1 day | Me; you smoke-test |
| **3b. Rules → plan → build** | extract-rules (Method B), review, brief, transform, verify, harden (fallback) | 1.5 days | Me; you smoke-test |
| **→ v0.1 release** | Usable plugin without fan-out workflows | | |
| **4. Dynamic workflows** | Six workflows in `extension.mjs`, skills prefer them when `--experimental` is on | 2–3 days | Me |
| **5. Uplift + reimagine** | Full uplift (pilot, playbook, batches, breaker) and reimagine | 1.5 days | Me |
| **6. Prove it** | End-to-end on AWS CardDemo (COBOL → Java transform) and a small .NET Framework 4.8 → .NET 8 uplift; docs; v1.0 release | 1.5 days | Both |

**Total:** about 8–10 working days. v0.1 lands after about 4.

---

## 8. Phase 0 spike checklist

These are run on your machine, because Copilot sessions can't authenticate in this sandbox. Each item gets a tiny probe plugin that I'll prepare.

1. **Skill args.** `/probe-skill hello world` should show the skill receiving `hello world`.
2. **Plugin agent names.**
   - What name does a plugin-shipped agent get in `/agent`: `name` or `plugin:name`?
   - Can a skill delegate to it by that name?
3. **`ask_user` from a skill.** It should work in interactive mode. In `copilot -p` it should fall back cleanly.
4. **MCP `PLUGIN_ROOT`.** A probe server echoes it in the CLI and in the Copilot app.
5. **Guard hook.**
   - A `preToolUse` deny blocks an edit under `legacy/`.
   - Record the exact output field.
   - It also fires for a subagent and for a workflow agent.
6. **Dynamic workflow.** A two-agent `ctx.parallel` probe runs from a prompt, from `copilot workflow run`, and in the Copilot app. `ctx.agent({agent: …})` resolves a plugin agent.
7. **Marketplace install in the app.** Adding the repo marketplace makes the plugin's skills and agents visible in a Copilot app session.
8. **Plan mode in the app.** The brief's "stop for approval" behaves well.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Dynamic Workflows are experimental and plan-gated | Fan-out commands degrade | Every command keeps a direct-subagent fallback. Preflight reports which path will be used. |
| Hook doesn't cover subagents or workflow agents | `legacy/` could be edited | Also recommend `--deny-tool`. Preflight self-test. Agents' prompt-level scope rules stay. |
| Model differences (prompts tuned for Claude) | Weaker extraction or verification quality | Recommend a Claude model in Copilot (available in the model picker) for v0.1. Compare rule-card output on CardDemo against upstream's published run. |
| Upstream changes | Drift | Converter plus overrides, pinned upstream SHA, and a monthly sync. |
| Licensing and trademarks | Confusion about provenance | Apache 2.0 allows it. Keep LICENSE, add a NOTICE describing the changes, and give it a distinct name (e.g. `modernize-for-copilot`). Don't list Anthropic as author or imply endorsement. |
| Visual Studio users | Not supported | Visual Studio lacks custom agents, subagents and skills. Target the CLI and the app (and VS Code as a bonus). |

---

## 10. Proposed GitHub issues

There is one milestone per phase. Labels: `phase-0` … `phase-6`, `needs-sam` (needs you to test or decide).

1. **[phase-0][needs-sam]** Run the Copilot capability spike (checklist §8) and record results in `docs/SPIKE.md`
2. **[phase-1]** Scaffold repo: Agent Plugins 1.0 `plugin.json`, `.github/plugin/marketplace.json`, LICENSE/NOTICE/README, CI
3. **[phase-1]** Converter skeleton (`convert/sync.py`) with pinned upstream SHA and the Claude-token lint
4. **[phase-1]** Convert the 8 agents to `.agent.md`
5. **[phase-2]** `modernize-tools` MCP server wrapping the 8 scripts plus `render_topology`; port the Python tests and drop telemetry
6. **[phase-2]** `preToolUse` legacy write guard with self-test
7. **[phase-3a]** Skills: modernize, preflight (new Check 7), assess (single-system), map, status
8. **[phase-3b]** Skills: extract-rules (Method B), review (`ask_user`), brief (approval gate)
9. **[phase-3b]** Skills: transform, verify, harden (fallback path)
10. **[phase-3b][needs-sam]** v0.1 smoke test in the Copilot CLI and app on a small legacy repo; tag v0.1.0
11. **[phase-4]** Port 4 workflows to `extension.mjs`: portfolio-assess, harden-scan, extract-rules, reimagine-scaffold
12. **[phase-4]** Port the uplift-deltas and uplift-migrate workflows (batches and circuit breaker)
13. **[phase-5]** Skills: uplift and reimagine on workflows, with fallbacks
14. **[phase-6][needs-sam]** End-to-end on AWS CardDemo (transform) and a .NET Framework 4.8 → .NET 8 sample (uplift); write up the results
15. **[phase-6]** Docs (install via marketplace for the CLI and app, Plan mode, `--experimental`, permissions) and tag v1.0.0
16. **[backlog]** v2: progress pane as a Copilot app canvas extension

---

## 11. Decisions needed from you

1. **Repo.** Where should it live? Options are a new repo under `samuelnyamukapa` or a Red Skies org, and a working name such as `modernize-for-copilot`. A standalone repo is recommended over forking the ~40-plugin `claude-plugins-official` monorepo, because the converter keeps the upstream link.
2. **Phase 0.** Do you want to run the spike yourself, or should I drive Copilot on your computer through computer use?
3. **Copilot plan.** Confirm your Copilot plan supports Dynamic Workflows; Pro/Pro+ on a legacy annual plan doesn't.
4. **Visibility.** Public or private repo to start.
