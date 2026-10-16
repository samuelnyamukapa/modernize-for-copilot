"""Parity checks for /modernize:parity: does the new system answer like the legacy one?

Standard library only. The modernize-tools server imports this module; the tests import it
directly. Everything lives under analysis/<system>/parity/:

  config.json    the settings: both base URLs, contracts, scrub and compare rules
                 (not parity.json: on Windows that is the same file as PARITY.json)
  cases.json     the requests to replay (imported from HAR files or written by hand)
  deltas.json    approved differences: the diff expects them and reports them as such
  results/       one file per case and side, plus the fetched contracts
  PARITY.json    the machine-readable result;  PARITY.md  the report a person signs

Requests only ever go to the two base URLs in the manifest. A case holds a path, never a
host. Methods that change data run only when the manifest allows them, because replaying a
POST against a real system is not a test. Header values named in `headers_from_env` are read
from the environment at run time and never written to disk.
"""
from __future__ import annotations

import datetime
import fnmatch
import gzip
import hashlib
import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
MATCH_LEVELS = ("exact", "semantic", "contract")
STATIC_EXT = (".js", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2",
              ".ttf", ".eot", ".webp", ".mp4", ".webm")
DROP_HEADERS = {"cookie", "authorization", "proxy-authorization", "host", "content-length", "connection",
                "accept-encoding", "origin", "referer", "user-agent", "sec-fetch-site", "sec-fetch-mode",
                "sec-fetch-dest", "sec-fetch-user", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
                "upgrade-insecure-requests", "x-xsrf-token", "x-csrf-token", "requestverificationtoken",
                "if-none-match", "if-modified-since", "cache-control", "pragma", "priority"}
MAX_BODY = 5 * 1024 * 1024
SCRUBBED = "<scrubbed>"


class ParityError(Exception):
    """A problem with the manifest, the cases or an argument: reported to the caller."""


def today() -> str:
    return datetime.date.today().isoformat()


# --------------------------------------------------------------------------- files

def parity_dir(ws: str, system: str) -> str:
    return os.path.join(ws, "analysis", system, "parity")


