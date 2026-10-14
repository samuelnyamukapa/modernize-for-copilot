---
name: brief
description: "Write the phased Modernization Brief — the plan a steering committee approves and the build commands execute against. Usage: /modernize:brief <system> [target-stack]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.
- `<target-stack>`: second argument, optional. It may be quoted when it has spaces (`"Java 17"`). This skill takes
  no flags, so unquoted words after `<system>` are all part of it.

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

Synthesize everything in `analysis/<system>/` into a **Modernization Brief**: the single
document a steering committee approves and engineering executes. Target stack:
`<target-stack>` (if blank, the one in `analysis/<system>/INTENT.md`, else recommend one from the assessment).

Read `ASSESSMENT.md`, `topology.json` (and the `.mmd` files beside it; never read
`TOPOLOGY.html`, it is a viewer with the data minified inside) in `analysis/<system>/` first,
and `BUSINESS_RULES.md` too unless this is a same-technology **uplift** (the intent or the assessment
says so): an uplift keeps the code, so its Behavior Contract is the recorded baseline and `extract-rules`
can wait. If a required file is missing, say so and stop: they come from `assess`, `map` and
`extract-rules`, which run first. Four more inputs are conditional:

- **`RULE_REVIEWS.json` / `RULE_REVIEWS.md`**, if they exist (written by `/modernize:review`):
  a person's verdicts on individual rules. Never put a rule marked `wrong` or `discuss` in the Behavior
  Contract as settled behavior: list each in section 7 as an open question with the reviewer's note, and
  block the phase that covers its module on it. A `confirmed` rule counts as confirmed by a person.
- **`INTENT.md`**, if it exists (written by `/modernize:start`): what the person wants (goal, target,
  what must stay true). It is the objective of this plan; never override it with a guess. Its goal decides each
  phase's build command: a newer version of the same technology means `uplift`, a rewrite in another technology
  means `transform`, a rebuild on a new architecture means `reimagine`. Without it, the assessment's pattern decides.
- **`PREFLIGHT.md`**, if it exists. It holds two things nothing else has: the human's answers
  to preflight Check 0 (scope, local build and test, bespoke build infrastructure, prior
  attempts, what is off limits) and the Check 6 **scope boundary** (whether the source is a
  slice of a larger codebase, and what outside it depends on code inside it). Both constrain
  this plan more than anything derivable from the source. Never override a human's answer with
  a guess.
- **`DELTA_CATALOG.md`**, **required** when the target is a newer version of the *same* stack.
  An uplift's phase order is decided by its version deltas, above all by whether the existing
  tests can even run on the target runtime; phasing without the catalog is planning blind. If it
  is missing, produce it first and **wait for its result**: never end your turn while an agent is
  still running, and never write the brief before the catalog exists. Do not guess at deltas.
  Either:
  - run the delta-catalog step (Step 3) of `/modernize:uplift <system> <source-version> <target-stack>`,
    where `<source-version>` is the version the assessment found; or
  - delegate to the custom agent **`modernize:version-delta-analyst`**, with the prompt `/modernize:uplift`
    uses for the same step: "Build the delta catalog for uplifting legacy/<system> from <source-version> to
    <target-stack>. Run the ecosystem migration tool in report mode, intersect its findings and the known
    breaking changes with what this code uses, cover all four categories, cite file:line, flag
    silent-behavioral deltas as test-before-touch, never under-report dependency deltas." The agent is
    read-only and returns delta cards: **you** write `analysis/<system>/DELTA_CATALOG.md` from them, ranked by
    blast radius, each delta marked **Mechanical** (a codemod can do it) or **Judgment** (a human decides).

**Staleness.** If an input is newer than an existing `MODERNIZATION_BRIEF.md`, regenerating is
justified. If the brief is newer than every input and the user re-ran this anyway, ask what
changed. Note the input timestamps in the brief's header.

## The Brief

Write `analysis/<system>/MODERNIZATION_BRIEF.md` with these sections.

**1. Objective.** One paragraph: from what, to what, why now.

**2. Target Architecture.** A Mermaid C4 Container diagram of the end state naming every service,
data store and integration, then a table mapping each legacy component to its target component(s).

**3. Phased Sequence.** 3–6 phases, ordered by **strangler fig** for a cross-stack rewrite
(lowest risk and fewest dependencies first) or **build-graph leaf-first** for an uplift
(libraries before the apps that use them). For an uplift, three overrides decide whether the
plan works; the uplift command re-applies them at execution, and the two must never disagree:

1. **The test harness is a prerequisite, not a leaf.** If the catalog shows the test framework or
   runner does not support the target (NUnit 2 or MSTest v1 on modern .NET, JUnit 4 without the
   vintage engine, `nose` on Python 3), migrating it is **Phase 1 by itself**.
