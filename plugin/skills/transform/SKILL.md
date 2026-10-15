---
name: transform
description: "Rewrite one legacy module in the target stack, with tests that prove it behaves the same. Usage: /modernize:transform <system> [module] [target-stack]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.
- `<module>`: second word, optional. A folder name of letters, digits, `.`, `-` and `_` only (e.g. `Contoso.Billing.Api`; never `..`), because it becomes `modernized/<system>/<module>/`. Refuse anything else, including a module name taken from the brief.
- `<target-stack>`: the rest, optional. It may be quoted when it has spaces (`"Java 17"`).

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

Transform module **`<module>`** of `<system>` into **<target-stack>**, with proof of behavioral
equivalence. This is one vertical slice of the strangler fig; output goes to
`modernized/<system>/<module>/`.

The code is `legacy/<system>`, often a symlink to where it really lives: say where it points (`readlink legacy/<system>`; in PowerShell, `(Get-Item legacy/<system>).Target`) in one line before you start. If `legacy/<system>` does not exist, stop and say so: nothing can run without the code, so the fix is `/modernize:start <system> --source <path to the code>`. Wait for every delegated agent's result before you continue: never end your turn while one is still running. Stop any server or other process you started (a legacy app on a local port, a watcher) before you finish, and say you did. **If `<module>` or `<target-stack>` is empty**, read
`analysis/<system>/MODERNIZATION_BRIEF.md`: take the target stack it names, and the first module of
the earliest phase whose `Command:` is `transform` that has no
`modernized/<system>/<module>/TRANSFORMATION_NOTES.md` yet (with no brief, the target in `INTENT.md`). Say which you picked.

**Where this skill writes.** Only to `modernized/<system>/<module>/` (the code, the tests and
`TRANSFORMATION_NOTES.md`) and to `analysis/` (the recorded outputs under `analysis/<system>/equivalence/`,
`EQUIVALENCE.json` and the report). Never edit anything under `legacy/`, or under a path recorded in
`analysis/<system>/SOURCE`: read the legacy code and run it, but send any build or run output it produces to
`analysis/<system>/equivalence/`, never into `legacy/`. The plugin's `legacy/` guard enforces this: a `preToolUse`
hook that runs before every tool call of this agent and of every agent it delegates to. A denied write under
`legacy/` is expected: that is the guard working. Do not retry with another command or tool, and never try to get
around it; write to `modernized/` or `analysis/` instead.
One exception: the denial ends with `Matched:` and the part of the command it matched. If that part does not
write under `legacy/` (a commit message that names it, a copy *from* it), the guard misread a compound command:
run its steps as separate commands, and if one step is denied on its own, stop and report it.

## Step 0 — Toolchain, then the plan (human gate)

**Target stack (required).** The runtime, package manager and test framework must respond
(`java -version` and `mvn -v`, `node -v` and `npm -v`, `python3 -V` and `pytest --version`). If not,
stop and say what to install: a plan gate now would only defer the failure an hour. Point to
`/modernize:preflight <system> <target-stack>`.
On Windows the same tools are run from PowerShell (e.g. `mvn -v`, `dotnet --version`; `py -3 -V` where `python3` is not on `PATH`).

**Legacy stack (advisory, never a blocker).** Try a syntax-only compile of the module. Legacy code
often cannot build locally by nature (CICS and IMS programs have no local translator; the real runtime
is a mainframe you do not have). If it cannot, dual execution is off the table: the tests assert
against **recorded traces and golden-master fixtures** (real production outputs, captured reports,
SME-confirmed examples). Say so in the plan and in `TRANSFORMATION_NOTES.md` ("equivalence is
trace-based; legacy was not executable here"), so reviewers know how strong the proof is.

**Run the old system only where it is safe.** Record baselines from the legacy code running on this
machine, or against a test environment the person named. Never call a production or third-party
service, register an account, or send or change real data to record a baseline unless the person
approved that exact target in the plan (say which calls, and which of them write). A token, password
or session cookie in a recorded response is a secret: replace it with a fixed fake value before
anything is saved, and never print it.

**The brief is binding.** If `MODERNIZATION_BRIEF.md` exists, find the phase whose `Command:` is this
one and whose `Modules:` include `<module>`, and treat its scope, entry criteria, exit criteria and any
edits the user made as binding. An unmet entry criterion is the next step: meet it, never re-plan
around it. If no phase covers `<module>`, stop and ask which phase this is.

**Wrong command for the plan.** If the brief's phases name only `/modernize:uplift` or `/modernize:reimagine` on their `Command:` lines, the
approved plan does not use `transform`: before anything else, stop and ask with `ask_user` whether to run the
planned command instead (recommended) or to transform outside the plan. Outside the plan, nothing the brief gates is
ticked or claimed, and the closing summary says the work was not part of the approved plan.

Read the module's source and the rules in `BUSINESS_RULES.md` that reference it, and any verdicts on them in `analysis/<system>/RULE_REVIEWS.json`: a rule marked `wrong` is not pinned as the oracle (use the reviewer's note for what is right, and if the note does not say, ask), and a P0 rule marked `discuss` is a question to settle at this plan gate before any code. Then present the
plan and **stop: write no code until the user explicitly approves**: which
source files are in scope, the target structure, which rules and behaviors it implements, how you will
prove equivalence, and anything ambiguous that needs a human decision now.

