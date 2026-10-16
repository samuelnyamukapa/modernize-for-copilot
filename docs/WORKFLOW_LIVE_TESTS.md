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
