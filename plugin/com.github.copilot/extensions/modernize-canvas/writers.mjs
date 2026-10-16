// The only writes the live status page makes, each filled in by the person using the page:
//   - a rule verdict, merged into analysis/<system>/RULE_REVIEWS.json in exactly the format
//     /modernize:review writes, with RULE_REVIEWS.md regenerated from it;
//   - the verify sign-off: the four value cells of VERIFICATION.md's `## Sign-off` table;
//   - the brief's approval: the `Approved by:`, `Date:` and `Approval covers:` lines inside the
//     Approval Block code fence of MODERNIZATION_BRIEF.md.
// Nothing else is ever written, and only inside analysis/<system>/ of the workspace: never under
// the legacy tree or a path recorded in analysis/*/SOURCE. A missing file or block is refused,
// never created (RULE_REVIEWS.json is the one file a first verdict may create, as the skill does).
// Adapted from anthropics/claude-plugins-official plugins/code-modernization/hooks/review/
// (deck.ts, ledger.ts) and hooks/sign.ts (Apache-2.0).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
    isSystemName, isRuleId, parseRules, parseReviews, VERDICTS, compareRuleIds, findSignoffTable,
    findApprovalBlock, DECISIONS,
} from "./parsers.mjs";
import { legacyDirName } from "./reader.mjs";

export class WriteError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const WRITABLE = new Set(["RULE_REVIEWS.json", "RULE_REVIEWS.md", "VERIFICATION.md", "MODERNIZATION_BRIEF.md"]);
const MAX_FILE = 8 * 1024 * 1024;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A value for one Markdown table cell or one line: one line, `|` and `\` escaped, invisible characters gone. */
export function cellValue(value, max = 120) {
    const flat = String(value ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, max);
    return flat.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** A value for a line inside a code fence: also no backticks, so it cannot close the fence. */
const fenceValue = (value, max) => cellValue(value, max).replace(/`/g, "'");

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(d) {
    if (!DATE.test(d ?? "")) return false;
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

function required(value, name, max) {
    if (typeof value !== "string" || value.replace(INVISIBLE, "").trim() === "") throw new WriteError(400, `${name} is required`);
    if (value.length > max) throw new WriteError(400, `${name} is longer than ${max} characters`);
    return value;
}

const inside = (root, p) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const realOrNull = (p) => {
    try {
        return fs.realpathSync(p);
    } catch {
        return null;
    }
};

/** Folders the page must never write to: the legacy tree (and each link's target) and every analysis/*\/SOURCE path. */
export function protectedRoots(ws) {
    const roots = [];
    const add = (p) => {
        if (!p) return;
        roots.push(path.resolve(p));
        const r = realOrNull(p);
        if (r) roots.push(r);
    };
    const legacy = path.join(ws, legacyDirName(ws));
    add(legacy);
    try {
        for (const e of fs.readdirSync(legacy)) add(path.join(legacy, e));
    } catch {
        // no legacy tree
    }
    const analysis = path.join(ws, "analysis");
    try {
        for (const e of fs.readdirSync(analysis)) {
            try {
                const src = fs.readFileSync(path.join(analysis, e, "SOURCE"), "utf8").split(/\r?\n/)[0].trim();
                if (src) add(path.isAbsolute(src) ? src : path.join(ws, src));
            } catch {
                // no SOURCE for this system
            }
        }
    } catch {
        // no analysis/
    }
    return roots;
}

/**
 * The real path of analysis/<system>/<file>, after every check: a valid system name, a whitelisted file name,
 * a real analysis/<system> folder that resolves inside the real analysis/ folder, a target that is not a link out
 * of it, and nothing under the legacy tree or a SOURCE path. Throws WriteError otherwise.
 */
export function targetPath(ws, system, file) {
    if (!isSystemName(system)) throw new WriteError(400, "invalid system name");
    if (!WRITABLE.has(file)) throw new WriteError(400, "not a file the page writes");
    const wsReal = realOrNull(ws);
    if (!wsReal) throw new WriteError(404, "workspace not found");
    const analysis = realOrNull(path.join(wsReal, "analysis"));
    if (!analysis || !inside(wsReal, analysis)) throw new WriteError(404, "analysis/ not found in the workspace");
    const dir = realOrNull(path.join(analysis, system));
    if (!dir || !inside(analysis, dir) || path.dirname(dir) !== analysis) throw new WriteError(404, `analysis/${system} not found`);
    if (!fs.statSync(dir).isDirectory()) throw new WriteError(404, `analysis/${system} is not a folder`);
    const target = path.join(dir, file);
    const real = realOrNull(target) ?? target;
    if (path.dirname(real) !== dir) throw new WriteError(403, `${file} resolves outside analysis/${system}`);
    for (const root of protectedRoots(wsReal)) {
        if (inside(root, real) || inside(root, dir)) throw new WriteError(403, "refused: that path is read-only legacy source");
    }
    return real;
}

/** Writes a temp file beside `target`, then renames it over the target. */
export function atomicWrite(target, text) {
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    try {
        fs.renameSync(tmp, target);
    } catch (err) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // already gone
        }
        throw err;
    }
}

