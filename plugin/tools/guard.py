#!/usr/bin/env python3
"""preToolUse guard: the legacy source is read-only.

Copilot runs this before every tool call (main agent, subagents and dynamic-workflow
agents, per docs/SPIKE.md checks 4-6) with JSON on stdin such as
    {"sessionId": "...", "cwd": "D:\\proj", "toolName": "apply_patch", "toolArgs": {...}}
It prints nothing to allow, or
    {"permissionDecision": "deny", "permissionDecisionReason": "..."}
to block. The hook process's own cwd is the plugin root; the project is `cwd` in the input.

Protected roots, for a workspace W:
  - W/<legacyDir> (default "legacy"; override with MODERNIZE_LEGACY_DIR or
    W/analysis/.modernize.json {"legacyDir": "..."}), lexically and, when it or a
    system folder under it is a link, the real target too
  - any path recorded in W/analysis/<system>/SOURCE (the --source code location)

What is blocked: file-edit tools whose target is inside a protected root, and shell
commands that both reference a protected root and look like they write. Copying *out*
of legacy (cp/rsync/Copy-Item with a destination elsewhere) and reading are allowed.
This is a guard rail against mistakes and steering, not a sandbox.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys

REASON = "modernize guard: {root} is read-only legacy source. Write to analysis/ or modernized/ instead."

READ_ONLY_TOOLS = {
    "view", "read", "read_file", "glob", "grep", "search", "ls", "list_dir", "list_directory", "rg",
    "fetch", "web_fetch", "web_search", "ask_user", "report_intent", "think", "skill", "task",
    "read_agent", "list_agents", "update_todo", "todo", "Read", "Glob", "Grep", "LS", "WebFetch",
    "WebSearch", "TodoWrite",
}
SHELL_TOOLS = {"bash", "powershell", "pwsh", "shell", "execute", "run_in_terminal", "terminal", "cmd", "Bash", "PowerShell"}
PATH_KEYS = ("path", "file_path", "filePath", "filepath", "file", "filename", "target", "target_file",
             "destination", "dest", "new_path", "old_path", "notebook_path", "uri")
CWD_KEYS = ("cwd", "workdir", "workingDirectory", "working_directory", "dir", "directory")

PATCH_FILE = re.compile(r"^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s+Move\s+to:\s*(.+?)\s*$", re.M)

# Verbs that write (POSIX shells, PowerShell, cmd). Lower-cased comparison.
WRITE_VERBS = {
    "rm", "rmdir", "unlink", "mv", "touch", "truncate", "chmod", "chown", "chgrp", "dd", "shred", "ln",
    "install", "mkdir", "patch", "tee", "sed", "perl", "awk",
    "remove-item", "move-item", "rename-item", "new-item", "set-content", "add-content", "clear-content",
    "out-file", "set-item", "set-itemproperty", "clear-item", "ni", "ri", "mi", "rni", "sc", "ac", "del",
    "erase", "rd", "ren", "move", "md",
}
COPY_VERBS = {"cp", "copy", "copy-item", "cpi", "xcopy", "robocopy", "rsync", "scp"}
CD_VERBS = {"cd", "pushd", "set-location", "sl", "chdir"}
GIT_WRITE = {"apply", "checkout", "restore", "reset", "clean", "stash", "am", "rm", "mv", "switch", "merge", "rebase", "pull", "commit"}
# Build and migration tools write next to the project they are pointed at (obj/, bin/, target/,
# node_modules/, packages/, or the project files themselves). Pointed at legacy, they are writes.
# Tools listed with subcommands write only for those (`dotnet list` and `upgrade-assistant analyze`
# don't); the rest always do. Compilers are left out: `cobc -fsyntax-only` and `gcc -fsyntax-only`
# are preflight's read-only smoke test, and their default output goes to the current folder.
BUILD_SUBCOMMANDS = {
    "dotnet": {"restore", "build", "test", "publish", "run", "clean", "pack", "add", "remove", "new", "format",
               "msbuild", "sln", "migrate", "vstest", "ef", "watch"},
    "nuget": {"restore", "install", "update", "pack", "add", "init"},
    "npm": {"install", "i", "ci", "add", "run", "run-script", "build", "test", "update", "up", "rebuild", "exec", "x", "init"},
    "yarn": {"install", "add", "run", "build", "test", "upgrade", "up", "exec", "init"},
    "pnpm": {"install", "i", "add", "run", "build", "test", "update", "up", "rebuild", "exec", "init"},
    "upgrade-assistant": {"upgrade"},
    "ng": {"update", "build", "test", "add", "generate", "g"},
}
BUILD_ALWAYS = {"msbuild", "mvn", "mvnw", "gradle", "gradlew", "make", "ant", "try-convert"}
INLINE_WRITE = re.compile(r"""open\s*\([^)]*['"][wax+]|\.write|write_text|write_bytes|unlink\(|remove\(|rename\(|replace\(|shutil\.|WriteAll|AppendAll|File\.Delete|File\.Move""", re.I)


# --------------------------------------------------------------------------- protected roots

def _norm(p: str) -> str:
    return os.path.normcase(os.path.normpath(p))


def _inside(root: str, path: str) -> bool:
    r, p = _norm(root), _norm(path)
    return p == r or p.startswith(r.rstrip("\\/") + os.sep)


def legacy_dir_name(ws: str) -> str:
    name = os.environ.get("MODERNIZE_LEGACY_DIR")
    if not name:
        try:
            with open(os.path.join(ws, "analysis", ".modernize.json"), encoding="utf-8") as fh:
                name = json.load(fh).get("legacyDir")
        except (OSError, ValueError, AttributeError):
            name = None
    return (name or "legacy").strip().strip("/\\") or "legacy"


def protected_roots(ws: str) -> list[str]:
    roots: list[str] = []

    def add(p: str) -> None:
        p = os.path.normpath(p)
        if p not in roots:
            roots.append(p)

    legacy = os.path.join(ws, legacy_dir_name(ws))
    add(legacy)
    for candidate in [legacy] + ([os.path.join(legacy, d) for d in _listdir(legacy)]):
        try:
            real = os.path.realpath(candidate)  # resolves symlinks and, on Windows, junctions
        except (OSError, ValueError):
            continue
        if _norm(real) != _norm(candidate):
            add(real)
    analysis = os.path.join(ws, "analysis")
    for system in _listdir(analysis):
        try:
            with open(os.path.join(analysis, system, "SOURCE"), encoding="utf-8") as fh:
                src = fh.readline().strip()
        except OSError:
            continue
        if src:
            add(src if os.path.isabs(src) else os.path.join(ws, src))
    return roots


def _listdir(p: str) -> list[str]:
    try:
        return os.listdir(p)
    except OSError:
        return []


def _is_junction(p: str) -> bool:
    isj = getattr(os.path, "isjunction", None)  # Python 3.12+
    return bool(isj and isj(p))


def hit(path: str, ws: str, roots: list[str]) -> str | None:
    """The protected root `path` falls in, if any (lexically and after resolving links)."""
    path = path.strip().strip("'\"`")
    if not path or path.startswith("-"):
        return None
    if os.sep == "/":
        path = path.replace("\\", "/")
    full = path if os.path.isabs(path) else os.path.join(ws, path)
    candidates = {os.path.normpath(full)}
    try:
        candidates.add(os.path.realpath(full))
    except (OSError, ValueError):
        pass
    for root in roots:
        if any(_inside(root, c) for c in candidates):
            return root
    return None


# --------------------------------------------------------------------------- tool inspection

def paths_from_args(args) -> list[str]:
    out: list[str] = []
    if isinstance(args, str):
        out += [m.group(1) or m.group(2) for m in PATCH_FILE.finditer(args)]
        return out
    if not isinstance(args, dict):
        return out
    for key in PATH_KEYS:
        v = args.get(key)
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list):
            out += [x for x in v if isinstance(x, str)]
    for key in ("paths", "files", "file_paths"):
        v = args.get(key)
        if isinstance(v, list):
            out += [x if isinstance(x, str) else (x.get("path") or x.get("file_path") or "") for x in v if isinstance(x, (str, dict))]
    for key in ("input", "patch", "content", "diff", "changes"):  # apply_patch variants
        v = args.get(key)
        if isinstance(v, str) and "*** " in v:
            out += [m.group(1) or m.group(2) for m in PATCH_FILE.finditer(v)]
    return [p for p in out if p]