def _read_json(path: str, default=None):
    if not os.path.isfile(path):
        if default is not None:
            return default
        raise ParityError(f"{path} does not exist.")
    with open(path, encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError as exc:
            raise ParityError(f"{os.path.basename(path)} is not valid JSON: {exc}") from None


def _write_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def _check_base_url(url, key: str) -> str:
    if not isinstance(url, str) or not re.match(r"^https?://[^/\s]+", url):
        raise ParityError(f"`{key}` must be an http:// or https:// base URL, got {url!r}.")
    return url.rstrip("/")


def default_manifest(system: str, legacy_url: str, candidate_url: str) -> dict:
    return {
        "system": system,
        "legacy": {"base_url": legacy_url},
        "candidate": {"base_url": candidate_url},
        "contracts": [],
        "match": "exact",
        "overrides": [],
        "scrub": {"json_paths": [], "xml_ignore": [], "regex": []},
        "compare_headers": ["content-type"],
        "allow_unsafe_methods": False,
        "headers_from_env": {},
        "timeout_s": 30,
        "insecure_tls": False,
    }


def init(ws: str, system: str, legacy_url: str, candidate_url: str) -> dict:
    """Write the manifest, an empty case list and an empty delta ledger, keeping any that exist."""
    legacy_url = _check_base_url(legacy_url, "legacy_url")
    candidate_url = _check_base_url(candidate_url, "candidate_url")
    if legacy_url == candidate_url:
        raise ParityError("The legacy and candidate base URLs are the same; parity needs two systems.")
    d = parity_dir(ws, system)
    os.makedirs(d, exist_ok=True)
    written, kept = [], []
    manifest_path = os.path.join(d, "config.json")
    if os.path.isfile(manifest_path):
        manifest = _read_json(manifest_path)
        manifest.setdefault("legacy", {})["base_url"] = legacy_url
        manifest.setdefault("candidate", {})["base_url"] = candidate_url
        _write_json(manifest_path, manifest)
        kept.append("config.json (base URLs updated)")
    else:
        _write_json(manifest_path, default_manifest(system, legacy_url, candidate_url))
        written.append("config.json")
    for name, empty in (("cases.json", []), ("deltas.json", [])):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            kept.append(name)
        else:
            _write_json(p, empty)
            written.append(name)
    return {"folder": os.path.relpath(d, ws), "written": written, "kept": kept}


def load_manifest(ws: str, system: str) -> dict:
    m = _read_json(os.path.join(parity_dir(ws, system), "config.json"))
    if not isinstance(m, dict):
        raise ParityError("config.json must hold a JSON object.")
    m["legacy"] = {**m.get("legacy", {}), "base_url": _check_base_url((m.get("legacy") or {}).get("base_url"), "legacy.base_url")}
    m["candidate"] = {**m.get("candidate", {}), "base_url": _check_base_url((m.get("candidate") or {}).get("base_url"), "candidate.base_url")}
    if m.get("match", "exact") not in MATCH_LEVELS:
        raise ParityError(f"`match` must be one of {', '.join(MATCH_LEVELS)}.")
    for o in m.get("overrides") or []:
        if not isinstance(o, dict) or not isinstance(o.get("path"), str):
            raise ParityError("Each override needs a `path` glob, such as \"/api/admin/*\".")
        if o.get("match", "exact") not in MATCH_LEVELS:
            raise ParityError(f"Override {o.get('path')!r}: `match` must be one of {', '.join(MATCH_LEVELS)}.")
    return m


# --------------------------------------------------------------------------- HAR import

def _case_key(c: dict) -> str:
    return hashlib.sha256(json.dumps([c["method"], c["path"], c.get("body") or ""], ensure_ascii=False).encode("utf-8")).hexdigest()


def import_har(ws: str, system: str, har_paths: list[str], include: str | None = None, exclude: str | None = None) -> dict:
    """Add one case per distinct request in the HAR files, dropping credentials and static files."""
    d = parity_dir(ws, system)
    cases_path = os.path.join(d, "cases.json")
    cases = _read_json(cases_path, default=[])
    if not isinstance(cases, list):
        raise ParityError("cases.json must hold a JSON list.")
    seen = {_case_key(c) for c in cases if isinstance(c, dict) and "method" in c and "path" in c}
    inc = re.compile(include) if include else None
    exc = re.compile(exclude) if exclude else None
    next_n = 1 + max([int(m.group(1)) for c in cases if isinstance(c, dict)
                      for m in [re.match(r"CASE-(\d+)$", str(c.get("id", "")))] if m] or [0])
    added = skipped = 0
    dropped_headers: set[str] = set()
    for rel in har_paths:
        har = _read_json(os.path.join(ws, rel))
        entries = ((har or {}).get("log") or {}).get("entries") or []
        for e in entries:
            req = e.get("request") or {}
            url = req.get("url") or ""
            parts = urllib.parse.urlsplit(url)
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            method = (req.get("method") or "GET").upper()
            if path.lower().split("?")[0].endswith(STATIC_EXT) or (inc and not inc.search(url)) or (exc and exc.search(url)):
                skipped += 1
                continue
            headers = {}
            for h in req.get("headers") or []:
                name = str(h.get("name", ""))
                if not name or name.startswith(":"):
                    continue
                if name.lower() in DROP_HEADERS:
                    dropped_headers.add(name.lower())
                    continue
                headers[name] = str(h.get("value", ""))
            body = (req.get("postData") or {}).get("text")
            case = {"id": f"CASE-{next_n:03d}", "name": f"{method} {path}"[:120], "method": method, "path": path,
                    "headers": headers, "body": body if body else None, "source": f"har:{rel}"}
            key = _case_key(case)
            if key in seen:
                skipped += 1
                continue
            seen.add(key)
            cases.append(case)
            next_n += 1
            added += 1
    _write_json(cases_path, cases)
    return {"cases_file": os.path.relpath(cases_path, ws), "added": added, "skipped": skipped, "total": len(cases),
            "dropped_headers": sorted(dropped_headers)}


# --------------------------------------------------------------------------- HTTP

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # compare redirects as they are, never follow them
        return None


def _opener(manifest: dict):
    handlers = [_NoRedirect()]
    if not manifest.get("use_proxy"):
        handlers.append(urllib.request.ProxyHandler({}))
    if manifest.get("insecure_tls"):
        handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))  # test systems only
    return urllib.request.build_opener(*handlers)


def _env_headers(manifest: dict) -> dict:
    out = {}
    for header, var in (manifest.get("headers_from_env") or {}).items():
        value = os.environ.get(str(var))
        if value is None:
            raise ParityError(f"headers_from_env: the environment variable {var!r} for header {header!r} is not set.")
        out[str(header)] = value
    return out


def send(opener, base_url: str, case: dict, extra_headers: dict, timeout: float) -> dict:
    path = case.get("path", "")
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
        raise ParityError(f"{case.get('id')}: `path` must start with a single '/' (a path, never a host).")
    body = case.get("body")
    data = body.encode("utf-8") if isinstance(body, str) else None
    headers = {**{str(k): str(v) for k, v in (case.get("headers") or {}).items()}, **extra_headers,
               "Accept-Encoding": "identity"}
    req = urllib.request.Request(base_url + path, data=data, method=case.get("method", "GET").upper(), headers=headers)
    try:
        resp = opener.open(req, timeout=timeout)
        status, rheaders, raw = resp.status, dict(resp.headers.items()), resp.read(MAX_BODY + 1)
    except urllib.error.HTTPError as exc:  # 4xx, 5xx and unfollowed redirects are answers too
        status, rheaders, raw = exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read(MAX_BODY + 1)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"error": f"{type(exc).__name__}: {getattr(exc, 'reason', exc)}"}
    lower = {k.lower(): v for k, v in rheaders.items()}
    if lower.get("content-encoding", "").lower() == "gzip":
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    truncated = len(raw) > MAX_BODY
    raw = raw[:MAX_BODY]
    return {"status": status, "headers": lower, "body": raw.decode("utf-8", "replace"),
            "sha256": hashlib.sha256(raw).hexdigest(), "truncated": truncated}


