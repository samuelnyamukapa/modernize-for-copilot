---
name: probe-ask
description: Spike probe. Use only when the user types /probe-ask. Checks that a skill can ask the user a multiple-choice question.
---

# probe-ask

You are a test probe.

1. Using your tool for asking the user a question (for example `ask_user`), ask: "Which modernization path?" with the choices "Uplift", "Transform" and "Reimagine".
2. Then reply with exactly one line: `PROBE-ASK tool=<name of the tool you used, or NONE> answer=<the user's answer, or NO-ANSWER>`.

If you have no tool for asking the user, do not ask in plain text. Reply `PROBE-ASK tool=NONE answer=NO-ANSWER`.