SEGMENT_SPLIT = re.compile(r"\|\||&&|[;|\n&]")
REDIRECT = re.compile(r"(?:^|[^<>&0-9])\d?>>?\s*([^\s;|&<>]+)|(?:Out-File|Tee-Object|Set-Content|Add-Content)\s+(?:-(?:File)?Path\s+|-LiteralPath\s+)?([^\s;|&]+)", re.I)


def _tokens(segment: str) -> list[str]:
    segment = segment.replace("\\", "/")  # Windows paths; "/" works on every OS here
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


LINK_TYPES = {"symboliclink", "junction", "hardlink"}


def _ps_param(toks: list[str], *names: str) -> str | None:
    lowered = [t.lower() for t in toks]
    for name in names:
        for i, t in enumerate(lowered):
            if t == name and i + 1 < len(toks):
                return toks[i + 1]
            if t.startswith(name + ":"):
                return toks[i][len(name) + 1:]
    return None


def _setup_allowed(verb: str, toks: list[str], base: str, legacy_root: str) -> bool | None:
    """Linking a new system into legacy/ (or creating legacy/ itself) is how preflight wires
    up the code, so it is allowed. Returns True to allow, None when the rule does not apply."""
    def is_new_child(p: str) -> bool:
        full = os.path.normpath(_rel(p, base))
        return _norm(os.path.dirname(full)) == _norm(legacy_root) and not os.path.lexists(full)

    def is_root(p: str) -> bool:
        return _norm(os.path.normpath(_rel(p, base))) == _norm(legacy_root)

    plain = [t for t in toks[1:] if not t.startswith("-")]
    lowered = [t.lower() for t in toks]
    if verb == "ln" and any(t.startswith("-") and "s" in t for t in toks[1:]) and len(plain) >= 2:
        return True if is_new_child(plain[-1]) else None
    if "mklink" in lowered:
        rest = [t for t in toks[lowered.index("mklink") + 1:] if not t.startswith("/")]
        return True if rest and is_new_child(rest[0]) else None
    if verb in ("new-item", "ni"):
        kind = (_ps_param(toks, "-itemtype", "-type") or "").lower()
        path = _ps_param(toks, "-path", "-name") or (plain[0] if plain else None)
        if path and kind in LINK_TYPES and is_new_child(path):
            return True
        if path and kind == "directory" and is_root(path):
            return True
        return None
    if verb in ("mkdir", "md") and plain and all(is_root(p) for p in plain):
        return True
    return None


