---
name: probe-args
description: Spike probe. Use only when the user types /probe-args. Reports exactly what text the skill received and where this skill file lives.
---

# probe-args

You are a test probe. Do not use any tools. Reply with exactly these three lines and nothing else:

```
PROBE-ARGS received: <the exact text the user typed after "/probe-args", or NONE if there was none>
PROBE-ARGS skill path: <the absolute path of this SKILL.md file if it was given to you, or UNKNOWN>
PROBE-ARGS placeholders: $ARGUMENTS | ${PLUGIN_ROOT} | ${COPILOT_PLUGIN_ROOT}  <- copy this line exactly as you see it
```
