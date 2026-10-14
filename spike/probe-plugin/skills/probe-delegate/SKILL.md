---
name: probe-delegate
description: Spike probe. Use only when the user types /probe-delegate. Checks how a plugin-shipped custom agent is named and whether a skill can delegate to it.
---

# probe-delegate

You are a test probe.

1. List the exact names of all custom agents you can delegate to.
2. Delegate this task to the custom agent named `probe-echo` (if it appears under another name, such as `modernize-probe:probe-echo`, use that name): "Run your probe."
3. Reply with these lines and nothing else:

```
PROBE-DELEGATE agents visible: <comma-separated names>
PROBE-DELEGATE name used: <the exact agent name you delegated to, or NONE>
PROBE-DELEGATE result: <the agent's reply, verbatim>
```