def shell_violation(command: str, ws: str, roots: list[str], cwd: str | None) -> str | None:
    base = cwd or ws
    legacy_root = roots[0] if roots else None
    in_protected = hit(base, ws, roots) if cwd else None

    # Redirections anywhere in the command: `> legacy/x`, `Out-File legacy\x`.
    for m in REDIRECT.finditer(command):
        target = m.group(1) or m.group(2)
        root = hit(_rel(target, base), ws, roots)
        if root:
            return root

    for segment in SEGMENT_SPLIT.split(command):
        toks = _tokens(segment.strip())
        if not toks:
            continue
        verb = os.path.basename(toks[0].replace("\\", "/")).lower()
        for ext in (".exe", ".cmd", ".bat"):
            if verb.endswith(ext):
                verb = verb[: -len(ext)]
        args = [t for t in toks[1:] if not t.startswith("-") and not re.match(r"^/[A-Za-z]{1,3}$", t)]
        if verb in CD_VERBS and args:
            root = hit(_rel(args[0], base), ws, roots)
            in_protected = root
            if root is None:
                base = os.path.normpath(_rel(args[0], base))
            continue
        referenced = next((r for r in (hit(_rel(a, base), ws, roots) for a in args) if r), None) or _mentioned(segment, ws, roots)
        target_root = referenced or in_protected
        if not target_root:
            continue
        if legacy_root and not in_protected and _setup_allowed(verb, toks, base, legacy_root):
            continue
        if verb in COPY_VERBS:
            dest = args[-1] if len(args) >= 2 else None
            dest_root = hit(_rel(dest, base), ws, roots) if dest else in_protected
            if dest_root:
                return dest_root
            continue
        if verb == "sed" and not any(t == "-i" or t.startswith("-i") or t == "--in-place" for t in toks[1:]):
            continue  # plain sed only prints
        if verb in ("perl",) and not any(t.startswith("-i") or t.startswith("-pi") for t in toks[1:]):
            continue
        if verb == "awk" and "inplace" not in segment:
            continue
        if verb in WRITE_VERBS:
            return target_root
        if verb == "git" and _git_subcommand(toks) in GIT_WRITE:
            return target_root
        if _builds(verb, toks):
            return target_root
        if INLINE_WRITE.search(segment):
            return target_root
    return None


