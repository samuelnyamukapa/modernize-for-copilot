# Smoke test on Windows: eShop (.NET Framework 4.7.2)

The test runs in its own Copilot session, in its own folder, so it never touches the plugin repo.

| Folder | What |
|---|---|
| `D:\githubProjects\modernize-for-copilot` | this repo: the plugin source |
| `D:\githubProjects\modernize-sandbox` | the test workspace: `analysis\`, `legacy\`, `modernized\` appear here |
| `D:\githubProjects\modernize-sandbox\sources\eShopLegacyMVCSolution` | the legacy code (Microsoft's eShopModernizing sample, MIT) |

## Part A: one-time setup

**A1. Install Git** (Copilot needs it for marketplace installs, and you need it for `git pull`):

```powershell
winget install --id Git.Git -e
```

Close **every** PowerShell and Copilot window, then open a new PowerShell and check: `git --version`.

**A2. Update the plugin source:**

```powershell
cd D:\githubProjects\modernize-for-copilot
git fetch origin
git reset --hard origin/main
```

`reset --hard` throws away local changes in this folder only. There are none worth keeping: Windows line endings made files look changed.

**A3. Reinstall the plugin.** Close every Copilot session first, or the uninstall fails.

```powershell
copilot plugin uninstall modernize
copilot plugin install D:\githubProjects\modernize-for-copilot\plugin
copilot plugin list
```

You should see `modernize (v0.1.0-dev)` in the list, and nothing called `modernize-for-copilot` or `modernize-probe`.

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
