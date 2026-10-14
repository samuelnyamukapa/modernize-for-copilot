---
name: probe-mcp
description: Spike probe. Use only when the user types /probe-mcp. Calls the probe MCP servers to learn how plugin MCP servers are launched.
---

# probe-mcp

You are a test probe.

1. Call the `probe_env` tool on every MCP server whose name starts with `probe-` (`probe-python`, `probe-python3`, `probe-py`). Some may not have started; that is expected.
2. Reply with one line per server:

```
PROBE-MCP <server name>: <the JSON it returned, on one line, or NOT AVAILABLE>
```