def _builds(verb: str, toks: list[str]) -> bool:
    if verb in BUILD_ALWAYS:
        return True
    subs = BUILD_SUBCOMMANDS.get(verb)
    if subs is None:
        return False
    words = [t.lower() for t in toks[1:] if not t.startswith("-")]
    if verb == "yarn" and not words:
        return True  # a bare `yarn` installs
    return any(w in subs for w in words)


def _git_subcommand(toks: list[str]) -> str:
    i = 1
    while i < len(toks):
        t = toks[i]
        if t in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t.lower()
    return ""


def _mentioned(text: str, ws: str, roots: list[str]) -> str | None:
    """A protected root named anywhere in the text, e.g. inside a quoted one-liner."""
    flat = text.replace("\\", "/")
    for root in roots:
        forms = {root.replace("\\", "/")}
        if _inside(ws, root):
            rel = os.path.relpath(root, ws).replace("\\", "/")
            forms |= {rel, "./" + rel}
        for f in forms:
            if re.search(r"(?:^|[\s'\"=(,:])" + re.escape(f) + r"(?:/|$|[\s'\")])", flat, re.I if os.name == "nt" else 0):
                return root
    return None


def _rel(path: str, base: str) -> str:
    path = path.strip().strip("'\"`").replace("\\", "/")
    return path if os.path.isabs(path) else os.path.join(base, path)


def decide(event: dict) -> str | None:
    """Return the protected root a call would write to, or None to allow."""
    ws = event.get("cwd") or os.getcwd()
    tool = str(event.get("toolName") or event.get("tool_name") or "")
    args = event.get("toolArgs", event.get("tool_input"))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            pass
    if tool in READ_ONLY_TOOLS or tool.lower() in READ_ONLY_TOOLS:
        return None
    roots = protected_roots(ws)
    if not any(os.path.lexists(r) for r in roots):
        return None  # nothing to protect in this workspace
    if tool in SHELL_TOOLS or tool.lower() in SHELL_TOOLS:
        command = args.get("command") if isinstance(args, dict) else args
        if not isinstance(command, str):
            return None
        cwd = next((args.get(k) for k in CWD_KEYS if isinstance(args, dict) and isinstance(args.get(k), str)), None)
        return shell_violation(command, ws, roots, cwd)
    for p in paths_from_args(args):
        root = hit(p, ws, roots)
        if root:
            return root
    return None


def deny(root: str, ws: str) -> str:
    shown = os.path.relpath(root, ws) if _inside(ws, root) else root
    return json.dumps({"permissionDecision": "deny", "permissionDecisionReason": REASON.format(root=shown.replace("\\", "/"))})


def main(argv: list[str]) -> int:
    raw = ""
    try:
        if "--input" in argv:
            with open(argv[argv.index("--input") + 1], encoding="utf-8-sig") as fh:
                raw = fh.read()
        else:
            raw = sys.stdin.buffer.read().decode("utf-8-sig", "replace")
        event = json.loads(raw) if raw.strip() else {}
        root = decide(event)
        if root:
            sys.stdout.write(deny(root, event.get("cwd") or os.getcwd()) + "\n")
    except Exception as exc:  # fail closed only when the call plausibly touches legacy
        if re.search(r"(?:^|[\\/\"' ])legacy[\\/]", raw):
            sys.stdout.write(json.dumps({"permissionDecision": "deny",
                                         "permissionDecisionReason": f"modernize guard could not check this call ({exc.__class__.__name__}); blocked because it mentions legacy/."}) + "\n")
    return 0


# --------------------------------------------------------------------------- self-test