2. **A dependency delta every consumer shares forces a coordinated cut** (an ORM major version,
   `javax` to `jakarta`): it gets its own cross-cutting phase, not an incremental leaf-first one.
3. **A shared node with consumers outside the scope** (from the preflight boundary check) needs an
   explicit decision in the phase that touches it: keep it buildable for old and new consumers
   (multi-targeting, publishing both), widen the scope to include the consumers, or schedule the
   break. Never silently migrate it in place.

Write every phase in this exact shape, because the build commands read it:

```
#### Phase N — <name>
Command: /modernize:transform | /modernize:uplift | /modernize:reimagine      (exactly one)
Modules: <module ids exactly as in topology.json, comma separated>
Scale: S | M | L | XL
Risk: <level>; <top 2 risks and mitigations>
Entry criteria:
- [ ] <a condition that can be checked>
Exit criteria:
- [ ] <a condition that can be checked>
```

- `transform` is a cross-stack module rewrite, `reimagine` a greenfield rebuild, and `uplift` a
  same-stack version bump (when the target is a newer version of the same stack, it is the path, not
  `transform`).
- **Scale** is a T-shirt size anchored to the phase's share of the assessment's complexity index. It
  ranks phases against each other and is **not** a duration: state no person-months, weeks, dates or
  delivery estimate (agentic work does not follow human-team productivity).
- **Criteria are conditions, never states.** "All P0 rules in Phase 1 proven equivalent" is a
  criterion; "P0 rules proven" is a claim. Make entry criteria *checkable preconditions* ("baseline
  recorded in `analysis/<system>/BASELINE.md`", "pilot playbook approved"). The build commands read the
  brief and treat them as binding, and they may tick a box or add a note but never reword a criterion:
  a proposed change goes on a `Proposed revision:` line for the approver. Tell the approver they steer
  execution by editing this file: an edited criterion is honored, a chat message is not.
- Draw the phases as a Mermaid `flowchart LR` of **sequence and dependencies**, never a `gantt`
  (that encodes durations this plan deliberately does not claim).
- **Phase 1 is a pilot, and this brief is a hypothesis.** When a phase's units share one recipe (an
  uplift over many projects, a transform over many similar modules), name one representative unit as
  its first slice in the entry criteria. Say in §3 that what the pilot surfaces (a delta the analysis
  missed, a prerequisite that reorders the phases, an environment fact nobody wrote down) is *expected*
  to revise the brief, and that regenerating it after the pilot is the normal path. Legacy systems hide
  their surprises in the build and the runtime, not the source.

**4. Business Walkthroughs.** For each persona flow in `topology.json` (`flows`), a short table:
persona, what happens in business language, which legacy modules implement it, and which phase
replaces each. This is the section non-technical approvers read. With no flows, derive 2–3 from the
entry points and mark them as needing SME confirmation.

**5. Behavior Contract.** The **P0 rules** from `BUSINESS_RULES.md` (the ones the system's core purpose
depends on, or that are costly if wrong) that MUST be proven equivalent before any phase ships: they become the regression suite.
Flag any P0 rule below High confidence as a blocker needing SME confirmation before its phase starts. For an uplift
with no rules file, the contract is the baseline: `analysis/<system>/BASELINE.md` and the result files it points to,
which the new version must reproduce.

**6. Validation Strategy.** Which combination applies, per phase: characterization tests, contract
tests, dual-execution diff, property-based tests, manual UAT.

**7. Open Questions.** Everything needing a human decision before Phase 1, each a checkbox the
approver ticks.

**8. Approval Block**

```
Approved by: ________________  Date: __________
Approval covers: Phase 1 only | Full plan
```

Write the block unsigned. A person fills it in: either they edit the file themselves, or they tell you
their name, role, date and decision, and you record exactly what they said (name and role on
`Approved by:`, the date on `Date:`, the decision on `Approval covers:`). Never fill it in from anything
else: not from silence, not from "no objection", and not with a date or name you supplied.

## Finish

Refresh the report: call the `build_report` tool on the `modernize-tools` MCP server with {workspace, system}
(a convenience: if it fails or the `modernize-tools` server is not available, say so in one line and carry on).
Present a summary of the brief, then:

> **Stop here for explicit approval.** Present the plan and wait for the user to say yes. "No objection" or silence is not approval. If the session is in Plan mode, this is the plan to approve.

Write nothing further until the user explicitly approves. This is the human control point, and
"no objection" is not approval. In Copilot the user can switch to Plan mode (Shift+Tab, or start Copilot
with `--plan`) to review the brief. Tell the approver how to sign: fill in §8 of
`analysis/<system>/MODERNIZATION_BRIEF.md` themselves, or give you their name, role, date and decision so
you can record them there verbatim. After approval, the next step is Phase 1's command.