# --------------------------------------------------------------------------- JSON paths and scrubbing

_TOKEN = re.compile(r"\.\.(?P<desc>[^.\[\]]+)|\.(?P<key>[^.\[\]]+)|\[(?P<idx>\*|\d+)\]|\['(?P<qkey>[^']*)'\]")


def parse_path(expr: str) -> list[tuple]:
    """`$.a.b`, `$..id`, `$.items[*].price`, `$.items[0]`, `$['odd key']` → tokens."""
    if not isinstance(expr, str) or not expr.startswith("$"):
        raise ParityError(f"JSON path {expr!r} must start with '$'.")
    tokens, pos, rest = [], 1, expr
    while pos < len(rest):
        m = _TOKEN.match(rest, pos)
        if not m:
            raise ParityError(f"Cannot read JSON path {expr!r} at {rest[pos:]!r}.")
        if m.group("desc") is not None:
            tokens.append(("desc", m.group("desc")))
        elif m.group("key") is not None:
            tokens.append(("key", "*" if m.group("key") == "*" else m.group("key")))
        elif m.group("qkey") is not None:
            tokens.append(("key", m.group("qkey")))
        else:
            tokens.append(("idx", m.group("idx")))
        pos = m.end()
    return tokens


def path_matches(pattern: list[tuple], concrete: list) -> bool:
    if not pattern:
        return not concrete
    kind, val = pattern[0]
    if kind == "desc":
        return any(isinstance(concrete[i], str) and (val == "*" or concrete[i] == val) and path_matches(pattern[1:], concrete[i + 1:])
                   for i in range(len(concrete)))
    if not concrete:
        return False
    head = concrete[0]
    if kind == "key" and isinstance(head, str) and (val == "*" or head == val):
        return path_matches(pattern[1:], concrete[1:])
    if kind == "idx" and isinstance(head, int) and (val == "*" or int(val) == head):
        return path_matches(pattern[1:], concrete[1:])
    return False


def render_path(concrete: list) -> str:
    out = "$"
    for t in concrete:
        if isinstance(t, int):
            out += f"[{t}]"
        elif re.match(r"^[A-Za-z_][A-Za-z0-9_\-]*$", t):
            out += "." + t
        else:
            out += f"['{t}']"
    return out


def _regex_scrubs(manifest: dict) -> list[tuple]:
    out = []
    for r in (manifest.get("scrub") or {}).get("regex") or []:
        try:
            out.append((re.compile(r["pattern"]), r.get("replace", SCRUBBED)))
        except (KeyError, TypeError, re.error) as exc:
            raise ParityError(f"scrub.regex entry {r!r} is not usable: {exc}") from None
    return out


def _scrub_text(text: str, regexes) -> str:
    for rx, rep in regexes:
        text = rx.sub(rep, text)
    return text


def scrub_json(value, patterns: list[list[tuple]], regexes, here=None):
    here = here or []
    if any(path_matches(p, here) for p in patterns) and here:
        return SCRUBBED
    if isinstance(value, dict):
        return {k: scrub_json(v, patterns, regexes, here + [k]) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_json(v, patterns, regexes, here + [i]) for i, v in enumerate(value)]
    if isinstance(value, str):
        return _scrub_text(value, regexes)
    return value


# --------------------------------------------------------------------------- diffing

def _short(v, limit=80) -> str:
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit - 1] + "…"


