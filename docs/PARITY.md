# `/modernize:parity`: does the new system answer like the old one?

**New in 1.1.** This skill is an addition in this port. The upstream `code-modernization` plugin has no equivalent.

`/modernize:verify` proves each module through its tests, from the inside. `/modernize:parity` checks the whole running system from the outside. It sends the same requests to the legacy and the new system, compares what comes back, checks the published contracts for breaking changes, and writes a report for a person to sign.

## When to run it

Run it once everything the plan names is built and `verify` has proven it, for a system that serves HTTP or SOAP: REST or GraphQL APIs, WCF or `.asmx` services, or a website. `/modernize:status` and the status canvas suggest it at that point. They suggest it again whenever its report is stale, is not PARITY, or has not been signed.

It never runs on its own, because it needs three things from a person:

- both systems running, and their base URLs;
- agreement before any request that changes data;
- a named person to sign the result.

```
/modernize:parity billing --legacy http://localhost:5001 --candidate http://localhost:5002 --har recordings/week.har
```

You can also ask in plain words: "check the new billing service answers the same as the old one".

## What it does

1. **Settings.** Writes `analysis/<system>/parity/config.json` with both base URLs, plus `cases.json` and `deltas.json`.
2. **Contracts.** Fetches each contract you list from both systems and compares them:
   - **OpenAPI (JSON):** a removed operation or parameter, a new required parameter, a removed response code, a removed or retyped property, or a newly required property is **BREAKING**.
   - **WSDL or XSD:** a removed operation or element, a changed type, a changed target namespace (a common WCF-to-CoreWCF slip), or a new required element is **BREAKING**.
   - **Anything else:** compared as text. Any change goes to a person as **REVIEW**.
3. **Cases.** Each case is one request, made of a method, a path, headers and a body. Cases come from:
   - HAR recordings of the legacy system, with cookies, authorization headers, static files and duplicates dropped;
   - the contracts and `BUSINESS_RULES.md`;
   - you.
4. **Run.** Every case goes to both systems. The status, the headers you list, and the body are compared:
   - **JSON** is compared field by field, so `InvoiceId` vs `invoiceId` is caught;
   - **XML and SOAP** are compared by element, so different namespace prefixes do not count as a difference;
   - **anything else** is compared as text.
5. **Report.** Writes `PARITY.md` and `PARITY.json`. It gives one verdict:

   | Verdict | Meaning |
   |---|---|
   | PARITY | Every case matched, or differed only as the delta ledger expects, and no contract broke |
   | NO PARITY | At least one unexplained difference, or a breaking contract change |
   | INCOMPLETE | Cases were skipped or failed, or a contract needs a person's review |
   | NO EVIDENCE | Nothing was compared |

6. **Triage and sign-off.** For each difference you decide one of three things:
   - it is noise, and gets a scrub rule;
   - it is an intended change, and gets an entry in the delta ledger, with a named approver;
   - it is a defect, and goes back to the build step.

   After every change, it runs again. When the verdict is PARITY, a person signs the Sign-off table at the end of `PARITY.md`.

## How strict it is

| Level | What must match | Typical use |
|---|---|---|
| `exact` (default) | Status, the listed headers, and the body as sent: number formats, key order, whitespace | Anything third parties parse |
| `semantic` | The same data; key order, `10` vs `10.0`, the charset on `content-type` and trailing whitespace may differ | Internal endpoints |
| `contract` | The status only; the contract is still checked | Endpoints being retired |

Set a level for the whole system in `config.json`. Then loosen it for chosen paths with `overrides` (`{"path": "/api/admin/*", "match": "semantic"}`), or on a single case. A person agrees to every loosening, every scrub rule and every delta. The agent never adds them on its own.

## Safety

- Requests only go to the two base URLs. A case holds a path, never a host.
- GET, HEAD and OPTIONS are replayed. Any other method needs two switches:
  - `allow_unsafe_methods` set to true in `config.json`;
  - your agreement in the session that both systems use disposable test data starting from the same state.
- A read-only SOAP call may be marked `"safe": true` after you confirm it changes nothing.
- Tokens come from environment variables named in `headers_from_env`. They are never written to any file.
- Proxies are bypassed and redirects are compared rather than followed.
- Nothing under `legacy/` is touched. The skill never builds or starts the legacy code. You start both systems.

## Files

| File | Written by | Edited by |
|---|---|---|
| `parity/config.json` | `parity_init` | A person, or the agent with a person's agreement |
| `parity/cases.json` | `parity_capture`, or the agent | A person, or the agent |
| `parity/deltas.json` | the agent, only with a named person's approval | A person |
| `parity/results/` | `parity_run` | Nobody |
| `parity/PARITY.md`, `PARITY.json` | `parity_run` | Only the Sign-off table, by a person |

## Limits

- Covers HTTP and SOAP only. For other boundaries, see the next section.
- OpenAPI contracts must be JSON when served live. For a YAML file on disk, use `oasdiff breaking`.
- Bodies over 5 MB are compared on their first 5 MB only. The report says when this happens.
- Has passed its automated tests (two local servers), but has not yet run against a real migrated system.

## Next: the Complete Migration Toolkit

`/modernize:parity` answers one question once: does the new system answer like the old one at its HTTP and SOAP boundary? For more than that, use the [Complete Migration Toolkit](https://github.com/samuelnyamukapa/complete-migration-toolkit) (`cmtk`). It is a separate plugin, built on the same ideas: contracts locked by default, approved drift only, and only a person signs. It adds:

- **Every pull request:** the same comparison, run in CI, with a report kept as evidence.
- **Other boundaries:** through adapters. The eShop pilot compared the catalog class library on .NET Framework and .NET 8 this way.
- **An AI tester:**
  - `/cmtk:plan` drafts a test plan and cases from stories or business rules;
  - `/cmtk:explore` explores within a charter and a budget;
  - `/cmtk:triage` sorts differences into noise, drift and defects;
  - `/cmtk:defects` drafts defect reports.

  Every draft and proposal waits for a person's review.

To install it in Copilot CLI:

```sh
copilot plugin marketplace add samuelnyamukapa/complete-migration-toolkit
copilot plugin install cmtk@complete-migration-toolkit
```

In the Copilot app, add the marketplace `samuelnyamukapa/complete-migration-toolkit` under Customize › Plugins, then install **cmtk**. Then start with `/cmtk:test`. The plugin needs Node.js 22.5 or later.
