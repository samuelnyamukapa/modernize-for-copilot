// Reader tests on temp workspaces: rewrite, uplift, reimagine, empty, and malformed files.
//   node --test plugin/tools/tests/canvas/reader.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    makeWorkspace, rmrf, crlf, rulesMd, STANDARD_RULES, briefMd, phase, verificationJson, verificationMd,
    SECURITY_MD, topologyJson, STANDARD_TOPOLOGY, CANVAS,
} from "./fixtures.mjs";

const { readWorkspace, readSystem, listSystems, legacyFolders, locatePath, pathRootsOf, tileFor, summaryOf } = await import(new URL("reader.mjs", CANVAS));
const { parseIntent, parseRules, parseBrief, parseSignoff, parseSecurity, parseVerification, parseTopology, parseReviews } = await import(new URL("parsers.mjs", CANVAS));

const A = (f) => `analysis/billing/${f}`;
const canSymlink = (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ln-"));
    try {
        fs.symlinkSync(d, path.join(d, "x"), "dir");
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(d, { recursive: true, force: true });
    }
})();

function rewriteWorkspace() {
    const ws = makeWorkspace({
        [A("INTENT.md")]: crlf("# Intent: billing\n\nDate: 2026-10-01\n\n**Goal:** transform (rewrite)\n\n**From:** COBOL batch\n**To:** Java 21 Spring\n"),
        [A("PREFLIGHT.md")]: "# Preflight\n",
        [A("ASSESSMENT.md")]: "# Assessment\n",
        [A("topology.json")]: topologyJson(STANDARD_TOPOLOGY),
        [A("BUSINESS_RULES.md")]: crlf(rulesMd(STANDARD_RULES)),
        [A("RULE_REVIEWS.json")]: JSON.stringify({ system: "billing", version: 1, reviews: { "RULE-003": { verdict: "confirmed", at: "2026-10-02T10:00:00Z", title: "Rounding truncates" } } }),
        [A("MODERNIZATION_BRIEF.md")]: briefMd({ phases: [phase(1, "Fees pilot", "transform", ["FEES", "RATES"]), phase(2, "Statements", "transform", ["STMT"])], signed: true, covers: "Phase 1 only", openQuestions: ["RULE-010: is daily accrual still the policy?"] }),
        [A("VERIFICATION.json")]: verificationJson([{ name: "FEES", verdict: "PROVEN" }]),
        [A("VERIFICATION.md")]: verificationMd({ signed: false }),
        [A("SECURITY_FINDINGS.md")]: crlf(SECURITY_MD),
        "modernized/billing/FEES/TRANSFORMATION_NOTES.md": "notes\n",
        "modernized/billing/FEES/src/Fees.java": "class Fees {}\n",
        "legacy/billing/src/FEES.cbl": "       PROCEDURE DIVISION.\n",
    }, {
        [A("INTENT.md")]: 900, [A("PREFLIGHT.md")]: 800, [A("ASSESSMENT.md")]: 700, [A("topology.json")]: 600,
        [A("BUSINESS_RULES.md")]: 500, [A("MODERNIZATION_BRIEF.md")]: 400,
        "modernized/billing/FEES/TRANSFORMATION_NOTES.md": 300, "modernized/billing/FEES/src/Fees.java": 300,
    });
    return ws;
}

test("empty workspace: no systems, and an analysis folder alone holds none", () => {
    const ws = makeWorkspace({ "analysis/.gitignore": "SECRETS.local.md\n" });
    try {
        const m = readWorkspace(ws);
        assert.deepEqual(m.systems, []);
        assert.equal(m.workspace.name, path.basename(ws));
        assert.deepEqual(summaryOf(m).systems, []);
    } finally {
        rmrf(ws);
    }
});

test("a system known only from legacy/: listed, next is the front door, map from its folders", () => {
    const ws = makeWorkspace({ "legacy/billing/src/a.cbl": "x", "legacy/billing/src/b.cbl": "x", "legacy/billing/jcl/run.jcl": "x", "legacy/billing/README": "x", "legacy/bad name/x": "x" });
    try {
        assert.deepEqual(listSystems(ws), ["billing"]);
        const s = readSystem(ws, "billing");
        assert.equal(s.hasAnalysis, false);
        assert.equal(s.next.command, "/modernize:start billing");
        assert.equal(s.map.source, "folders");
        const tiles = Object.fromEntries(s.map.groups[0].tiles.map((t) => [t.id, t.size]));
        assert.deepEqual(tiles, { src: 2, jcl: 1, ".": 1 });
    } finally {
        rmrf(ws);
    }
});

