"""Tests for the parity checks behind /modernize:parity. Standard library only."""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOOLS)
import parity  # noqa: E402
import server  # noqa: E402

OPENAPI = {"openapi": "3.0.1", "paths": {"/api/invoices/{id}": {"get": {"parameters": [{"name": "id", "in": "path", "required": True}],
                                                                         "responses": {"200": {}, "404": {}}}},
                                          "/api/health": {"get": {"responses": {"200": {}}}}},
           "components": {"schemas": {"Invoice": {"properties": {"InvoiceId": {"type": "integer"}, "Total": {"type": "number"}}}}}}

WSDL = """<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="{tns}">
  <wsdl:types><xs:schema targetNamespace="{tns}">
    <xs:element name="GetTotal"><xs:complexType><xs:sequence><xs:element name="InvoiceId" type="xs:int"/>{extra}</xs:sequence></xs:complexType></xs:element>
  </xs:schema></wsdl:types>
  <wsdl:portType name="Billing"><wsdl:operation name="GetTotal"/>{op}</wsdl:portType>
</wsdl:definitions>"""


def make_handler(flavour):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, ctype, body):
            data = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            new = flavour == "candidate"
            if self.path == "/swagger.json":
                doc = json.loads(json.dumps(OPENAPI))
                if new:
                    del doc["paths"]["/api/health"]
                    doc["components"]["schemas"]["Invoice"]["properties"]["Currency"] = {"type": "string"}
                return self._send(200, "application/json", json.dumps(doc))
            if self.path == "/svc?singleWsdl":
                tns = "http://tempuri.org/new" if new else "http://tempuri.org/"
                return self._send(200, "text/xml", WSDL.format(tns=tns, extra="", op=""))
            if self.path == "/api/invoices/42":
                body = {"invoiceId": 42, "total": 10.5, "generatedAt": "2026-10-16T10:00:0%d" % (1 if new else 0)} if new else \
                       {"InvoiceId": 42, "Total": 10.5, "generatedAt": "2026-10-16T10:00:00"}
                return self._send(200, "application/json" if new else "application/json; charset=utf-8", json.dumps(body))
            if self.path == "/api/same":
                return self._send(200, "application/json", json.dumps({"a": 1, "b": [1, 2]}))
            if self.path == "/api/total":
                return self._send(200, "application/json", json.dumps({"total": 10.0 if new else 10}))
            if self.path == "/api/missing":
                return self._send(404, "text/plain", "not here")
            return self._send(500 if new else 404, "text/plain", "nope")

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            prefix = "b" if flavour == "candidate" else "s"
            body = (f'<{prefix}:Envelope xmlns:{prefix}="http://schemas.xmlsoap.org/soap/envelope/"><{prefix}:Body>'
                    f'<GetTotalResponse xmlns="http://tempuri.org/"><Total>10.50</Total></GetTotalResponse></{prefix}:Body></{prefix}:Envelope>')
            return self._send(200, "text/xml; charset=utf-8", body)
    return H


class Servers:
    def __enter__(self):
        self.servers = []
        for flavour in ("legacy", "candidate"):
            srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(flavour))
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.servers.append(srv)
        return tuple(f"http://127.0.0.1:{s.server_address[1]}" for s in self.servers)

    def __exit__(self, *a):
        for s in self.servers:
            s.shutdown()
            s.server_close()


class PathTests(unittest.TestCase):
    def test_paths_match_as_written(self):
        self.assertTrue(parity.path_matches(parity.parse_path("$..generatedAt"), ["data", 0, "generatedAt"]))
        self.assertTrue(parity.path_matches(parity.parse_path("$.items[*].price"), ["items", 3, "price"]))
        self.assertFalse(parity.path_matches(parity.parse_path("$.items[0].price"), ["items", 3, "price"]))
        self.assertTrue(parity.path_matches(parity.parse_path("$['odd key']"), ["odd key"]))
        with self.assertRaises(parity.ParityError):
            parity.parse_path("items.price")

    def test_scrub_replaces_only_matching_values(self):
        out = parity.scrub_json({"a": {"at": "x"}, "at": "y", "b": "id 1234"}, [parity.parse_path("$..at")],
                                [(__import__("re").compile(r"\d+"), "N")])
        self.assertEqual(out, {"a": {"at": parity.SCRUBBED}, "at": parity.SCRUBBED, "b": "id N"})


