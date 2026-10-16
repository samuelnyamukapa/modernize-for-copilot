// The page's writers: RULE_REVIEWS.json/.md in the review skill's format, the verify sign-off and
// the brief's approval (only their cells/lines change), and never a write outside analysis/<system>/.
//   node --test plugin/tools/tests/canvas/writers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeWorkspace, rmrf, crlf, rulesMd, STANDARD_RULES, briefMd, phase, verificationMd, CANVAS } from "./fixtures.mjs";

const W = await import(new URL("writers.mjs", CANVAS));

const A = (f) => `analysis/billing/${f}`;
const read = (ws, rel) => fs.readFileSync(path.join(ws, rel), "utf8");
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

function changedLines(before, after) {
    const a = before.split(/\r?\n/);
    const b = after.split(/\r?\n/);
    assert.equal(a.length, b.length, "same number of lines");
    return a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
}

function status(fn) {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof W.WriteError, `expected a WriteError, got ${err}`);
        return err.status;
    }
    return 200;
}

const NOW = new Date("2026-10-16T09:30:00.000Z");

test("review: a first verdict creates RULE_REVIEWS.json in the skill's format, title taken from the rules", () => {
    const ws = makeWorkspace({ [A("BUSINESS_RULES.md")]: rulesMd(STANDARD_RULES) });
    try {
        W.writeReview(ws, { system: "billing", rule: "RULE-002", verdict: "discuss", note: "Ask finance" }, NOW);
        const json = JSON.parse(read(ws, A("RULE_REVIEWS.json")));
        assert.deepEqual(json, { system: "billing", version: 1, reviews: { "RULE-002": { verdict: "discuss", at: "2026-10-16T09:30:00.000Z", title: "Late fee waived once a year", note: "Ask finance" } } });
        const md = read(ws, A("RULE_REVIEWS.md"));
        assert.match(md, /^# Rule reviews: billing\n\n/);
        assert.match(md, /\n\| Rule \| Verdict \| When \| Title \| Note \|\n\|---\|---\|---\|---\|---\|\n\| RULE-002 \| Needs discussion \| 2026-10-16 \| Late fee waived once a year \| Ask finance \|\n/);
    } finally {
        rmrf(ws);
    }
});

test("review: merging keeps every existing entry as it was and replaces only the one answered", () => {
    const existing = {
        system: "billing",
        version: 1,
        reviews: {
            "RULE-010": { verdict: "confirmed", at: "2026-10-14T20:59:29.2573038+01:00", title: "Interest accrues daily", extra: "kept" },
            "RULE-002": { verdict: "wrong", at: "2026-10-14T21:00:00Z", title: "old", note: "old note" },
            "RULE-004": { verdict: "discuss", at: "2026-10-14T21:00:00Z", title: "Statement footer text" },
        },
    };
    const ws = makeWorkspace({ [A("BUSINESS_RULES.md")]: crlf(rulesMd(STANDARD_RULES)), [A("RULE_REVIEWS.json")]: JSON.stringify(existing) });
    try {
        W.writeReview(ws, { system: "billing", rule: "RULE-002", verdict: "confirmed" }, NOW);
        const json = JSON.parse(read(ws, A("RULE_REVIEWS.json")));
        assert.deepEqual(json.reviews["RULE-010"], existing.reviews["RULE-010"]);
        assert.deepEqual(json.reviews["RULE-004"], existing.reviews["RULE-004"]);
        assert.deepEqual(json.reviews["RULE-002"], { verdict: "confirmed", at: NOW.toISOString(), title: "Late fee waived once a year" });
        const rows = read(ws, A("RULE_REVIEWS.md")).split("\n").filter((l) => l.startsWith("| RULE-"));
        assert.deepEqual(rows.map((r) => r.split(" | ")[0]), ["| RULE-002", "| RULE-004", "| RULE-010"], "sorted by rule number, not as text");
    } finally {
        rmrf(ws);
    }
});

test("review: a note with a pipe or a new line stays one table cell", () => {
    const ws = makeWorkspace({ [A("BUSINESS_RULES.md")]: rulesMd(STANDARD_RULES) });
    try {
        W.writeReview(ws, { system: "billing", rule: "RULE-001", verdict: "wrong", note: "a | b\n| RULE-999 | Confirmed |" }, NOW);
        const row = read(ws, A("RULE_REVIEWS.md")).split("\n").find((l) => l.startsWith("| RULE-001"));
        assert.equal(row, "| RULE-001 | Wrong | 2026-10-16 | Fee is 2.5 percent | a \\| b \\| RULE-999 \\| Confirmed \\| |");
        assert.ok(!read(ws, A("RULE_REVIEWS.md")).includes("\n| RULE-999"));
    } finally {
        rmrf(ws);
    }
});

test("review: refused for an unknown rule, a bad verdict, a bad system name, or an unreadable ledger", () => {
    const ws = makeWorkspace({ [A("BUSINESS_RULES.md")]: rulesMd(STANDARD_RULES), "analysis/other/x": "x", "analysis/other/RULE_REVIEWS.json": "{broken" });
    try {
        assert.equal(status(() => W.writeReview(ws, { system: "billing", rule: "RULE-777", verdict: "confirmed" })), 404);
        assert.equal(status(() => W.writeReview(ws, { system: "billing", rule: "RULE-001", verdict: "yes" })), 400);
        assert.equal(status(() => W.writeReview(ws, { system: "../billing", rule: "RULE-001", verdict: "confirmed" })), 400);
        assert.equal(status(() => W.writeReview(ws, { system: "billing", rule: "__proto__", verdict: "confirmed" })), 400);
        assert.equal(status(() => W.writeReview(ws, { system: "nosuch", rule: "RULE-001", verdict: "confirmed" })), 404);
        fs.writeFileSync(path.join(ws, "analysis/other/BUSINESS_RULES.md"), rulesMd(STANDARD_RULES));
        assert.equal(status(() => W.writeReview(ws, { system: "other", rule: "RULE-001", verdict: "confirmed" })), 409);
        assert.equal(read(ws, "analysis/other/RULE_REVIEWS.json"), "{broken", "an unreadable ledger is never overwritten");
        assert.ok(!fs.existsSync(path.join(ws, A("RULE_REVIEWS.json"))));
    } finally {
        rmrf(ws);
    }
});

test("verify sign-off: only the four value cells change, CRLF kept, values escaped", () => {
    const before = crlf(verificationMd({ signed: false }));
    const ws = makeWorkspace({ [A("VERIFICATION.md")]: before });
    try {
        W.writeSignoff(ws, { system: "billing", name: "Grace | Hopper", role: "Owner\nof billing", date: "2026-10-16", decision: "accept with conditions" });
        const after = read(ws, A("VERIFICATION.md"));
        assert.ok(after.includes("\r\n") && !/[^\r]\n/.test(after), "CRLF kept");
        const lines = after.split("\r\n");
        assert.deepEqual(changedLines(before, after).map((i) => lines[i]), [
            "| Name | Grace \\| Hopper |",
            "| Role | Owner of billing |",
            "| Date | 2026-10-16 |",
            "| Decision | accept with conditions |",
        ]);
        assert.ok(after.includes("| Name | not a sign-off row |"), "a row outside the Sign-off section is untouched");
    } finally {
        rmrf(ws);
    }
});

test("verify sign-off: refused when the file or the table is missing, or a value is not allowed", () => {
    const ws = makeWorkspace({ "analysis/billing/x": "x", "analysis/other/VERIFICATION.md": "# Verification\n\nNo table.\n" });
    try {
        const ok = { system: "billing", name: "G", role: "R", date: "2026-10-16", decision: "accept" };
        assert.equal(status(() => W.writeSignoff(ws, ok)), 404);
        assert.ok(!fs.existsSync(path.join(ws, A("VERIFICATION.md"))), "never created");
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, system: "other" })), 409);
        fs.writeFileSync(path.join(ws, A("VERIFICATION.md")), verificationMd());
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, decision: "approve" })), 400);
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, date: "16/10/2026" })), 400);
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, date: "2026-02-30" })), 400);
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, name: "   " })), 400);
        assert.equal(status(() => W.writeSignoff(ws, ok)), 200);
    } finally {
        rmrf(ws);
    }
});

