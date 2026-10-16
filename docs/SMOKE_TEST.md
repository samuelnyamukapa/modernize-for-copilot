# Smoke test on Windows: eShop (.NET Framework 4.7.2)

The test runs in its own Copilot session, in its own folder, so it never touches the plugin repo.

| Folder | What |
|---|---|
| `D:\githubProjects\modernize-sandbox` | the test workspace: `analysis\`, `legacy\`, `modernized\` appear here |
| `D:\githubProjects\modernize-sandbox\sources\eShopLegacyMVCSolution` | the legacy code (Microsoft's eShopModernizing sample, MIT) |

## Part A: one-time setup

**A1. Install Git** (Copilot needs it to install from a marketplace):

```powershell
winget install --id Git.Git -e
```

Close **every** PowerShell and Copilot window, then open a new PowerShell and check: `git --version`.

**A2. Install the plugin from the marketplace.** This is the same path users take. Copilot CLI 1.0.98 warns that installing from a local folder is deprecated, so the smoke test no longer does that. Close every Copilot session first, or the uninstall fails.

```powershell
copilot plugin uninstall modernize
copilot plugin marketplace add samuelnyamukapa/modernize-for-copilot
copilot plugin install modernize@modernize-for-copilot
copilot plugin list
```

You should see `modernize@modernize-for-copilot (v1.0.0)`. The first line fails harmlessly if the plugin isn't installed.

**A3. After each fix is pushed,** close every Copilot window (CLI and app), then update. A running session can keep the plugin folder busy on Windows:

```powershell
copilot plugin marketplace update modernize-for-copilot
copilot plugin update modernize@modernize-for-copilot
```

**For plugin development only:** `copilot --plugin-dir D:\path\to\modernize-for-copilot\plugin` loads a local clone for one session without installing it. After a `git pull`, start a new session. Don't combine it with an installed copy, or the plugin loads twice.

## Part B: the test session

**B1. Open a separate test window:**

```powershell
cd D:\githubProjects\modernize-sandbox
copilot
```

Trust the folder when asked. You don't need `--experimental` for Parts B and C: it only turns on dynamic workflows, which the plugin uses from Phase 4 onwards. Optional: `/model` and pick a Claude model, since the prompts were written for Claude. That needs a paid Copilot plan; Free and Student get Auto only.

Leave approvals on **Manual**. Approve reads, and writes under `analysis\` and `modernized\`. Say **No** to anything that would edit `legacy\`; the guard blocks those anyway.

**B2. Front door and preflight:**

```
/modernize:start eshop --source D:\githubProjects\modernize-sandbox\sources\eShopLegacyMVCSolution
```

Answer the pop-ups. Suggested answers: *Understand it first* or *Upgrade .NET Framework to .NET 8*; build locally: *yes, Visual Studio / dotnet*; anything off limits: *no*. It should write `analysis\eshop\INTENT.md`, link `legacy\eshop` to the sources folder, and write `analysis\eshop\PREFLIGHT.md`.

**B3. Assess:**

```
/modernize:assess eshop
```

Expected: `analysis\eshop\ASSESSMENT.md`, `ARCHITECTURE.mmd`, and `REPORT.html`.

**B4. Map:**

```
/modernize:map eshop
```

Expected: `analysis\eshop\topology.json` and `TOPOLOGY.html`. Open the HTML in a browser.

**B5. Status:**

```
/modernize:status eshop
```

Expected: an artifact table and one next command.

After each step, tell Claude "B*n* done". Claude reads `D:\githubProjects\modernize-sandbox\analysis\eshop` directly and checks the output. Only screenshot errors.

## Part C (later): rules, plan, build, proof

`/modernize:extract-rules eshop` → `/modernize:review eshop` → `/modernize:brief eshop ".NET 8"` → `/modernize:uplift …` → `/modernize:verify eshop`.

## Part D (later): dynamic workflows

In the Copilot desktop app workflows are on already. In the CLI, start the test window with `copilot --experimental` (or run `/experimental on` in an open session). Then:

1. `/workflows` should list six `modernize-…` workflows. If it lists fewer, screenshot it: a definition was rejected.
2. Re-run `/modernize:extract-rules eshop`. It should say it is using the `modernize-extract-rules-mine` workflow (Method A) and show progress in `/workflows`.
3. `/modernize:harden eshop` runs `modernize-harden-scan`; `/modernize:uplift` runs `modernize-uplift-deltas` and later `modernize-uplift-migrate`.

## Part E (later): the live status canvas (Copilot desktop app)

1. Open the sandbox folder as a project in the app, and run `/modernize:status eshop`. After the table, the agent should open the **modernize status** canvas beside the session. You can also ask for it: "Open the modernize-status canvas for system eshop".
2. The page should show:
   - the uplift track and its next command;
   - each step with its age;
   - the module treemap;
   - the plan with its approval;
   - the `verify` verdicts and the `harden` counts.
3. Ask the session to read a file under `legacy\eshop`. Its module's tile should light up, and the read should appear under Activity.
4. Optional, and it writes files: in a workspace with rules waiting for review, give one verdict on the review deck. `analysis\<system>\RULE_REVIEWS.json` and `RULE_REVIEWS.md` should gain that verdict. Only a person uses the deck and the sign-off form; the agent never does.

## Part F (later): the parity check (new in 1.1)

Use a system whose legacy and new versions can both run locally and serve HTTP or SOAP: the eShop uplift, or the billing fixture.

1. Start both systems, for example legacy on `http://localhost:5001` and the new one on `http://localhost:5002`. The skill never starts the legacy code.
2. Optional: record some traffic against the legacy system as a HAR file. In the browser's developer tools, use Network › Export HAR. Save it inside the workspace.
3. Run `/modernize:parity eshop --legacy http://localhost:5001 --candidate http://localhost:5002 --har recordings\eshop.har`.
4. Expected:
    - `analysis\eshop\parity\config.json`, `cases.json` and `deltas.json` are written;
    - the skill lists the contracts it found and the cases, and asks before running any request that changes data;
    - `PARITY.md` gives a verdict with every difference, including any that look like noise, such as timestamps;
    - no file under `parity\` holds a token.
5. Change one field name in the new system, run the check again, and confirm the difference is caught. Then undo the change.
6. Run `/modernize:status eshop`. Parity should appear as a step, with the next command matching the verdict.