def diff_json(a, b, semantic: bool, here=None, out=None) -> list[dict]:
    here = here if here is not None else []
    out = out if out is not None else []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k not in b:
                out.append({"where": render_path(here + [k]), "legacy": _short(a[k]), "candidate": "(missing)"})
        for k in b:
            if k not in a:
                out.append({"where": render_path(here + [k]), "legacy": "(missing)", "candidate": _short(b[k])})
        for k in a:
            if k in b:
                diff_json(a[k], b[k], semantic, here + [k], out)
        if not semantic and list(a) != list(b) and set(a) == set(b):
            out.append({"where": render_path(here), "legacy": "key order " + ",".join(a)[:60],
                        "candidate": "key order " + ",".join(b)[:60]})
        return out
    if isinstance(a, list) and isinstance(b, list):
        for i in range(max(len(a), len(b))):
            if i >= len(a):
                out.append({"where": render_path(here + [i]), "legacy": "(missing)", "candidate": _short(b[i])})
            elif i >= len(b):
                out.append({"where": render_path(here + [i]), "legacy": _short(a[i]), "candidate": "(missing)"})
            else:
                diff_json(a[i], b[i], semantic, here + [i], out)
        return out
    same_type = type(a) is type(b) or (semantic and isinstance(a, (int, float)) and isinstance(b, (int, float))
                                       and not isinstance(a, bool) and not isinstance(b, bool))
    if not same_type or a != b:
        out.append({"where": render_path(here), "legacy": _short(a), "candidate": _short(b)})
    return out


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def diff_xml(a: ET.Element, b: ET.Element, ignore: set, regexes, here: str = "", out=None) -> list[dict]:
    out = out if out is not None else []
    path = f"{here}/{_local(a.tag)}"
    if a.tag != b.tag:
        out.append({"where": path, "legacy": a.tag, "candidate": b.tag})
        return out
    if _local(a.tag) in ignore:
        return out
    if a.attrib != b.attrib:
        for k in sorted(set(a.attrib) | set(b.attrib)):
            va = _scrub_text(a.attrib[k], regexes) if k in a.attrib else "(missing)"
            vb = _scrub_text(b.attrib[k], regexes) if k in b.attrib else "(missing)"
            if va != vb:
                out.append({"where": f"{path}/@{_local(k)}", "legacy": va, "candidate": vb})
    ta = _scrub_text((a.text or "").strip(), regexes)
    tb = _scrub_text((b.text or "").strip(), regexes)
    if ta != tb:
        out.append({"where": f"{path}/text()", "legacy": _short(ta), "candidate": _short(tb)})
    ca, cb = list(a), list(b)
    for i in range(max(len(ca), len(cb))):
        if i >= len(ca):
            out.append({"where": f"{path}/{_local(cb[i].tag)}[{i + 1}]", "legacy": "(missing)", "candidate": "(element)"})
        elif i >= len(cb):
            out.append({"where": f"{path}/{_local(ca[i].tag)}[{i + 1}]", "legacy": "(element)", "candidate": "(missing)"})
        else:
            diff_xml(ca[i], cb[i], ignore, regexes, path, out)
    return out


def body_kind(content_type: str, body: str) -> str:
    ct = (content_type or "").lower()
    stripped = body.lstrip()
    if "json" in ct or (not ct and stripped[:1] in "{["):
        return "json"
    if "xml" in ct or "soap" in ct or (not ct and stripped.startswith("<?xml")):
        return "xml"
    return "text"


def _media_type(value: str) -> str:
    return (value or "").split(";")[0].strip().lower()


def compare(case: dict, legacy: dict, candidate: dict, manifest: dict, match: str) -> list[dict]:
    """Every difference between the two answers to one case, after scrubbing."""
    if "error" in legacy or "error" in candidate:
        return []
    diffs = []
    if legacy["status"] != candidate["status"]:
        diffs.append({"where": "status", "legacy": str(legacy["status"]), "candidate": str(candidate["status"])})
    if match == "contract":
        return diffs
    exact = match == "exact"
    for h in manifest.get("compare_headers") or []:
        h = str(h).lower()
        va, vb = legacy["headers"].get(h), candidate["headers"].get(h)
        if h == "content-type" and not exact:
            va, vb = _media_type(va or ""), _media_type(vb or "")
        if (va or "") != (vb or ""):
            diffs.append({"where": f"header:{h}", "legacy": va or "(missing)", "candidate": vb or "(missing)"})
    scrub = manifest.get("scrub") or {}
    regexes = _regex_scrubs(manifest)
    kind = body_kind(legacy["headers"].get("content-type", ""), legacy["body"])
    if kind == "json":
        try:
            ja, jb = json.loads(legacy["body"]), json.loads(candidate["body"])
        except json.JSONDecodeError:
            kind = "text"
        else:
            patterns = [parse_path(p) for p in scrub.get("json_paths") or []]
            ja, jb = scrub_json(ja, patterns, regexes), scrub_json(jb, patterns, regexes)
            diffs += diff_json(ja, jb, semantic=not exact)
            return diffs
    if kind == "xml":
        try:
            xa, xb = ET.fromstring(legacy["body"].encode("utf-8")), ET.fromstring(candidate["body"].encode("utf-8"))
        except ET.ParseError:
            kind = "text"
        else:
            diffs += diff_xml(xa, xb, set(scrub.get("xml_ignore") or []), regexes)
            return diffs
    ta, tb = _scrub_text(legacy["body"], regexes), _scrub_text(candidate["body"], regexes)
    if not exact:
        ta, tb = "\n".join(l.rstrip() for l in ta.strip().splitlines()), "\n".join(l.rstrip() for l in tb.strip().splitlines())
    if ta != tb:
        la, lb = ta.splitlines(), tb.splitlines()
        n = next((i for i in range(min(len(la), len(lb))) if la[i] != lb[i]), min(len(la), len(lb)))
        diffs.append({"where": f"body line {n + 1}", "legacy": _short(la[n] if n < len(la) else "(end)"),
                      "candidate": _short(lb[n] if n < len(lb) else "(end)")})
    return diffs