> **Stop here for explicit approval.** Present the plan and wait for the user to say yes. "No objection" or silence is not approval. If the session is in Plan mode, this is the plan to approve.

## Step 1 — Characterization tests first

Delegate to the custom agent **`modernize:test-engineer`** with this prompt (fill in the placeholders, and name
the test framework that is right for `<target-stack>`):

> Write characterization tests for module <module> of legacy/<system>.
> Read the source, identify every observable behavior and encode each as a test with concrete input and
> expected output derived from the legacy logic. Target framework: <right for <target-stack>>. Write to
> `modernized/<system>/<module>/src/test/`. These tests define 'done'. Name the `RULE-NNN` id(s) each test pins
> (from `analysis/<system>/BUSINESS_RULES.md`) in its name or a one-line comment, so the trace can find it. Follow your secret-handling rules:
> no credential from legacy code becomes a fixture; use fake same-shape values and read anything live
> from environment variables.

Show the user the test file and get a yes before going on.

## Step 2 — Idiomatic transformation

Write the implementation in `modernized/<system>/<module>/src/main/`. **Write what a senior
<target-stack> engineer would write from the *specification*, not from the legacy structure:** do not
mirror COBOL paragraphs as methods or keep names like `WS-TEMP-AMT-X`; use the target's idioms
(records, streams, injection, proper error types). Include the domain model, service logic, API
surface and configuration, and link each class to the rule IDs it implements in a short comment.

## Step 3 — Prove it, and prove the proof can fail

While iterating, run only this module's tests; run the whole suite once before Step 4.

