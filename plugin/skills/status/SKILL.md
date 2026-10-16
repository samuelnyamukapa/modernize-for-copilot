---
name: status
description: "Where am I? Progress, what is stale, and the exact next command to run — start here when unsure. Usage: /modernize:status <system>"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

Report where the modernization of `<system>` stands, in one screen. This skill inspects and never modifies,
except that it refreshes `analysis/<system>/REPORT.html` (call the `build_report` tool on the `modernize-tools` MCP
server with {workspace, system}, a convenience: if the call fails or the `modernize-tools` server isn't available, say so in one line and carry on). If nothing
exists yet, the answer is `/modernize:start <system> --source <path to the code>`, which asks what the person wants and starts preflight.

## 1 — Inventory

Check `analysis/<system>/` and `modernized/<system>*/` and build a table, one row per stage, with each artifact's
presence and modification time:

| Stage | Artifacts |
|---|---|
| intent | `INTENT.md` (what the person wants; written by `/modernize:start`) |
| preflight | `PREFLIGHT.md` (are the Check 0 human answers and the Check 6 scope-boundary finding there?), where `legacy/<system>` points (does that directory exist?) |
| assess | `ASSESSMENT.md`, `ARCHITECTURE.mmd` |
| map | `topology.json`, `TOPOLOGY.html`, `*.mmd`, `extract_topology.*` |
| extract-rules | `BUSINESS_RULES.md`, `DATA_OBJECTS.md` |
| review | `RULE_REVIEWS.json`: how many flagged rules a person has decided (confirmed, wrong, needs discussion), and how many are still open |
| brief | `MODERNIZATION_BRIEF.md` (is the approval block signed?) |
| harden | `SECURITY_FINDINGS.md`, `security_remediation.patch` |
| uplift | `DELTA_CATALOG.md`, `BASELINE.md`, `PLAYBOOK.md` (no playbook means the pilot has not happened, so the fan-out must not), `modernized/<system>-uplifted/UPLIFT_NOTES.md` (per unit: builds on target? baseline reproduced?) |
| transform | each `modernized/<system>/<module>/`: tests present? `TRANSFORMATION_NOTES.md` present (its completion marker)? |
| reimagine | `modernized/<system>-reimagined/`: per-service acceptance tests, and the `AGENTS.md` handoff (its completion marker; it does not write `TRANSFORMATION_NOTES.md`) |
| equivalence | `EQUIVALENCE.json`: cases executed, same, differs (any differing or missing case, or zero executed, is a failure) |
| verify | `VERIFICATION.md` (written by `/modernize:verify`): the verdict per built module (PROVEN, PARTLY PROVEN or NOT PROVEN) and whether a person has signed it: signed means the
**Sign-off** table at the end of `VERIFICATION.md` has a Name and a Decision filled in (`VERIFICATION.json` keeps the
script's blank template, so never judge the sign-off from it). A built module with no `VERIFICATION.md`, or one older than the module's code or tests, is **not proven yet** |
| parity | `parity/PARITY.md` (written by `/modernize:parity`): the verdict (PARITY, NO PARITY, INCOMPLETE or NO EVIDENCE), the counts, any BREAKING contract, and whether its **Sign-off** row has a Name and a Decision. A report older than the new system's code is stale |

## 2 — Stale

Flag any artifact older than one it derives from: the brief older than `ASSESSMENT.md`, `topology.json` or
`BUSINESS_RULES.md` (no longer reflects discovery: rerun `brief`); an uplift's brief older than
`DELTA_CATALOG.md`, or with no catalog (phase order was decided without the version deltas: rerun `brief`);
`TOPOLOGY.html` older than `topology.json` (rerun the render step of `map`); a `TRANSFORMATION_NOTES.md` older
than `BUSINESS_RULES.md` (the module may not implement the latest rules: list which).

## 3 — Secrets hygiene

Does `analysis/.gitignore` exist and cover `SECRETS.local.md` and `*.local.patch` (`git check-ignore` in a git
repo)? If `SECRETS.local.md` exists, confirm it is NOT tracked (`git ls-files --error-unmatch` should fail) and
never committed (`git log --all --oneline -- <path>` should be empty). If either fails, say so prominently and
recommend rotation and history scrubbing.

## 4 — Live status in the Copilot app

In the Copilot desktop app, after the table, open the live status: call the `open_canvas` tool for the canvas
`modernize-status` with input `{"system": "<system>"}`. It shows the same steps, the map of the code, the verdicts,
what needs a person and the next command, and it refreshes itself as files change; it never runs a command. This is a
convenience: if canvases are not available (in the CLI, say), say nothing about it and carry on.

## 5 — Verdict

End with three lines:

- **Where you are:** the furthest completed stage and how much it covers ("mapped 100%, 2 of 14 modules transformed, 1 proven").
- **What is stale:** or "nothing".
- **Next command:** the single most useful next step as the exact command line to paste, with a one-line reason.
  The order is preflight, assess, map, extract-rules, review (when rules are flagged for a person), brief (needs approval), then the brief's Phase 1 command
  (`transform`, `uplift` or `reimagine`), then `verify` for what was built, then `harden`. Never call a
  built module done until `verify` says PROVEN and a person has signed it: put `verify` ahead of building the next module.
