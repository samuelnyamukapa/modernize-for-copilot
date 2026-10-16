// The one next command, following plugin/skills/status/SKILL.md's order, tested on facts directly.
//   node --test plugin/tools/tests/canvas/next.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { CANVAS } from "./fixtures.mjs";

const { progressOf } = await import(new URL("progress.mjs", CANVAS));

const T = 1_700_000_000_000;
const signedBrief = (phases, covers = "Full plan") => ({ phases, openQuestions: 0, rulesInQuestions: [], target: "java-spring", approval: { hasBlock: true, signed: true, by: "Ada", covers } });
const ph = (number, modules, command = "transform") => ({ number, title: `P${number}`, command, modules, entry: [], exit: [] });

/** Facts for a system that has finished discovery; `over` replaces fields. */
function facts(over = {}) {
    const files = {
        "INTENT.md": T, "PREFLIGHT.md": T + 1, "ASSESSMENT.md": T + 2, "topology.json": T + 3, "BUSINESS_RULES.md": T + 4,
        "MODERNIZATION_BRIEF.md": T + 10, ...(over.files ?? {}),
    };
    for (const [k, v] of Object.entries(files)) if (v === null) delete files[k];
    return {
        system: "billing", track: "rewrite", intent: { goal: "transform", securityFirst: false }, hasAnalysis: true, legacyExists: true, hasSource: false,
        rules: [], reviews: {}, brief: signedBrief([ph(1, ["FEES", "RATES"]), ph(2, ["STMT"])]), verification: null, signoff: null, security: null,
        modules: [], upliftNotesMs: null, reimaginedHandoffMs: null, mapCount: 4, deltaCount: 0,
        ...over,
        files,
    };
}
const next = (over) => progressOf(facts(over)).next;
const only = (...names) => Object.fromEntries(["INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md", "topology.json", "BUSINESS_RULES.md", "MODERNIZATION_BRIEF.md"].map((n) => [n, names.includes(n) ? T : null]));
const mod = (name, built = true, newestMs = T + 20) => ({ name, built, notesMs: built ? T + 20 : null, newestMs });
const verif = (entries, atMs = T + 100) => ({ overall: null, tooling: [], modules: entries.map(([name, verdict, reason = ""]) => ({ name, track: "rewrite", verdict, reason, atMs })) });

test("nothing yet: the front door, with --source when the code is not linked", () => {
    assert.equal(next({ hasAnalysis: false, files: only() }).command, "/modernize:start billing");
    assert.equal(next({ hasAnalysis: false, legacyExists: false, files: only() }).command, "/modernize:start billing --source <path to the code>");
});

test("discovery in order: preflight, assess, map, extract-rules", () => {
    assert.equal(next({ files: only("INTENT.md"), brief: null }).command, "/modernize:preflight billing");
    assert.equal(next({ files: only("INTENT.md", "PREFLIGHT.md"), brief: null }).command, "/modernize:assess billing");
    assert.equal(next({ files: only("INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md"), brief: null }).command, "/modernize:map billing");
    assert.equal(next({ files: only("INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md", "topology.json"), brief: null }).command, "/modernize:extract-rules billing");
});

test("a security review chosen first comes right after the assessment", () => {
    assert.equal(next({ intent: { goal: "transform", securityFirst: true }, files: only("INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md"), brief: null }).command, "/modernize:harden billing");
});

test("an uplift does not need a rules file before its brief", () => {
    assert.equal(next({ track: "uplift", intent: { goal: "uplift" }, files: only("INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md", "topology.json"), brief: null }).command, "/modernize:brief billing");
});

test("flagged P0 rules without a verdict send the person to review; rules only named in open questions do not block", () => {
    const rules = [{ id: "RULE-001", priority: "P0", confidence: "Medium" }, { id: "RULE-002", priority: "P1", confidence: "Low" }];
    assert.equal(next({ rules, brief: null }).command, "/modernize:review billing");
    assert.equal(next({ rules, reviews: { "RULE-001": { verdict: "wrong" } }, brief: null }).command, "/modernize:brief billing");
    const named = { ...signedBrief([]), rulesInQuestions: ["RULE-002"] };
    const p = progressOf(facts({ rules, reviews: { "RULE-001": { verdict: "confirmed" } }, brief: named }));
    assert.deepEqual(p.flagged.map((r) => r.id), ["RULE-002"], "the deck holds it");
    assert.notEqual(p.next.command, "/modernize:review billing");
});

