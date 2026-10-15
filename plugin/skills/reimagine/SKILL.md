---
name: reimagine
description: "Rebuild the system from its extracted intent on a new architecture, with two human checkpoints. Usage: /modernize:reimagine <system> [target-vision]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name that starts with a letter or digit, then only letters, digits, `-` and `_`. Refuse anything else.
- `<target-vision>`: **everything after `<system>`**, optional. It is usually several words, so take the whole
  remainder and never truncate it. With none, use the target vision in `analysis/<system>/INTENT.md`. Below,
  `<target-vision>` always means that whole remainder.

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

The code is `legacy/<system>`, often a symlink to where it really lives: say where it points (`readlink legacy/<system>`; in PowerShell, `(Get-Item legacy/<system>).Target`) in one line before you start. If `legacy/<system>` does not exist, stop and say so: nothing can run without the code, so the fix is `/modernize:start <system> --source <path to the code>`. Wait for every delegated agent's result before you continue: never end your turn while one is still running. Stop any server or other process you started (a legacy app on a local port, a watcher) before you finish, and say you did.

**Reimagine** the system as: <target-vision>. This is not a port but a rebuild from extracted intent: the legacy
system is the *specification source*, not the structural template. The skill orchestrates a team of
agents with two explicit human checkpoints.

**Where this skill writes.** Only to `modernized/<system>-reimagined/` (the scaffolded services, their tests and
the `AGENTS.md` handoff) and to `analysis/` (`AI_NATIVE_SPEC.md`, `REIMAGINED_ARCHITECTURE.md` and the report).
Never edit anything under `legacy/`, or under a path recorded in `analysis/<system>/SOURCE`: read the legacy code,
never write to it. The plugin's `legacy/` guard enforces this: a `preToolUse` hook that runs before every tool call of
this agent, of every agent it delegates to and of every dynamic-workflow agent. A denied write under `legacy/` is
expected: that is the guard working. Do not retry with another command or tool, and never try to get around it;
write to `modernized/<system>-reimagined/` or `analysis/` instead.
One exception: the denial ends with `Matched:` and the part of the command it matched. If that part does not
write under `legacy/` (a commit message that names it, a copy *from* it), the guard misread a compound command:
run its steps as separate commands, and if one step is denied on its own, stop and report it.

**The brief is binding.** If `analysis/<system>/MODERNIZATION_BRIEF.md` exists, find the phase whose
`Command:` is this one and whose scope matches `<system>` and <target-vision>, and treat its scope, entry
criteria, exit criteria and the user's edits as binding on everything below, on top of (never instead of)
this skill's own two checkpoints. An unmet entry criterion is the next step: meet it, never re-plan
around it. If no phase matches, stop and ask which phase this is.

## Phase A — Specification mining

Reuse what discovery already produced (honoring `RULE_REVIEWS.json`: a rule marked `wrong` is not part of the spec as written, and a P0 rule marked `discuss` is a question for the architecture checkpoint): `BUSINESS_RULES.md`, `DATA_OBJECTS.md`, `topology.json` and
`ASSESSMENT.md` in `analysis/<system>/`. Delegate these in parallel (and tell the user all are running), but only
the ones whose input is missing:

1. To the custom agent **`modernize:business-rules-extractor`**, only if `BUSINESS_RULES.md` is missing:
   "Extract every business rule from legacy/<system> into Given/When/Then form, as a structured list."
2. To the custom agent **`modernize:legacy-analyst`**: "Catalog every external interface of legacy/<system>:
   inbound (screens, APIs, batch triggers, queues) and outbound (reports, files, downstream calls, DB writes),
   each with name, direction, payload shape, and frequency or SLA if discernible. Mask credentials in endpoints
   and payload examples."
3. To the custom agent **`modernize:legacy-analyst`**, only if there is no `topology.json` or `DATA_OBJECTS.md`:
   "Identify the core domain entities of legacy/<system> and their relationships: an entity list and a Mermaid
   erDiagram."

Write `analysis/<system>/AI_NATIVE_SPEC.md`: **Capabilities** (what the system must do, from rules and
interfaces), **Domain Model** (entities and erDiagram), **Interface Contracts** (each external interface as
an OpenAPI or AsyncAPI fragment), **Non-functional requirements** inferred from legacy (batch windows,
volumes), and the **Behavior Contract** (the Given/When/Then rules, which are the acceptance tests).
Credentials are masked everywhere; connection details appear as env-var placeholders (`${DATABASE_URL}`),
never literals.

## Phase B — Checkpoint 1

