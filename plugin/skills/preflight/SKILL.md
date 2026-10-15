---
name: preflight
description: "Run this first — checks the environment, records where the code lives, and says what to fix before anything else runs. Usage: /modernize:preflight <system> [target-stack] [--source <path>]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the arguments from the user's message instead.

- `<system>`: first word. A folder name of letters, digits, `-` and `_` only. Refuse anything else.
- `<target-stack>`: second argument, optional. It may be quoted when it has spaces (`"Java 17"`). If it starts with
  `--`, it is a flag, not a stack.
- `--source <path>`: optional. Where the code really lives (a directory, absolute or relative).

The **workspace** is the absolute path of the current working directory: the project folder that holds `legacy/`, `analysis/` and `modernized/`.

Check whether this environment can analyze — and eventually modernize — the
system `<system>`, and tell the user exactly what to fix before the other
commands run into it. Modernization runs fail late and confusingly when this is
skipped: metrics silently degrade without analysis tools, tests can't run
without a build toolchain, and dependency maps come out wrong when half the
source isn't in the tree.

Run every check even when an early one fails — the point is one complete
readiness report, not the first error.

## Where the code lives

The code is `legacy/<system>`: a copy, or a symlink to where it really lives (how a large repository stays
put). Nothing is ever copied for you.

- If the arguments contain `--source <path>`, check that it exists and is not the filesystem root or the user's
  home directory, then, only if `legacy/<system>` does not exist yet, create the link:
  - POSIX: `mkdir -p legacy && ln -s <absolute path> legacy/<system>`.
  - Windows (PowerShell): create `legacy` if it is missing, then
    `New-Item -ItemType SymbolicLink -Path legacy\<system> -Target <absolute path>`. A symbolic link may need
    Developer Mode or admin rights. If `New-Item -ItemType SymbolicLink` fails, use a directory junction instead:
    `New-Item -ItemType Junction -Path legacy\<system> -Target <absolute path>` (the same as
    `cmd /c mklink /J legacy\<system> <absolute path>`). If that fails too, record the path in
    `analysis/<system>/SOURCE` (below) instead of linking.
  - After linking, the guard protects both `legacy/<system>` and the link's real target (symlink or junction).

  If `legacy/<system>` already exists and points elsewhere, say so and change nothing.
- **`analysis/<system>/SOURCE`** is one line: the absolute path of the code. Write it with a file tool (it is under
  `analysis/`, which the guard allows). The plugin's guard hook treats a path recorded there as read-only legacy
  source, exactly like `legacy/`. If `SOURCE` already exists and names a different path, say so and change nothing.
- **The guard allows exactly this setup step.** Creating `legacy/` itself, and creating a symlink or junction at a
  `legacy/<system>` that does not exist yet, are allowed. Anything else inside `legacy/` is blocked, including
  replacing an existing link. If the guard still refuses (for example, the name already exists), that is the guard
  working: do not retry with another command or tool, and never try to get around it. Record the path in
  `analysis/<system>/SOURCE` and read the code there wherever this skill says `legacy/<system>`.
- Say where `legacy/<system>` points (`readlink legacy/<system>`; in PowerShell `(Get-Item legacy\<system>).Target`),
  or "a directory in this workspace", or "not linked: the path in `analysis/<system>/SOURCE`", in one line before you
  start.

Never modify anything under `legacy/<system>`, or under a path recorded in `analysis/<system>/SOURCE`.

## Check 0 — Ask the human (these answers are not in the source)

The most expensive modernization mistakes are things a person who knows the
system answers in seconds. Ask **only** the five questions below — add none —
and accept "don't know" for any of them.

**Ask with the `ask_user` tool (a pop-up), never in chat text.** It takes
at most four questions per call: ask 1–4 in one call and 5 in a second. Give
each question its own options, one of them "Don't know", and let the person
type an answer instead. Do not print the questions in your reply and do not
answer them yourself. Run the other checks while the questions are open — none of
them needs the answers: start the first `ask_user` call together with the first
checks' tool calls, and if the pop-up holds the session until it is answered, run
the remaining checks straight after.

**Headless run** (`copilot -p`, autopilot, or `ask_user` unavailable): do not ask.
Each question then has no answer and gets an open item (below).

1. **Scope** — Is this code the complete system, or one slice of a larger
   codebase? If a slice: what *outside* it depends on code *inside* it, and is
   breaking those consumers acceptable? (Check 6 verifies the crossing from the
   source; the answer says whether it *matters*.)
