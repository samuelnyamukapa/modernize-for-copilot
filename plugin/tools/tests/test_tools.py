"""Tests for the modernize-tools MCP server and the legacy/ guard. Standard library only."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
import guard  # noqa: E402


class McpClient:
    def __init__(self, entry="any"):
        self.proc = subprocess.Popen([sys.executable, os.path.join(TOOLS, "server.py"), "--entry", entry],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=PLUGIN)
        self.next_id = 0

    def call(self, method, params=None):
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def tool(self, name, **arguments):
        reply = self.call("tools/call", {"name": name, "arguments": arguments})
        result = reply["result"]
        return result["content"][0]["text"], result["isError"]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.ws, "legacy", "billing"))
        os.makedirs(os.path.join(self.ws, "analysis", "billing"))
        self.client = McpClient()
        self.client.call("initialize", {"protocolVersion": "2025-06-18"})
        self.client.proc.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')

    def tearDown(self):
        self.client.close()
        shutil.rmtree(self.ws, ignore_errors=True)

    def test_lists_every_tool(self):
        names = {t["name"] for t in self.client.call("tools/list")["result"]["tools"]}
        self.assertEqual(names, {"build_report", "make_shards", "render_rules", "compare", "trace_rules",
                                 "baseline_diff", "uplift_checks", "proof_pack", "render_topology", "doctor"})

    def test_workspace_must_be_absolute_folder(self):
        text, err = self.client.tool("build_report", workspace="relative/path", system="billing")
        self.assertTrue(err)
        self.assertIn("absolute", text)

    def test_system_name_is_validated(self):
        text, err = self.client.tool("build_report", workspace=self.ws, system="../etc")
        self.assertTrue(err)
        self.assertIn("folder name", text)

    def test_dotted_module_names_are_accepted_but_not_traversal(self):
        text, _ = self.client.tool("proof_pack", workspace=self.ws, system="billing", module="Contoso.Billing.Api")
        self.assertIn("proof_pack.py billing Contoso.Billing.Api", text)
        text, err = self.client.tool("proof_pack", workspace=self.ws, system="billing", module="..")
        self.assertTrue(err)
        text, err = self.client.tool("trace_rules", workspace=self.ws, system="billing", module="a..b")
        self.assertTrue(err)

    def test_paths_must_stay_in_workspace(self):
        text, err = self.client.tool("compare", workspace=self.ws, cases="../../outside.json")
        self.assertTrue(err)
        self.assertIn("outside the workspace", text)

    def test_runs_script_in_workspace(self):
        text, _ = self.client.tool("build_report", workspace=self.ws, system="billing")
        self.assertIn("build_report.py billing", text)
        self.assertIn(f"(run in {self.ws})", text)
        self.assertIn("exit code:", text)

    def test_render_topology_escapes_untrusted_names(self):
        topo = {"nodes": [{"id": "x</script><script>alert(1)</script>"}], "edges": []}
        with open(os.path.join(self.ws, "analysis", "billing", "topology.json"), "w") as fh:
            json.dump(topo, fh)
        text, err = self.client.tool("render_topology", workspace=self.ws, system="billing")
        self.assertFalse(err, text)
        with open(os.path.join(self.ws, "analysis", "billing", "TOPOLOGY.html"), encoding="utf-8") as fh:
            html = fh.read()
        self.assertNotIn("x</script><script>alert(1)", html)
        self.assertIn("\\u003c/script\\u003e", html)

    def test_render_topology_needs_topology_json(self):
        text, err = self.client.tool("render_topology", workspace=self.ws, system="billing")
        self.assertTrue(err)
        self.assertIn("topology.json", text)

    def test_doctor_reports_runtime_and_guard(self):
        text, err = self.client.tool("doctor", workspace=self.ws)
        info = json.loads(text)
        self.assertFalse(err, text)
        self.assertEqual(info["guard_self_test"], "pass")
        self.assertTrue(info["python_ok"])
        self.assertIn(os.path.join(self.ws, "legacy"), info["legacy_protected_roots"])

    def test_unknown_tool_is_an_error_not_a_crash(self):
        reply = self.client.call("tools/call", {"name": "nope", "arguments": {}})
        self.assertIn("error", reply)
        self.assertIn("result", self.client.call("ping"))


class ScriptPatchTest(unittest.TestCase):
    """convert/sync.py SCRIPT_PATCHES: fixes applied on top of the upstream scripts."""

    def render(self, skipped):
        ws = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(ws, "analysis", "billing"))
            rule = {"name": "Late fee is 5%", "category": "Calculation", "priority": "P0",
                    "source": "src/Fees.cs:10-12", "plainEnglish": "x", "given": "g", "when": "w", "then": "t",
                    "confidence": "High"}
            result = {"confirmedRules": [rule], "rejectedRules": [], "dataObjects": [],
                      "stats": {"skippedPhases": skipped}}
            with open(os.path.join(ws, "analysis", "billing", "rules_result.json"), "w") as fh:
                json.dump(result, fh)
            subprocess.run([sys.executable, os.path.join(PLUGIN, "scripts", "render_rules.py"), "billing",
                            "--workspace", ws], check=True, capture_output=True, cwd=ws)
            with open(os.path.join(ws, "analysis", "billing", "BUSINESS_RULES.md"), encoding="utf-8") as fh:
                return fh.read()
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_rules_header_claims_a_referee_only_when_one_ran(self):
        self.assertIn("checked by a second agent", self.render([]))
        text = self.render(["referee", "p0-panel"])
        self.assertNotIn("checked by a second agent", text)
        self.assertIn("No referee agent checked these citations", text)


class WorkingDirectoryTest(unittest.TestCase):
    def test_server_leaves_the_plugin_folder(self):
        """Windows cannot update or uninstall a plugin while a process's working directory is inside it."""
        if not os.path.isdir("/proc/self"):
            self.skipTest("needs /proc")
        c = McpClient()
        try:
            c.call("initialize", {"protocolVersion": "2025-06-18"})
            cwd = os.readlink(f"/proc/{c.proc.pid}/cwd")
            self.assertFalse(os.path.realpath(cwd).startswith(os.path.realpath(PLUGIN)), cwd)
        finally:
            c.close()