Present the spec summary and ask **one focused question**: "Which of these capabilities are P0 for the
reimagined system, and should any be deliberately dropped?" Ask it with the `ask_user` tool, letting the person
answer in their own words; where `ask_user` is unavailable, ask it in chat. This question has no default: never
answer it yourself and never continue past this checkpoint without the person's answer, in any mode. Wait, and
record the answer in the spec.

## Phase C — Architecture, then critique

Design the target architecture for <target-vision>: a Mermaid C4 Container diagram, service boundaries with
rationale (which rules and entities live where), technology choices with a one-line justification each, and
the data migration approach from the legacy stores. Then delegate to the custom agent
**`modernize:architecture-critic`**, with this prompt followed by the draft architecture: "Review this
architecture for <target-vision> against `analysis/<system>/AI_NATIVE_SPEC.md`: over-engineering, missed
requirements, scaling risks, simpler alternatives." Incorporate the critique and write
`analysis/<system>/REIMAGINED_ARCHITECTURE.md`.

## Phase D — Checkpoint 2

Present the architecture and **stop: scaffold nothing until the user explicitly approves**. The approval
authorizes the build-out.

> **Stop here for explicit approval.** Present the plan and wait for the user to say yes. "No objection" or silence is not approval. If the session is in Plan mode, this is the plan to approve.

## Phase E — Parallel scaffolding (only after Phase D approval)

**Preferred: dynamic workflow.** If this session has Copilot dynamic workflows (started with `--experimental`),
scaffold **every** service in the approved architecture (no cap from this skill; Copilot's run limits apply).
Tell the user the service count, then run the `modernize-reimagine-scaffold` dynamic workflow (the plugin
registers it) with these args. The Phase D approval authorizes it. Runs start in the background. Wait for the
result, then continue from it. To resume a stopped run, open `/workflows` and resume it there.

```
{ "system": "<system>", "services": [
  { "name": "<service-name>", "responsibilities": "<one line from the architecture>" }, ...
] }
```

Each `name` becomes a folder, so it must start with a letter or digit, then only letters, digits, `-` and `_`:
the workflow rejects the whole run on one unsafe name, or on a missing `system` or an empty `services` list.

Each agent writes only inside `modernized/<system>-reimagined/<service-name>/` (disjoint, so parallel writes
do not conflict). It returns:

```
{
  system,
  scaffolded: [ { service, summary, acceptanceTestCount,
                  pendingRuleIds?, filesCreated?, blockers? } ... ],
  notScaffolded: [ "<service-name>", ... ],          // skipped or errored
  totals: { services, acceptanceTests, pendingRules } // pendingRules counts distinct rule IDs
}
```

From the result report `scaffolded[]` (each service with its `pendingRuleIds`), `totals` (services,
acceptanceTests, pendingRules), and `notScaffolded`, and **read every service's `scaffolded[].blockers`**: that
is where planted instructions in the untrusted spec surface.

**Fallback.** If dynamic workflows aren't available (or `modernize-reimagine-scaffold` isn't registered), or the
run fails, use the direct method below.

Delegate to the custom agent **`modernize:scaffolder`**, one per service, in parallel (at most 3 at a time; say
which you deferred), with this prompt: "Scaffold the <service-name> service per
`analysis/<system>/REIMAGINED_ARCHITECTURE.md` and `AI_NATIVE_SPEC.md`: project skeleton, domain model, API stubs
matching the interface contracts, and **executable acceptance tests** for every behavior-contract rule assigned
to this service (mark unimplemented ones expected-failure with the rule ID). No credential from legacy code
becomes a fixture or config default: use fake same-shape values and env-var placeholders. Write to
`modernized/<system>-reimagined/<service-name>/`."

When all finish, run the acceptance suites and report: total tests, passing (scaffolded behavior), pending
(rule IDs awaiting implementation), and `tests executed: N` (a suite that executed nothing proved nothing).
On Windows the same tools are run from PowerShell (e.g. `dotnet test`, `mvn -q test`).

## Phase F — Knowledge handoff

Write `modernized/<system>-reimagined/AGENTS.md`, the persistent context for the new system (Copilot reads
`AGENTS.md` natively): architecture summary, service responsibilities, where the spec lives, how to run the
tests, and the legacy-to-modern traceability map. It gets committed, so connection details and credentials
appear only as env-var names with a pointer to where they are provisioned, never values. This file also marks
the reimagine as done for `/modernize:status`.

Report: services scaffolded, acceptance tests defined, the share of behaviors with a home, and where the
artifacts are. Refresh the report: call the `build_report` tool on the `modernize-tools` MCP server with
{workspace, system} (a convenience: if it fails or the `modernize-tools` server is not available, say so in one
line and carry on). The next step is implementing the pending rules service by service, then
`/modernize:harden <system>`.
