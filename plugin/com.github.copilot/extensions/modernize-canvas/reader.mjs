// Reads one workspace (the folder that holds legacy/, analysis/ and modernized/) into the JSON
// model the live status page draws. Reads only: never writes, never runs anything, and never
// follows a link out of the workspace except the legacy/<system> link itself.
// Adapted from anthropics/claude-plugins-official plugins/code-modernization/hooks/reader/
// (discover.ts, tracks.ts, modernized.ts, progress.ts; Apache-2.0), ported to plain JavaScript.
import fs from "node:fs";
import path from "node:path";

import {
    isSystemName, parseIntent, parseRules, parseReviews, parseBrief, parseVerification, parseSignoff,
    parseSecurity, parseTopology, countDeltas, plain, line,
} from "./parsers.mjs";
import { progressOf } from "./progress.mjs";

/** Files under analysis/<system>/ whose presence and modification time the steps are judged by. */
export const ANALYSIS_FILES = [
    "INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md", "ARCHITECTURE.mmd", "topology.json", "TOPOLOGY.html",
    "BUSINESS_RULES.md", "DATA_OBJECTS.md", "RULE_REVIEWS.json", "MODERNIZATION_BRIEF.md", "DELTA_CATALOG.md",
    "BASELINE.md", "PLAYBOOK.md", "AI_NATIVE_SPEC.md", "REIMAGINED_ARCHITECTURE.md", "EQUIVALENCE.json",
    "VERIFICATION.json", "VERIFICATION.md", "SECURITY_FINDINGS.md", "SOURCE",
];

const MAX_TEXT = 4 * 1024 * 1024;
const MAX_TOPOLOGY = 16 * 1024 * 1024;
export const LEGACY_WALK_CAP = 20_000;
const MODULE_WALK_CAP = 3_000;
const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules"]);
const LEGACY_TTL_MS = 60_000;
const MODULE_TTL_MS = 10_000;

const lstat = (p) => {
    try {
        return fs.lstatSync(p);
    } catch {
        return null;
    }
};

/** A regular file's mtime (ms), or null. A symbolic link is not followed: it counts as missing. */
export function fileMtime(p) {
    const s = lstat(p);
    return s && s.isFile() ? s.mtimeMs : null;
}

/** A regular file's text, or null when missing, a link, unreadable or over `max` bytes. */
export function readText(p, max = MAX_TEXT) {
    const s = lstat(p);
    if (!s || !s.isFile() || s.size > max) return null;
    try {
        return fs.readFileSync(p, "utf8");
    } catch {
        return null;
    }
}

const realDir = (p) => {
    try {
        const r = fs.realpathSync(p);
        return fs.statSync(r).isDirectory() ? r : null;
    } catch {
        return null;
    }
};

const listDir = (p) => {
    try {
        return fs.readdirSync(p, { withFileTypes: true });
    } catch {
        return [];
    }
};

/** The read-only tree's folder name: MODERNIZE_LEGACY_DIR, analysis/.modernize.json {legacyDir}, else `legacy`. */
export function legacyDirName(ws) {
    let name = process.env.MODERNIZE_LEGACY_DIR;
    if (!name) {
        try {
            name = JSON.parse(readText(path.join(ws, "analysis", ".modernize.json"), 64 * 1024) ?? "null")?.legacyDir;
        } catch {
            name = undefined;
        }
    }
    name = typeof name === "string" ? name.trim().replace(/^[\\/]+|[\\/]+$/g, "") : "";
    const ok = /^[A-Za-z0-9._ -]+(?:[\\/][A-Za-z0-9._ -]+)*$/.test(name) && !name.split(/[\\/]/).some((seg) => seg === ".." || seg === ".");
    return ok ? name : "legacy";
}