1. **Run the tests** (`cd modernized/<system>/<module>` and the stack's test command) and show the
   output. Fix and rerun until green.
   On Windows the same tools are run from PowerShell (e.g. `dotnet test`, `mvn -q test`).
2. **Count what ran.** Report `equivalence cases executed: N`. A run that executed **zero** cases proved
   nothing, and a comparison test must **fail, never skip,** when its legacy oracle or fixture is
   missing: a suite that is green because everything skipped is not green. If the oracle was
   unreachable, fix that; do not report the suite as passing.
3. **Show the tests can fail.** Temporarily break the new code in one small way that matters (change a
   rounding mode, shift a threshold by one, flip a comparison), confirm at least one test goes red,
   restore it, and record `Canary: <the change> → <N> tests failed` in the notes. If nothing failed,
   the tests do not pin the behavior: strengthen them before going on.
4. **When the legacy code can run here**, also run both systems on the same inputs, save each output
   under `analysis/<system>/equivalence/legacy/` and `.../new/`, list the pairs in
   `analysis/<system>/equivalence/cases.json` (paths relative to that folder; the schema is at the top of
   the plugin's `scripts/compare.py`, and is repeated under **The `cases.json` format** below), and call the
   `compare` tool on the `modernize-tools` MCP server with
   `{workspace, cases: "analysis/<system>/equivalence/cases.json", out: "analysis/<system>/EQUIVALENCE.json"}`.
   That tool, not your judgment, decides same or different. It returns the script's exit code, stdout and
   stderr: exit 0 only when at least one case executed, none is missing or differs (approved differences
   are allowed), the self-check did not fail and some compared output was not empty; 1 otherwise; 2 for
   unusable input (fix `cases.json` and call it again). If the `modernize-tools` server or its `compare` tool
   is not available, stop here: tell the user to run `/mcp` to check that `modernize-tools` (or
   `modernize-tools-win`) is connected, and to see `/modernize:preflight`. Never compare the outputs yourself
   or write `EQUIVALENCE.json` by hand.
   Mask only fields that legitimately vary
   (timestamps, generated ids) and say what each mask hides. A difference you accept is recorded with a
   reason in the case's `approvedDifference`, and only a person accepts it.
   Floating-point numbers that another compiler or math library prints slightly differently are not a
   mask: give that case a `tolerance` (`rel` or `abs`, and a `why`), which compares numbers written with a
   decimal point or exponent within it, every other byte exactly, and is listed in the result.

### The `cases.json` format

From the top of the plugin's `scripts/compare.py` (case paths here follow the layout above):

```json
{"system": "<system>",
 "legacy": {"label": "COBOL, GnuCOBOL 3.2", "command": "optional free text"},
 "new":    {"label": "Java 17",             "command": "optional free text"},
 "cases": [{"id": "C01", "title": "Interest posting, normal account",
            "legacy": "legacy/C01.out", "new": "new/C01.out",
            "mask": [{"bytes": "278-330", "why": "run timestamp"},
                     {"regex": "\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}"}],
            "approvedDifference": "optional: why a person accepted a difference",
            "note": "optional"}]}
```

- Paths are relative to the cases file's folder and may not leave it. `bytes` ranges are 0-based and
  inclusive; `regex` runs on the bytes decoded as latin-1. Every masked span, on both sides, is replaced by
  one fixed marker, so masks never hide the position of a difference and a variable-length match still
  compares equal.
- A case is `same` (identical after masking), `differs` (the first difference is recorded; a person may
  approve it: `differs-approved`) or `missing` (a file is absent, unreadable or outside the cases folder;
  never a pass).
- A person who accepts a difference records it on the case (`"approvedDifference": "why"`), or once for
  every case that shares an `input` label with a top-level `"approvedInputs": {"F23": "why"}`. A reason is
  required either way, and an approved difference is still listed as a difference in the result.
- A `tolerance` goes on a case, or at the top level for all cases:
  `"tolerance": {"rel": 1e-9, "abs": 0, "why": "last-digit rounding of the exp() in the interest formula"}`.
  The reason is required and is recorded. Every integer and every dotted run like `1.2.3` must match
  exactly. Within the tolerance the case is `same`, with the largest relative difference recorded; anything
  outside it is `differs`. A relative tolerance above 1% or an absolute one above 1e-6 is refused: that is a
  different result, not rounding.

## Step 4 — Notes and a side-by-side

Write `modernized/<system>/<module>/TRANSFORMATION_NOTES.md`: a mapping table (legacy file:lines to target
file:lines, per behavior); deliberate deviations with rationale; what was NOT migrated (dead code,
unreachable branches) and why; the canary result and the executed-case count; follow-ups for the next
dependent module. Show one representative behavior side by side
(`diff -y --width=160 <(sed -n '<lines>p' <legacy file>) <target file>`; PowerShell has no `<(...)`, so
without `bash` on `PATH` print the two ranges one after the other, e.g.
`Get-Content <legacy file> | Select-Object -Skip <first line - 1> -First <line count>`, then the target lines).
Never pick a credential-bearing
range, and mask any credential-like literal in the notes: they live in `modernized/` and get committed.
This is your own evidence: `/modernize:verify <system> <module>` is the independent re-check
(it re-runs the tests and the comparison, tries new inputs, and gives one verdict).

## Step 5 — Architecture review

Delegate to the custom agent **`modernize:architecture-critic`** to review the code against <target-stack>
best practice, with this prompt: "Review the transformed module in `modernized/<system>/<module>/` against
<target-stack> best practice." Apply HIGH-severity feedback and list the rest in the notes.

Report: tests passing, cases executed, lines of legacy retired, where the artifacts are. Refresh the
report: call the `build_report` tool on the `modernize-tools` MCP server with {workspace, system} (a
convenience: if it fails or the `modernize-tools` server isn't available, say so in one line and carry on).
The next step is the brief's next module, or `/modernize:harden <system>` when the phase is done.