test("rewrite workspace: track, steps, deck, brief, verdicts, sign-off, security, map", () => {
    const ws = rewriteWorkspace();
    try {
        const [s] = readWorkspace(ws).systems;
        assert.equal(s.name, "billing");
        assert.equal(s.track, "rewrite");
        assert.equal(s.trackWhy, "INTENT.md: transform");
        assert.deepEqual({ goal: s.intent.goal, from: s.intent.from, to: s.intent.to }, { goal: "transform", from: "COBOL batch", to: "Java 21 Spring" });
        assert.deepEqual(s.rules, { total: 5, p0: 3, flaggedOpen: 2, p0Open: 1 });
        // RULE-002 (P0, Medium, SME question) is flagged; RULE-003 has a verdict; RULE-010 is named in an open question.
        assert.deepEqual(s.deck.map((r) => r.id), ["RULE-002", "RULE-010"]);
        const r2 = s.deck[0];
        assert.equal(r2.sme, "Is the waiver per calendar year or rolling?");
        assert.equal(r2.given, "an account in good standing");
        assert.equal(r2.then, "the fee is 2.5% rounded down · never below 1.00");
        assert.equal(r2.citation, "src/Billing/Fees.cs:10-20");
        assert.equal(s.reviews.confirmed, 1);
        assert.equal(s.brief.phases.length, 2);
        assert.deepEqual(s.brief.phases[0].modules, ["FEES", "RATES"]);
        assert.equal(s.brief.phases[0].command, "transform");
        assert.deepEqual(s.brief.approval, { hasBlock: true, signed: true, by: "Ada Lovelace, Head of Billing", date: "2026-10-01", covers: "Phase 1 only", hasCovers: true, hasDate: true });
        assert.equal(s.brief.openQuestions, 1);
        assert.deepEqual(s.modules.map((m) => [m.name, m.built, m.proof?.state]), [["FEES", true, "proven"]]);
        assert.deepEqual(s.verification.signoff, { hasTable: true, signed: false });
        assert.deepEqual(s.security, { Critical: 1, High: 2, Medium: 3, Low: 4 });
        const kinds = s.attention.map((a) => a.kind);
        for (const k of ["review", "signoff", "security"]) assert.ok(kinds.includes(k), k);
        assert.equal(s.next.command, "/modernize:review billing");
        assert.equal(s.map.source, "topology");
        assert.deepEqual(s.map.groups.map((g) => g.name), ["Statements", "Fees"]);
        const tiles = Object.fromEntries(s.map.groups.flatMap((g) => g.tiles).map((t) => [t.id, t.state]));
        assert.deepEqual(tiles, { STMT: "todo", FEES: "proven", RATES: "todo", FOOTER: "todo" });
        assert.ok(!("ds:ACCTS" in tiles), "datastores have no loc and are left off the map");
        const stage = Object.fromEntries(s.stages.map((x) => [x.key, x.done]));
        assert.deepEqual(stage, { intent: true, preflight: true, assess: true, map: true, "extract-rules": true, review: false, brief: true, transform: true, verify: false, harden: true });
    } finally {
        rmrf(ws);
    }
});

test("rewrite workspace: a stale brief and stale notes are flagged with the command that fixes them", () => {
    const ws = rewriteWorkspace();
    try {
        // BUSINESS_RULES.md rewritten after the brief and after FEES's notes.
        fs.utimesSync(path.join(ws, A("BUSINESS_RULES.md")), new Date(), new Date());
        const s = readSystem(ws, "billing");
        assert.deepEqual(s.stale.map((x) => [x.artifact, x.fix]), [
            ["MODERNIZATION_BRIEF.md", "/modernize:brief billing"],
            ["FEES/TRANSFORMATION_NOTES.md", "/modernize:transform billing FEES"],
        ]);
        assert.ok(s.stages.find((x) => x.key === "brief").stale);
    } finally {
        rmrf(ws);
    }
});