2. **Build & test locally** — Can this environment restore, build, and run the
   tests? Roughly how long does the full CI pipeline take?
3. **Bespoke build infrastructure** — Is there organization-specific build or
   dependency machinery (an internal package feed, a code generator, a wrapper
   around the standard build tool) a newcomer would not guess? Where is it
   documented?
4. **Prior attempts** — Has anyone tried to modernize this before? What went wrong?
5. **Off limits** — Is anything in this code not allowed to change in this
   pass (a component another team owns, a frozen branch, generated code)?

Write each question in a section of `PREFLIGHT.md` called **Answers**, with the
person's answer **verbatim** under it — never paraphrase away a caveat. If a
question has no answer (the tool is unavailable, as in a headless run, or the
person skips it), write **an open item the human must fill in** under it. All
five always appear.

## Check 1 — Detect the stack

Fingerprint `legacy/<system>` from file extensions and manifests: languages, build
system, deployment and config descriptors. Report what you found and the rough
file split.

## Check 2 — Analysis tooling

Check availability (`command -v`; in PowerShell `Get-Command`), version and what degrades without it:

| Tool | Used by | Without it |
|---|---|---|
| `scc` (or `cloc`) | assess | LOC and complexity fall back to `find` + `wc`; the COCOMO index gets coarser |
| Python 3.9 or newer for the plugin's scripts | map, extract-rules, verify, report | the dependency scripts, the shard builder, the proof scripts and the HTML report can't run |
| `lizard` | assess --portfolio | complexity is estimated from decision-keyword counts |

The plugin's scripts do not run in your shell's Python. They run inside the `modernize-tools` MCP server
(`modernize-tools-win` on Windows), which was started with its own interpreter. So the Python row comes from the
`doctor` tool of Check 7: report its `python` (version), `python_executable` and `python_ok`, and which `entry`
served it. If `doctor` is unavailable, the Python row is ❌: the scripts cannot run at all. Separately, check that the
shell can start Python 3 (`python3`; on Windows `py -3`, `python` or `python3`: use whichever runs Python 3 wherever a
command says `python3`), because the guard hook is started with it; Check 7 says why that matters.

The `doctor` result also has a `tools` map: the path of each of `git`, `scc`, `cloc`, `dotnet`, `java`, `mvn`,
`gradle`, `node` and `npm` on the MCP server's `PATH`, or null. Use it alongside your own `command -v` checks, not
instead of them. If the two disagree (the shell finds a tool the server does not, or the reverse), say so: the server
and the shell see different `PATH`s.

Give the platform's install one-liner for anything missing.

## Check 3 — Build toolchain (prove it on THIS code, not just presence)

**3a — Read the build definition first.** Something already builds this system.
Find the CI or pipeline definition (`azure-pipelines.yml`, `Jenkinsfile`,
`.github/workflows/`, `.gitlab-ci.yml`, build JCL procs, a `Makefile`) and the
build configuration above or beside the source (`Directory.Build.props` and
`nuget.config`; a parent POM, `settings.xml` or `.mvn/`; a private-registry
`.npmrc` or `pip.conf`; a root `build/`, `eng/` or `scripts/`). It is the most
honest record of the pinned toolchain, where dependencies really come from and
what a naive build skips. Quote the pinned version and the dependency source,
and flag anything bespoke: a homegrown binary-resolution scheme is what a
transformation must not discover halfway through.

**3b — Smoke test, escalating.** Find the compiler or interpreter for the
detected stack (GnuCOBOL `cobc`, a JDK with Maven or Gradle, `cc`/`make`,
`dotnet`, ...), then prove it works on this code. The `doctor` `tools` map
(`dotnet`, `java`, `mvn`, `gradle`, `node`, `npm`) is a quick first look at what is
present; presence is not proof:

- **Level 1, any stack:** syntax-compile one representative file
  (`cobc -fsyntax-only`, `javac`, `gcc -fsyntax-only`). Catches missing
  copybooks and includes, dialect flags, fixed versus free format.
- **Level 2, any stack with a build system:** restore and build ONE whole small
  project the way 3a says CI does. A one-file compile misses private feeds,
  code generation, shared props and pinned SDKs — where large codebases hide
  their surprises. Restore and build write next to the project (`obj/`, `bin/`,
  `packages/`, `target/`, `node_modules/`), so do it in a scratch copy, never
  inside `legacy/<system>`: copy the project and whatever it references
  (solution file, shared props, sibling projects) into a scratch directory as
  below, keeping their relative layout. On POSIX use `cp -RH` or
  `rsync -a src/ dest/` (a plain `cp -r` of a link copies the link, not the code);
  in PowerShell, `Copy-Item -Recurse` or `robocopy /E`. The guard blocks
  build tools pointed at `legacy/`.

