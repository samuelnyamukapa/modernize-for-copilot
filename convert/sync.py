#!/usr/bin/env python3
"""Regenerate the mechanical parts of the Copilot plugin from a pinned upstream commit.

Upstream: anthropics/claude-plugins-official, plugins/code-modernization (Apache 2.0).

What this script owns (overwritten on every run):
  plugin/scripts/            upstream python scripts, minus telemetry
  plugin/scripts/tests/      upstream script tests, minus telemetry
  plugin/assets/             upstream assets, minus the pane's screenshots
  plugin/com.github.copilot/agents/*.agent.md   converted agents
  convert/upstream-snapshot/ upstream commands + workflows, kept only as a diff reference

What it never touches (hand-maintained):
  plugin/skills/             the commands, rewritten as Copilot skills
  plugin/tools/              MCP server and guard hook
  plugin/com.github.copilot/extensions/   dynamic workflows
  plugin/com.github.copilot/hooks/

Usage:
  python3 convert/sync.py                 # use the SHA in convert/upstream.json
  python3 convert/sync.py --source DIR    # use an existing checkout of the upstream plugin dir
  python3 convert/sync.py --sha <sha>     # re-pin to another upstream commit
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, "plugin")
PIN_FILE = os.path.join(ROOT, "convert", "upstream.json")
SNAPSHOT = os.path.join(ROOT, "convert", "upstream-snapshot")

DROP_SCRIPTS = {"telemetry.py", "telemetry.sh", "test_telemetry.py"}
DROP_ASSETS = {"media", "topology-viewer-screenshot.jpg"}

# Claude Code tool name -> Copilot custom-agent tool alias (primary names).
TOOL_MAP = {
    "Read": "read",
    "Glob": "search",
    "Grep": "search",
    "Bash": "execute",
    "Write": "edit",
    "Edit": "edit",
    "MultiEdit": "edit",
    "NotebookEdit": "edit",
    "WebFetch": "web",
    "WebSearch": "web",
    "Task": "agent",
    "Agent": "agent",
    "TodoWrite": "todo",
}

# Agents that must only run inside an orchestrated batch, never picked by a person.
NOT_USER_INVOCABLE = {"uplift-migrator", "scaffolder"}

# Text rewrites applied to agent bodies. Each must change Claude-specific wording only.
BODY_REWRITES = [
    (re.compile(r"/code-modernization:(modernize-[a-z-]+)"), r"/\1"),
    (
        re.compile(
            r"Use the \*\*Write/Edit tools\*\* for every file change — they are what the\s+"
            r"workspace permission rules can see and scope\."
        ),
        "Use the **edit tool** for every file change — it is what the plugin's\n"
        "`legacy/` write guard and the session's tool approvals can see and scope.",
    ),
    (re.compile(r"Use \*\*Bash only\*\*"), "Use **the shell only**"),
]


def run(cmd: list[str], cwd: str | None = None) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def fetch(pin: dict) -> tuple[str, str]:
    """Sparse, shallow fetch of the pinned commit. Returns (tmpdir, plugin_dir)."""
    tmp = tempfile.mkdtemp(prefix="upstream-")
    run(["git", "init", "-q"], cwd=tmp)
    run(["git", "remote", "add", "origin", pin["repo"]], cwd=tmp)
    run(["git", "sparse-checkout", "set", "--no-cone", pin["path"]], cwd=tmp)
    run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", pin["sha"]], cwd=tmp)
    run(["git", "checkout", "-q", "FETCH_HEAD"], cwd=tmp)
    return tmp, os.path.join(tmp, pin["path"])


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        raise ValueError("missing YAML frontmatter")
    fm: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if not line.strip():
            continue
        key, _, value = line.partition(":")
        fm[key.strip()] = value.strip()
    return fm, m.group(2)


def yaml_str(value: str) -> str:
    """Quote a scalar so YAML never misreads colons, quotes or leading symbols."""
    return json.dumps(value, ensure_ascii=False)


def convert_agent(src: str, dst_dir: str) -> str:
    with open(src, encoding="utf-8") as fh:
        fm, body = split_frontmatter(fh.read())
    name = fm["name"]
    description = fm["description"]
    for pattern, repl in BODY_REWRITES:
        body = pattern.sub(repl, body)
        description = pattern.sub(repl, description)
    tools: list[str] = []
    for tool in (t.strip() for t in fm.get("tools", "").split(",") if t.strip()):
        mapped = TOOL_MAP.get(tool)
        if mapped is None:
            raise ValueError(f"{name}: no Copilot mapping for tool {tool!r}")
        if mapped not in tools:
            tools.append(mapped)
    lines = [
        "---",
        f"name: {name}",
        f"description: {yaml_str(description)}",
        f"tools: [{', '.join(yaml_str(t) for t in tools)}]",
    ]
    if name in NOT_USER_INVOCABLE:
        lines.append("user-invocable: false")
    lines += ["---", "", body.lstrip("\n")]
    out = os.path.join(dst_dir, f"{name}.agent.md")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines).rstrip("\n") + "\n")
    if len(body) > 30000:
        raise ValueError(f"{name}: body exceeds Copilot's 30,000-character agent limit")
    return name


def copy_tree(src: str, dst: str, drop: set[str]) -> None:
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(
        src, dst, ignore=lambda d, names: [n for n in names if n in drop or n == "__pycache__"]
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", help="existing upstream plugin directory (skips the git fetch)")
    ap.add_argument("--sha", help="re-pin to this upstream commit before syncing")
    args = ap.parse_args()

    with open(PIN_FILE, encoding="utf-8") as fh:
        pin = json.load(fh)
    if args.sha:
        pin["sha"] = args.sha

    tmp = None
    if args.source:
        src = os.path.abspath(args.source)
    else:
        tmp, src = fetch(pin)
    try:
        with open(os.path.join(src, ".claude-plugin", "plugin.json"), encoding="utf-8") as fh:
            upstream_version = json.load(fh).get("version", "unknown")

        copy_tree(os.path.join(src, "scripts"), os.path.join(PLUGIN, "scripts"), DROP_SCRIPTS)
        copy_tree(os.path.join(src, "assets"), os.path.join(PLUGIN, "assets"), DROP_ASSETS)

        agents_dst = os.path.join(PLUGIN, "com.github.copilot", "agents")
        if os.path.exists(agents_dst):
            shutil.rmtree(agents_dst)
        os.makedirs(agents_dst)
        agents = sorted(
            convert_agent(os.path.join(src, "agents", f), agents_dst)
            for f in os.listdir(os.path.join(src, "agents"))
            if f.endswith(".md")
        )

        for part in ("commands", "workflows"):
            copy_tree(os.path.join(src, part), os.path.join(SNAPSHOT, part), set())

        pin["version"] = upstream_version
        with open(PIN_FILE, "w", encoding="utf-8") as fh:
            json.dump(pin, fh, indent=2)
            fh.write("\n")
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

    print(f"synced upstream {pin['sha'][:7]} (v{upstream_version}): {len(agents)} agents, scripts, assets")
    print("review `git diff convert/upstream-snapshot` for command/workflow changes to port by hand")
    return 0


if __name__ == "__main__":
    sys.exit(main())