test("uplift workspace: its own steps, the working copy as one module, a signed verification, next is harden", () => {
    const ws = makeWorkspace({
        "analysis/inv/INTENT.md": "# Intent\n\nDate: 2026-10-14\n\n**Goal:** uplift (same-stack version move)\n\n**From:** .NET Framework 4.7.2\n**To:** .NET 8\n\n## Not chosen\n- A security review comes first\n",
        "analysis/inv/PREFLIGHT.md": "x",
        "analysis/inv/ASSESSMENT.md": "x",
        "analysis/inv/topology.json": topologyJson({ Core: [["Catalog", 300, "src/Catalog.cs"]], Web: [["Controllers", 500, "src/Controllers.cs"]] }),
        "analysis/inv/MODERNIZATION_BRIEF.md": briefMd({ phases: [phase(1, "Pilot", "uplift", ["Catalog"], { entry: [true, true], exit: [true] })], signed: true, covers: "full plan", inlineDate: false }),
        "analysis/inv/DELTA_CATALOG.md": "# Deltas\n\n### DELTA-001: System.Web\n\n### DELTA-002: BinaryFormatter\n",
        "analysis/inv/BASELINE.md": "x",
        "analysis/inv/PLAYBOOK.md": "x",
        "analysis/inv/VERIFICATION.json": verificationJson([{ name: "inv-uplifted", track: "uplift", verdict: "PROVEN" }, { name: "ignored", track: "uplift", verdict: "proven" }]),
        "analysis/inv/VERIFICATION.md": crlf(verificationMd({ signed: true })),
        "modernized/inv-uplifted/UPLIFT_NOTES.md": "notes",
        "modernized/inv-uplifted/src/Catalog.cs": "class C {}",
    }, { "analysis/inv/ASSESSMENT.md": 900, "analysis/inv/topology.json": 800, "analysis/inv/MODERNIZATION_BRIEF.md": 600, "analysis/inv/DELTA_CATALOG.md": 700, "modernized/inv-uplifted/UPLIFT_NOTES.md": 500, "modernized/inv-uplifted/src/Catalog.cs": 500 });
    try {
        const s = readSystem(ws, "inv");
        assert.equal(s.track, "uplift");
        assert.equal(s.intent.securityFirst, false, "a security review listed under Not chosen was not chosen");
        assert.deepEqual(s.stages.map((x) => x.key), ["intent", "preflight", "assess", "map", "extract-rules", "review", "brief", "deltas", "baseline", "pilot", "migrate", "verify", "harden"]);
        assert.equal(s.stages.find((x) => x.key === "deltas").detail, "2 deltas");
        assert.deepEqual(s.modules.map((m) => [m.name, m.built, m.proof.state]), [["inv-uplifted", true, "proven"]]);
        assert.deepEqual(s.verification.signoff, { hasTable: true, signed: true, name: "Grace Hopper", role: "Product owner", date: "2026-10-15", decision: "accept" });
        assert.equal(s.brief.approval.covers, "full plan");
        assert.equal(s.brief.approval.date, "2026-10-01");
        assert.ok(s.stages.find((x) => x.key === "verify").done);
        assert.deepEqual(s.stale, []);
        assert.equal(s.next.command, "/modernize:harden inv");
        assert.ok(s.map.groups.flatMap((g) => g.tiles).every((t) => t.state === "proven"));
    } finally {
        rmrf(ws);
    }
});

test("reimagine workspace: inferred from the newest artifacts, services listed, NOT PROVEN service is next", () => {
    const ws = makeWorkspace({
        "analysis/shop/PREFLIGHT.md": "x",
        "analysis/shop/ASSESSMENT.md": "x",
        "analysis/shop/topology.json": topologyJson(STANDARD_TOPOLOGY),
        "analysis/shop/BUSINESS_RULES.md": rulesMd([{ id: "RULE-001", name: "A", priority: "P0" }]),
        "analysis/shop/MODERNIZATION_BRIEF.md": briefMd({ phases: [phase(1, "Rebuild", "reimagine", [])], signed: true }),
        "analysis/shop/DELTA_CATALOG.md": "x",
        "analysis/shop/AI_NATIVE_SPEC.md": "x",
        "analysis/shop/REIMAGINED_ARCHITECTURE.md": "x",
        "analysis/shop/VERIFICATION.json": verificationJson([{ name: "orders", track: "reimagine", verdict: "NOT PROVEN", reasons: ["Tests: 2 failed."] }, { name: "catalog", track: "reimagine", verdict: "PROVEN" }]),
        "modernized/shop-reimagined/AGENTS.md": "handoff",
        "modernized/shop-reimagined/catalog/src/x.ts": "x",
        "modernized/shop-reimagined/orders/src/x.ts": "x",
    }, { "analysis/shop/DELTA_CATALOG.md": 9000, "modernized/shop-reimagined/catalog/src/x.ts": 600, "modernized/shop-reimagined/orders/src/x.ts": 600 });
    try {
        const s = readSystem(ws, "shop");
        assert.equal(s.track, "reimagine");
        assert.match(s.trackWhy, /^newest artifact: /);
        assert.deepEqual(s.stages.slice(7, 10).map((x) => [x.key, x.done]), [["spec", true], ["design", true], ["scaffold", true]]);
        assert.deepEqual(s.modules.map((m) => [m.name, m.proof.state]), [["catalog", "proven"], ["orders", "not"]]);
        assert.equal(s.next.command, "/modernize:verify shop orders");
        assert.match(s.next.reason, /NOT PROVEN: Tests: 2 failed\./);
        assert.ok(s.attention.some((a) => a.text === "orders: NOT PROVEN: Tests: 2 failed."));
    } finally {
        rmrf(ws);
    }
});

