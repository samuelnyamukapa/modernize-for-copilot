---
name: parity
description: "Prove the new system answers like the legacy one at its boundaries: replay the same requests against both running systems, check the published contracts for breaking changes, and report every difference for a person to sign off. Usage: /modernize:parity <system> [--legacy <url>] [--candidate <url>] [--har <file>...]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.
- `--legacy <url>` and `--candidate <url>`: optional. The base URLs of the running legacy and new systems, such as `http://localhost:5001`.
- `--har <file>`: optional, may repeat. HAR files inside the workspace, recorded against the legacy system.

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

**Tools.** This skill calls `parity_init`, `parity_capture` and `parity_run` on the `modernize-tools` MCP server (`modernize-tools-win` on Windows; only one of the two serves tools on a machine). Always pass `workspace` (the absolute path above) and give every other path relative to it. They are essential: if the server isn't available, stop. Tell the user to run `/mcp` to check that `modernize-tools` (or `modernize-tools-win`) is connected, and to see `/modernize:preflight`. Never compute a verdict, a difference or a contract check by hand, and never edit `PARITY.md` or `PARITY.json` except the sign-off row in step 7. A tool that answers with an error about an argument is not unavailable: correct the call.

`verify` proves each module from the inside, with tests. This skill proves the system from the outside: the same request goes to both systems, and every difference in status, headers, body or contract is listed. It works for any migration, whatever was used to build the new system.

What you must never do:

- Write anything in `legacy/`, or edit the new system to make a difference go away. A real difference is fixed through `/modernize:transform`, `/modernize:uplift` or by the team, then checked again.
- Add a scrub rule or a delta, or change a case's match level, without a person's agreement in this session. Each one hides differences from every later run.
- Sign the report. Only a person signs, with their own name.
- Point either base URL at a production system, or replay requests that change data, unless a person has agreed in this session (step 5).

Ask with the `ask_user` tool. In `copilot -p`, autopilot, or when `ask_user` is unavailable, no one can answer: take the safe default stated at each step, and say what you assumed.

## 1 — The two systems

Both systems must be running. This skill never builds or starts the legacy code inside `legacy/`. If `analysis/<system>/BASELINE.md` or `analysis/<system>/PREFLIGHT.md` says how the legacy system was hosted (for example from a scratch copy during `uplift`), offer that to the user.

Take the base URLs from the arguments. Otherwise ask for them with `ask_user`: "What is the base URL of the running legacy system, and of the new one?" If either is not a local or test address, ask: "Is this a test environment with test data?" and stop unless the answer is yes. Headless with no URLs: stop and say which arguments are needed.

Call `parity_init` with {workspace, system: "<system>", legacy_url, candidate_url}. It writes `analysis/<system>/parity/config.json`, `cases.json` and `deltas.json`, and keeps any that already exist.

## 2 — The contracts consumers rely on

List each contract the system publishes, from `ASSESSMENT.md`, `topology.json` and the code: for example `/swagger/v1/swagger.json`, `/Service.svc?singleWsdl`, or an XSD. Add each one to `contracts` in `config.json` as `{"name": "...", "kind": "openapi" | "wsdl" | "xsd" | "text", "path": "/..."}`. The path must be served by both systems. A contract file that only exists on disk (a YAML OpenAPI document, say) is out of scope here: if `oasdiff` is installed, suggest the user runs `oasdiff breaking <legacy file> <new file>` and records the result.

The default for every contract is no change at all. `parity_run` reports each one as IDENTICAL, EQUIVALENT, COMPATIBLE (only additions), BREAKING or REVIEW.

## 3 — How strict each boundary is

`config.json` sets one match level for everything (`"match": "exact"`) and lets a person loosen it per path with `overrides`, such as `{"path": "/api/admin/*", "match": "semantic"}`. A case can also carry its own `match`.

| Level | What must match |
|---|---|
| `exact` | Status, the listed headers, and the body as sent: number formats, key order, whitespace |
| `semantic` | Status and the same data: key order, `10` vs `10.0`, the charset on `content-type` and trailing whitespace may differ |
| `contract` | The status only. The contract is still checked in step 2 |

