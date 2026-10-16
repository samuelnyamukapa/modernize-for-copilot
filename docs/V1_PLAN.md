# Plan: from v0.1.0 to v1.0.0

Written 16 Oct 2026, 01:00, before an unattended overnight run.

## Where things stand

- **v0.1.0 is on `main`** (commit `d9f444e`), which is what the marketplace serves. Every skill has run on eShopLegacyMVC. One workflow, `modernize-harden-scan`, has run live. The rest is in [CHANGELOG.md](../CHANGELOG.md).
- **The git tag and GitHub Release could not be created from Claude's session.** Pushing a tag and creating a release both return HTTP 403 for this session type. Sam creates them with:
  ```powershell
  git fetch origin; git tag -a v0.1.0 d9f444e -m "modernize for Copilot 0.1.0"; git push origin v0.1.0
  ```
  Then use GitHub › Releases › Draft a new release › v0.1.0, and paste the 0.1.0 section of CHANGELOG.md. The same applies to v1.0.0.

## 1. The five remaining workflows, live (issues #11–#12 follow-up)

- **Where:** in the Copilot desktop app, driven by computer use, with Claude Sonnet 5.5 and the approval mode left on Interactive.
- **What to approve:** reads, and writes under `analysis/` and `modernized/`. Decline anything under `legacy/`; the guard blocks it anyway.
- **Fixture:** a new sandbox, `D:\githubProjects\modernize-sandbox-workflows`, with two tiny legacy systems. That keeps each run to a handful of agents and keeps the AI-credit cost low. eShop is left as it is.
  - `billing`: a small .NET Framework 4.8 C# solution with real business rules (fees, discounts, eligibility) and some .NET 8 breaking changes (`System.Web`, `ConfigurationManager`, `BinaryFormatter`).
  - `inventory`: a second small system, so the portfolio survey has two rows.

| Workflow | Run with | Passes when |
|---|---|---|
| `modernize-portfolio-assess` | `{parentDir: "legacy", systems: ["billing", "inventory"]}` | One row per system, COCOMO index computed in code |
| `modernize-extract-rules-mine` | `{system: "billing", modules: [...]}` | Rules come back refereed; `render_rules` writes BUSINESS_RULES.md |
| `modernize-uplift-deltas` | `{system: "billing", source: ".NET Framework 4.8", target: ".NET 8"}` | Deltas from the four finders, each refereed |
| `modernize-uplift-migrate` | units from the billing working copy, after a hand-written pilot `PLAYBOOK.md` | Each unit builds on net8 in its own folder |
| `modernize-reimagine-scaffold` | `{system: "billing", services: [two services]}` | One scaffolder per service, writing only its own folder |

The results go in [WORKFLOW_LIVE_TESTS.md](WORKFLOW_LIVE_TESTS.md). Anything that breaks gets fixed, with a regression test, and the run is repeated.

## 2. The live status canvas (issue #16)

Upstream's live pane (estate map, review deck, sign dialog) was dropped for v0.1. The Copilot desktop app has **canvases**: an extension declares one with `createCanvas`, and its `open` handler returns the URL of a web page the app shows beside the session.

- **Extension:** `com.github.copilot/extensions/modernize-canvas/`, which serves a local page on 127.0.0.1 only.
  - **Status:** per system, the pipeline stages with their artifacts, how fresh each one is, and what is stale. It also shows the brief's phases and gates, verify verdicts and harden counts. It refreshes itself as files change.
  - **Review deck:** the rules waiting for a person, with Right, Wrong or Not sure, written to `RULE_REVIEWS.json` in exactly the format `/modernize:review` uses.
  - **Sign-off:** the person's name, role and decision, for `VERIFICATION.md`'s sign-off table and the brief's approval block. Only a person fills these in; the agent never does.
- **Agent actions:** `refresh`, and `show <system>`, so a skill can open it.
- **Rules:**
  - The page never writes under `legacy/`.
  - Everything it shows is escaped, because it comes from untrusted source.
  - It binds to loopback only and requires a random per-instance token.
- **Tests:** Node tests for the data model and writers. Then a live check in the app.

## 3. Docs and v1.0.0

- **Docs:** README (install for the CLI and the app, the pipeline, workflows, the canvas), the smoke-test guide and CHANGELOG 1.0.0.
- **Version:** 1.0.0 in `plugin.json` and `marketplace.json`.
- **Issues:** close #10, #14, #15 and #16, with evidence.
- **Release:** the tag and Release are Sam's step, as above.

## 4. Verification

- CI green on Ubuntu and Windows.
- A fresh marketplace install into a clean Copilot home.
- An independent review agent checks the release notes' claims against the evidence files.

## Guardrails for the unattended run

- Nothing under `legacy/` or `sources/` is changed. eShop and CardDemo are left as they are.
- **Spending cap:** about 150 workflow agents in total, kept down by the fixture's size. Any single run that would need more than 60 is stopped and noted.
- **Unclear outcomes:** if a step needs a decision that can't be undone, or the results are unclear, I record it here and in the morning summary rather than guessing.

## Outcome (16 Oct 2026, morning)

- **Workflows:** all five remaining workflows ran live on the first attempt; see [WORKFLOW_LIVE_TESTS.md](WORKFLOW_LIVE_TESTS.md). The fixture is .NET Framework 4.7.2 rather than 4.8. About 66 workflow agents were used in all, well under the cap.
- **The canvas:** built and tested live in the app. Testing found two bugs:
  - an open session kept the plugin folder busy on Windows. `4967c86` moves the server and extensions out of it, but the `py` launcher that starts the server may still hold it; not yet checked on Windows;
  - a test folder was listed as a system. Fixed in `9aa04e5`, with a regression test.
- **Docs and 1.0.0:** done; see [CHANGELOG.md](../CHANGELOG.md).
- **Tags and releases:** both published on 16 Oct.
  - **v0.1.0** (`d9f444e`): Sam created it on the website. The release workflow had failed with "Resource not accessible by integration": its token may not create a tag on a commit whose workflow files differ from `main`'s.
  - **v1.0.0** (`e60972d`, Latest): published by the release workflow. That workflow now also publishes the release for a tag a maintainer pushed by hand.