test("malformed files are tolerated: bad JSON, odd verdicts, a broken rules ledger", () => {
    const ws = makeWorkspace({
        "analysis/billing/PREFLIGHT.md": "x",
        "analysis/billing/topology.json": "{ not json",
        "analysis/billing/VERIFICATION.json": "[1,2",
        "analysis/billing/RULE_REVIEWS.json": "{\"reviews\": [1]}",
        "analysis/billing/BUSINESS_RULES.md": "### RULE-001 no separator\n### : no id\n" + "x".repeat(10_000) + "\n",
        "analysis/billing/MODERNIZATION_BRIEF.md": "# nothing useful\n",
        "analysis/billing/SECURITY_FINDINGS.md": "No table here.\n",
        "legacy/billing/a/x.txt": "x",
    });
    try {
        const s = readSystem(ws, "billing");
        assert.equal(s.map.source, "folders");
        assert.equal(s.verification, null);
        assert.equal(s.reviews.readable, false);
        assert.equal(s.rules.total, 0);
        assert.deepEqual(s.brief.phases, []);
        assert.equal(s.brief.approval.hasBlock, false);
        assert.equal(s.security, null);
        assert.equal(parseVerification(JSON.stringify({ modules: [{ name: "a", track: "rewrite", verdict: "PROVEN!" }, { name: "b", track: "rewrite", verdict: "PARTLY PROVEN" }] })).modules.length, 1);
        assert.equal(parseTopology("[]"), null);
        assert.deepEqual(parseReviews("{}").reviews, {});
        assert.equal(parseReviews('{"reviews":{"__proto__":{"verdict":"confirmed"},"RULE-1":{"verdict":"maybe"}}}').ok, true);
        assert.deepEqual(parseReviews('{"reviews":{"__proto__":{"verdict":"confirmed"},"RULE-1":{"verdict":"maybe"}}}').reviews, {});
    } finally {
        rmrf(ws);
    }
});

test("parsers read INTENT.md written as labels or as sections, and CRLF everywhere", () => {
    assert.deepEqual(parseIntent(crlf("# Intent\n\nDate: 2026-10-14\n\n## Goal\n\nunderstand\n\nUser answer: map it\n\n## To\n\nUnderstand the system.\n")), {
        goal: "understand", to: "Understand the system.", date: "2026-10-14", securityFirst: false,
    });
    assert.equal(parseIntent("**Goal:** transform\n\nWhat must stay true: A security review comes first\n").securityFirst, true);
    assert.equal(parseIntent("**Goal:** reimagine\n").goal, "reimagine");
    const rules = parseRules(crlf(rulesMd(STANDARD_RULES)));
    assert.equal(rules.length, 5);
    assert.equal(rules[2].defect, "Truncation loses a cent on odd amounts.");
    assert.equal(rules[3].sme, "Still used?");
    const brief = parseBrief(crlf(briefMd({ phases: [phase(1, "One", "transform", ["A", "B"], { entry: [true, false], exit: [false] })] })));
    assert.deepEqual(brief.phases[0].entry.map((c) => c.ticked), [true, false]);
    assert.equal(brief.target, "java-spring");
    assert.equal(brief.approval.signed, false);
    assert.equal(brief.approval.hasBlock, true);
    assert.equal(parseSignoff(crlf(verificationMd({ signed: true }))).signed, true);
    assert.equal(parseSignoff(verificationMd({ signed: false })).signed, false);
    assert.deepEqual(parseSecurity("| Severity | Count |\n|---|---|\n| Critical | 2 |\n| High | 1 |\n"), { Critical: 2, High: 1, Medium: 0, Low: 0 });
    assert.deepEqual(parseSecurity("| ID | Severity |\n|---|---|\n| S1 | High |\n| S2 | low |\n"), { Critical: 0, High: 1, Medium: 0, Low: 1 });
});

