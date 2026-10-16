# Dynamic workflows: live test results

All six workflows ran live in the **GitHub Copilot desktop app on Windows** on 16 Oct 2026, with Claude Sonnet 5.5. Every run completed on its first attempt.

- **Driving the app:** Claude drove it by computer use.
- **Starting the runs:** each workflow was started from a prompt in an ordinary session ("Run the modernize-… dynamic workflow with args …"). The app needed no `--experimental` switch.
- **Saved envelopes:** each run's envelope (run id, status and result) was saved by the session under `analysis/live-tests/` in the fixture workspace.

## The fixture

`D:\githubProjects\modernize-sandbox-workflows`, built for this test so each run stays small:

- `legacy/billing` is a .NET Framework 4.7.2 solution of 12 files and 160 lines, in three projects:
  - Billing.Core: late fees, discounts, invoice numbers, a VAT setting read through `ConfigurationManager`, and a `BinaryFormatter` archive;
  - Billing.Reports: statement totals;
  - Billing.Web: an `IHttpHandler`.
- `legacy/inventory` is one 17-line reorder rule.
- `analysis/billing` holds a hand-written `PLAYBOOK.md`, `REIMAGINED_ARCHITECTURE.md` and `AI_NATIVE_SPEC.md`, for the two workflows that need an approved pilot or design first.
- `modernized/billing-uplifted` is a copy of `legacy/billing`, to serve as the uplift working copy.

Nothing under `legacy/` changed in any run: no file was newer than the fixture, and no `bin/` or `obj/` folder appeared.

## Results

| Workflow | Run | Agents | Result |
|---|---|---|---|
| `modernize-harden-scan` (on eShop, 15 Oct) | `aefca519` | 25 | 5 finders, 16 findings judged, 2 refuted, 0 unverified; 3 High, 4 Medium, 7 Low |
| `modernize-portfolio-assess` | `2d7a7228` | 2 | One row per system: billing 160 SLOC, 12 files, complexity 8; inventory 17 SLOC. Complexity index computed in code |
| `modernize-extract-rules-mine` | `b82bdcf4` | 16 | Module mode: 3 modules in 1 batch. 6 rules confirmed (3 P0), 0 rejected, 0 unverified, 8 data objects. `render_rules` wrote BUSINESS_RULES.md and DATA_OBJECTS.md |
| `modernize-uplift-deltas` | `3d37ca43` | about 19 | 14 deltas (4 API-removed, 4 Behavioral-silent, 3 Dependency, 3 Project-system; 4 mechanical, 10 judgment), 1 dropped by a referee, 35 touched sites |
| `modernize-uplift-migrate` | `c41dfa9e` | 2 | Billing.Core and then Billing.Reports, batched by dependency. Both built on net8.0 (`dotnet build … -c Release`); no shared-file needs; playbook gaps reported |
| `modernize-reimagine-scaffold` | `1255322b` | 2 | invoicing (12 acceptance tests) and pricing (8). 4 rules pending, each tagged by rule id; each service wrote only its own folder |

That makes about 66 workflow agents in all.

## Observations

- **Duplicate deltas:** `uplift-deltas` listed the same issue under several finders. BinaryFormatter, for example, appears as an API-removed delta and as a behavioral one. Like upstream, the workflow removes duplicates only when the name and the code site are both the same, so this is upstream behaviour, not a port bug. `/modernize:uplift` folds them when it writes the catalog.
- **Playbook gaps:** `uplift-migrate` correctly reported that the hand-written playbook contradicted the delta catalog on BinaryFormatter, and that it left the VAT config file to the host. These are the gaps a real pilot exists to close.
- **No blockers:** `reimagine-scaffold` raised none, and found no planted instructions in the spec. The invoicing scaffold asked a person to confirm the 30-day boundary of RULE-001.

## The live status canvas, live

Tested on 16 Oct 2026 in the Copilot desktop app on Windows.

**How it was loaded.** The installed copy of `modernize` could not be updated that night: the old version's server and extension processes, started from the plugin folder by sessions still open on the machine, kept Windows from replacing it (os error 32). The canvas extension was therefore loaded from a local marketplace folder (`D:\githubProjects\modernize-canvas-dev`), which the app reads in place. It was removed again after the test. Since 4967c86, the server and extensions move out of the plugin folder when they start. Whether that is enough on Windows is not yet checked: the `py` launcher that starts the server may still hold the folder.

| Check | Result |
|---|---|
| Opening it | The agent opened it with `open_canvas` when asked "Open the modernize-status canvas for system eshop". The app showed the page served from `127.0.0.1` beside the session. |
| eShop | Uplift track, next command `/modernize:verify eshop`, steps with their ages, the treemap from `topology.json` (33 modules), the plan with its signed approval, both PARTLY PROVEN verdicts with the recorded sign-off, and the security counts 0, 3, 4, 7 |
| Live activity | When the session read `legacy/eshop/.../PicController.cs` through a shell command, the PicController tile lit blue and the activity list showed the read |
| Review deck | In the billing fixture, the deck showed RULE-006 (P0, suspected defect). **Not sure** plus a note wrote `RULE_REVIEWS.json` and `RULE_REVIEWS.md` in `/modernize:review`'s format |
| Approval form | A fixture brief was added while the page was open. The page updated by itself and showed the form. Signing it (test name "Fixture Tester") rewrote only the `Approved by:`/`Date:` and `Approval covers:` lines |
| Agent action | The agent called the canvas's `summary` action and reported what needed attention |
| One bug | `analysis/live-tests/` showed up as a system. Fixed in 9aa04e5: an `analysis/` folder now counts as a system only if it holds skill output |