class StandDownTest(unittest.TestCase):
    def test_windows_entry_serves_nothing_off_windows(self):
        if os.name == "nt":
            self.skipTest("posix-only check")
        c = McpClient("windows")
        try:
            c.call("initialize")
            self.assertEqual(c.call("tools/list")["result"]["tools"], [])
        finally:
            c.close()


class GuardTest(unittest.TestCase):
    def test_self_test_table(self):
        self.assertEqual(guard.self_test(), [])

    def run_hook(self, event):
        proc = subprocess.run([sys.executable, os.path.join(TOOLS, "guard.py")], input=json.dumps(event).encode(),
                              capture_output=True, cwd=PLUGIN)
        self.assertEqual(proc.returncode, 0)
        return proc.stdout.decode().strip()

    def test_hook_protocol_deny_and_allow(self):
        ws = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(ws, "legacy", "billing"))
            out = self.run_hook({"cwd": ws, "toolName": "apply_patch",
                                 "toolArgs": {"input": "*** Begin Patch\n*** Update File: legacy/billing/A.cbl\n*** End Patch"}})
            decision = json.loads(out)
            self.assertEqual(decision["permissionDecision"], "deny")
            self.assertIn("legacy is read-only", decision["permissionDecisionReason"])
            self.assertEqual(self.run_hook({"cwd": ws, "toolName": "view", "toolArgs": {"path": "legacy/billing/A.cbl"}}), "")
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_no_legacy_folder_means_no_opinion(self):
        ws = tempfile.mkdtemp()
        try:
            self.assertEqual(self.run_hook({"cwd": ws, "toolName": "bash", "toolArgs": {"command": "rm -rf legacy"}}), "")
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_linked_source_is_protected_at_its_real_path(self):
        if not hasattr(os, "symlink"):
            self.skipTest("no symlinks")
        ws, src = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(ws, "legacy"))
            try:
                os.symlink(src, os.path.join(ws, "legacy", "billing"))
            except OSError:
                self.skipTest("symlinks not permitted")
            event = {"cwd": ws, "toolName": "edit", "toolArgs": {"path": os.path.join(src, "PAY.cbl")}}
            self.assertIsNotNone(guard.decide(event))
        finally:
            shutil.rmtree(ws, ignore_errors=True)
            shutil.rmtree(src, ignore_errors=True)

    def test_source_file_protects_external_code(self):
        ws, src = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(ws, "legacy"))
            os.makedirs(os.path.join(ws, "analysis", "billing"))
            with open(os.path.join(ws, "analysis", "billing", "SOURCE"), "w") as fh:
                fh.write(src + "\n")
            self.assertIsNotNone(guard.decide({"cwd": ws, "toolName": "bash", "toolArgs": {"command": f"rm {src}/x"}}))
        finally:
            shutil.rmtree(ws, ignore_errors=True)
            shutil.rmtree(src, ignore_errors=True)

    def test_malformed_input_touching_legacy_fails_closed(self):
        proc = subprocess.run([sys.executable, os.path.join(TOOLS, "guard.py")], input=b'{"cwd": "/x", legacy/billing broken',
                              capture_output=True, cwd=PLUGIN)
        self.assertIn("deny", proc.stdout.decode())

    def test_real_hook_command_denies_and_allows(self):
        """Run the exact hooks.json command for this OS, as Copilot would (cwd = plugin root)."""
        with open(os.path.join(PLUGIN, "com.github.copilot", "hooks", "hooks.json")) as fh:
            entry = json.load(fh)["hooks"]["preToolUse"][0]
        if os.name == "nt":
            argv = ["powershell", "-NoProfile", "-NonInteractive", "-Command", entry["powershell"]]
        else:
            argv = ["bash", "-c", entry["bash"]]
        ws = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(ws, "legacy", "billing"))
            env = dict(os.environ, PLUGIN_ROOT=PLUGIN)
            deny_event = {"cwd": ws, "toolName": "edit", "toolArgs": {"path": os.path.join("legacy", "billing", "A.cbl")}}
            allow_event = {"cwd": ws, "toolName": "edit", "toolArgs": {"path": os.path.join("modernized", "A.java")}}
            out = subprocess.run(argv, input=json.dumps(deny_event).encode(), capture_output=True, cwd=PLUGIN, env=env, timeout=60)
            self.assertIn('"permissionDecision": "deny"', out.stdout.decode(), out.stderr.decode())
            out = subprocess.run(argv, input=json.dumps(allow_event).encode(), capture_output=True, cwd=PLUGIN, env=env, timeout=60)
            self.assertEqual(out.stdout.decode().strip(), "", out.stderr.decode())
        finally:
            shutil.rmtree(ws, ignore_errors=True)

    def test_hooks_json_and_mcp_json_shape(self):
        with open(os.path.join(PLUGIN, "com.github.copilot", "hooks", "hooks.json")) as fh:
            hooks = json.load(fh)
        entry = hooks["hooks"]["preToolUse"][0]
        self.assertEqual(hooks["version"], 1)
        self.assertIn("tools/guard.py", entry["bash"])
        self.assertIn("tools\\guard.py", entry["powershell"])
        with open(os.path.join(PLUGIN, "mcp.json")) as fh:
            mcp = json.load(fh)
        for server in mcp["mcpServers"].values():
            self.assertEqual(server["type"], "stdio")
            self.assertIn("${PLUGIN_ROOT}/tools/server.py", server["args"])


if __name__ == "__main__":
    unittest.main()