A failed smoke test is the most valuable output of this command: report the
actual error and diagnose it (missing copybook or include path, missing dialect
flag, a dependency the standard feed cannot resolve). Level 2 being *impossible*
(no build system, a mainframe stack with no local runtime) is a fact, not a
failure: equivalence then falls back to recorded traces.

If `<target-stack>` was given, prove it with a throwaway project, not a version
string: in a scratch directory outside `legacy/<system>` (`mktemp -d`; in
PowerShell `New-Item -ItemType Directory (Join-Path ([IO.Path]::GetTempPath()) (New-Guid))`),
create the smallest project the stack allows, restore, build, run one passing
test with its real package manager and test framework, then delete it. A target
that cannot build here is a finding.

## Check 4 — Source completeness

The map is only as good as what is in the tree. Look for the stack's equivalents of:

- **Referenced-but-missing includes** — copybooks, headers, imports that resolve
  nowhere. Count them and list the top names.
- **Deployment and config descriptors** — JCL, CICS CSD, `web.xml` or route
  configs, cron and scheduler definitions. Without them, entry points and the
  code-to-storage join are guesswork.
- **Data definitions** — DDL, schemas, record layouts, ORM mappings.
- **Binary-only artifacts** — load modules, jars, DLLs with no source. Flag them now.

## Check 5 — Optional context

- **Production telemetry** — is an APM MCP server connected, or are batch logs
  and runtime exports available? (Enables the runtime overlay in assess.)
- **Version control** — is `legacy/<system>` under git with real history? (Change
  frequency sharpens risk ranking.) The `doctor` `tools` map says whether `git` is
  on the server's `PATH`.

## Check 6 — Scope boundary (is `<system>` the whole world, or a slice?)

Every downstream command assumes `legacy/<system>` *is* the system. When it is one
directory inside a larger repository — a monorepo module, one solution folder, a
subsystem sharing includes with siblings — that assumption is the most dangerous
in the run, and nothing else checks it. Resolve any symlink or junction (or take the
path in `analysis/<system>/SOURCE`), then look for a
repository, solution or reactor root above `legacy/<system>`, and for manifests or
includes inside it that reach outside. If either is true, report both directions:

- **Outbound** — things inside that depend on source outside (project or module
  references, shared includes, a parent build file). The map and the delta
  catalog only see what is under `legacy/<system>`, so each one is a dependency they will
  silently miss. List them.
- **Inbound** — things outside that depend on things inside: the **blast
  radius**. An in-place migration of a node with outside consumers breaks each of
  them. Grep the sibling manifests for references into `legacy/<system>`, list the nodes
  they use, and say plainly that each needs an explicit decision *before* any
  in-place change: keep it buildable for old and new consumers during the
  transition, widen the scope to include the consumers, or schedule the break.

If `<system>` is a standalone repository, one line saying so is the whole check.

## Check 7 — Is the source protected from edits?

Every command is written never to edit `legacy/<system>`, but that is only a convention until something enforces it.
In this plugin the enforcement is the plugin's `legacy/` guard: a `preToolUse` hook that runs before every tool call
of the main agent, its subagents and dynamic-workflow agents, and denies edit tools and write-looking shell commands
aimed at a protected root. This check is **read-only**: never edit the hook, the plugin or anything under
`legacy/<system>`, and never suggest loosening, disabling or getting around the guard.

**7a — Ask the plugin.** Call the `doctor` tool on the `modernize-tools` MCP server (`modernize-tools-win` on
Windows; only one of the two serves tools on a machine) with `{workspace}`. It returns JSON. Require all three:

- **`guard_self_test` is `"pass"`.** Anything else is a list of failed guard cases: quote it.
- **`python_ok` is `true`** (Python 3.9 or newer). Report `python` (the version) and `python_executable` (the
  interpreter that runs the scripts), and `entry`. On Windows, `python` and `python3` can resolve to the Microsoft
  Store stub or to different installations; the executable path shows which one ran.