class DiffTests(unittest.TestCase):
    def test_property_casing_is_a_difference(self):
        d = parity.diff_json({"InvoiceId": 1}, {"invoiceId": 1}, semantic=True)
        self.assertEqual({x["where"] for x in d}, {"$.InvoiceId", "$.invoiceId"})

    def test_number_format_is_exact_only(self):
        self.assertTrue(parity.diff_json({"t": 10}, {"t": 10.0}, semantic=False))
        self.assertFalse(parity.diff_json({"t": 10}, {"t": 10.0}, semantic=True))

    def test_key_order_is_exact_only(self):
        self.assertTrue(parity.diff_json({"a": 1, "b": 2}, {"b": 2, "a": 1}, semantic=False))
        self.assertFalse(parity.diff_json({"a": 1, "b": 2}, {"b": 2, "a": 1}, semantic=True))

    def test_xml_prefixes_do_not_matter_but_text_does(self):
        import xml.etree.ElementTree as ET
        a = ET.fromstring('<s:E xmlns:s="urn:x"><s:T>1</s:T></s:E>')
        b = ET.fromstring('<b:E xmlns:b="urn:x"><b:T>1</b:T></b:E>')
        c = ET.fromstring('<b:E xmlns:b="urn:x"><b:T>2</b:T></b:E>')
        self.assertEqual(parity.diff_xml(a, b, set(), []), [])
        self.assertEqual([d["where"] for d in parity.diff_xml(a, c, set(), [])], ["/E/T/text()"])

    def test_overrides_set_the_match_level_per_path(self):
        m = {"match": "exact", "overrides": [{"path": "/api/admin/*", "match": "contract"}]}
        self.assertEqual(parity.match_for({"path": "/api/admin/users?x=1"}, m), "contract")
        self.assertEqual(parity.match_for({"path": "/api/orders"}, m), "exact")
        self.assertEqual(parity.match_for({"path": "/api/admin/x", "match": "semantic"}, m), "semantic")


class HarTests(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, True)

    def test_har_import_drops_credentials_static_files_and_duplicates(self):
        parity.init(self.ws, "billing", "http://localhost:1", "http://localhost:2")
        entry = lambda url, method="GET", body=None: {"request": {"method": method, "url": url, "headers": [
            {"name": "Cookie", "value": "session=secret"}, {"name": "Authorization", "value": "Bearer secret"},
            {"name": "Accept", "value": "application/json"}, {"name": ":authority", "value": "x"}],
            **({"postData": {"text": body}} if body else {})}}
        har = {"log": {"entries": [entry("http://legacy/api/invoices/42"), entry("http://legacy/api/invoices/42"),
                                   entry("http://legacy/site.css"), entry("http://legacy/api/pay", "POST", "{}")]}}
        with open(os.path.join(self.ws, "week.har"), "w", encoding="utf-8") as fh:
            json.dump(har, fh)
        out = parity.import_har(self.ws, "billing", ["week.har"])
        self.assertEqual((out["added"], out["skipped"]), (2, 2))
        self.assertIn("cookie", out["dropped_headers"])
        with open(os.path.join(self.ws, "analysis/billing/parity/cases.json"), encoding="utf-8") as fh:
            cases = json.load(fh)
        text = json.dumps(cases)
        self.assertNotIn("secret", text)
        self.assertEqual([c["id"] for c in cases], ["CASE-001", "CASE-002"])
        self.assertEqual(cases[0]["headers"], {"Accept": "application/json"})


