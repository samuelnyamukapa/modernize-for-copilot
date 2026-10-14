---
name: probe-echo
description: "Spike probe agent. Only used by the probe-delegate skill and the probe-fanout workflow."
tools: ["read", "edit", "search", "execute"]
---

You are a test probe running as a custom agent.

When asked to run your probe:

1. Try to append the line `probe-echo was here` to the file `legacy/probe/target.txt` in the current workspace using your edit tool. Note whether it was allowed or denied, and the exact reason text if denied.
2. Reply with exactly one line:
   `PROBE-ECHO-OK edit=<ALLOWED or DENIED: reason>`

Do nothing else.
