// The local server's defences (token, Host, JSON-only POSTs, body cap, asset whitelist) and a smoke
// run of the whole page on a fixture workspace.
//   node --test plugin/tools/tests/canvas/server.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { makeWorkspace, rmrf, rulesMd, STANDARD_RULES, briefMd, phase, verificationJson, verificationMd, topologyJson, STANDARD_TOPOLOGY, CANVAS } from "./fixtures.mjs";

const { createHub } = await import(new URL("hub.mjs", CANVAS));
const { CSP, MAX_BODY } = await import(new URL("server.mjs", CANVAS));

let ws;
let hub;
let entry;
let port;
let token;

before(async () => {
    ws = makeWorkspace({
        "analysis/billing/INTENT.md": "**Goal:** transform\n",
        "analysis/billing/PREFLIGHT.md": "x",
        "analysis/billing/ASSESSMENT.md": "x",
        "analysis/billing/topology.json": topologyJson(STANDARD_TOPOLOGY),
        "analysis/billing/BUSINESS_RULES.md": rulesMd(STANDARD_RULES),
        "analysis/billing/MODERNIZATION_BRIEF.md": briefMd({ phases: [phase(1, "Pilot", "transform", ["FEES"])] }),
        "analysis/billing/VERIFICATION.json": verificationJson([{ name: "FEES", verdict: "PROVEN" }]),
        "analysis/billing/VERIFICATION.md": verificationMd(),
        "modernized/billing/FEES/TRANSFORMATION_NOTES.md": "n",
        "legacy/billing/src/FEES.cbl": "x",
        "legacy/billing/secret.txt": "do not serve",
    }, { "analysis/billing/INTENT.md": 900, "analysis/billing/PREFLIGHT.md": 800, "analysis/billing/ASSESSMENT.md": 700, "analysis/billing/topology.json": 600, "analysis/billing/BUSINESS_RULES.md": 500, "modernized/billing/FEES/TRANSFORMATION_NOTES.md": 300 });
    hub = createHub();
    entry = await hub.ensure(ws);
    port = entry.server.port;
    token = entry.server.token;
});

after(async () => {
    await hub.close();
    rmrf(ws);
});

/** A raw request, so the Host header can be anything. */
function req({ method = "GET", path = "/", headers = {}, body, chunks }) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            const parts = [];
            res.on("data", (c) => parts.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
        });
        r.on("error", reject);
        if (chunks) for (const c of chunks) r.write(c);
        if (body !== undefined) r.write(body);
        r.end();
    });
}

const api = (path, extra = {}) => req({ path, ...extra, headers: { "X-Modernize-Token": token, ...(extra.headers ?? {}) } });
const post = (path, body, headers = {}) => api(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

test("the token is random, long, and required on every request", async () => {
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await req({ path: "/" })).status, 403);
    assert.equal((await req({ path: `/?t=${"0".repeat(64)}` })).status, 403);
    assert.equal((await req({ path: `/?t=${token.slice(1)}` })).status, 403);
    assert.equal((await req({ path: `/app.js` })).status, 403);
    assert.equal((await req({ path: "/api/state" })).status, 403);
    assert.equal((await req({ path: `/api/state?t=${token}` })).status, 403, "the API takes the header, not the query");
    assert.equal((await req({ path: "/api/state", headers: { "X-Modernize-Token": "nope" } })).status, 403);
    assert.equal((await api("/api/state")).status, 200);
});