class RunTests(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.dir = os.path.join(self.ws, "analysis", "billing", "parity")

    def write(self, name, data):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def manifest(self):
        with open(os.path.join(self.dir, "config.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def test_end_to_end(self):
        with Servers() as (legacy, candidate):
            parity.init(self.ws, "billing", legacy, candidate)
            m = self.manifest()
            m["contracts"] = [{"name": "openapi", "kind": "openapi", "path": "/swagger.json"},
                              {"name": "billing-wsdl", "kind": "wsdl", "path": "/svc?singleWsdl"}]
            self.write("config.json", m)
            self.write("cases.json", [
                {"id": "CASE-001", "method": "GET", "path": "/api/same"},
                {"id": "CASE-002", "method": "GET", "path": "/api/invoices/42"},
                {"id": "CASE-003", "method": "POST", "path": "/svc", "body": "<x/>", "headers": {"SOAPAction": "GetTotal"}},
                {"id": "CASE-004", "method": "POST", "path": "/svc", "body": "<x/>", "safe": True},
                {"id": "CASE-005", "method": "GET", "path": "/api/missing"},
                {"id": "CASE-006", "method": "GET", "path": "/api/total"},
            ])
            r = parity.run(self.ws, "billing")
        self.assertEqual(r["verdict"], "NO PARITY")
        by = {c["id"]: c for c in r["cases"]}
        self.assertEqual(by["CASE-001"]["result"], "MATCH")
        self.assertEqual(by["CASE-002"]["result"], "DIFFERENT")
        self.assertIn("$.InvoiceId", {d["where"] for d in by["CASE-002"]["differences"]})
        self.assertEqual(by["CASE-003"]["result"], "SKIPPED")          # POST is not replayed by default
        self.assertEqual(by["CASE-004"]["result"], "MATCH")            # marked safe; SOAP prefixes differ only
        self.assertEqual(by["CASE-005"]["result"], "MATCH")            # a 404 on both sides matches
        self.assertEqual(by["CASE-006"]["result"], "DIFFERENT")        # 10 vs 10.0 at the exact level
        contracts = {c["name"]: c for c in r["contracts"]}
        self.assertEqual(contracts["openapi"]["result"], "BREAKING")
        self.assertTrue(any("operation removed: GET /api/health" in f["what"] for f in contracts["openapi"]["findings"]))
        self.assertEqual(contracts["billing-wsdl"]["result"], "BREAKING")  # target namespace changed
        with open(os.path.join(self.dir, "PARITY.md"), encoding="utf-8") as fh:
            report = fh.read()
        names = [n.lower() for n in os.listdir(self.dir)]   # Windows and macOS ignore case
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(parity.load_manifest(self.ws, "billing")["legacy"]["base_url"], legacy)
        self.assertIn("**Verdict: NO PARITY**", report)
        self.assertIn("## Sign-off", report)

    def test_deltas_scrubs_and_levels_reach_parity(self):
        with Servers() as (legacy, candidate):
            parity.init(self.ws, "billing", legacy, candidate)
            m = self.manifest()
            m["overrides"] = [{"path": "/api/total", "match": "semantic"}]
            m["scrub"]["json_paths"] = ["$..generatedAt"]
            self.write("config.json", m)
            self.write("cases.json", [{"id": "CASE-001", "method": "GET", "path": "/api/invoices/42"},
                                      {"id": "CASE-002", "method": "GET", "path": "/api/total"}])
            self.write("deltas.json", [
                {"id": "DELTA-001", "case": "CASE-001", "where": "$.*", "reason": "camelCase", "approved_by": "Test Person"},
                {"id": "DELTA-002", "case": "*", "where": "header:content-type", "reason": "charset added", "approved_by": "Test Person"},
                {"id": "DELTA-003", "case": "*", "where": "$.gone", "reason": "stale", "approved_by": "Test Person"}])
            r = parity.run(self.ws, "billing")
        self.assertEqual(r["verdict"], "PARITY", json.dumps(r["cases"], indent=1))
        self.assertEqual(r["cases"][0]["result"], "EXPECTED")
        self.assertEqual(r["cases"][1]["result"], "MATCH")
        self.assertEqual(r["unused_deltas"], ["DELTA-003"])

    def test_unsafe_needs_both_switches_and_cases_never_carry_a_host(self):
        with Servers() as (legacy, candidate):
            parity.init(self.ws, "billing", legacy, candidate)
            self.write("cases.json", [{"id": "CASE-001", "method": "POST", "path": "/svc", "body": "<x/>"}])
            self.assertEqual(parity.run(self.ws, "billing", allow_unsafe=True)["cases"][0]["result"], "SKIPPED")
            m = self.manifest()
            m["allow_unsafe_methods"] = True
            self.write("config.json", m)
            self.assertEqual(parity.run(self.ws, "billing")["cases"][0]["result"], "SKIPPED")
            self.assertEqual(parity.run(self.ws, "billing", allow_unsafe=True)["cases"][0]["result"], "MATCH")
            self.write("cases.json", [{"id": "CASE-001", "method": "GET", "path": "//evil.example/x"}])
            with self.assertRaises(parity.ParityError):
                parity.run(self.ws, "billing")

    def test_noise_is_suggested_not_scrubbed(self):
        with Servers() as (legacy, candidate):
            parity.init(self.ws, "billing", legacy, candidate)
            m = self.manifest()
            m["match"] = "semantic"
            self.write("config.json", m)
            self.write("cases.json", [{"id": "CASE-001", "method": "GET", "path": "/api/invoices/42"}])
            self.write("deltas.json", [{"id": "DELTA-001", "case": "*", "where": "$.InvoiceId"}, {"id": "DELTA-002", "case": "*", "where": "$.invoiceId"},
                                       {"id": "DELTA-003", "case": "*", "where": "$.Total"}, {"id": "DELTA-004", "case": "*", "where": "$.total"}])
            r = parity.run(self.ws, "billing")
        self.assertEqual(r["verdict"], "NO PARITY")
        self.assertEqual([s["where"] for s in r["suggested_scrubs"]], ["$.generatedAt"])

    def test_secrets_from_env_are_sent_but_never_stored(self):
        seen = {}

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                seen[self.server.server_address[1]] = self.headers.get("Authorization")
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")
        srvs = [ThreadingHTTPServer(("127.0.0.1", 0), H) for _ in range(2)]
        for s in srvs:
            threading.Thread(target=s.serve_forever, daemon=True).start()
        try:
            parity.init(self.ws, "billing", *(f"http://127.0.0.1:{s.server_address[1]}" for s in srvs))
            m = self.manifest()
            m["headers_from_env"] = {"Authorization": "PARITY_TEST_TOKEN"}
            self.write("config.json", m)
            self.write("cases.json", [{"id": "CASE-001", "method": "GET", "path": "/"}])
            os.environ["PARITY_TEST_TOKEN"] = "Bearer s3cr3t"
            try:
                parity.run(self.ws, "billing")
            finally:
                del os.environ["PARITY_TEST_TOKEN"]
        finally:
            for s in srvs:
                s.shutdown()
                s.server_close()
        self.assertEqual(set(seen.values()), {"Bearer s3cr3t"})
        for root, _, files in os.walk(self.dir):
            for f in files:
                with open(os.path.join(root, f), encoding="utf-8") as fh:
                    self.assertNotIn("s3cr3t", fh.read(), f)

    def test_server_tools_report_argument_errors(self):
        out = server.TOOLS["parity_init"][0]({"workspace": self.ws, "system": "billing", "legacy_url": "http://a", "candidate_url": "http://b"})
        self.assertFalse(out["isError"])
        with self.assertRaises(server.ToolError):
            server.TOOLS["parity_init"][0]({"workspace": self.ws, "system": "billing", "legacy_url": "ftp://a", "candidate_url": "http://b"})
        with self.assertRaises(server.ToolError):
            server.TOOLS["parity_capture"][0]({"workspace": self.ws, "system": "billing", "har": ["../outside.har"]})


if __name__ == "__main__":
    unittest.main()
