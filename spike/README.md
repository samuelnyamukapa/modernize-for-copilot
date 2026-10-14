# Phase 0 spike

`probe-plugin/` is a throwaway plugin. Each part checks one assumption from [docs/PORTING_PLAN.md](../docs/PORTING_PLAN.md) §8. Results go in [docs/SPIKE.md](../docs/SPIKE.md).

## Setup (Windows, PowerShell)

```powershell
copilot plugin marketplace add samuelnyamukapa/modernize-for-copilot
copilot plugin install modernize-probe@modernize-for-copilot
cd <repo>\spike\workspace
copilot --experimental
```

Don't use a relative path such as `copilot plugin install ..\probe-plugin`. Copilot CLI 1.0.97 reads `..\probe-plugin` as a GitHub `owner/repo` and the install fails. A full path works, but direct path installs are deprecated, so use the marketplace.

`workspace\legacy\probe\target.txt` stands in for legacy code. The guard hook should stop any edit to it.

## Checks

Run each of these inside the Copilot session, then copy what it prints into `docs/SPIKE.md`.

| # | Type | Expect | Checks |
|---|---|---|---|
| 1 | `/probe-args system-x java-spring` | `received: system-x java-spring` | Skills receive their arguments |
| 2 | `/probe-mcp` | At least one server returns JSON with `PLUGIN_ROOT` set | Plugin MCP servers start, which Python launcher works, and whether `PLUGIN_ROOT` is set |
| 3 | `/probe-ask` | A multiple-choice prompt, then `tool=ask_user` | Skills can ask the user |
| 4 | `/probe-delegate` | The agent list, plus `PROBE-ECHO-OK edit=DENIED…` | How plugin agents are named, delegation from a skill, and whether the hook fires in a subagent |
| 5 | `Append a line to legacy/probe/target.txt` | Refused by the guard | The `preToolUse` deny works in the main agent |
| 6 | `Run the probe-fanout dynamic workflow` | `byName` shows which agent name resolved, and `DENIED` from each agent | Plugin-shipped workflows, agent naming inside workflows, and the hook inside workflow agents |
| 7 | Outside Copilot: `copilot workflow run probe-fanout --args "{}"` | The same result as check 6 | Running workflows from the CLI |
| 8 | Copilot app: add the marketplace, start a session in `spike\workspace`, repeat checks 1, 4 and 6 | Same as the CLI | Parity in the app |

After the checks:
- `%TEMP%\modernize-probe-hook.log` shows the exact hook input and which plugin-root variable, if any, hooks receive.
- `type legacy\probe\target.txt` must still show only its original line.

Clean up with `copilot plugin uninstall modernize-probe`.
