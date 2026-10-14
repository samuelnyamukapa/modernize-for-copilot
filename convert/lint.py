#!/usr/bin/env python3
"""Structural checks for the Copilot plugin. Exits non-zero on any error.

- No Claude Code-only tokens in skills, agents, hooks, extensions or tools.
- Agent and skill frontmatter is present and uses keys Copilot understands.
- Skill folder name matches its `name`.
- plugin.json and marketplace.json parse and agree on name and version.
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, "plugin")

# Directories whose text the agent reads as instructions or which run as plugin code.
CHECKED_DIRS = ["skills", "com.github.copilot", "tools"]

FORBIDDEN = [
    (re.compile(r"CLAUDE_PLUGIN_ROOT"), "use the modernize-tools MCP server instead of ${CLAUDE_PLUGIN_ROOT}"),
    (re.compile(r"\bAskUserQuestion\b"), "use the ask_user tool"),
    (re.compile(r"Workflow tool"), "refer to Copilot dynamic workflows"),
    (re.compile(r"\.claude/settings"), "Copilot does not read Claude permission rules; use the guard hook"),
    (re.compile(r"/code-modernization:"), "skills are invoked as /modernize:<verb>"),
    (re.compile(r"(?<![\w:])/modernize-[a-z]"), "skills are invoked as /modernize:<verb>, not /modernize-<verb>"),
    (re.compile(r"['\"]code-modernization:"), "agents are named modernize:<agent>"),
    (re.compile(r"\bEnterPlanMode\b|\bExitPlanMode\b"), "say 'stop and wait for explicit approval'"),
    (re.compile(r"\$(?:system|target_stack|module|scope|source_version|target_version|project_pattern|module_pattern|target_vision)\b"), "named placeholders are not substituted; write <system>, <target-stack>, ..."),
    (re.compile(r"CLAUDE\.md"), "the handoff file is AGENTS.md"),
    (re.compile(r"modernize-panel|modernize-sign|review-pane|progress pane"), "the progress pane is not ported"),
]

AGENT_KEYS = {"name", "description", "tools", "model", "target", "user-invocable",
              "disable-model-invocation", "mcp-servers", "metadata"}
SKILL_KEYS = {"name", "description"}


def frontmatter(path: str) -> dict[str, str] | None:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if line and not line.startswith((" ", "\t", "-")) and ":" in line:
            k, _, v = line.partition(":")
            out[k.strip()] = v.strip()
    return out


def main() -> int:
    errors: list[str] = []

    def err(path: str, msg: str) -> None:
        errors.append(f"{os.path.relpath(path, ROOT)}: {msg}")

    for d in CHECKED_DIRS:
        base = os.path.join(PLUGIN, d)
        for dirpath, _, files in os.walk(base):
            for f in files:
                if not f.endswith((".md", ".json", ".mjs", ".js", ".py", ".sh")):
                    continue
                p = os.path.join(dirpath, f)
                with open(p, encoding="utf-8") as fh:
                    for n, line in enumerate(fh, 1):
                        for pat, hint in FORBIDDEN:
                            if pat.search(line) and "lint: allow" not in line:
                                err(p, f"line {n}: {pat.pattern!r} — {hint}")

    agents = os.path.join(PLUGIN, "com.github.copilot", "agents")
    for f in sorted(os.listdir(agents)) if os.path.isdir(agents) else []:
        p = os.path.join(agents, f)
        if not f.endswith(".agent.md"):
            err(p, "agent files must end in .agent.md")
            continue
        fm = frontmatter(p)
        if fm is None:
            err(p, "missing frontmatter")
            continue
        for k in fm:
            if k not in AGENT_KEYS:
                err(p, f"unknown agent key {k!r}")
        if not fm.get("description"):
            err(p, "description is required")
        if fm.get("name") and fm["name"] + ".agent.md" != f:
            err(p, f"name {fm['name']!r} does not match file name")

    skills = os.path.join(PLUGIN, "skills")
    for d in sorted(os.listdir(skills)) if os.path.isdir(skills) else []:
        p = os.path.join(skills, d, "SKILL.md")
        if not os.path.isfile(p):
            err(os.path.join(skills, d), "missing SKILL.md")
            continue
        fm = frontmatter(p)
        if fm is None:
            err(p, "missing frontmatter")
            continue
        for k in fm:
            if k not in SKILL_KEYS:
                err(p, f"unknown skill key {k!r}")
        if fm.get("name") != d:
            err(p, f"name {fm.get('name')!r} must match folder {d!r}")
        if not fm.get("description"):
            err(p, "description is required")

    with open(os.path.join(PLUGIN, "plugin.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    with open(os.path.join(ROOT, ".github", "plugin", "marketplace.json"), encoding="utf-8") as fh:
        market = json.load(fh)
    entries = {e["name"]: e for e in market.get("plugins", [])}
    entry = entries.get(manifest.get("name"))
    if not entry:
        err(os.path.join(ROOT, ".github/plugin/marketplace.json"), f"no entry for {manifest.get('name')!r}")
    elif entry.get("version") != manifest.get("version"):
        err(os.path.join(ROOT, ".github/plugin/marketplace.json"), "version differs from plugin.json")

    for e in errors:
        print(f"error: {e}")
    print(f"lint: {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