def match_for(case: dict, manifest: dict) -> str:
    level = case.get("match") or manifest.get("match", "exact")
    path = (case.get("path") or "").split("?")[0]
    for o in manifest.get("overrides") or []:
        if fnmatch.fnmatchcase(path, o["path"]):
            level = case.get("match") or o.get("match", level)
    if level not in MATCH_LEVELS:
        raise ParityError(f"{case.get('id')}: `match` must be one of {', '.join(MATCH_LEVELS)}.")
    return level


def _delta_covers(delta: dict, case_id: str, where: str) -> bool:
    if delta.get("case", "*") not in ("*", case_id):
        return False
    pattern = str(delta.get("where", ""))
    if pattern.startswith("$"):
        try:
            return where.startswith("$") and path_matches(parse_path(pattern), _concrete(where))
        except ParityError:
            return False
    return fnmatch.fnmatchcase(where, pattern)


def _concrete(where: str) -> list:
    out = []
    for kind, val in parse_path(where):
        out.append(int(val) if kind == "idx" else val)
    return out


# --------------------------------------------------------------------------- contracts

def _fetch_contract(opener, manifest: dict, side: str, c: dict, extra: dict, timeout: float) -> dict:
    case = {"id": c.get("name"), "method": "GET", "path": c.get("path"), "headers": {}}
    return send(opener, manifest[side]["base_url"], case, extra, timeout)


def _resolve_schema_props(doc: dict) -> dict:
    schemas = (doc.get("components") or {}).get("schemas") or doc.get("definitions") or {}
    out = {}
    for name, s in schemas.items():
        if isinstance(s, dict):
            props = s.get("properties") or {}
            out[name] = {"props": {p: (v.get("type") or v.get("$ref") or "") if isinstance(v, dict) else "" for p, v in props.items()},
                         "required": set(s.get("required") or [])}
    return out


def diff_openapi(a: dict, b: dict) -> list[dict]:
    findings = []
    methods = ("get", "put", "post", "delete", "patch", "head", "options")
    ops_a = {(p, m): op for p, item in (a.get("paths") or {}).items() if isinstance(item, dict) for m, op in item.items() if m in methods}
    ops_b = {(p, m): op for p, item in (b.get("paths") or {}).items() if isinstance(item, dict) for m, op in item.items() if m in methods}
    for key in sorted(ops_a.keys() - ops_b.keys()):
        findings.append({"breaking": True, "what": f"operation removed: {key[1].upper()} {key[0]}"})
    for key in sorted(ops_b.keys() - ops_a.keys()):
        findings.append({"breaking": False, "what": f"operation added: {key[1].upper()} {key[0]}"})
    for key in sorted(ops_a.keys() & ops_b.keys()):
        oa, ob = ops_a[key] or {}, ops_b[key] or {}
        label = f"{key[1].upper()} {key[0]}"
        pa = {(p.get("name"), p.get("in")): p for p in oa.get("parameters") or [] if isinstance(p, dict)}
        pb = {(p.get("name"), p.get("in")): p for p in ob.get("parameters") or [] if isinstance(p, dict)}
        for k in sorted(pb.keys() - pa.keys(), key=str):
            if pb[k].get("required"):
                findings.append({"breaking": True, "what": f"{label}: new required parameter {k[0]} ({k[1]})"})
        for k in sorted(pa.keys() - pb.keys(), key=str):
            findings.append({"breaking": True, "what": f"{label}: parameter removed {k[0]} ({k[1]})"})
        for code in sorted(set((oa.get("responses") or {})) - set((ob.get("responses") or {}))):
            findings.append({"breaking": True, "what": f"{label}: response {code} removed"})
    sa, sb = _resolve_schema_props(a), _resolve_schema_props(b)
    for name in sorted(sa.keys() - sb.keys()):
        findings.append({"breaking": True, "what": f"schema removed: {name}"})
    for name in sorted(sa.keys() & sb.keys()):
        for prop in sorted(sa[name]["props"].keys() - sb[name]["props"].keys()):
            findings.append({"breaking": True, "what": f"schema {name}: property removed {prop}"})
        for prop in sorted(sa[name]["props"].keys() & sb[name]["props"].keys()):
            if sa[name]["props"][prop] != sb[name]["props"][prop]:
                findings.append({"breaking": True, "what": f"schema {name}: property {prop} type {sa[name]['props'][prop] or '?'} → {sb[name]['props'][prop] or '?'}"})
        for prop in sorted(sb[name]["required"] - sa[name]["required"]):
            findings.append({"breaking": True, "what": f"schema {name}: {prop} is now required"})
        for prop in sorted(sb[name]["props"].keys() - sa[name]["props"].keys()):
            findings.append({"breaking": False, "what": f"schema {name}: property added {prop}"})
    return findings


