# Phase 0 spike results

Copilot CLI 1.0.97 on Windows 11, model Auto (`gpt-6-luna`), 14 Oct 2026. The probe plugin was installed from a full local path.

| # | Check | Result | Consequence for the port |
|---|---|---|---|
| 0 | Install | `copilot plugin install ..\probe-plugin` fails, because a relative path is read as GitHub `owner/repo`. A full path works. Marketplace installs need `git` on `PATH`. | Docs: install from the marketplace, and list git as a prerequisite. |
| 1 | Skill args | ✅ `/modernize-probe:probe-args system-x java-spring` runs the skill, and `$ARGUMENTS` in `SKILL.md` is replaced with `system-x java-spring`. Plain `/probe-args` gives "Unknown command". Asking in plain words also runs the skill (`skill(probe-args)` tool), but then `$ARGUMENTS` is left as written. `${PLUGIN_ROOT}` and `${COPILOT_PLUGIN_ROOT}` are **not** replaced in skills. The skill is given its own path (`…\.copilot\installed-plugins\_direct\probe-plugin\skills\probe-args\SKILL.md`). | Skills use `$ARGUMENTS`, plus a fallback that reads the user's message. Commands are namespaced `/<plugin>:<skill>`, so choose a short plugin name. Scripts can be found relative to the SKILL.md path, with MCP as the main route. |
| 2 | MCP / PLUGIN_ROOT | ✅ All three stdio servers started (`py -3`, `python`, `python3`). Each got `PLUGIN_ROOT`, `PLUGIN_DATA`, `COPILOT_PLUGIN_ROOT`, `COPILOT_PLUGIN_DATA` and `CLAUDE_PLUGIN_ROOT`, with cwd set to the plugin root. `${PLUGIN_ROOT}` in `args` was expanded. On this PC the three launchers resolved to three different Pythons (3.13.2, 3.10.4 and the 3.13 Microsoft Store build). | Confirms the MCP route for the scripts. Choose the launcher deliberately: `python` and `python3` can hit the Windows Store stub on clean machines. Preflight should report which Python ran. |
| 3 | ask_user | ✅ A skill called `ask_user` with choices, and the answer ("Uplift") came back to the skill. | AskUserQuestion maps to `ask_user`. |
| 4 | Agent naming, delegation, hook in subagent | Partial: a skill delegated to the plugin agent, which is named **`modernize-probe:probe-echo`** (plugin-prefixed) and ran on the session model. Hook result pending. | Skills and workflows must name agents as `<plugin>:<agent>`. |
| 5 | preToolUse deny | pending | |
| 6 | Dynamic workflow | pending | |
| 7 | `copilot workflow run` | pending | |
| 8 | Copilot app parity | pending: app not installed | |