Keep `exact` for anything third parties parse. Ask the user with `ask_user` before loosening any path, showing which paths it covers. Headless: keep `exact`.

## 4 — The cases

A case is one request: `{"id": "CASE-001", "name": "...", "method": "GET", "path": "/api/invoices/42", "headers": {...}, "body": null}`. The path never holds a host: requests only go to the two base URLs.

Gather cases from these sources, best first:

1. **Recorded traffic.** If the user gave `--har` files, or has some (browser developer tools, Fiddler or mitmproxy, recorded against the legacy system), call `parity_capture` with {workspace, system, har: [...]} and an `include` regex for the API paths if the HAR also holds other sites. It drops cookies, authorization headers and static files, and removes duplicates. Tell the user which headers were dropped.
2. **The contract and the rules.** For each operation in the contracts, and each rule in `BUSINESS_RULES.md` that an API exposes, write cases into `cases.json`: a normal value, the boundary values the rule names, an unknown id, and a bad input. Give each case a `name` that says what it checks, such as "RULE-007 late fee at exactly 30 days".
3. **The user.** Ask for the requests they care most about.

If a request needs a token, never write the token into a case. Add `"headers_from_env": {"Authorization": "PARITY_AUTH"}` to `config.json` and ask the user to set that environment variable before the run.

Show the case list (id, method, path, name) and say how many change data.

## 5 — Requests that change data

GET, HEAD and OPTIONS are replayed. Other methods are skipped, unless both of these hold:

- the user has said, in this session, that both systems use disposable test data that starts from the same state; and
- `config.json` has `"allow_unsafe_methods": true`, and you pass `allow_unsafe: true` to `parity_run`.

A SOAP call is a POST, even when it only reads. A person may mark such a case `"safe": true` after confirming that the operation changes nothing. Ask with `ask_user`, listing the operations. Headless: skip them.

## 6 — Run, then triage

Call `parity_run` with {workspace, system} (add `allow_unsafe` only as step 5 allows). It writes `PARITY.md`, `PARITY.json` and the raw answers under `results/`. Read `PARITY.md` and report the verdict:

- **PARITY:** every case matched, or differed only as the delta ledger expects, and no contract broke.
- **NO PARITY:** at least one unexplained difference, or a breaking contract change.
- **INCOMPLETE:** cases were skipped or could not run, or a contract needs a person's review.
- **NO EVIDENCE:** nothing was compared.

Then go through the differences with the user, grouped by `where`:

- **Probably noise** (listed in the report: timestamps, GUIDs and similar on both sides). Ask the user whether to scrub each path. With a yes, add it to `scrub.json_paths` (or `scrub.xml_ignore`, or a `scrub.regex` entry) in `config.json`.
- **An intended change** (a fix, or a format change consumers have agreed to). Record it in `deltas.json` only when a named person approves it in this session: `{"id": "DELTA-001", "case": "*" or a case id, "where": "<the where value from the report>", "reason": "...", "approved_by": "<their name>", "date": "<today>"}`. Take the date from the system clock (`Get-Date -Format yyyy-MM-dd` in PowerShell, `date +%F` elsewhere).
- **A defect in the new system.** Leave it as a difference. Name the case and the place, and hand it to the build step that owns it.

Re-run `parity_run` after every change to `config.json` or `deltas.json`. Report any delta the report lists as matching nothing.

## 7 — Sign-off

Only when the verdict is PARITY, ask with `ask_user`: "Do you sign off parity for <system>? Give your name and role." With a yes, fill in the sign-off row of `PARITY.md` with exactly the name and role given, the decision "Signed off", and today's date from the system clock. Change nothing else in the file. Never fill it in for anyone, and never in headless mode.

## 8 — Wrap-up

Say, in a few lines: the verdict, the counts, any breaking contract changes, the open differences and who owns them, and the next step. The next step is a fix and a re-run, or `/modernize:status <system>` once signed off. Then call `build_report` with {workspace, system: "<system>"} to refresh `REPORT.html`. If that fails, say so in one line and carry on.
