---
name: review
description: "Confirm or correct the business rules that need a person's judgement; the plan and the build read your answers. Usage: /modernize:review <system> [flagged|p0|all]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.
- `<scope>`: second word, optional: `flagged` (the default), `p0` or `all`. If the second word is not one of these three, the scope is `flagged` and that word belongs to the rest below.
- Anything else in the arguments or the message, such as `RULE-004 wrong: it truncates on purpose`, is a verdict the person typed in the request (step 2).

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

Ask a person to decide the business rules in `analysis/<system>/BUSINESS_RULES.md` that depend on judgement, and record each answer so the plan and the build honor it. Agents mined the rules and a second agent checked every citation, but only someone who knows the business can say whether a rule is *right*: whether a truncation is intended or a defect, whether a threshold is still the policy. This skill asks in a pop-up (the `ask_user` tool) and never edits `BUSINESS_RULES.md`.

## 1 — Choose the rules

Read `BUSINESS_RULES.md` (each card has `### RULE-NNN`, Priority, Confidence, and sometimes a suspected defect or an SME question) and, if it exists, `analysis/<system>/RULE_REVIEWS.json`; rules already decided are skipped, and you say how many. `<scope>` picks the rest:

- **flagged** (the default): P0 rules that have a suspected defect, an SME question or less than High confidence, plus any rule the brief's open questions name.
- **p0**: every P0 rule. **all**: every rule.

Say how many rules will be asked (about a minute per ten). If none is left, say so and give the next command.

## 2 — Ask

Use the `ask_user` tool, never chat text, up to four rules per call. One question per rule: its id as the header (or as the first words of the question, if the pop-up has no header); the title, the plain-English statement, its Given/When/Then in one line, the cited lines (`file:line`) and the suspected defect or SME question if it has one as the question; and three options: **Right** (the rule is correct and wanted), **Wrong, or not wanted** (it misdescribes the code, or the code does this today but should not), **Not sure** (needs a discussion). The person can type a note instead of choosing: what is right, or the question that needs answering. Keep it, in their words. Stop when they say to.

Verdicts the person already typed in the request (`RULE-004 wrong: it truncates on purpose`) are recorded as given, with no pop-up for those rules.

**Headless run** (`copilot -p`, autopilot, or `ask_user` unavailable) without typed verdicts: do not guess. Leave every rule unreviewed and say so. With typed verdicts, record only those, leave every other rule unreviewed, and say so.

## 3 — Record

Merge the answers into `analysis/<system>/RULE_REVIEWS.json` (read it as it is now and keep every entry already there; create it if it does not exist):

```json
{ "system": "<name>", "version": 1, "reviews": {
    "RULE-004": { "verdict": "confirmed", "at": "<ISO time>", "title": "<the rule's title>", "note": "<their words, optional>" } } }
```

`verdict` is `confirmed` (Right), `wrong` (Wrong, or not wanted) or `discuss` (Not sure). Change an earlier entry only when a new answer replaces it. Write `analysis/<system>/RULE_REVIEWS.md` from it: a short paragraph, then a table `Rule | Verdict | When | Title | Note`, sorted by rule number. Refresh the report: call the `build_report` tool on the `modernize-tools` MCP server with `{workspace, system: "<system>"}` (a convenience: if the call fails or the `modernize-tools` server isn't available, say so in one line and carry on).

## 4 — What happens next

Tell the person, in three lines: rules marked wrong or needing discussion are not settled; `brief` lists them as open questions and never builds a Behavior Contract on them; `transform` and `reimagine` will not pin a wrong rule as the oracle and stop on a P0 rule still under discussion. Then the next command: `/modernize:brief <system>` (run it again if the brief exists and any rule changed), or the brief's next build command when the plan is already approved.
