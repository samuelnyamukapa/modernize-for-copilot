# Phase 0 spike results

Copilot CLI 1.0.97 on Windows 11, model Auto (`gpt-6-luna`), 14 Oct 2026. The probe plugin was installed from a full local path.

| # | Check | Result | Consequence for the port |
|---|---|---|---|
| 0 | Install | `copilot plugin install ..\probe-plugin` fails, because a relative path is read as GitHub `owner/repo`. A full path works. Marketplace installs need `git` on `PATH`. | Docs: install from the marketplace, and list git as a prerequisite. |
| 1 | Skill args | ✅ `/modernize-probe:probe-args system-x java-spring` runs the skill, and `$ARGUMENTS` in `SKILL.md` is replaced with `system-x java-spring`. Plain `/probe-args` gives "Unknown command". Asking in plain words also runs the skill (`skill(probe-args)` tool), but then `$ARGUMENTS` is left as written. `${PLUGIN_ROOT}` and `${COPILOT_PLUGIN_ROOT}` are **not** replaced in skills. The skill is given its own path (`…\.copilot\installed-plugins\_direct\probe-plugin\skills\probe-args\SKILL.md`). | Skills use `$ARGUMENTS`, plus a fallback that reads the user's message. Commands are namespaced `/<plugin>:<skill>`, so choose a short plugin name. Scripts can be found relative to the SKILL.md path, with MCP as the main route. |
| 2 | MCP / PLUGIN_ROOT | pending | |
| 3 | ask_user | pending | |
| 4 | Agent naming, delegation, hook in subagent | pending | |
| 5 | preToolUse deny | pending | |
| 6 | Dynamic workflow | pending | |
| 7 | `copilot workflow run` | pending | |
| 8 | Copilot app parity | pending: app not installed | |