test("a flat topology node list with its own domain field is read too", () => {
    const t = parseTopology(JSON.stringify({ nodes: [{ id: "A", loc: 10, domain: "D1" }, { id: "B", loc: 5, domain: "D2", kind: "module" }, { id: "S", kind: "datastore", domain: "D1" }] }));
    assert.deepEqual(t.nodes.map((n) => [n.id, n.domain, n.loc]), [["A", "D1", 10], ["B", "D2", 5]]);
});

test("the legacy walk is capped and does not follow links inside the tree", { skip: !canSymlink && "symlinks unavailable" }, () => {
    const outside = makeWorkspace({ "big/1": "x", "big/2": "x", "big/3": "x" });
    const files = { "real/legacy-src/a/1": "x", "real/legacy-src/a/2": "x", "real/legacy-src/b/1": "x" };
    for (let i = 0; i < 30; i++) files[`real/legacy-src/c/${i}`] = "x";
    const ws = makeWorkspace(files);
    try {
        fs.mkdirSync(path.join(ws, "legacy"));
        fs.symlinkSync(path.join(ws, "real/legacy-src"), path.join(ws, "legacy/billing"), "dir");
        fs.symlinkSync(path.join(outside, "big"), path.join(ws, "real/legacy-src/a/linked"), "dir");
        const full = legacyFolders(path.join(ws, "legacy/billing"));
        assert.deepEqual(full.folders.map((f) => [f.name, f.files]), [["c", 30], ["a", 2], ["b", 1]]);
        assert.equal(full.truncated, false);
        const capped = legacyFolders(path.join(ws, "legacy/billing"), 10);
        assert.equal(capped.truncated, true);
        assert.deepEqual(listSystems(ws), ["billing"]);
    } finally {
        rmrf(ws);
        rmrf(outside);
    }
});

test("an analysis file that is a link is not read", { skip: !canSymlink && "symlinks unavailable" }, () => {
    const outside = makeWorkspace({ "secret.md": "### RULE-001: leaked\n**Priority:** P0\n**Confidence:** Low\n" });
    const ws = makeWorkspace({ "analysis/billing/PREFLIGHT.md": "x" });
    try {
        fs.symlinkSync(path.join(outside, "secret.md"), path.join(ws, A("BUSINESS_RULES.md")));
        const s = readSystem(ws, "billing");
        assert.equal(s.rules, null);
    } finally {
        rmrf(ws);
        rmrf(outside);
    }
});

test("paths a tool touched are located in legacy/ or modernized/, and matched to a tile", () => {
    const ws = rewriteWorkspace();
    try {
        const model = readWorkspace(ws);
        const roots = pathRootsOf(ws, model);
        const sys = model.systems[0];
        const hit = locatePath(ws, roots, "legacy/billing/src/FEES.cbl");
        assert.deepEqual(hit, { system: "billing", area: "legacy", rel: "src/FEES.cbl" });
        assert.equal(tileFor(sys, hit.area, hit.rel), "FEES");
        const abs = locatePath(ws, roots, path.join(ws, "modernized", "billing", "RATES", "src", "R.java"));
        assert.deepEqual(abs, { system: "billing", area: "modernized", rel: "RATES/src/R.java" });
        assert.equal(tileFor(sys, abs.area, abs.rel), "RATES");
        assert.equal(locatePath(ws, roots, "analysis/billing/BRIEF.md"), null);
        assert.equal(locatePath(ws, roots, "legacy/billing/../../etc/passwd"), null);
        assert.equal(locatePath(ws, roots, "https://example.com/legacy/billing/x"), null);
    } finally {
        rmrf(ws);
    }
});

test("summary for the agent: one plain line per field, the next command, verdicts", () => {
    const ws = rewriteWorkspace();
    try {
        const sum = summaryOf(readWorkspace(ws));
        const s = sum.systems[0];
        assert.equal(s.system, "billing");
        assert.equal(s.next.command, "/modernize:review billing");
        assert.deepEqual(s.verdicts, { FEES: "PROVEN" });
        assert.equal(s.briefApproved, true);
        assert.equal(s.verificationSigned, false);
        assert.match(sum.note, /never runs commands/);
    } finally {
        rmrf(ws);
    }
});