// A folder under analysis/ is a system only when a skill has written one of these into it, or the
// legacy tree has the same name: scratch folders such as analysis/notes/ are not systems.
const SYSTEM_MARKERS = [
    "INTENT.md", "PREFLIGHT.md", "ASSESSMENT.md", "topology.json", "BUSINESS_RULES.md", "MODERNIZATION_BRIEF.md",
    "DELTA_CATALOG.md", "BASELINE.md", "PLAYBOOK.md", "VERIFICATION.json", "SECURITY_FINDINGS.md", "SOURCE",
    "AI_NATIVE_SPEC.md", "REIMAGINED_ARCHITECTURE.md", "RULE_REVIEWS.json", "parity",
];

/**
 * The systems in the workspace: entries under the legacy tree (a folder, or a link to one), and folders under
 * analysis/ (real folders only: a link there is not read) that hold a skill's output, whose names the skills accept.
 */
export function listSystems(ws, legacyDir = legacyDirName(ws)) {
    const names = new Set();
    for (const e of listDir(path.join(ws, "analysis"))) {
        if (!e.isDirectory() || !isSystemName(e.name)) continue;
        const dir = path.join(ws, "analysis", e.name);
        if (SYSTEM_MARKERS.some((f) => fs.existsSync(path.join(dir, f)))) names.add(e.name);
    }
    const legacy = path.join(ws, legacyDir);
    for (const e of listDir(legacy)) {
        if (!isSystemName(e.name)) continue;
        if (e.isDirectory() || (e.isSymbolicLink() && realDir(path.join(legacy, e.name)))) names.add(e.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

function cached(cache, key, ttl, compute) {
    const hit = cache?.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttl) return hit.value;
    const value = compute();
    cache?.set(key, { at: now, value });
    return value;
}

/** The newest mtime of any file in a folder (capped walk, links not followed). */
function newestIn(dir, cache) {
    return cached(cache, `newest:${dir}`, MODULE_TTL_MS, () => {
        let newest = 0;
        let seen = 0;
        const stack = [dir];
        while (stack.length && seen < MODULE_WALK_CAP) {
            const d = stack.pop();
            for (const e of listDir(d)) {
                if (++seen > MODULE_WALK_CAP) break;
                const p = path.join(d, e.name);
                if (e.isDirectory()) {
                    if (!SKIP_DIRS.has(e.name)) stack.push(p);
                } else if (e.isFile()) {
                    const m = fileMtime(p);
                    if (m && m > newest) newest = m;
                }
            }
        }
        return newest;
    });
}

const isRealDir = (p) => {
    const s = lstat(p);
    return !!s && s.isDirectory();
};

const subdirs = (dir) => listDir(dir).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort((a, b) => a.localeCompare(b));

/** The built units for the track: rewrite modules, the uplift working copy, or reimagined services. */
function modulesOf(ws, system, track, cache) {
    const mod = path.join(ws, "modernized");
    if (track === "uplift") {
        const dir = path.join(mod, `${system}-uplifted`);
        if (!isRealDir(dir)) return { modules: [], notesMs: null, handoffMs: null };
        const notesMs = fileMtime(path.join(dir, "UPLIFT_NOTES.md"));
        return { modules: [{ name: `${system}-uplifted`, built: notesMs !== null, notesMs, newestMs: newestIn(dir, cache) }], notesMs, handoffMs: null };
    }
    if (track === "reimagine") {
        const dir = path.join(mod, `${system}-reimagined`);
        if (!isRealDir(dir)) return { modules: [], notesMs: null, handoffMs: null };
        const handoffMs = fileMtime(path.join(dir, "AGENTS.md"));
        const modules = subdirs(dir).slice(0, 500).map((name) => ({ name, built: handoffMs !== null, notesMs: null, newestMs: newestIn(path.join(dir, name), cache) }));
        return { modules, notesMs: null, handoffMs };
    }
    const dir = path.join(mod, system);
    if (!isRealDir(dir)) return { modules: [], notesMs: null, handoffMs: null };
    const modules = subdirs(dir).slice(0, 500).map((name) => {
        const notesMs = fileMtime(path.join(dir, name, "TRANSFORMATION_NOTES.md"));
        return { name, built: notesMs !== null, notesMs, newestMs: newestIn(path.join(dir, name), cache) };
    });
    return { modules, notesMs: null, handoffMs: null };
}

/** The newest mtime among files and folders (a folder by its newest file). */
function newestOf(paths, cache) {
    let best = null;
    for (const p of paths) {
        const s = lstat(p);
        if (!s) continue;
        const m = s.isDirectory() ? newestIn(p, cache) || s.mtimeMs : s.isFile() ? s.mtimeMs : null;
        if (m && (!best || m > best.ms)) best = { ms: m, path: p };
    }
    return best;
}

/**
 * The track: what INTENT.md says the person wants; else the track whose own artifacts were written last (like
 * upstream's reader/tracks.ts); else what the brief's phases run; else a rewrite, where the skills begin.
 */
export function inferTrack(ws, system, intent, brief, cache) {
    const goal = intent?.goal;
    if (goal === "uplift") return { track: "uplift", why: "INTENT.md: uplift" };
    if (goal === "transform") return { track: "rewrite", why: "INTENT.md: transform" };
    if (goal === "reimagine") return { track: "reimagine", why: "INTENT.md: reimagine" };
    const a = (n) => path.join(ws, "analysis", system, n);
    const m = (n) => path.join(ws, "modernized", n);
    const ranked = [
        ["rewrite", newestOf([m(system)], cache)],
        ["uplift", newestOf([a("DELTA_CATALOG.md"), a("BASELINE.md"), a("PLAYBOOK.md"), m(`${system}-uplifted`)], cache)],
        ["reimagine", newestOf([a("AI_NATIVE_SPEC.md"), a("REIMAGINED_ARCHITECTURE.md"), m(`${system}-reimagined`)], cache)],
    ].filter(([, n]) => n);
    if (ranked.length) {
        const [track, newest] = ranked.reduce((best, e) => (e[1].ms > best[1].ms ? e : best));
        return { track, why: `newest artifact: ${path.relative(ws, newest.path).split(path.sep).join("/")}` };
    }
    const cmds = new Set((brief?.phases ?? []).map((p) => p.command).filter(Boolean));
    if (cmds.size === 1) {
        const only = [...cmds][0];
        return { track: only === "transform" ? "rewrite" : only, why: `the brief's phases run /modernize:${only}` };
    }
    return { track: "rewrite", why: goal === "understand" ? "INTENT.md: understand" : "no track artifacts yet" };
}

/**
 * Tiles for the map when there is no topology.json: one per top-level folder of legacy/<system>, sized by file count.
 * The legacy/<system> link itself is followed; no link inside the tree is. The walk stops at LEGACY_WALK_CAP entries.
 */
export function legacyFolders(root, cap = LEGACY_WALK_CAP) {
    const base = realDir(root);
    if (!base) return null;
    const counts = new Map();
    let seen = 0;
    let truncated = false;
    const top = listDir(base);
    for (const e of top) {
        if (++seen > cap) {
            truncated = true;
            break;
        }
        if (e.isFile()) counts.set("", (counts.get("") ?? 0) + 1);
        else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) counts.set(e.name, 0);
    }
    for (const name of [...counts.keys()].filter((k) => k !== "")) {
        if (truncated) break;
        const stack = [path.join(base, name)];
        let n = 0;
        while (stack.length) {
            const d = stack.pop();
            for (const e of listDir(d)) {
                if (++seen > cap) {
                    truncated = true;
                    break;
                }
                if (e.isDirectory()) {
                    if (!SKIP_DIRS.has(e.name)) stack.push(path.join(d, e.name));
                } else if (e.isFile()) n += 1;
            }
            if (truncated) break;
        }
        counts.set(name, n);
    }
    const folders = [...counts.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
    return { folders, truncated };
}

/** Lower-case and squash punctuation, so `Billing.Core`, `billing-core` and `BILLING_CORE` meet. */
const keyOf = (s) => String(s).toLowerCase().replace(/::/g, "-").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const MAX_TILES = 2000;

function mapOf(ws, legacyDir, system, topology, track, modules, proofs, cache) {
    const local = modules.filter((m) => m.onDisk !== false && (m.track ?? track) === track);
    const byKey = new Map(local.map((m) => [keyOf(m.name), m]));
    const whole = track === "uplift" ? local[0] : undefined;
    const stateOf = (tile) => {
        const m = track === "rewrite" ? (byKey.get(keyOf(tile.id)) ?? byKey.get(keyOf(tile.label))) : track === "uplift" ? whole : undefined;
        if (!m) return "todo";
        const p = proofs.get(m.name.toLowerCase());
        if (p?.state === "proven") return "proven";
        return m.built ? "built" : "progress";
    };
    if (topology) {
        const nodes = [...topology.nodes].sort((a, b) => b.loc - a.loc).slice(0, MAX_TILES);
        const anyLoc = nodes.some((n) => n.loc > 0);
        const groups = new Map();
        for (const n of nodes) {
            const tile = { id: n.id, label: n.label, size: anyLoc ? Math.max(1, n.loc) : 1, ...(n.file && { file: n.file }) };
            tile.state = stateOf(tile);
            if (!groups.has(n.domain)) groups.set(n.domain, []);
            groups.get(n.domain).push(tile);
        }
        return {
            source: "topology",
            unit: anyLoc ? "lines of code" : "modules",
            groups: [...groups.entries()].map(([name, tiles]) => ({ name, tiles })),
            truncated: topology.nodes.length > MAX_TILES,
        };
    }
    const walk = cached(cache, `legacy:${path.join(ws, legacyDir, system)}`, LEGACY_TTL_MS, () => legacyFolders(path.join(ws, legacyDir, system)));
    if (!walk || walk.folders.length === 0) return { source: "none", unit: "", groups: [], truncated: false };
    const tiles = walk.folders.slice(0, MAX_TILES).map((f) => {
        const tile = { id: f.name === "" ? "." : f.name, label: f.name === "" ? "(files at the top level)" : f.name, size: Math.max(1, f.files) };
        tile.state = stateOf(tile);
        return tile;
    });
    return { source: "folders", unit: "files", groups: [{ name: `${legacyDir}/${system}`, tiles }], truncated: walk.truncated };
}

/** Everything the page shows for one system. `cache` (a Map) keeps the folder walks between reads. */
export function readSystem(ws, system, { cache, legacyDir = legacyDirName(ws) } = {}) {
    const adir = path.join(ws, "analysis", system);
    const hasAnalysis = isRealDir(adir);
    const files = {};
    for (const name of ANALYSIS_FILES) files[name] = hasAnalysis ? fileMtime(path.join(adir, name)) : null;
    const text = (name, max) => (hasAnalysis ? readText(path.join(adir, name), max) : null);

    const intentText = text("INTENT.md");
    const intent = intentText !== null ? parseIntent(intentText) : null;
    const rulesText = text("BUSINESS_RULES.md");
    const rules = rulesText !== null ? parseRules(rulesText) : null;
    const reviewsRead = parseReviews(text("RULE_REVIEWS.json"));
    const briefText = text("MODERNIZATION_BRIEF.md");
    const brief = briefText !== null ? parseBrief(briefText) : null;
    const verification = parseVerification(text("VERIFICATION.json"));
    const verificationMd = text("VERIFICATION.md");
    const signoff = verificationMd !== null ? parseSignoff(verificationMd) : null;
    const securityText = text("SECURITY_FINDINGS.md");
    const security = securityText !== null ? parseSecurity(securityText) : null;
    const topoText = text("topology.json", MAX_TOPOLOGY);
    const topology = topoText !== null ? parseTopology(topoText) : null;
    const deltaText = text("DELTA_CATALOG.md");

    const { track, why } = inferTrack(ws, system, intent, brief, cache);
    const built = modulesOf(ws, system, track, cache);
    // A verdict whose folder is not on disk (moved, or another track's earlier work) is still shown, under its own track.
    const onDisk = new Set(built.modules.map((m) => m.name.toLowerCase()));
    for (const e of verification?.modules ?? []) {
        if (e.track === track && onDisk.has(e.name.toLowerCase())) continue;
        if (built.modules.some((m) => m.name.toLowerCase() === e.name.toLowerCase() && (m.track ?? track) === e.track)) continue;
        built.modules.push({ name: e.name, track: e.track, built: false, onDisk: false, notesMs: null, newestMs: 0 });
    }
    const legacyRoot = path.join(ws, legacyDir, system);
    const facts = {
        system,
        track,
        intent,
        hasAnalysis,
        legacyExists: realDir(legacyRoot) !== null,
        hasSource: files.SOURCE !== null,
        files,
        rules,
        reviews: reviewsRead.reviews,
        brief,
        verification,
        signoff,
        security,
        modules: built.modules,
        upliftNotesMs: built.notesMs,
        reimaginedHandoffMs: built.handoffMs,
        mapCount: topology?.nodes.length ?? 0,
        deltaCount: deltaText !== null ? countDeltas(deltaText) : 0,
    };
    const p = progressOf(facts);
    const tally = { confirmed: 0, wrong: 0, discuss: 0 };
    for (const v of Object.values(reviewsRead.reviews)) tally[v.verdict] += 1;

    return {
        name: system,
        track,
        trackWhy: why,
        intent,
        hasAnalysis,
        legacyExists: facts.legacyExists,
        stages: p.stages,
        stale: p.stale,
        attention: p.attention,
        next: p.next,
        rules: rules ? { total: rules.length, p0: rules.filter((r) => r.priority === "P0").length, flaggedOpen: p.flagged.length, p0Open: p.p0Open.length } : null,
        deck: p.flagged.slice(0, 300),
        reviews: { ...tally, readable: reviewsRead.ok },
        brief: brief
            ? {
                ...(brief.target && { target: brief.target }),
                phases: brief.phases.slice(0, 30).map((ph) => ({ ...ph, modules: ph.modules.slice(0, 60), entry: ph.entry.slice(0, 40), exit: ph.exit.slice(0, 40) })),
                openQuestions: brief.openQuestions,
                approval: brief.approval,
            }
            : null,
        modules: built.modules.map((m) => ({ name: m.name, track: m.track ?? track, built: m.built, onDisk: m.onDisk !== false, proof: p.proofs.get(m.name.toLowerCase()) ?? null })),
        verification: verification || signoff
            ? { overall: verification?.overall ?? null, signoff: signoff ?? { hasTable: false, signed: false } }
            : null,
        security,
        map: mapOf(ws, legacyDir, system, topology, track, built.modules, p.proofs, cache),
    };
}

/** The whole workspace as the page's model. */
export function readWorkspace(ws, { cache } = {}) {
    const legacyDir = legacyDirName(ws);
    const systems = listSystems(ws, legacyDir).slice(0, 50).map((s) => readSystem(ws, s, { cache, legacyDir }));
    return { workspace: { name: path.basename(path.resolve(ws)) }, legacyDir, systems, readAt: new Date().toISOString() };
}

/**
 * Where a path a tool touched sits: {system, area: "legacy" | "modernized", rel} or null. `roots` comes from
 * pathRootsOf(); paths may be absolute or relative to the workspace, with either slash.
 */
export function locatePath(ws, roots, candidate) {
    if (typeof candidate !== "string" || candidate.length > 1000) return null;
    let p = candidate.trim().replace(/^['"`]+|['"`,;:)]+$/g, "");
    if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;
    p = p.replace(/\\/g, "/");
    const abs = /^([A-Za-z]:\/|\/)/.test(p) ? p : `${ws.replace(/\\/g, "/").replace(/\/+$/, "")}/${p.replace(/^\.\//, "")}`;
    const norm = path.posix.normalize(abs);
    const win = process.platform === "win32";
    for (const r of roots) {
        const pre = r.prefix;
        const a = win ? norm.toLowerCase() : norm;
        const b = win ? pre.toLowerCase() : pre;
        if (a === b.replace(/\/$/, "") || a.startsWith(b)) {
            return { system: r.system, area: r.area, rel: norm.slice(pre.length).replace(/^\/+/, "") };
        }
    }
    return null;
}

/** The folder prefixes locatePath matches against, longest first: legacy/<s> (and its link target), modernized/<s>*. */
export function pathRootsOf(ws, model) {
    const roots = [];
    const posix = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    for (const s of model.systems) {
        const legacy = path.join(ws, model.legacyDir, s.name);
        roots.push({ prefix: posix(legacy), system: s.name, area: "legacy" });
        const real = realDir(legacy);
        if (real && posix(real) !== posix(legacy)) roots.push({ prefix: posix(real), system: s.name, area: "legacy" });
        for (const suffix of ["-uplifted", "-reimagined", ""]) {
            roots.push({ prefix: posix(path.join(ws, "modernized", s.name + suffix)), system: s.name, area: "modernized" });
        }
    }
    return roots.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** The map tile a touched path lights up, or null. */
export function tileFor(system, area, rel) {
    const tiles = (system?.map?.groups ?? []).flatMap((g) => g.tiles);
    if (!tiles.length || typeof rel !== "string") return null;
    const r = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const first = r.split("/")[0] ?? "";
    if (area === "legacy") {
        const lower = r.toLowerCase();
        const byFile = tiles.find((t) => t.file && t.file.toLowerCase() === lower);
        if (byFile) return byFile.id;
        if (system.map.source === "folders") {
            return (tiles.find((t) => t.id === first) ?? (r.includes("/") ? null : tiles.find((t) => t.id === ".")))?.id ?? null;
        }
        const base = lower.split("/").pop();
        const byBase = tiles.filter((t) => t.file && t.file.toLowerCase().split("/").pop() === base);
        return byBase.length === 1 ? byBase[0].id : null;
    }
    if (system.track === "uplift") return null;
    const k = keyOf(first);
    return tiles.find((t) => keyOf(t.id) === k || keyOf(t.label) === k)?.id ?? null;
}

/** A compact summary of the workspace for the agent: every string made one plain short line. */
export function summaryOf(model) {
    return {
        workspace: plain(model.workspace.name, 80),
        note: "The canvas shows state and never runs commands. Run the next command yourself, or tell the person.",
        systems: model.systems.map((s) => {
            const done = s.stages.filter((st) => st.done).map((st) => st.key);
            const verdicts = {};
            for (const m of s.modules) if (m.proof?.verdict) verdicts[plain(m.name, 60)] = m.proof.state === "changed" ? `${m.proof.verdict} (changed since)` : m.proof.verdict;
            return {
                system: s.name,
                track: s.track,
                stage: done.length ? done[done.length - 1] : "not started",
                stepsDone: done,
                next: s.next.command ? { command: plain(s.next.command, 160), reason: plain(s.next.reason, 200) } : { byHand: plain(s.next.text, 80), reason: plain(s.next.reason, 200) },
                briefApproved: s.brief ? s.brief.approval.signed : null,
                verificationSigned: s.verification ? s.verification.signoff.signed : null,
                verdicts,
                rulesWaitingForReview: s.rules?.flaggedOpen ?? 0,
                p0RulesWaitingForReview: s.rules?.p0Open ?? 0,
                security: s.security,
                attention: s.attention.slice(0, 12).map((a) => plain(a.text, 200)),
            };
        }),
    };
}

export { line };
