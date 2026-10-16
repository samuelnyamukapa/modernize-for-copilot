// Small synthetic workspaces for the canvas tests, modelled on what the skills really write
// (rule cards from render_rules.py, the brief's phase and approval shapes, proof_pack.py's
// VERIFICATION.json and Sign-off table, the harden scorecard, the map skill's topology tree).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CANVAS = new URL("../../../com.github.copilot/extensions/modernize-canvas/", import.meta.url);

/** A temp workspace: files is {"rel/path": text}; mtimes is {"rel/path": seconds ago}. */
export function makeWorkspace(files = {}, mtimes = {}) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "modernize-canvas-"));
    for (const [rel, text] of Object.entries(files)) {
        const p = path.join(ws, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (text === null) fs.mkdirSync(p, { recursive: true });
        else fs.writeFileSync(p, text);
    }
    for (const [rel, secondsAgo] of Object.entries(mtimes)) setAge(ws, rel, secondsAgo);
    return ws;
}

export function setAge(ws, rel, secondsAgo) {
    const t = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(path.join(ws, rel), t, t);
}

export const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

export function card({ id, name, priority = "P1", confidence = "High", question, defect, category = "Calculation" }) {
    return [
        `### ${id}: ${name}`,
        `**Category:** ${category}`,
        `**Priority:** ${priority}`,
        `**Source:** \`src/Billing/Fees.cs:10-20\``,
        `**Plain English:** ${name}, in plain words.`,
        "**Specification:**",
        "  Given an account in good standing",
        "  When  a fee is charged",
        "  Then  the fee is 2.5% rounded down",
        "  And   never below 1.00",
        "**Parameters:** RATE=0.025",
        "**Edge cases handled:** zero balance",
        ...(defect ? [`**Suspected defect:** ${defect}`] : []),
        `**Confidence:** ${confidence}${question ? ` — ${question}` : ""}`,
    ].join("\n");
}

export function rulesMd(cards) {
    return [
        "# Business Rules — billing",
        "",
        "At extraction: some confirmed rules.",
        "",
        "| ID | Name | Category | Priority | Source | Confidence |",
        "|---|---|---|---|---|---|",
        "",
        "## Calculation",
        "",
        ...cards.map((c) => `${card(c)}\n`),
        "## Rules requiring SME confirmation",
        "",
        ...cards.filter((c) => c.confidence && c.confidence !== "High").map((c) => `- **${c.id}** (${c.confidence}): ${c.question ?? "Confirm this rule."}`),
        "",
    ].join("\n");
}

export const STANDARD_RULES = [
    { id: "RULE-001", name: "Fee is 2.5 percent", priority: "P0" },
    { id: "RULE-002", name: "Late fee waived once a year", priority: "P0", confidence: "Medium", question: "Is the waiver per calendar year or rolling?" },
    { id: "RULE-003", name: "Rounding truncates", priority: "P0", defect: "Truncation loses a cent on odd amounts." },
    { id: "RULE-004", name: "Statement footer text", priority: "P2", confidence: "Low", question: "Still used?" },
    { id: "RULE-010", name: "Interest accrues daily", priority: "P1" },
];

export function phase(n, title, command, modules, { entry = [false], exit = [false] } = {}) {
    return [
        `#### Phase ${n} — ${title}`,
        `Command: /modernize:${command}`,
        `Modules: ${modules.join(", ")}`,
        "Scale: M",
        "Risk: Medium; mitigations",
        "Entry criteria:",
        ...entry.map((t, i) => `- [${t ? "x" : " "}] entry condition ${i + 1}`),
        "Exit criteria:",
        ...exit.map((t, i) => `- [${t ? "x" : " "}] exit condition ${i + 1}`),
        "",
    ].join("\n");
}