def _wsdl_summary(root: ET.Element) -> dict:
    ops, elements = set(), {}
    for el in root.iter():
        name = _local(el.tag)
        if name == "operation" and el.get("name"):
            ops.add(el.get("name"))
        if name in ("element", "complexType") and el.get("name"):
            owner = _local(el.tag) + ":" + el.get("name")
            children = {}
            for child in el.iter():
                if child is not el and _local(child.tag) == "element" and child.get("name"):
                    children[child.get("name")] = (child.get("type") or "", child.get("minOccurs", "1"))
            elements.setdefault(owner, children)
    tns = {_local(el.tag) + ":" + (el.get("targetNamespace") or "") for el in root.iter() if el.get("targetNamespace")}
    return {"ops": ops, "elements": elements, "tns": tns}


def diff_wsdl(a: ET.Element, b: ET.Element) -> list[dict]:
    sa, sb = _wsdl_summary(a), _wsdl_summary(b)
    findings = []
    for t in sorted(sa["tns"] - sb["tns"]):
        findings.append({"breaking": True, "what": f"target namespace no longer offered: {t.split(':', 1)[1]} ({t.split(':', 1)[0]})"})
    for op in sorted(sa["ops"] - sb["ops"]):
        findings.append({"breaking": True, "what": f"operation removed: {op}"})
    for op in sorted(sb["ops"] - sa["ops"]):
        findings.append({"breaking": False, "what": f"operation added: {op}"})
    for owner in sorted(sa["elements"].keys() - sb["elements"].keys()):
        findings.append({"breaking": True, "what": f"{owner.replace(':', ' ')} removed"})
    for owner in sorted(sa["elements"].keys() & sb["elements"].keys()):
        ca, cb = sa["elements"][owner], sb["elements"][owner]
        for child in sorted(ca.keys() - cb.keys()):
            findings.append({"breaking": True, "what": f"{owner.replace(':', ' ')}: element {child} removed"})
        for child in sorted(ca.keys() & cb.keys()):
            if ca[child][0].rsplit(":", 1)[-1] != cb[child][0].rsplit(":", 1)[-1]:
                findings.append({"breaking": True, "what": f"{owner.replace(':', ' ')}: element {child} type {ca[child][0]} → {cb[child][0]}"})
        for child in sorted(cb.keys() - ca.keys()):
            required = cb[child][1] != "0"
            findings.append({"breaking": required, "what": f"{owner.replace(':', ' ')}: element {child} added{' (required)' if required else ''}"})
    return findings


def check_contract(c: dict, legacy: dict, candidate: dict) -> dict:
    name, kind = c.get("name") or c.get("path"), (c.get("kind") or "").lower()
    for side, r in (("legacy", legacy), ("candidate", candidate)):
        if "error" in r:
            return {"name": name, "kind": kind, "result": "ERROR", "findings": [{"breaking": False, "what": f"{side}: {r['error']}"}]}
        if r["status"] != 200:
            return {"name": name, "kind": kind, "result": "ERROR", "findings": [{"breaking": False, "what": f"{side} answered HTTP {r['status']}"}]}
    findings: list[dict] = []
    try:
        if kind == "openapi":
            findings = diff_openapi(json.loads(legacy["body"]), json.loads(candidate["body"]))
        elif kind in ("wsdl", "xsd"):
            findings = diff_wsdl(ET.fromstring(legacy["body"].encode("utf-8")), ET.fromstring(candidate["body"].encode("utf-8")))
        elif legacy["sha256"] != candidate["sha256"]:
            findings = [{"breaking": None, "what": "the text differs; this kind is not analysed, so a person must review it"}]
    except (json.JSONDecodeError, ET.ParseError) as exc:
        return {"name": name, "kind": kind, "result": "ERROR", "findings": [{"breaking": False, "what": f"could not parse: {exc}"}]}
    if any(f["breaking"] for f in findings):
        result = "BREAKING"
    elif any(f["breaking"] is None for f in findings):
        result = "REVIEW"
    elif findings:
        result = "COMPATIBLE"
    elif legacy["sha256"] == candidate["sha256"]:
        result = "IDENTICAL"
    else:
        result = "EQUIVALENT"
    return {"name": name, "kind": kind, "result": result, "findings": findings}


# --------------------------------------------------------------------------- run