test("brief: missing, stale, unsigned, or an understand-only goal", () => {
    assert.equal(next({ brief: null, files: { "MODERNIZATION_BRIEF.md": null } }).command, "/modernize:brief billing");
    const stale = next({ files: { "MODERNIZATION_BRIEF.md": T + 1 } });
    assert.equal(stale.command, "/modernize:brief billing");
    assert.match(stale.reason, /older than/);
    const unsigned = next({ brief: { phases: [], openQuestions: 0, rulesInQuestions: [], approval: { hasBlock: true, signed: false } } });
    assert.equal(unsigned.action, "sign-brief");
    assert.equal(unsigned.command, undefined);
    assert.equal(next({ brief: { phases: [], openQuestions: 0, rulesInQuestions: [], approval: { hasBlock: false, signed: false } } }).command, "/modernize:brief billing");
    assert.equal(next({ intent: { goal: "understand" } }).command, "/modernize:status billing");
});

test("rewrite: the first approved module not built, with the target stack", () => {
    assert.equal(next({}).command, "/modernize:transform billing FEES java-spring");
});

test("rewrite: verify comes before building the next module, and a proof is not done until a person signs", () => {
    assert.equal(next({ modules: [mod("FEES")] }).command, "/modernize:verify billing FEES");
    const notProven = next({ modules: [mod("FEES")], verification: verif([["FEES", "NOT PROVEN", "Tests: 1 failed."]]) });
    assert.equal(notProven.command, "/modernize:verify billing FEES");
    assert.match(notProven.reason, /NOT PROVEN: Tests: 1 failed\./);
    assert.equal(next({ modules: [mod("FEES")], verification: verif([["FEES", "PARTLY PROVEN"]]) }).command, "/modernize:verify billing FEES");
    const changed = next({ modules: [mod("FEES", true, T + 10_000_000)], verification: verif([["FEES", "PROVEN"]]) });
    assert.match(changed.reason, /changed after it was verified/);
    const unsigned = next({ modules: [mod("FEES")], verification: verif([["FEES", "PROVEN"]]), signoff: { hasTable: true, signed: false } });
    assert.equal(unsigned.action, "sign-verification");
    const signed = next({ modules: [mod("FEES")], verification: verif([["FEES", "PROVEN"]]), signoff: { hasTable: true, signed: true } });
    assert.equal(signed.command, "/modernize:transform billing RATES java-spring");
});

test("rewrite: an unbuilt module still in progress is the one to build; an untokenisable id becomes <module>", () => {
    assert.equal(next({ modules: [mod("FEES", false)] }).command, "/modernize:transform billing FEES java-spring");
    assert.equal(next({ brief: signedBrief([ph(1, ["Fees screen"])]) }).command, "/modernize:transform billing <module> java-spring");
});

test("rewrite: after the approved phases, harden; then revise the brief for the next phases, or status when all is done", () => {
    const done = { modules: [mod("FEES"), mod("RATES")], verification: verif([["FEES", "PROVEN"], ["RATES", "PROVEN"]]), signoff: { hasTable: true, signed: true } };
    const phase1 = signedBrief([ph(1, ["FEES", "RATES"]), ph(2, ["STMT"])], "Phase 1 only");
    assert.equal(next({ ...done, brief: phase1 }).command, "/modernize:harden billing");
    assert.equal(next({ ...done, brief: phase1, files: { "SECURITY_FINDINGS.md": T + 50 } }).command, "/modernize:brief billing");
    const all = { ...done, brief: signedBrief([ph(1, ["FEES", "RATES"])]), files: { "SECURITY_FINDINGS.md": T + 50 } };
    const finalStep = next(all);
    assert.equal(finalStep.command, "/modernize:parity billing");
    assert.match(finalStep.reason, /HTTP or SOAP endpoints/);
    const signedParity = { verdict: "PARITY", atMs: T + 200, different: 0, breaking: 0, signoff: { hasTable: true, signed: true } };
    assert.equal(next({ ...all, parity: signedParity }).command, "/modernize:status billing");
});

