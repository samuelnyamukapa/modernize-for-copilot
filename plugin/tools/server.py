#!/usr/bin/env python3
"""modernize-tools: a stdlib-only MCP stdio server that runs the plugin's scripts.

Why a server and not shell commands in the skills: Copilot does not substitute a
plugin-root placeholder inside skills, but it does start plugin MCP servers with
PLUGIN_ROOT set and `${PLUGIN_ROOT}` expanded in their args (docs/SPIKE.md, check 2).
Each tool takes the project folder (`workspace`) explicitly, because the server's own
working directory is the plugin root, not the user's project.

Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio). Nothing else may
be written to stdout.

Launch: mcp.json declares two entries so that exactly one serves tools on any machine:
  --entry posix    started with `python3`; stands down on Windows when `py` exists
  --entry windows  started with `py -3`;  only serves on Windows
"""
from __future__ import annotations

import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
SCRIPTS = os.path.join(PLUGIN_ROOT, "scripts")
ASSETS = os.path.join(PLUGIN_ROOT, "assets")
VERSION = "1.0.0"
OUTPUT_CAP = 60_000
TIMEOUT_S = 900

SYSTEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
# Module folders may contain dots (.NET projects such as Contoso.Billing.Api), never "..".
MODULE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ToolError(Exception):
    """A problem with the caller's arguments; reported back as a tool error, not a crash."""


# --------------------------------------------------------------------------- validation

def workspace_of(args: dict) -> str:
    ws = args.get("workspace")
    if not isinstance(ws, str) or not ws.strip():
        raise ToolError("`workspace` is required: the absolute path of the project folder that holds legacy/ and analysis/.")
    ws = os.path.expanduser(ws.strip())
    if not os.path.isabs(ws):
        raise ToolError(f"`workspace` must be an absolute path, got {ws!r}.")
    ws = os.path.normpath(ws)
    if not os.path.isdir(ws):
        raise ToolError(f"`workspace` {ws!r} is not a folder.")
    return ws


def system_of(args: dict, key: str = "system", required: bool = True) -> str | None:
    value = args.get(key)
    if value in (None, "") and not required:
        return None
    if not isinstance(value, str) or not SYSTEM_RE.match(value):
        raise ToolError(f"`{key}` must be a folder name of letters, digits, '-' and '_' (got {value!r}).")
    return value


def module_of(args: dict) -> str | None:
    value = args.get("module")
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not MODULE_RE.match(value) or ".." in value:
        raise ToolError(f"`module` must be a folder name of letters, digits, '.', '-' and '_' (got {value!r}).")
    return value


def _inside(base: str, path: str) -> bool:
    base_c, path_c = os.path.normcase(base), os.path.normcase(path)
    return path_c == base_c or path_c.startswith(base_c.rstrip("\\/") + os.sep)


def path_in(ws: str, value, key: str, required: bool = True) -> str | None:
    """A workspace-relative path for a script argument. Lexical check, so legacy/<system>
    may still be a link to code elsewhere; the scripts apply their own realpath rules."""
    if value in (None, "") and not required:
        return None
    if not isinstance(value, str) or "\x00" in value:
        raise ToolError(f"`{key}` must be a path string.")
    full = os.path.normpath(value if os.path.isabs(value) else os.path.join(ws, value))
    if not _inside(ws, full):
        raise ToolError(f"`{key}` {value!r} is outside the workspace.")
    return os.path.relpath(full, ws)


def paths_in(ws: str, values, key: str) -> list[str]:
    if values in (None, ""):
        return []
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list):
        raise ToolError(f"`{key}` must be a list of paths.")
    return [path_in(ws, v, key) for v in values]


def flag(args: dict, key: str) -> bool:
    return bool(args.get(key))


# --------------------------------------------------------------------------- running scripts

def run_script(script: str, argv: list[str], ws: str) -> dict:
    cmd = [sys.executable, os.path.join(SCRIPTS, script), *argv]
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    try:
        proc = subprocess.run(cmd, cwd=ws, capture_output=True, timeout=TIMEOUT_S, env=env)
    except subprocess.TimeoutExpired:
        return result_text(f"{script} timed out after {TIMEOUT_S}s.", error=True)
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    shown = " ".join([script, *argv])
    parts = [f"$ python {shown}", f"(run in {ws})", f"exit code: {proc.returncode}"]
    if out.strip():
        parts += ["--- stdout ---", cap(out)]
    if err.strip():
        parts += ["--- stderr ---", cap(err)]
    # A non-zero exit is often a meaningful verdict (e.g. "not every module proven"), so it is
    # reported in the text and left for the skill to interpret, not flagged as a tool failure.
    return result_text("\n".join(parts), error=proc.returncode not in (0, 1))