test("brief approval: only the three lines inside the Approval Block fence change (inline Date)", () => {
    const before = briefMd({ phases: [phase(1, "Pilot", "transform", ["FEES"])], signed: false });
    const ws = makeWorkspace({ [A("MODERNIZATION_BRIEF.md")]: before });
    try {
        W.writeApproval(ws, { system: "billing", name: "Ada ```Lovelace", role: "Head | of billing", date: "2026-10-16", covers: "Phase 1 only" });
        const after = read(ws, A("MODERNIZATION_BRIEF.md"));
        const lines = after.split("\n");
        assert.deepEqual(changedLines(before, after).map((i) => lines[i]), [
            "Approved by: Ada '''Lovelace, Head \\| of billing  Date: 2026-10-16",
            "Approval covers: Phase 1 only",
        ]);
        assert.equal(after.split("```").length, before.split("```").length, "no fence opened or closed");
    } finally {
        rmrf(ws);
    }
});

test("brief approval: a Date on its own line is filled in place; CRLF kept", () => {
    const before = crlf(briefMd({ signed: false, inlineDate: false }));
    const ws = makeWorkspace({ [A("MODERNIZATION_BRIEF.md")]: before });
    try {
        W.writeApproval(ws, { system: "billing", name: "Ada", role: "Owner", date: "2026-10-16", covers: "Full plan" });
        const after = read(ws, A("MODERNIZATION_BRIEF.md"));
        const lines = after.split("\r\n");
        assert.deepEqual(changedLines(before, after).map((i) => lines[i]), ["Approved by: Ada, Owner", "Date: 2026-10-16", "Approval covers: Full plan"]);
    } finally {
        rmrf(ws);
    }
});