test("parity: a stale, failing or unsigned report comes right after verify; its step and attention show up only once it exists", () => {
    const done = { modules: [mod("FEES"), mod("RATES")], verification: verif([["FEES", "PROVEN"], ["RATES", "PROVEN"]]), signoff: { hasTable: true, signed: true },
                   brief: signedBrief([ph(1, ["FEES", "RATES"])], "Phase 1 only") };
    const report = (over) => ({ verdict: "PARITY", atMs: T + 200, different: 0, breaking: 0, signoff: { hasTable: true, signed: true }, ...over });
    assert.ok(!progressOf(facts(done)).stages.some((st) => st.key === "parity"));

    const failing = progressOf(facts({ ...done, parity: report({ verdict: "NO PARITY", different: 3, breaking: 1, signoff: { hasTable: true, signed: false } }) }));
    assert.equal(failing.next.command, "/modernize:parity billing");
    assert.match(failing.next.reason, /parity is NO PARITY/);
    assert.ok(failing.attention.some((a) => a.kind === "parity" && /3 unexplained differences, 1 breaking contract change$/.test(a.text)));
    const stage = failing.stages.find((st) => st.key === "parity");
    assert.equal(stage.done, false);
    assert.equal(stage.detail, "NO PARITY");
    assert.deepEqual(failing.stages.map((st) => st.key).slice(-3), ["verify", "parity", "harden"]);

    const unsigned = progressOf(facts({ ...done, parity: report({ signoff: { hasTable: true, signed: false } }) }));
    assert.match(unsigned.next.reason, /no person has signed it/);
    assert.ok(unsigned.attention.some((a) => a.text === "parity/PARITY.md is not signed by a person"));

    const stale = progressOf(facts({ ...done, modules: [mod("FEES", true, T + 10_000_000), mod("RATES")], verification: verif([["FEES", "PROVEN"], ["RATES", "PROVEN"]], T + 20_000_000), parity: report() }));
    assert.match(stale.next.reason, /changed since parity was checked/);
    assert.ok(stale.stale.some((x) => x.artifact === "parity/PARITY.md"));
    assert.equal(stale.stages.find((st) => st.key === "parity").done, false);

    const good = progressOf(facts({ ...done, parity: report() }));
    assert.equal(good.next.command, "/modernize:harden billing");
    assert.equal(good.stages.find((st) => st.key === "parity").done, true);
    assert.equal(progressOf(facts({ ...done, parity: report({ verdict: null }) })).next.reason, "parity/PARITY.json cannot be read: run the check again");
});

test("uplift: baseline, pilot, the rest, then verify the working copy as a whole", () => {
    const base = { track: "uplift", intent: { goal: "uplift" }, brief: signedBrief([ph(1, ["A"], "uplift")]) };
    assert.match(next({ ...base, files: { "DELTA_CATALOG.md": T + 5 } }).reason, /records what the tests do today/);
    assert.match(next({ ...base, files: { "DELTA_CATALOG.md": T + 5, "BASELINE.md": T + 11 } }).reason, /pilot/);
    const f = { "DELTA_CATALOG.md": T + 5, "BASELINE.md": T + 11, "PLAYBOOK.md": T + 12 };
    assert.match(next({ ...base, files: f }).reason, /migrates the rest/);
    const built = { ...base, files: f, upliftNotesMs: T + 30, modules: [{ name: "billing-uplifted", built: true, newestMs: T + 30 }] };
    assert.equal(next(built).command, "/modernize:verify billing");
    assert.equal(next({ ...base, files: f }).command, "/modernize:uplift billing");
});

test("uplift: a brief with no delta catalog is stale and is redone first", () => {
    const n = next({ track: "uplift", intent: { goal: "uplift" } });
    assert.equal(n.command, "/modernize:brief billing");
    assert.match(n.reason, /no DELTA_CATALOG\.md/);
});

test("reimagine: spec, design, scaffold with the vision, then verify each service", () => {
    const base = { track: "reimagine", intent: { goal: "reimagine", to: "REST API and SPA" }, brief: signedBrief([ph(1, [], "reimagine")]) };
    assert.equal(next(base).command, '/modernize:reimagine billing "REST API and SPA"');
    assert.match(next({ ...base, files: { "AI_NATIVE_SPEC.md": T + 20 } }).reason, /designs the new architecture/);
    const built = { ...base, files: { "AI_NATIVE_SPEC.md": T + 20, "REIMAGINED_ARCHITECTURE.md": T + 21 }, reimaginedHandoffMs: T + 40, modules: [{ name: "orders", built: true, newestMs: T + 40 }] };
    assert.equal(next(built).command, "/modernize:verify billing orders");
});

test("attention lists what needs a person", () => {
    const p = progressOf(facts({
        brief: { phases: [], openQuestions: 0, rulesInQuestions: [], approval: { hasBlock: true, signed: false } },
        rules: [{ id: "RULE-001", priority: "P0", confidence: "Low" }, { id: "RULE-002", priority: "P0", confidence: "High" }],
        reviews: { "RULE-002": { verdict: "discuss" } },
        modules: [mod("FEES")],
        verification: verif([["FEES", "NOT PROVEN", "why"]]),
        signoff: { hasTable: true, signed: false },
        security: { Critical: 0, High: 2, Medium: 0, Low: 0 },
        files: { "MODERNIZATION_BRIEF.md": T + 1 },
    }));
    assert.deepEqual(p.attention.map((a) => a.kind), ["brief", "review", "review", "proof", "signoff", "stale", "stale", "stale", "security"]);
    assert.equal(p.attention.find((a) => a.kind === "proof").text, "FEES: NOT PROVEN: why");
});

test("an understand-only goal shows the discovery steps and harden, no build steps", () => {
    const keys = progressOf(facts({ intent: { goal: "understand" } })).stages.map((s) => s.key);
    assert.deepEqual(keys, ["intent", "preflight", "assess", "map", "extract-rules", "review", "brief", "harden"]);
});