NOISE_RX = [
    ("a GUID", re.compile(r"^\"?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\"?$")),
    ("a timestamp", re.compile(r"^\"?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")),
    ("a /Date()/ value", re.compile(r"^\"?\\?/Date\(\d+")),
]


def _noise_suggestions(case_results: list[dict]) -> list[dict]:
    by_where: dict[str, list[dict]] = {}
    for r in case_results:
        for d in r.get("differences") or []:
            if not d.get("delta"):
                by_where.setdefault(re.sub(r"\[\d+\]", "[*]", d["where"]), []).append(d)
    out = []
    for where, ds in sorted(by_where.items()):
        for label, rx in NOISE_RX:
            if all(rx.match(str(d["legacy"])) and rx.match(str(d["candidate"])) for d in ds):
                out.append({"where": where, "cases": len(ds), "why": f"both sides hold {label} that changes on every call"})
                break
    return out


def run(ws: str, system: str, allow_unsafe: bool = False, only: list[str] | None = None) -> dict:
    d = parity_dir(ws, system)
    manifest = load_manifest(ws, system)
    cases = _read_json(os.path.join(d, "cases.json"), default=[])
    deltas = _read_json(os.path.join(d, "deltas.json"), default=[])
    if not isinstance(cases, list) or not isinstance(deltas, list):
        raise ParityError("cases.json and deltas.json must each hold a JSON list.")
    ids = [c.get("id") for c in cases if isinstance(c, dict)]
    if len(ids) != len(set(ids)) or any(not isinstance(i, str) or not re.match(r"^[A-Za-z0-9_.-]{1,64}$", i) for i in ids):
        raise ParityError("Every case needs a unique `id` of letters, digits, '.', '-' and '_'.")
    if only:
        unknown = set(only) - set(ids)
        if unknown:
            raise ParityError(f"Unknown case ids: {', '.join(sorted(unknown))}.")
        cases = [c for c in cases if c.get("id") in only]
    opener = _opener(manifest)
    extra = _env_headers(manifest)
    timeout = float(manifest.get("timeout_s") or 30)
    unsafe_ok = bool(manifest.get("allow_unsafe_methods")) and allow_unsafe
    res_dir = os.path.join(d, "results")
    os.makedirs(res_dir, exist_ok=True)

    contracts = []
    for c in manifest.get("contracts") or []:
        if not isinstance(c, dict) or not isinstance(c.get("path"), str):
            raise ParityError("Each contract needs a `name`, a `kind` (openapi, wsdl, xsd or text) and a `path` on both systems.")
        la = _fetch_contract(opener, manifest, "legacy", c, extra, timeout)
        ca = _fetch_contract(opener, manifest, "candidate", c, extra, timeout)
        slug = re.sub(r"[^A-Za-z0-9_.-]", "_", str(c.get("name") or c["path"]))[:64]
        for side, r in (("legacy", la), ("candidate", ca)):
            if "body" in r:
                with open(os.path.join(res_dir, f"contract-{slug}.{side}.txt"), "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(r["body"])
        contracts.append(check_contract(c, la, ca))

    used_deltas: set[str] = set()
    case_results = []
    for case in cases:
        method = str(case.get("method", "GET")).upper()
        safe = method in SAFE_METHODS or case.get("safe") is True
        entry = {"id": case["id"], "name": case.get("name") or f"{method} {case.get('path')}", "method": method,
                 "path": case.get("path"), "match": match_for(case, manifest)}
        if not safe and not unsafe_ok:
            entry.update(result="SKIPPED", why="changes data: needs allow_unsafe_methods in config.json and allow_unsafe on this run")
            case_results.append(entry)
            continue
        legacy = send(opener, manifest["legacy"]["base_url"], case, extra, timeout)
        candidate = send(opener, manifest["candidate"]["base_url"], case, extra, timeout)
        for side, r in (("legacy", legacy), ("candidate", candidate)):
            _write_json(os.path.join(res_dir, f"{case['id']}.{side}.json"), r)
        if "error" in legacy or "error" in candidate:
            entry.update(result="ERROR", why="; ".join(f"{s}: {r['error']}" for s, r in (("legacy", legacy), ("candidate", candidate)) if "error" in r))
            case_results.append(entry)
            continue
        diffs = compare(case, legacy, candidate, manifest, entry["match"])
        for diff in diffs:
            for delta in deltas:
                if isinstance(delta, dict) and _delta_covers(delta, case["id"], diff["where"]):
                    diff["delta"] = delta.get("id", "?")
                    used_deltas.add(delta.get("id", "?"))
                    break
        open_diffs = [x for x in diffs if not x.get("delta")]
        entry["differences"] = diffs
        entry["result"] = "DIFFERENT" if open_diffs else ("EXPECTED" if diffs else "MATCH")
        if legacy.get("truncated") or candidate.get("truncated"):
            entry["note"] = "a body was over 5 MB and only its first 5 MB were compared"
        case_results.append(entry)

    counts = {k: sum(1 for r in case_results if r["result"] == k) for k in ("MATCH", "EXPECTED", "DIFFERENT", "SKIPPED", "ERROR")}
    broken = [c for c in contracts if c["result"] == "BREAKING"]
    review = [c for c in contracts if c["result"] in ("REVIEW", "ERROR")]
    if broken or counts["DIFFERENT"]:
        verdict = "NO PARITY"
    elif not case_results and not contracts:
        verdict = "NO EVIDENCE"
    elif counts["SKIPPED"] or counts["ERROR"] or review:
        verdict = "INCOMPLETE"
    elif counts["MATCH"] + counts["EXPECTED"] == 0:
        verdict = "NO EVIDENCE"
    else:
        verdict = "PARITY"
    result = {
        "system": system, "date": today(), "verdict": verdict,
        "legacy": manifest["legacy"]["base_url"], "candidate": manifest["candidate"]["base_url"],
        "counts": counts, "contracts": contracts, "cases": case_results,
        "unused_deltas": sorted({str(x.get("id")) for x in deltas if isinstance(x, dict)} - used_deltas),
        "suggested_scrubs": _noise_suggestions(case_results),
        "partial_run": bool(only),
    }
    _write_json(os.path.join(d, "PARITY.json"), result)
    with open(os.path.join(d, "PARITY.md"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(render_report(result))
    return result


def _cell(text) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ").replace("`", "'")


def render_report(r: dict) -> str:
    c = r["counts"]
    lines = [
        f"# Parity report: {r['system']}",
        "",
        f"**Verdict: {r['verdict']}**" + (" (partial run: only some cases were replayed)" if r.get("partial_run") else ""),
        "",
        f"- Date: {r['date']}",
        f"- Legacy: `{r['legacy']}`",
        f"- Candidate: `{r['candidate']}`",
        f"- Cases: {sum(c.values())} in all: {c['MATCH']} match, {c['EXPECTED']} differ only as the delta ledger expects, "
        f"{c['DIFFERENT']} differ, {c['SKIPPED']} skipped, {c['ERROR']} could not run",
        "",
        "Computed by the modernize-tools `parity_run` tool from the files in this folder. Do not edit the numbers by hand: re-run it.",
        "",
        "## Contracts",
        "",
    ]
    if r["contracts"]:
        lines += ["| Contract | Kind | Result | Findings |", "| --- | --- | --- | --- |"]
        for k in r["contracts"]:
            found = "; ".join(f["what"] for f in k["findings"]) or "none"
            lines.append(f"| {_cell(k['name'])} | {_cell(k['kind'])} | {k['result']} | {_cell(found)} |")
    else:
        lines.append("No contracts are listed in config.json, so none were checked.")
    lines += ["", "## Cases", "", "| Case | Request | Match level | Result |", "| --- | --- | --- | --- |"]
    for x in r["cases"]:
        lines.append(f"| {x['id']} | {_cell(x['name'])} | {x['match']} | {x['result']}{(' — ' + _cell(x['why'])) if x.get('why') else ''} |")
    diff_rows = [(x["id"], d) for x in r["cases"] for d in x.get("differences") or []]
    lines += ["", "## Differences", ""]
    if diff_rows:
        lines += ["| Case | Where | Legacy | Candidate | Expected by |", "| --- | --- | --- | --- | --- |"]
        for cid, d in diff_rows[:500]:
            lines.append(f"| {cid} | `{_cell(d['where'])}` | {_cell(d['legacy'])} | {_cell(d['candidate'])} | {d.get('delta') or '—'} |")
        if len(diff_rows) > 500:
            lines.append(f"\n{len(diff_rows) - 500} more differences are in PARITY.json.")
    else:
        lines.append("None.")
    if r["suggested_scrubs"]:
        lines += ["", "## Probably noise", "",
                  "These differences look like values that change on every call. A person decides whether to scrub them; scrubbing hides them from every later run.", "",
                  "| Where | Cases | Why |", "| --- | --- | --- |"]
        for s in r["suggested_scrubs"]:
            lines.append(f"| `{_cell(s['where'])}` | {s['cases']} | {s['why']} |")
    if r["unused_deltas"]:
        lines += ["", "## Deltas that matched nothing", "", "These approved differences no longer occur. Check whether they are still needed: "
                  + ", ".join(r["unused_deltas"])]
    lines += ["", "## Sign-off", "",
              "Filled in by a person, never by the agent. Re-running the check clears it, because the evidence has changed.", "",
              "| Name | Role | Decision | Date |", "| --- | --- | --- | --- |", "|  |  |  |  |", ""]
    return "\n".join(lines)