test("brief approval: refused without a fenced block, without the brief, or with an unknown scope", () => {
    const ws = makeWorkspace({ [A("MODERNIZATION_BRIEF.md")]: briefMd({ fence: false }), "analysis/other/x": "x" });
    try {
        const ok = { system: "billing", name: "Ada", role: "Owner", date: "2026-10-16", covers: "Full plan" };
        const before = read(ws, A("MODERNIZATION_BRIEF.md"));
        assert.equal(status(() => W.writeApproval(ws, ok)), 409);
        assert.equal(read(ws, A("MODERNIZATION_BRIEF.md")), before);
        assert.equal(status(() => W.writeApproval(ws, { ...ok, system: "other" })), 404);
        assert.equal(status(() => W.writeApproval(ws, { ...ok, covers: "Everything" })), 400);
    } finally {
        rmrf(ws);
    }
});

test("never writes outside analysis/<system>: links out, the legacy tree, a SOURCE path", { skip: !canSymlink && "symlinks unavailable" }, () => {
    const outside = makeWorkspace({ "elsewhere/BUSINESS_RULES.md": rulesMd(STANDARD_RULES), "elsewhere/VERIFICATION.md": verificationMd() });
    const ws = makeWorkspace({
        "legacy/billing/src/a.cbl": "x",
        "legacy/billing/VERIFICATION.md": verificationMd(),
        "analysis/real/BUSINESS_RULES.md": rulesMd(STANDARD_RULES),
        "analysis/real/VERIFICATION.md": "placeholder",
        "analysis/src/VERIFICATION.md": verificationMd(),
        "analysis/src/SOURCE": "",
    });
    try {
        const ok = { name: "G", role: "R", date: "2026-10-16", decision: "accept" };
        // analysis/<system> is a link to a folder outside analysis/
        fs.symlinkSync(path.join(outside, "elsewhere"), path.join(ws, "analysis", "linked"), "dir");
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, system: "linked" })), 404);
        assert.equal(status(() => W.writeReview(ws, { system: "linked", rule: "RULE-001", verdict: "confirmed" })), 404);
        assert.equal(read(outside, "elsewhere/VERIFICATION.md"), verificationMd());
        // analysis/<system> is a link into the legacy tree
        fs.symlinkSync(path.join(ws, "legacy", "billing"), path.join(ws, "analysis", "billing"), "dir");
        assert.ok([403, 404].includes(status(() => W.writeSignoff(ws, { ...ok, system: "billing" }))));
        assert.equal(read(ws, "legacy/billing/VERIFICATION.md"), verificationMd());
        // a file in analysis/<system> that is a link into the legacy tree
        fs.rmSync(path.join(ws, "analysis/real/VERIFICATION.md"));
        fs.symlinkSync(path.join(ws, "legacy/billing/VERIFICATION.md"), path.join(ws, "analysis/real/VERIFICATION.md"));
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, system: "real" })), 403);
        assert.equal(read(ws, "legacy/billing/VERIFICATION.md"), verificationMd());
        // a system whose analysis folder is recorded as a SOURCE (protected code location)
        fs.writeFileSync(path.join(ws, "analysis/src/SOURCE"), `${path.join(ws, "analysis", "src")}\n`);
        assert.equal(status(() => W.writeSignoff(ws, { ...ok, system: "src" })), 403);
        assert.equal(read(ws, "analysis/src/VERIFICATION.md"), verificationMd());
        // traversal in the system name never reaches the file system
        for (const system of ["..", "../legacy", "a/b", "a\\b", ".hidden", ""]) assert.equal(status(() => W.writeSignoff(ws, { ...ok, system })), 400, system);
        assert.equal(status(() => W.targetPath(ws, "real", "BUSINESS_RULES.md")), 400, "only the four files the page writes");
    } finally {
        rmrf(ws);
        rmrf(outside);
    }
});

test("writes are atomic: no temp file is left behind", () => {
    const ws = makeWorkspace({ [A("BUSINESS_RULES.md")]: rulesMd(STANDARD_RULES), [A("VERIFICATION.md")]: verificationMd() });
    try {
        W.writeReview(ws, { system: "billing", rule: "RULE-001", verdict: "confirmed" });
        W.writeSignoff(ws, { system: "billing", name: "G", role: "R", date: "2026-10-16", decision: "reject" });
        assert.deepEqual(fs.readdirSync(path.join(ws, "analysis/billing")).sort(), ["BUSINESS_RULES.md", "RULE_REVIEWS.json", "RULE_REVIEWS.md", "VERIFICATION.md"]);
    } finally {
        rmrf(ws);
    }
});