def self_test() -> list[str]:
    """Run the decision table against a throwaway workspace. Returns failure descriptions."""
    import tempfile
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as ws:
        os.makedirs(os.path.join(ws, "legacy", "billing"))
        os.makedirs(os.path.join(ws, "modernized"))
        L = os.path.join("legacy", "billing", "PAY.cbl")
        cases = [
            ("apply_patch", {"input": f"*** Begin Patch\n*** Update File: {os.path.join(ws, L)}\n@@\n+x\n*** End Patch"}, True),
            ("apply_patch", {"input": "*** Begin Patch\n*** Add File: modernized/billing/Pay.java\n+x\n*** End Patch"}, False),
            ("apply_patch", "*** Begin Patch\n*** Update File: legacy/billing/PAY.cbl\n*** End Patch", True),
            ("edit", {"path": L}, True),
            ("create", {"path": "modernized/billing/Pay.java"}, False),
            ("str_replace_editor", {"path": os.path.join(ws, "legacy")}, True),
            ("view", {"path": L}, False),
            ("powershell", {"command": "Add-Content -LiteralPath 'legacy/billing/PAY.cbl' -Value 'x'"}, True),
            ("powershell", {"command": "Get-Content legacy\\billing\\PAY.cbl | Select-Object -First 5"}, False),
            ("powershell", {"command": "Copy-Item -Recurse legacy\\billing modernized\\billing-uplifted"}, False),
            ("powershell", {"command": "Remove-Item legacy\\billing -Recurse"}, True),
            ("bash", {"command": "cat legacy/billing/PAY.cbl | head"}, False),
            ("bash", {"command": "echo x > legacy/billing/PAY.cbl"}, True),
            ("bash", {"command": "echo x >> ./legacy/billing/new.txt"}, True),
            ("bash", {"command": "sed -n 1,20p legacy/billing/PAY.cbl"}, False),
            ("bash", {"command": "sed -i 's/a/b/' legacy/billing/PAY.cbl"}, True),
            ("bash", {"command": "cp -r legacy/billing modernized/billing-uplifted"}, False),
            ("bash", {"command": "rsync -a legacy/billing/ modernized/billing-uplifted/"}, False),
            ("bash", {"command": "cp notes.txt legacy/billing/"}, True),
            ("bash", {"command": "cd legacy/billing && rm PAY.cbl"}, True),
            ("bash", {"command": "cd legacy/billing && grep -rn PERFORM ."}, False),
            ("bash", {"command": "git -C legacy/billing checkout -- ."}, True),
            ("bash", {"command": "git apply legacy/billing/fix.patch"}, True),
            ("bash", {"command": "python3 -c \"open('legacy/billing/PAY.cbl','w').write('')\""}, True),
            ("bash", {"command": "rm -rf modernized/billing && mkdir modernized/billing"}, False),
            ("bash", {"command": "touch PAY.cbl", "cwd": os.path.join(ws, "legacy", "billing")}, True),
            ("bash", {"command": "dotnet build modernized/billing-uplifted"}, False),
            ("bash", {"command": "cp -RH legacy/billing modernized/billing-uplifted"}, False),
            ("bash", {"command": "dotnet restore legacy/billing/Billing.sln"}, True),
            ("bash", {"command": "cd legacy/billing && dotnet build"}, True),
            ("powershell", {"command": "& msbuild.exe legacy\\billing\\Billing.sln /t:Build"}, True),
            ("powershell", {"command": "nuget.exe restore legacy\\billing\\Billing.sln"}, True),
            ("bash", {"command": "mvn -f legacy/billing/pom.xml package"}, True),
            ("bash", {"command": "npm --prefix legacy/billing ci"}, True),
            ("bash", {"command": "dotnet list legacy/billing/Billing.csproj package --outdated"}, False),
            ("bash", {"command": "upgrade-assistant analyze legacy/billing/Billing.sln --report modernized/ua.sarif"}, False),
            ("bash", {"command": "upgrade-assistant upgrade legacy/billing/Billing.csproj"}, True),
            ("bash", {"command": "cobc -fsyntax-only legacy/billing/PAY.cbl"}, False),
            ("bash", {"command": "mkdir -p legacy && ln -s /work/payroll legacy/payroll"}, False),
            ("bash", {"command": "ln -s /work/other legacy/billing"}, True),
            ("bash", {"command": "mkdir legacy/billing/newdir"}, True),
            ("powershell", {"command": "New-Item -ItemType Junction -Path legacy\\payroll -Target D:\\src\\payroll"}, False),
            ("powershell", {"command": "New-Item -ItemType SymbolicLink -Path legacy\\billing -Target D:\\x"}, True),
            ("powershell", {"command": "New-Item -ItemType File -Path legacy\\payroll"}, True),
            ("powershell", {"command": "cmd /c mklink /J legacy\\payroll D:\\src\\payroll"}, False),
            ("powershell", {"command": "New-Item -ItemType Directory -Path legacy -Force"}, False),
        ]
        for tool, args, want_deny in cases:
            got = decide({"cwd": ws, "toolName": tool, "toolArgs": args}) is not None
            if got != want_deny:
                failures.append(f"{tool} {json.dumps(args)[:120]}: expected {'deny' if want_deny else 'allow'}, got {'deny' if got else 'allow'}")
    return failures


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        fails = self_test()
        for f in fails:
            print("FAIL", f)
        print("guard self-test:", "pass" if not fails else f"{len(fails)} failure(s)")
        sys.exit(1 if fails else 0)
    sys.exit(main(sys.argv[1:]))