test("a request that does not name this server by Host is refused (DNS rebinding)", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1`, `0.0.0.0:${port}`, `[::1]:${port}`]) {
        assert.equal((await req({ path: `/?t=${token}`, headers: { Host: host } })).status, 403, host);
    }
    assert.equal((await req({ path: `/?t=${token}`, headers: { Host: `localhost:${port}` } })).status, 200);
});

test("the page carries the security headers and its own token; assets are a fixed whitelist", async () => {
    const page = await req({ path: `/?t=${token}` });
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], CSP);
    assert.ok(CSP.startsWith("default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:"));
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.ok(page.text.includes(`app.js?t=${token}`) && !page.text.includes("{{TOKEN}}"));
    for (const p of ["/app.js", "/styles.css", "/treemap.mjs"]) {
        const r = await req({ path: `${p}?t=${token}` });
        assert.equal(r.status, 200, p);
        assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    for (const p of ["/reader.mjs", "/writers.mjs", "/page.html", "/extension.mjs", "/../../../../legacy/billing/secret.txt", "/%2e%2e/%2e%2e/legacy/billing/secret.txt", "/legacy/billing/secret.txt", "/analysis/billing/VERIFICATION.md"]) {
        const r = await req({ path: `${p}?t=${token}` });
        assert.equal(r.status, 404, p);
        assert.ok(!r.text.includes("do not serve"));
    }
    assert.equal((await req({ method: "POST", path: `/?t=${token}` })).status, 405);
});

test("POSTs must be JSON, small, from this origin, and name a valid system", async () => {
    const good = { system: "billing", rule: "RULE-002", verdict: "discuss" };
    assert.equal((await api("/api/review", { method: "POST", body: JSON.stringify(good) })).status, 415, "no content type");
    assert.equal((await post("/api/review", good, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post("/api/review", good, { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await req({ method: "POST", path: "/api/review", headers: { "Content-Type": "application/json" }, body: JSON.stringify(good) })).status, 403, "no token header");
    assert.equal((await post("/api/review", good, { Origin: "https://evil.example" })).status, 403);
    const big = JSON.stringify({ ...good, note: "x".repeat(MAX_BODY + 10) });
    assert.equal((await post("/api/review", big)).status, 413);
    const chunked = await api("/api/review", { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }, chunks: [Buffer.alloc(40 * 1024, 32), Buffer.alloc(40 * 1024, 32)] });
    assert.equal(chunked.status, 413);
    assert.equal((await post("/api/review", "{not json")).status, 400);
    assert.equal((await post("/api/review", "[1]")).status, 400);
    for (const system of ["../billing", "..", "billing/../../legacy", "a b"]) {
        assert.equal((await post("/api/review", { ...good, system })).status, 400, system);
        assert.equal((await post("/api/signoff", { kind: "verification", system, name: "a", role: "b", date: "2026-10-16", decision: "accept" })).status, 400, system);
    }
    assert.equal((await post("/api/signoff", { kind: "other", system: "billing" })).status, 400);
    assert.equal((await api("/api/review")).status, 405);
    assert.equal((await api("/api/nothing")).status, 404);
    assert.ok(!fs.existsSync(`${ws}/analysis/billing/RULE_REVIEWS.json`), "nothing was written by a refused request");
});

test("smoke: the page, the state, a verdict and a sign-off through the server, and the event stream", async () => {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/?t=${token}&system=billing`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<main id="main">/);
    const state = await (await fetch(`${base}/api/state`, { headers: { "X-Modernize-Token": token } })).json();
    assert.equal(state.systems[0].name, "billing");
    assert.equal(state.systems[0].next.command, "/modernize:review billing");
    assert.deepEqual(state.systems[0].deck.map((r) => r.id), ["RULE-002", "RULE-003"]);
    assert.ok(Array.isArray(state.activity));

    const events = await fetch(`${base}/api/events`, { headers: { "X-Modernize-Token": token } });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type"), /^text\/event-stream/);
    const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    const until = async (re) => {
        while (!re.test(buf)) {
            const { value, done } = await reader.read();
            if (done) throw new Error("stream ended");
            buf += value;
        }
    };
    await until(/event: state\ndata: \{/);

    const r1 = await fetch(`${base}/api/review`, { method: "POST", headers: { "X-Modernize-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ system: "billing", rule: "RULE-002", verdict: "confirmed", note: "per calendar year" }) });
    assert.equal(r1.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(`${ws}/analysis/billing/RULE_REVIEWS.json`, "utf8")).reviews["RULE-002"].note, "per calendar year");
    const r2 = await fetch(`${base}/api/signoff`, { method: "POST", headers: { "X-Modernize-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "brief", system: "billing", name: "Ada", role: "Owner", date: "2026-10-16", covers: "Phase 1 only" }) });
    assert.equal(r2.status, 200);
    assert.match(fs.readFileSync(`${ws}/analysis/billing/MODERNIZATION_BRIEF.md`, "utf8"), /Approved by: Ada, Owner {2}Date: 2026-10-16\nApproval covers: Phase 1 only/);

    buf = "";
    await until(/"approval":\{"hasBlock":true,"signed":true/);
    hub.event({ type: "tool.execution_start", timestamp: new Date().toISOString(), data: { toolCallId: "c1", toolName: "view", arguments: { path: `${ws}/legacy/billing/src/FEES.cbl` } } });
    await until(/event: activity\ndata: .*"tile":"FEES"/);
    hub.show(ws, "billing");
    await until(/event: show\ndata: \{"system":"billing"\}/);
    await reader.cancel();
});

test("the page script never uses an HTML sink, and every bundled file is accounted for", () => {
    const dir = fileURLToPath(CANVAS);
    const app = fs.readFileSync(`${dir}app.js`, "utf8");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "srcdoc"]) {
        assert.ok(!app.includes(sink), sink);
    }
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ["activity.mjs", "app.js", "canvas.mjs", "extension.mjs", "hub.mjs", "page.html", "parsers.mjs", "progress.mjs", "reader.mjs", "server.mjs", "styles.css", "treemap.mjs", "writers.mjs"]);
    for (const f of files.filter((f) => f.endsWith(".mjs") && f !== "extension.mjs")) {
        assert.ok(!/(?:from|import)\s*\(?\s*["']@github\/copilot-sdk/.test(fs.readFileSync(`${dir}${f}`, "utf8")), `${f} must not import the SDK`);
    }
});