function readExisting(p) {
    let s;
    try {
        s = fs.lstatSync(p);
    } catch {
        return null;
    }
    if (!s.isFile()) throw new WriteError(409, `${path.basename(p)} is not a regular file`);
    if (s.size > MAX_FILE) throw new WriteError(413, `${path.basename(p)} is too large`);
    return fs.readFileSync(p, "utf8");
}

// ---------------------------------------------------------------- reviews

const VERDICT_WORDS = { confirmed: "Confirmed", wrong: "Wrong", discuss: "Needs discussion" };

/** RULE_REVIEWS.md from the ledger: a short paragraph, then `Rule | Verdict | When | Title | Note` by rule number. */
export function reviewsMarkdown(system, reviews) {
    const entries = Object.entries(reviews).sort((a, b) => compareRuleIds(a[0], b[0]));
    const count = (v) => entries.filter(([, e]) => e.verdict === v).length;
    return [
        `# Rule reviews: ${system}`,
        "",
        `A person's verdict on business rules in \`BUSINESS_RULES.md\`, written by \`/modernize:review\` or the live status canvas. ${count("confirmed")} confirmed, ${count("wrong")} wrong, ${count("discuss")} needing discussion. A rule marked **Wrong** or **Needs discussion** is not settled: \`brief\` lists it as an open question, and the build commands do not build on it. A rule with no row here has not been reviewed.`,
        "",
        "| Rule | Verdict | When | Title | Note |",
        "|---|---|---|---|---|",
        ...entries.map(([id, e]) => `| ${cellValue(id, 40)} | ${VERDICT_WORDS[e.verdict]} | ${cellValue((e.at ?? "").slice(0, 10), 10)} | ${cellValue(e.title, 200)} | ${cellValue(e.note, 600)} |`),
        "",
    ].join("\n");
}

/**
 * Records one verdict. `body` is {system, rule, verdict: confirmed | wrong | discuss, note?}. The rule must be a card in
 * BUSINESS_RULES.md (its title is taken from there, never from the request). Every entry already in the file is kept;
 * only the answered rule's entry is replaced.
 */
export function writeReview(ws, body, now = new Date()) {
    const { system, rule, verdict } = body ?? {};
    if (!isSystemName(system)) throw new WriteError(400, "invalid system name");
    if (!isRuleId(rule)) throw new WriteError(400, "invalid rule id");
    if (!VERDICTS.includes(verdict)) throw new WriteError(400, "verdict must be confirmed, wrong or discuss");
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) throw new WriteError(400, "note must be text of at most 2000 characters");
    const jsonPath = targetPath(ws, system, "RULE_REVIEWS.json");
    const mdPath = targetPath(ws, system, "RULE_REVIEWS.md");
    const rulesText = readExisting(path.join(path.dirname(jsonPath), "BUSINESS_RULES.md"));
    if (rulesText === null) throw new WriteError(404, "BUSINESS_RULES.md not found");
    const card = parseRules(rulesText).find((r) => r.id === rule);
    if (!card) throw new WriteError(404, `${rule} is not in BUSINESS_RULES.md`);

    const existing = readExisting(jsonPath);
    const parsed = parseReviews(existing);
    if (!parsed.ok) throw new WriteError(409, "RULE_REVIEWS.json is not readable JSON; fix it by hand first");
    const raw = parsed.raw ?? {};
    const reviews = { ...(raw.reviews ?? {}) };
    const note = typeof body.note === "string" ? body.note.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim() : "";
    reviews[rule] = { verdict, at: now.toISOString(), title: card.title, ...(note && { note }) };
    const out = { ...raw, system, version: raw.version ?? 1, reviews };
    atomicWrite(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
    atomicWrite(mdPath, reviewsMarkdown(system, parseReviews(JSON.stringify(out)).reviews));
    return { ok: true, rule, verdict };
}