- **The system's code is covered by `legacy_protected_roots`.** The path of the system's code is `legacy/<system>`
  and, when that is a symlink or junction, its real target too; or, when the code is recorded in
  `analysis/<system>/SOURCE`, that path. Each must equal or sit inside one entry of `legacy_protected_roots`
  (compare full paths; case-insensitively on Windows). **If `legacy/<system>` is a link, its real target must be
  covered as well**: a root that covers only the link's path does not stop an edit made through the real path.  If a
  link's target is missing from the list, record the target in `analysis/<system>/SOURCE` (a file under `analysis/`,
  which the guard allows) and run this check again.

Statuses:

- **✅** — all three hold. Name the roots that cover the code, and the Python version and executable.
- **❌** — the self-test failed, `python_ok` is false, or the code (or a link's real target) is not covered. Say
  which, and the fix: a newer Python for the MCP server, recording the path in `analysis/<system>/SOURCE`, or
  reinstalling the plugin when the self-test fails.

**7b — If the `doctor` tool is unavailable** (the server is not connected, or the tool is missing or errors before
returning JSON), the status is **❌** and the verdict is **Not ready** for every build command (`transform`,
`reimagine`, `uplift`): the plugin's scripts run in the `modernize-tools` MCP server and the `legacy/` guard is the
plugin's hook, so if the plugin is not loaded, neither can be relied on. Tell the user to run `/mcp` to check that
`modernize-tools` (or `modernize-tools-win`) is connected, and to reinstall the plugin if it is not (from the
marketplace; close other Copilot sessions first, because an uninstall fails while one is open). Do not suggest a
workaround: do not run the scripts by hand, and do not suggest anything that edits `legacy/`.

**7c — Say this on any status, so a green row is not read as a guarantee:** the guard is a guard rail, not a
sandbox. It covers Copilot's edit tools and the shell commands it recognizes as writes (`rm`, `mv`, `sed -i`, `> file`,
`Set-Content`, `New-Item`, ...), not a script or program that opens the files itself. It runs in the shell's Python,
not the server's: if the hook cannot find a Python 3 (Check 2), it falls back to blocking every non-read call that
mentions `legacy/`, which is safe but stops the build commands. And
`guard_self_test` proves the guard's logic on this machine, not that the hook fired in this session. So do not run
the build commands (`transform`, `reimagine`, `uplift`) in autopilot or with allow-all permissions (`--yolo`,
`--allow-all`): approving each tool call is the second line of defence. The hard guarantee is the operating system:
a read-only mount, or a sandbox that blocks shell writes.

## Report

Write `analysis/<system>/PREFLIGHT.md`. **Lead with the Answers section and the
Check 6 finding** — downstream commands (`brief` above all) read those two.
Record where the code lives (the `legacy/<system>` link target, or the path in
`analysis/<system>/SOURCE`). If you date the report, take the date from the system clock (`Get-Date -Format
yyyy-MM-dd` or `date +%F`), never from memory.
Then a table, one row per check, status ✅ / ⚠️ / ❌, what was found and the fix
for anything not green, then a **Ready / Ready-with-gaps / Not ready** verdict per
command:

- `assess`, `map`, `extract-rules` — Checks 1–2 mostly green and few missing includes.
- `brief` — needs only the discovery artifacts (plus `DELTA_CATALOG.md` for a
  same-stack uplift); no tooling.
- `transform`, `reimagine` — also need Check 3 green for the **target** stack. A
  red legacy toolchain is Ready-with-gaps, not Not-ready: equivalence falls back
  to recorded traces instead of dual execution (normal for code with no local
  runtime).
- `harden` — Check 2 plus any stack-specific SAST tooling found.
- `uplift` — Check 3 green for the **target** version, plus, when `<target-stack>`
  looks like a version bump: (a) is the **source** runtime also here? Both present
  means a true dual run; target-only means equivalence degrades to recorded
  outputs (say which). (b) Is the ecosystem's **migration tool** installed
  (`upgrade-assistant`, OpenRewrite, `pyupgrade`, `ng`)? Missing is
  Ready-with-gaps: the delta catalog is then agent-derived only. (c) Did Check 6
  find **inbound consumers**? That is Ready-with-gaps — no plan exists yet to
  record a decision in — but the gap that matters most: name the shared nodes and
  say `brief` must give each an explicit transition decision, and `uplift` will
  not migrate a shared node in place without one.
- **Check 7, for every build command** (`transform`, `reimagine`, `uplift`): a ❌ in
  Check 7 makes the command **Not ready**, whatever the other checks say. The code
  is only as safe as the guard, and these commands write the most.

Print the table in the session too. End with the single most important fix if
anything is red, and the next step: `/modernize:assess <system>`.
