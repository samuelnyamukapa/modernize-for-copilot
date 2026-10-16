// Pure text parsers for the files the modernize skills write under analysis/<system>/.
// No file access and no SDK import: the reader feeds them text, the tests feed them fixtures.
// Adapted from anthropics/claude-plugins-official plugins/code-modernization/hooks/reader/*.ts
// and hooks/text.ts (Apache-2.0), ported to plain JavaScript and cut down to what the canvas shows.
//
// Every file is written by an agent from an untrusted code base, so every field is optional:
// anything that does not fit is dropped, never thrown on, and nothing here is ever rendered
// as HTML (the page uses textContent only).

/** The longest line a parser looks at; a longer one is not a card, and a pattern run over it is what a hostile file is for. */
export const MAX_LINE = 4000;

/** The names the skills accept for a system: letters, digits, hyphen and underscore. */
const SYSTEM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const isSystemName = (value) => typeof value === "string" && SYSTEM_NAME.test(value);

/** Safe to place in a command line: one plain token, letter or digit first. */
export const isToken = (value) => typeof value === "string" && TOKEN.test(value);

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One short line of ordinary characters, for text that goes in front of the agent. */
export function plain(value, max = 160) {
    if (typeof value !== "string") return "";
    const flat = value.replace(INVISIBLE, " ").replace(/[`<>[\]]/g, "_").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** One short line for the page: control characters gone, length capped. The page renders it as text, never markup. */
export function line(value, max = 300) {
    if (typeof value !== "string") return "";
    const flat = value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** `text` as lines, CRLF or LF, each cut to what a parser looks at. */
export const linesOf = (text) =>
    String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const stripMd = (t) => t.replace(/\*\*/g, "").replace(/`/g, "").trim();
const isBlank = (v) => v === undefined || v === null || String(v).replace(/[\s_]/g, "") === "";

/** The number in `RULE-012` (12), for sorting by rule number. */
export function ruleNumber(id) {
    const m = /(\d+)[a-z]?$/.exec(String(id));
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export const compareRuleIds = (a, b) => ruleNumber(a) - ruleNumber(b) || String(a).localeCompare(String(b));

// ---------------------------------------------------------------- INTENT.md

const GOALS = ["uplift", "transform", "reimagine", "understand"];

/**
 * INTENT.md, written by /modernize:start: the goal (uplift, transform, reimagine or understand), from and to, what
 * must stay true, and the date. The layout is prose, so each field is read from a labelled line when there is one.
 */
export function parseIntent(text) {
    const lines = linesOf(text);
    const label = (re) => {
        for (const l of lines) {
            const m = re.exec(l);
            if (m && m[1].trim() !== "") return stripMd(m[1]).replace(/^[:\-–—\s]+/, "").trim();
        }
        return undefined;
    };
    // A field is a labelled line (`**Goal:** uplift`) or a heading (`## Goal`) with the value on the next lines.
    const section = (re) => {
        const at = lines.findIndex((l) => /^#{2,4}\s/.test(l) && re.test(l.replace(/^#+\s*/, "").trim()));
        if (at < 0) return undefined;
        const body = [];
        for (const l of lines.slice(at + 1)) {
            if (/^#{1,4}\s/.test(l)) break;
            if (l.trim() !== "") body.push(stripMd(l));
            if (body.length >= 2) break;
        }
        return body.length ? body.join(" ") : undefined;
    };
    const goalLine = label(/^\W*(?:goal|what\s+(?:you|they)\s+want(?:\s+to\s+do)?)\W*[:\-–—]\s*(.+)$/i) ?? section(/^goal\b/i);
    let goal;
    for (const source of [goalLine, ...lines.slice(0, 40)]) {
        if (!source) continue;
        const lower = source.toLowerCase();
        const hits = GOALS.map((g) => ({ g, at: lower.search(new RegExp(`\\b${g}\\b`)) })).filter((x) => x.at >= 0);
        if (hits.length) {
            goal = hits.sort((a, b) => a.at - b.at)[0].g;
            break;
        }
        if (source === goalLine) {
            if (/\bsame (?:stack|technology)|newer version|version (?:move|bump)|upgrade/i.test(lower)) goal = "uplift";
            else if (/\brewrite\b/i.test(lower)) goal = "transform";
            else if (/\brebuild|from scratch|greenfield/i.test(lower)) goal = "reimagine";
            if (goal) break;
        }
    }
    const from = label(/^\W*from\W*[:\-–—]\s*(.+)$/i) ?? section(/^from\b/i);
    const to = label(/^\W*(?:to|target(?:\s+stack)?|vision|target\s+and\s+vision)\W*[:\-–—]\s*(.+)$/i) ?? section(/^(?:to|target)\b/i);
    const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(lines.join("\n"))?.[1];
    // "A security review comes first" counts only when it was chosen: not under a "Not chosen" heading or label.
    let securityFirst = false;
    let excluded = false;
    for (const l of lines) {
        if (/^#{1,6}\s/.test(l) || /^\s*\*\*[^*]+:?\*\*:?\s*$/.test(l)) excluded = /\bnot\s+(?:chosen|selected|picked)|unselected|declined/i.test(l);
        if (!excluded && /security review comes first/i.test(l) && !/\bnot\s+(?:chosen|selected|picked)\b/i.test(l)) securityFirst = true;
    }
    return {
        ...(goal && { goal }),
        ...(from && { from: line(from, 120) }),
        ...(to && { to: line(to, 120) }),
        ...(date && { date }),
        securityFirst,
    };
}

// ---------------------------------------------------------------- BUSINESS_RULES.md

const ID = "[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\\d+[a-z]?";
const CARD_HEADING = new RegExp(`^#{3,4}\\s+(${ID})\\s*[·:\\-–—]\\s*(.+?)\\s*$`);
const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const FORBIDDEN_ID = new Set(["__proto__", "constructor", "prototype"]);

export const isRuleId = (id) => typeof id === "string" && LEDGER_ID.test(id) && !FORBIDDEN_ID.has(id);

const labelled = (body, name) => {
    const m = new RegExp(`^[ \\t>]*\\*\\*${name}:?\\*\\*:?[ \\t]*(.*)$`, "im").exec(body);
    const t = m ? stripMd(m[1]) : "";
    return t === "" ? undefined : t;
};

function specOf(body) {
    const at = body.search(/\*\*Specification:?\*\*/i);
    const block = at < 0 ? body : body.slice(at);
    const out = { given: [], when: [], then: [] };
    let cur;
    for (const raw of linesOf(block).slice(at < 0 ? 0 : 1)) {
        const l = raw.trim().replace(/^```\w*$/, "").replace(/^[-*]\s+/, "");
        if (at >= 0 && /^\*\*[A-Za-z][^*]*\*\*/.test(l)) break;
        const m = /^(Given|When|Then|And)\b\s*(.*)$/.exec(l);
        if (!m) continue;
        const rest = stripMd(m[2]);
        if (m[1] === "And") {
            if (cur) out[cur].push(rest);
            continue;
        }
        cur = m[1].toLowerCase();
        out[cur].push(rest);
    }
    const join = (parts) => (parts.length ? parts.join(" · ") : undefined);
    return { given: join(out.given), when: join(out.when), then: join(out.then) };
}

function cardOf(id, title, body) {
    const priority = (/\*\*Priority:?\*\*:?\s*`?(P\d)\b/i.exec(body)?.[1] ?? /\bPriority\s*:?\s*(P\d)\b/i.exec(body)?.[1] ?? "").toUpperCase();
    const confLine = labelled(body, "Confidence");
    const confidence = /^(High|Medium|Low)\b/i.exec(confLine ?? "")?.[1];
    const conf = confidence ? confidence[0].toUpperCase() + confidence.slice(1).toLowerCase() : undefined;
    // The SME question: a labelled line, `SME question:` inline, or (render_rules / the hand format) the text after
    // the dash on a Confidence line below High.
    let sme = labelled(body, "SME questions?") ?? /\bSME questions?\s*:\s*(.+)$/im.exec(body)?.[1];
    if (sme === undefined && conf && conf !== "High") {
        const after = /^(?:High|Medium|Low)\b\s*[—–-]\s*(.+)$/i.exec(confLine ?? "")?.[1];
        if (after) sme = after;
    }
    const defect = labelled(body, "Suspected defect");
    const spec = specOf(body);
    const source = labelled(body, "Source");
    return {
        id,
        title: line(stripMd(title), 160),
        priority,
        ...(labelled(body, "Category") && { category: line(labelled(body, "Category"), 40) }),
        ...(conf && { confidence: conf }),
        plain: line(labelled(body, "Plain English") ?? "", 600),
        ...(spec.given && { given: line(spec.given, 600) }),
        ...(spec.when && { when: line(spec.when, 600) }),
        ...(spec.then && { then: line(spec.then, 600) }),
        ...(source && { citation: line(source, 200) }),
        ...(defect && { defect: line(defect, 600) }),
        ...(sme && { sme: line(stripMd(sme), 600) }),
    };
}

/**
 * BUSINESS_RULES.md as rule cards (`### RULE-NNN: name` with labelled fields), plus the SME questions listed in its
 * "Rules requiring SME confirmation" section, keyed by rule id.
 */
export function parseRules(text) {
    const lines = linesOf(text);
    const rules = [];
    const smeList = new Map();
    let open = null;
    let inSmeSection = false;
    const close = (end) => {
        if (open) rules.push(cardOf(open.id, open.title, lines.slice(open.start, end).join("\n")));
        open = null;
    };
    lines.forEach((l, i) => {
        const card = CARD_HEADING.exec(l);
        if (card) {
            close(i);
            inSmeSection = false;
            open = { id: card[1], title: card[2], start: i + 1 };
            return;
        }
        if (/^#{1,4}\s/.test(l)) {
            close(i);
            inSmeSection = /requiring SME|SME confirmation/i.test(l);
            return;
        }
        if (inSmeSection) {
            const m = new RegExp(`^\\s*[-*]\\s+\\**(${ID})\\**\\s*(?:\\(([^)]*)\\))?\\s*[:\\-–—]?\\s*(.*)$`).exec(l);
            if (m && m[3].trim()) smeList.set(m[1], line(stripMd(m[3]), 600));
        }
    });
    close(lines.length);
    const seen = new Set();
    const unique = [];
    for (const r of rules) {
        if (seen.has(r.id) || !isRuleId(r.id)) continue;
        seen.add(r.id);
        if (!r.sme && smeList.has(r.id) && r.confidence !== "High") r.sme = smeList.get(r.id);
        unique.push(r);
    }
    return unique;
}

/** What /modernize:review's `flagged` scope asks about: P0 with a suspected defect, an SME question or below High confidence. */
export const needsReview = (rule) => rule.priority === "P0" && (rule.defect !== undefined || rule.sme !== undefined || rule.confidence !== "High");

// ---------------------------------------------------------------- RULE_REVIEWS.json

export const VERDICTS = ["confirmed", "wrong", "discuss"];

/**
 * RULE_REVIEWS.json as {ok, raw, reviews}: `reviews` holds only the well-formed entries (for display), `raw` the
 * parsed object as it is (so a writer can keep every entry). ok is false when the file exists but is not JSON of
 * the expected shape, which a writer must not overwrite.
 */
export function parseReviews(text) {
    if (text === null || text === undefined) return { ok: true, raw: null, reviews: {} };
    let raw;
    try {
        raw = JSON.parse(String(text).replace(/^﻿/, ""));
    } catch {
        return { ok: false, raw: null, reviews: {} };
    }
    if (!isRecord(raw) || (raw.reviews !== undefined && !isRecord(raw.reviews))) return { ok: false, raw: null, reviews: {} };
    const reviews = {};
    for (const [id, item] of Object.entries(raw.reviews ?? {}).slice(0, 5000)) {
        if (!isRuleId(id) || !isRecord(item) || !VERDICTS.includes(item.verdict)) continue;
        reviews[id] = {
            verdict: item.verdict,
            at: typeof item.at === "string" && /^\d{4}-\d{2}-\d{2}/.test(item.at) ? item.at.slice(0, 40) : "",
            ...(typeof item.title === "string" && item.title.trim() && { title: line(item.title, 160) }),
            ...(typeof item.note === "string" && item.note.trim() && { note: line(item.note, 600) }),
        };
    }
    return { ok: true, raw, reviews };
}

// ---------------------------------------------------------------- MODERNIZATION_BRIEF.md

const PHASE_HEADING = /^(#{2,4})\s+Phase\s+(\d+)\s*[—–:.\-]\s*(.+?)\s*$/i;
const CHECKBOX = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Where the brief's Approval Block code fence is: {open, close} line indexes of its fences (exclusive content), or
 * null. The fence is the first one after an "Approval Block" heading or bold label that holds an `Approved by:`
 * line; failing that, the first fence anywhere that holds one.
 */
export function findApprovalBlock(lines) {
    const fences = [];
    let open = -1;
    for (let i = 0; i < lines.length; i++) {
        if (FENCE.test(lines[i])) {
            if (open < 0) open = i;
            else {
                fences.push({ open, close: i });
                open = -1;
            }
        }
    }
    const holds = (f) => lines.slice(f.open + 1, f.close).some((l) => /^\s*Approved by\s*:/i.test(l));
    const label = lines.findIndex((l) => /approval block/i.test(l) && (/^\s*#/.test(l) || /\*\*/.test(l)));
    if (label >= 0) {
        const after = fences.find((f) => f.open > label && holds(f));
        if (after) return after;
    }
    return fences.find(holds) ?? null;
}

const UNDERS = /^_*$/;

/** The approval block's three fields, as written; signed when `Approved by:` holds a name. */
export function parseApproval(lines) {
    const block = findApprovalBlock(lines);
    if (!block) return { hasBlock: false, signed: false };
    const body = lines.slice(block.open + 1, block.close);
    const byLine = body.find((l) => /^\s*Approved by\s*:/i.test(l)) ?? "";
    const by = byLine.replace(/^\s*Approved by\s*:/i, "").replace(/\bDate\s*:.*$/i, "").trim();
    const dateLine = body.find((l) => /\bDate\s*:/i.test(l)) ?? "";
    const date = dateLine.replace(/^.*\bDate\s*:/i, "").trim();
    const coversLine = body.find((l) => /^\s*Approval covers\s*:/i.test(l));
    const covers = coversLine === undefined ? "" : coversLine.replace(/^\s*Approval covers\s*:/i, "").trim();
    const signed = !isBlank(by) && !UNDERS.test(by.replace(/\s/g, ""));
    const coversFilled = covers !== "" && !/\|/.test(covers.replace(/\\\|/g, ""));
    return {
        hasBlock: true,
        signed,
        ...(signed && { by: line(by, 160) }),
        ...(!isBlank(date) && { date: line(date, 40) }),
        ...(coversFilled && { covers: line(covers, 80) }),
        hasCovers: coversLine !== undefined,
        hasDate: dateLine !== "",
    };
}

/**
 * The brief: target stack, phases (`#### Phase N — title` with `Command:`, `Modules:`, `Scale:`, entry and exit
 * criteria), unticked open questions and the rule ids they name, and the approval block.
 */
export function parseBrief(text) {
    const lines = linesOf(text);
    const phases = [];
    let cur = null;
    let list = null;
    let section = "";
    const openQuestions = [];
    const closePhase = () => {
        if (cur) phases.push(cur.phase);
        cur = null;
        list = null;
    };
    for (const l of lines) {
        const ph = PHASE_HEADING.exec(l);
        if (ph) {
            closePhase();
            cur = {
                level: ph[1].length,
                phase: { number: Number(ph[2]), title: line(stripMd(ph[3]), 120), modules: [], entry: [], exit: [] },
            };
            continue;
        }
        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(l);
        const bold = /^\s*\*\*(\d+\.\s*[^*]+)\*\*\s*$/.exec(l);
        if (heading && cur && heading[1].length <= cur.level) closePhase();
        if (heading && heading[1].length <= 2 && !cur) section = stripMd(heading[2]).toLowerCase();
        if (bold && !cur) section = stripMd(bold[1]).toLowerCase();
        if (bold && cur) {
            closePhase();
            section = stripMd(bold[1]).toLowerCase();
        }
        if (cur) {
            const p = cur.phase;
            let m;
            if ((m = /^\s*Command\s*:\s*(.*)$/i.exec(l))) {
                const cmd = /\/modernize:(transform|uplift|reimagine)\b/i.exec(m[1]);
                if (cmd) p.command = cmd[1].toLowerCase();
                list = null;
            } else if ((m = /^\s*Modules?\s*:\s*(.*)$/i.exec(l))) {
                p.modules = m[1].split(/[,;]/).map((s) => stripMd(s)).filter((s) => s !== "" && s.length <= 120).slice(0, 200);
                list = null;
            } else if ((m = /^\s*Scale\s*:\s*`?(XL|S|M|L)\b/i.exec(l))) {
                p.scale = m[1].toUpperCase();
                list = null;
            } else if (/^\s*Entry criteria\s*:/i.test(l)) list = "entry";
            else if (/^\s*Exit criteria\s*:/i.test(l)) list = "exit";
            else if (/^\s*(Risk|Proposed revision)\s*:/i.test(l)) list = null;
            else if (list && (m = CHECKBOX.exec(l))) p[list].push({ text: line(stripMd(m[2]), 300), ticked: m[1] !== " " });
            continue;
        }
        if (/open questions/.test(section)) {
            const m = CHECKBOX.exec(l);
            if (m && m[1] === " ") openQuestions.push(m[2]);
        }
    }
    closePhase();
    const stackToken = /\*\*Target stack:?\*\*:?\s*`([A-Za-z0-9][\w.+/-]{0,59})`/i.exec(lines.join("\n"))?.[1];
    const named = new Set();
    for (const q of openQuestions) for (const m of q.matchAll(new RegExp(ID, "g"))) named.add(m[0]);
    return {
        ...(stackToken && { target: stackToken }),
        phases,
        openQuestions: openQuestions.length,
        rulesInQuestions: [...named].filter(isRuleId),
        approval: parseApproval(lines),
    };
}

// ---------------------------------------------------------------- VERIFICATION.json / VERIFICATION.md

export const PROOF_VERDICTS = ["PROVEN", "PARTLY PROVEN", "NOT PROVEN"];
const PACK_TRACKS = { rewrite: "rewrite", transform: "rewrite", uplift: "uplift", reimagine: "reimagine" };

/** `2026-09-24 20:31 UTC` (the pack's stamp) as epoch ms; null when it is anything else. */
export function packTime(value) {
    if (typeof value !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:UTC|Z)?$/.exec(value.trim());
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    return Number.isFinite(ms) ? ms : null;
}

/**
 * VERIFICATION.json as the proof pack wrote it: a verdict per module, only ever one of the three exact words. Its
 * `signoff` is the script's blank template and is never read: the sign-off lives in VERIFICATION.md.
 */
export function parseVerification(text) {
    if (typeof text !== "string" || text.length > 4_000_000) return null;
    let raw;
    try {
        raw = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
        return null;
    }
    if (!isRecord(raw) || !Array.isArray(raw.modules)) return null;
    const modules = [];
    for (const item of raw.modules.slice(0, 1000)) {
        if (!isRecord(item) || typeof item.name !== "string" || !PROOF_VERDICTS.includes(item.verdict)) continue;
        const track = PACK_TRACKS[item.track];
        if (!track || item.name.trim() === "") continue;
        const first = Array.isArray(item.reasons) ? item.reasons.find((r) => typeof r === "string" && r.trim()) : undefined;
        modules.push({ name: line(item.name, 100), track, verdict: item.verdict, reason: first ? line(first, 300) : "", atMs: packTime(item.verifiedAt) });
    }
    const tooling = (Array.isArray(raw.toolingOnly) ? raw.toolingOnly : [])
        .filter((t) => isRecord(t) && typeof t.name === "string")
        .slice(0, 1000)
        .map((t) => line(t.name, 100));
    const overall = isRecord(raw.overall) && PROOF_VERDICTS.includes(raw.overall.verdict) ? raw.overall.verdict : null;
    return { overall, modules, tooling, generatedMs: packTime(raw.generated) };
}

export const SIGNOFF_FIELDS = ["Name", "Role", "Date", "Decision"];
export const DECISIONS = ["accept", "accept with conditions", "reject"];

/** The `## Sign-off` table's rows in VERIFICATION.md: {section:{start,end}, rows:{Name:{index, value}...}} or null. */
export function findSignoffTable(lines) {
    const start = lines.findIndex((l) => /^##\s+Sign-?off\b/i.test(l));
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^#{1,2}\s/.test(lines[i])) {
            end = i;
            break;
        }
    }
    const rows = {};
    for (let i = start + 1; i < end; i++) {
        const m = /^\s*\|\s*(Name|Role|Date|Decision)\s*\|(.*)\|\s*$/i.exec(lines[i]);
        if (!m) continue;
        const key = SIGNOFF_FIELDS.find((f) => f.toLowerCase() === m[1].toLowerCase());
        if (key && !rows[key]) rows[key] = { index: i, value: m[2].trim() };
    }
    return SIGNOFF_FIELDS.every((f) => rows[f]) ? { start, end, rows } : null;
}

const isTemplateDecision = (v) => /accept\s*\/\s*accept with conditions\s*\/\s*reject/i.test(v);

/** VERIFICATION.md's sign-off: signed means Name and Decision are filled in. */
export function parseSignoff(text) {
    const table = findSignoffTable(linesOf(text));
    if (!table) return { hasTable: false, signed: false };
    const val = (k) => table.rows[k].value.replace(/\\\|/g, "|");
    const name = isBlank(val("Name")) ? "" : val("Name");
    const decision = isBlank(val("Decision")) || isTemplateDecision(val("Decision")) ? "" : val("Decision");
    const role = isBlank(val("Role")) ? "" : val("Role");
    const date = isBlank(val("Date")) ? "" : val("Date");
    return {
        hasTable: true,
        signed: name !== "" && decision !== "",
        ...(name && { name: line(name, 120) }),
        ...(role && { role: line(role, 120) }),
        ...(date && { date: line(date, 40) }),
        ...(decision && { decision: line(decision, 60) }),
    };
}

// ---------------------------------------------------------------- SECURITY_FINDINGS.md

const SEVERITIES = ["Critical", "High", "Medium", "Low"];

function tablesOf(lines) {
    const out = [];
    let cur = null;
    for (const l of lines) {
        if (/^\s*\|.*\|\s*$/.test(l)) {
            const cells = l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => stripMd(c));
            if (!cur) cur = { header: cells, rows: [] };
            else if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
            else cur.rows.push(cells);
        } else if (cur) {
            out.push(cur);
            cur = null;
        }
    }
    if (cur) out.push(cur);
    return out;
}

/**
 * Severity counts from SECURITY_FINDINGS.md: the scorecard row (a table with Critical, High, Medium and Low columns),
 * else a Severity | Count table, else a tally of the findings table's Severity column. Null when none is there.
 */
export function parseSecurity(text) {
    const tables = tablesOf(linesOf(text));
    for (const t of tables) {
        const cols = SEVERITIES.map((s) => t.header.findIndex((h) => h.toLowerCase() === s.toLowerCase()));
        if (cols.every((c) => c >= 0)) {
            const row = t.rows.find((r) => cols.every((c) => /^\d+$/.test((r[c] ?? "").trim())));
            if (row) return Object.fromEntries(SEVERITIES.map((s, i) => [s, Number(row[cols[i]])]));
        }
    }
    for (const t of tables) {
        const low = t.header.map((h) => h.toLowerCase());
        const sev = low.findIndex((h) => h.includes("severity"));
        const count = low.findIndex((h) => ["count", "total", "n", "#", "findings"].includes(h));
        if (sev < 0 || count < 0 || t.header.length > 3) continue;
        const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
        let any = false;
        for (const r of t.rows) {
            const s = SEVERITIES.find((x) => new RegExp(`^${x}\\b`, "i").test(r[sev] ?? ""));
            if (s && /^\d+$/.test((r[count] ?? "").trim())) {
                counts[s] += Number(r[count]);
                any = true;
            }
        }
        if (any) return counts;
    }
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    let any = false;
    for (const t of tables) {
        const low = t.header.map((h) => h.toLowerCase());
        const sev = low.findIndex((h) => h.includes("severity"));
        if (sev < 0 || low.some((h) => /package|installed|fixed|cve/.test(h))) continue;
        for (const r of t.rows) {
            const s = SEVERITIES.find((x) => new RegExp(`^${x}\\b`, "i").test(r[sev] ?? ""));
            if (s) {
                counts[s] += 1;
                any = true;
            }
        }
    }
    return any ? counts : null;
}

// ---------------------------------------------------------------- topology.json

/**
 * topology.json's code nodes for the map: [{id, label, loc, domain, file?}]. Reads the map skill's tree (`root` with
 * `children`, domains as `kind: "domain"` containers) and a flat `nodes` list (each with its own `domain`).
 */
export function parseTopology(text) {
    if (typeof text !== "string" || text.length > 16_000_000) return null;
    let raw;
    try {
        raw = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
        return null;
    }
    if (!isRecord(raw)) return null;
    const out = [];
    const str = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
    let budget = 50_000;
    const walk = (node, domain, depth) => {
        if (!isRecord(node) || depth > 12 || budget-- <= 0) return;
        const id = str(node.id) ?? str(node.name);
        if (!id) return;
        const kind = str(node.kind) ?? "node";
        const name = str(node.name) ?? id;
        const children = Array.isArray(node.children) ? node.children : [];
        const here = kind === "domain" ? name : (str(node.domain) ?? domain);
        if ((children.length === 0 || kind === "module") && kind !== "domain" && kind !== "system") {
            const loc = typeof node.loc === "number" && Number.isFinite(node.loc) && node.loc > 0 ? node.loc : 0;
            const file = str(node.file);
            if (kind !== "datastore" && (kind === "module" || loc > 0 || file)) {
                out.push({
                    id: line(id, 120),
                    label: line(name, 120),
                    loc,
                    domain: line(here ?? "Other", 80),
                    ...(file && { file: file.replace(/\\/g, "/").replace(/^\.\//, "").slice(0, 400) }),
                });
            }
        }
        for (const c of children.slice(0, 20_000)) walk(c, here, depth + 1);
    };
    if (isRecord(raw.root)) walk(raw.root, undefined, 0);
    if (Array.isArray(raw.nodes)) for (const n of raw.nodes.slice(0, 50_000)) walk(n, undefined, 0);
    const seen = new Set();
    const nodes = out.filter((n) => (seen.has(n.id) ? false : seen.add(n.id)));
    return nodes.length ? { nodes } : null;
}

// ---------------------------------------------------------------- small helpers for the other artifacts

/** DELTA_CATALOG.md: how many delta cards (`### ...` headings or table rows with an id). */
export function countDeltas(text) {
    const lines = linesOf(text);
    const cards = lines.filter((l) => /^#{3,4}\s+\S/.test(l)).length;
    if (cards) return cards;
    return tablesOf(lines).reduce((n, t) => n + t.rows.length, 0);
}
