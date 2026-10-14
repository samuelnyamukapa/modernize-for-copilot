#!/usr/bin/env python3
"""Minimal MCP stdio server (stdlib only) for the spike.

Exposes one tool, `probe_env`, that reports how Copilot launched it: which
launcher name worked, PLUGIN_ROOT / PLUGIN_DATA, cwd, python version and OS.
Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, per the MCP stdio transport.
"""
import json
import os
import platform
import sys

LAUNCHER = sys.argv[1] if len(sys.argv) > 1 else "unknown"
SERVER = f"probe-{LAUNCHER}"


def reply(msg_id, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def probe_env():
    keys = ["PLUGIN_ROOT", "PLUGIN_DATA", "COPILOT_PLUGIN_ROOT", "COPILOT_PLUGIN_DATA",
            "CLAUDE_PLUGIN_ROOT", "PROBE_DATA"]
    return {
        "server": SERVER,
        "launcher": LAUNCHER,
        "env": {k: os.environ.get(k) for k in keys},
        "cwd": os.getcwd(),
        "script": os.path.abspath(__file__),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "os": f"{platform.system()} {platform.release()}",
    }


TOOLS = [{
    "name": "probe_env",
    "description": "Report how this MCP server was launched (plugin root, data dir, python, OS).",
    "inputSchema": {"type": "object", "properties": {}},
}]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        continue
    method, msg_id = req.get("method"), req.get("id")
    if msg_id is None:  # notification, e.g. notifications/initialized
        continue
    if method == "initialize":
        reply(msg_id, {
            "protocolVersion": req.get("params", {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER, "version": "0.0.1"},
        })
    elif method == "tools/list":
        reply(msg_id, {"tools": TOOLS})
    elif method == "tools/call":
        name = req.get("params", {}).get("name")
        if name == "probe_env":
            reply(msg_id, {"content": [{"type": "text", "text": json.dumps(probe_env(), indent=2)}]})
        else:
            reply(msg_id, error={"code": -32602, "message": f"unknown tool {name}"})
    elif method == "ping":
        reply(msg_id, {})
    else:
        reply(msg_id, error={"code": -32601, "message": f"method not found: {method}"})