export function briefMd({ phases = [], signed = false, covers = "Full plan", inlineDate = true, openQuestions = [], fence = true } = {}) {
    const block = signed
        ? inlineDate
            ? [`Approved by: Ada Lovelace, Head of Billing  Date: 2026-10-01`, `Approval covers: ${covers}`]
            : [`Approved by: Ada Lovelace, Head of Billing`, `Date: 2026-10-01`, `Approval covers: ${covers}`]
        : inlineDate
            ? ["Approved by: ________________  Date: __________", "Approval covers: Phase 1 only | Full plan"]
            : ["Approved by: ________________", "Date: __________", "Approval covers: Phase 1 only | Full plan"];
    return [
        "# Modernization Brief: billing (COBOL → Java)",
        "",
        "**Target stack:** `java-spring`",
        "",
        "## 1. Objective",
        "",
        "Move billing.",
        "",
        "## 3. Phased Sequence",
        "",
        ...phases,
        "## 7. Open Questions",
        "",
        "### Before Phase 1",
        "",
        ...openQuestions.map((q) => `- [ ] ${q}`),
        "- [x] An answered question",
        "",
        "## 8. Approval Block",
        "",
        ...(fence ? ["```text", ...block, "```"] : block),
        "",
        "Tell the approver how to sign.",
        "",
    ].join("\n");
}

/** The proof pack's minute stamp, `2026-10-15 19:07 UTC`. */
export const packStamp = (d = new Date()) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

export function verificationJson(modules, generated = packStamp()) {
    return JSON.stringify({
        v: 1,
        system: "billing",
        generated,
        modules: modules.map((m) => ({ name: m.name, track: m.track ?? "rewrite", verdict: m.verdict, reasons: m.reasons ?? [], verifiedAt: m.verifiedAt ?? generated })),
        toolingOnly: [],
        signoff: { name: "", role: "", date: "", decision: "" },
        overall: { verdict: modules[0]?.verdict ?? "NOT PROVEN", counts: {} },
    }, null, 2);
}

export function verificationMd({ signed = false } = {}) {
    return [
        "# Verification: billing",
        "",
        "**Overall: PROVEN** (1 proven)",
        "",
        "| Module | Track | Verdict |",
        "|---|---|---|",
        "| FEES | rewrite | **PROVEN** |",
        "",
        "## Sign-off",
        "",
        "A person fills this in. Copilot leaves it blank.",
        "",
        "| | |",
        "|---|---|",
        `| Name | ${signed ? "Grace Hopper" : "________________"} |`,
        `| Role | ${signed ? "Product owner" : "________________"} |`,
        `| Date | ${signed ? "2026-10-15" : "__________"} |`,
        `| Decision | ${signed ? "accept" : "accept / accept with conditions / reject"} |`,
        "",
        "## How each verdict is computed",
        "",
        "| Name | not a sign-off row |",
        "",
    ].join("\n");
}

export const SECURITY_MD = [
    "# Security hardening - billing",
    "",
    "## Scorecard",
    "",
    "| Critical | High | Medium | Low | Disputed |",
    "|---|---|---|---|---|",
    "| 1 | 2 | 3 | 4 | 0 |",
    "",
    "## Findings",
    "",
    "| ID | Severity | Source | Vulnerability |",
    "|---|---|---|---|",
    "| SEC-001 | High | `a.cs:1` | x |",
    "",
].join("\n");

export function topologyJson(domains) {
    return JSON.stringify({
        system: "billing",
        root: {
            id: "sys",
            name: "billing",
            kind: "system",
            children: [
                ...Object.entries(domains).map(([dom, mods]) => ({
                    id: `dom:${dom}`,
                    name: dom,
                    kind: "domain",
                    children: mods.map(([id, loc, file]) => ({ id, name: id, kind: "module", language: "cobol", loc, file })),
                })),
                { id: "dom:data", name: "Data stores", kind: "domain", children: [{ id: "ds:ACCTS", name: "ACCTS", kind: "datastore" }] },
            ],
        },
        edges: [],
        entryPoints: [],
        deadEnds: [],
        observations: [],
        flows: [],
    });
}

export const STANDARD_TOPOLOGY = { Fees: [["FEES", 800, "src/FEES.cbl"], ["RATES", 200, "src/RATES.cbl"]], Statements: [["STMT", 1200, "src/STMT.cbl"], ["FOOTER", 50, "src/FOOTER.cbl"]] };

export function rmrf(ws) {
    fs.rmSync(ws, { recursive: true, force: true });
}