// ---------------------------------------------------------------- sign-off

/** VERIFICATION.md with the four value cells of its `## Sign-off` table filled; null when the table is missing. */
export function applySignoff(text, { name, role, date, decision }) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const table = findSignoffTable(lines);
    if (!table) return null;
    const values = { Name: cellValue(name), Role: cellValue(role), Date: cellValue(date, 10), Decision: cellValue(decision, 40) };
    for (const [key, row] of Object.entries(table.rows)) {
        lines[row.index] = lines[row.index].replace(/^(\s*\|\s*[A-Za-z]+\s*\|).*(\|\s*)$/, (_, head, tail) => `${head} ${values[key]} ${tail.trimEnd()}`);
    }
    return lines.join(eol);
}

/** Signs analysis/<system>/VERIFICATION.md: {system, name, role, date: YYYY-MM-DD, decision}. */
export function writeSignoff(ws, body) {
    const { system } = body ?? {};
    if (!isSystemName(system)) throw new WriteError(400, "invalid system name");
    const name = required(body.name, "name", 120);
    const role = required(body.role, "role", 120);
    if (!validDate(body.date)) throw new WriteError(400, "date must be YYYY-MM-DD");
    if (!DECISIONS.includes(body.decision)) throw new WriteError(400, "decision must be accept, accept with conditions or reject");
    const target = targetPath(ws, system, "VERIFICATION.md");
    const text = readExisting(target);
    if (text === null) throw new WriteError(404, "VERIFICATION.md not found: run /modernize:verify first");
    const out = applySignoff(text, { name, role, date: body.date, decision: body.decision });
    if (out === null) throw new WriteError(409, "VERIFICATION.md has no Sign-off table with Name, Role, Date and Decision rows");
    atomicWrite(target, out);
    return { ok: true };
}

export const COVERS = ["Phase 1 only", "Full plan"];

/** The brief with its Approval Block filled; null when the block (or one of its lines) is missing. */
export function applyApproval(text, { name, role, date, covers }) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const block = findApprovalBlock(lines);
    if (!block) return null;
    const at = (re) => {
        for (let i = block.open + 1; i < block.close; i++) if (re.test(lines[i])) return i;
        return -1;
    };
    const by = at(/^\s*Approved by\s*:/i);
    const cov = at(/^\s*Approval covers\s*:/i);
    const inlineDate = by >= 0 && /\bDate\s*:/i.test(lines[by]);
    const dateLine = inlineDate ? by : at(/^\s*Date\s*:/i);
    if (by < 0 || cov < 0 || dateLine < 0) return null;
    const who = fenceValue(`${name}, ${role}`, 250);
    const when = fenceValue(date, 10);
    const indent = (i) => /^\s*/.exec(lines[i])[0];
    lines[by] = inlineDate ? `${indent(by)}Approved by: ${who}  Date: ${when}` : `${indent(by)}Approved by: ${who}`;
    if (!inlineDate) lines[dateLine] = `${indent(dateLine)}Date: ${when}`;
    lines[cov] = `${indent(cov)}Approval covers: ${fenceValue(covers, 40)}`;
    return lines.join(eol);
}

/** Signs the approval block of analysis/<system>/MODERNIZATION_BRIEF.md: {system, name, role, date, covers}. */
export function writeApproval(ws, body) {
    const { system } = body ?? {};
    if (!isSystemName(system)) throw new WriteError(400, "invalid system name");
    const name = required(body.name, "name", 120);
    const role = required(body.role, "role", 120);
    if (!validDate(body.date)) throw new WriteError(400, "date must be YYYY-MM-DD");
    if (!COVERS.includes(body.covers)) throw new WriteError(400, "approval covers must be Phase 1 only or Full plan");
    const target = targetPath(ws, system, "MODERNIZATION_BRIEF.md");
    const text = readExisting(target);
    if (text === null) throw new WriteError(404, "MODERNIZATION_BRIEF.md not found: run /modernize:brief first");
    const out = applyApproval(text, { name, role, date: body.date, covers: body.covers });
    if (out === null) throw new WriteError(409, "the brief has no Approval Block code fence with Approved by:, Date: and Approval covers: lines");
    atomicWrite(target, out);
    return { ok: true };
}