def cap(text: str) -> str:
    if len(text) <= OUTPUT_CAP:
        return text
    return text[:OUTPUT_CAP] + f"\n… [{len(text) - OUTPUT_CAP} more characters cut; re-run the script for the full output]"


def result_text(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": error}


# --------------------------------------------------------------------------- tools

WS = {"type": "string", "description": "Absolute path of the project folder (the one holding legacy/, analysis/ and modernized/)."}
SYS = {"type": "string", "description": "The system's folder name, e.g. billing (as in legacy/billing and analysis/billing)."}


def t_build_report(a):
    ws, system = workspace_of(a), system_of(a)
    argv = [system]
    out = path_in(ws, a.get("out"), "out", required=False)
    if out:
        argv += ["--out", out]
    return run_script("build_report.py", argv, ws)


def t_make_shards(a):
    ws, system = workspace_of(a), system_of(a)
    argv = [system]
    pattern = a.get("module_pattern")
    if pattern:
        if not isinstance(pattern, str) or pattern.startswith("-"):
            raise ToolError("`module_pattern` must be a glob such as 'src/billing/*'.")
        argv.append(pattern)
    if flag(a, "all"):
        argv.append("--all")
    return run_script("make_shards.py", argv, ws)


def t_render_rules(a):
    ws, system = workspace_of(a), system_of(a)
    argv = [system]
    res = path_in(ws, a.get("result"), "result", required=False)
    if res:
        argv += ["--result", res]
    return run_script("render_rules.py", argv, ws)


def t_compare(a):
    ws = workspace_of(a)
    argv = [path_in(ws, a.get("cases"), "cases")]
    out = path_in(ws, a.get("out"), "out", required=False)
    if out:
        argv += ["--out", out]
    if flag(a, "allow_outside"):
        argv.append("--allow-outside")
    return run_script("compare.py", argv, ws)


def t_trace_rules(a):
    ws, system = workspace_of(a), system_of(a)
    argv = [system]
    if flag(a, "json"):
        argv.append("--json")
    if flag(a, "all"):
        argv.append("--all")
    module = module_of(a)
    if module:
        argv += ["--module", module]
    for r in paths_in(ws, a.get("results"), "results"):
        argv += ["--results", r]
    return run_script("trace_rules.py", argv, ws)


def t_baseline_diff(a):
    ws = workspace_of(a)
    argv = [path_in(ws, a.get("baseline"), "baseline")]
    results = paths_in(ws, a.get("results"), "results")
    if not results:
        raise ToolError("`results` needs at least one JUnit XML / .trx file or folder from the fresh test run.")
    for r in results:
        argv += ["--junit", r]
    for e in paths_in(ws, a.get("baseline_evidence"), "baseline_evidence"):
        argv += ["--baseline-evidence", e]
    if flag(a, "json"):
        argv.append("--json")
    if a.get("max_list") is not None:
        argv += ["--max-list", str(int(a["max_list"]))]
    return run_script("baseline_diff.py", argv, ws)


def t_uplift_checks(a):
    ws = workspace_of(a)
    argv = [path_in(ws, a.get("legacy"), "legacy"), path_in(ws, a.get("work"), "work")]
    catalog = path_in(ws, a.get("catalog"), "catalog", required=False)
    if catalog:
        argv.append(catalog)
    if flag(a, "json"):
        argv.append("--json")
    return run_script("uplift_checks.py", argv, ws)


def t_proof_pack(a):
    ws, system = workspace_of(a), system_of(a)
    argv = [system]
    module = module_of(a)
    if module:
        argv.append(module)
    return run_script("proof_pack.py", argv, ws)


TOPOLOGY_MARKER = "/*__TOPOLOGY_DATA__*/ null"


def t_render_topology(a):
    """Inject analysis/<system>/topology.json into the shipped viewer (was an inline heredoc upstream)."""
    ws, system = workspace_of(a), system_of(a)
    out_dir = os.path.join(ws, "analysis", system)
    src = os.path.join(out_dir, "topology.json")
    if not os.path.isfile(src):
        raise ToolError(f"{os.path.relpath(src, ws)} does not exist yet; write it before rendering the map.")
    with open(os.path.join(ASSETS, "topology-viewer.html"), encoding="utf-8") as fh:
        tpl = fh.read()
    if TOPOLOGY_MARKER not in tpl:
        return result_text("The viewer template is missing its data marker; the plugin install looks damaged.", error=True)
    with open(src, encoding="utf-8") as fh:
        try:
            data = json.dumps(json.load(fh))
        except json.JSONDecodeError as exc:
            raise ToolError(f"topology.json is not valid JSON: {exc}") from None
    # topology.json is derived from untrusted code. It lands inside a <script> block, which
    # the HTML parser closes on a literal "</script>", so escape the characters that matter.
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    out = os.path.join(out_dir, "TOPOLOGY.html")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(tpl.replace(TOPOLOGY_MARKER, "/*__TOPOLOGY_DATA__*/ " + data))
    return result_text(f"wrote {os.path.relpath(out, ws)} ({os.path.getsize(out) >> 10} KB)")


def t_doctor(a):
    """Environment facts for /modernize:preflight: which Python runs the scripts, and the guard self-test."""
    sys.path.insert(0, HERE)
    try:
        import guard  # noqa: E402  (same folder)
        failures = guard.self_test()
    finally:
        sys.path.pop(0)
    info = {
        "plugin_version": VERSION,
        "plugin_root": PLUGIN_ROOT,
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "python_ok": sys.version_info >= (3, 9),
        "os": f"{platform.system()} {platform.release()}",
        "entry": ENTRY,
        "guard_self_test": "pass" if not failures else {"failed": failures},
        "tools": {name: shutil.which(name) for name in ("git", "scc", "cloc", "dotnet", "java", "mvn", "gradle", "node", "npm")},
    }
    if a.get("workspace"):
        ws = workspace_of(a)
        info["workspace"] = ws
        info["legacy_protected_roots"] = guard.protected_roots(ws)
    return result_text(json.dumps(info, indent=2), error=bool(failures) or not info["python_ok"])


TOOLS = {
    "build_report": (t_build_report, "Refresh the one-page offline report analysis/<system>/REPORT.html from every artifact on disk.",
                     {"workspace": WS, "system": SYS, "out": {"type": "string", "description": "Optional output path inside the workspace."}},
                     ["workspace", "system"]),
    "make_shards": (t_make_shards, "Split the legacy source into module shards for business-rule extraction; writes analysis/<system>/extract-rules.modules.json.",
                    {"workspace": WS, "system": SYS,
                     "module_pattern": {"type": "string", "description": "Optional glob limiting which modules are sharded."},
                     "all": {"type": "boolean", "description": "Include every file, not just the default selection."}},
                    ["workspace", "system"]),
    "render_rules": (t_render_rules, "Render analysis/<system>/rules_result.json into BUSINESS_RULES.md and DATA_OBJECTS.md.",
                     {"workspace": WS, "system": SYS, "result": {"type": "string", "description": "Optional path of the rules result JSON."}},
                     ["workspace", "system"]),
    "compare": (t_compare, "Byte-level legacy-vs-modern output comparison from a cases.json; writes EQUIVALENCE.json next to it.",
                {"workspace": WS, "cases": {"type": "string", "description": "Path of cases.json inside the workspace."},
                 "out": {"type": "string"}, "allow_outside": {"type": "boolean"}},
                ["workspace", "cases"]),
    "trace_rules": (t_trace_rules, "Trace each RULE-NNN to the modernized code and tests that answer for it.",
                    {"workspace": WS, "system": SYS, "json": {"type": "boolean"}, "all": {"type": "boolean"},
                     "module": {"type": "string", "description": "Only rules for this built module."},
                     "results": {"type": "array", "items": {"type": "string"}, "description": "Test result files to read."}},
                    ["workspace", "system"]),
    "baseline_diff": (t_baseline_diff, "Compare a fresh test run (JUnit XML or .trx) against BASELINE.md and list regressions.",
                      {"workspace": WS, "baseline": {"type": "string", "description": "Path of analysis/<system>/BASELINE.md."},
                       "results": {"type": "array", "items": {"type": "string"}, "description": "Result files or folders from the fresh run."},
                       "baseline_evidence": {"type": "array", "items": {"type": "string"}},
                       "json": {"type": "boolean"}, "max_list": {"type": "integer"}},
                      ["workspace", "baseline", "results"]),
    "uplift_checks": (t_uplift_checks, "Uplift guardrails: test files changed during the uplift, and behavioural deltas no test names.",
                      {"workspace": WS, "legacy": {"type": "string", "description": "legacy/<system>"},
                       "work": {"type": "string", "description": "modernized/<system>-uplifted"},
                       "catalog": {"type": "string", "description": "analysis/<system>/DELTA_CATALOG.md"}, "json": {"type": "boolean"}},
                      ["workspace", "legacy", "work"]),
    "proof_pack": (t_proof_pack, "Compute one verdict per built module (PROVEN / PARTLY PROVEN / NOT PROVEN); writes VERIFICATION.md and .json.",
                   {"workspace": WS, "system": SYS, "module": {"type": "string"}},
                   ["workspace", "system"]),
    "render_topology": (t_render_topology, "Build the interactive analysis/<system>/TOPOLOGY.html from topology.json using the plugin's viewer.",
                        {"workspace": WS, "system": SYS}, ["workspace", "system"]),
    "doctor": (t_doctor, "Report the plugin's runtime (Python version, OS, available build tools) and run the legacy/ guard self-test.",
               {"workspace": {**WS, "description": WS["description"] + " Optional."}}, []),
}


def tool_list() -> list[dict]:
    return [
        {"name": name, "description": desc,
         "inputSchema": {"type": "object", "properties": props, "required": req}}
        for name, (_, desc, props, req) in TOOLS.items()
    ]


# --------------------------------------------------------------------------- JSON-RPC loop

def stands_down() -> bool:
    """Exactly one of the two mcp.json entries serves tools on a given machine."""
    if ENTRY == "windows":
        return os.name != "nt"
    if ENTRY == "posix":
        return os.name == "nt" and shutil.which("py") is not None
    return False


def handle(req: dict) -> dict | None:
    method, msg_id = req.get("method"), req.get("id")
    if msg_id is None:
        return None
    if method == "initialize":
        return ok(msg_id, {
            "protocolVersion": (req.get("params") or {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "modernize-tools", "version": VERSION},
            "instructions": "Runs the modernize plugin's scripts. Always pass `workspace` as the absolute project path.",
        })
    if method == "tools/list":
        return ok(msg_id, {"tools": [] if STAND_DOWN else tool_list()})
    if method == "tools/call":
        params = req.get("params") or {}
        name, args = params.get("name"), params.get("arguments") or {}
        if STAND_DOWN or name not in TOOLS:
            return err(msg_id, -32602, f"unknown tool {name!r}")
        try:
            return ok(msg_id, TOOLS[name][0](args))
        except ToolError as exc:
            return ok(msg_id, result_text(str(exc), error=True))
        except Exception as exc:  # report, never crash the server
            return ok(msg_id, result_text(f"{name} failed: {exc.__class__.__name__}: {exc}", error=True))
    if method == "ping":
        return ok(msg_id, {})
    return err(msg_id, -32601, f"method not found: {method}")


def ok(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def err(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def serve(stdin, stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle(req) if isinstance(req, dict) else None
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            stdout.flush()


def _entry(argv: list[str]) -> str:
    if "--entry" in argv:
        i = argv.index("--entry")
        if i + 1 < len(argv):
            return argv[i + 1]
    return "any"


ENTRY = _entry(sys.argv[1:])
STAND_DOWN = stands_down()

def leave_plugin_dir() -> None:
    """Copilot starts this server with the plugin folder as its working directory. Windows cannot
    delete or rename a folder that is some process's working directory, so while a session is open
    `copilot plugin update` and uninstall fail ("os error 32"). Every tool runs its script with
    cwd=workspace and every path here is absolute, so the server moves out of the plugin folder."""
    try:
        os.chdir(tempfile.gettempdir())
    except OSError:
        pass


if __name__ == "__main__":
    leave_plugin_dir()
    stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
    stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n", write_through=True)
    serve(stdin, stdout)
