// Where one system stands: its steps, what is stale, what needs a person, and the one next command.
// Pure: it takes the facts the reader gathered from disk (parsed files and modification times) and
// decides nothing a file does not say. The order follows plugin/skills/status/SKILL.md.
// Adapted from anthropics/claude-plugins-official plugins/code-modernization/hooks/reader/progress.ts
// and reader/verification.ts (Apache-2.0).
import { isToken, needsReview, compareRuleIds } from "./parsers.mjs";

export const PREFIX = "/modernize:";

/** The proof pack stamps minutes; a file written in the same minute as the check is not newer than it. */
const SLACK_MS = 90_000;

const cmd = (verb, system, ...rest) => [`${PREFIX}${verb}`, system, ...rest.filter((r) => r !== undefined && r !== "")].join(" ");
const quoteArg = (v) => (/^[A-Za-z0-9._+-]+$/.test(v) ? v : `"${v.replace(/["`$\\]/g, "")}"`);

/** The rules waiting for a person under /modernize:review's default `flagged` scope, with no verdict yet. */
export function flaggedRules(rules, reviews, brief) {
    const named = new Set(brief?.rulesInQuestions ?? []);
    return (rules ?? [])
        .filter((r) => needsReview(r) || named.has(r.id))
        .filter((r) => reviews[r.id] === undefined)
        .sort((a, b) => compareRuleIds(a.id, b.id));
}

/** All rules the `flagged` scope covers, decided or not (for the tally). */
function flaggedAll(rules, brief) {
    const named = new Set(brief?.rulesInQuestions ?? []);
    return (rules ?? []).filter((r) => needsReview(r) || named.has(r.id));
}

/**
 * Where a built module stands with the proof: proven, partly, not, changed (its files are newer than the check),
 * none (built, nothing checked it) or null (not built, and no verdict).
 */
export function proofOf(facts, module) {
    const v = facts.verification;
    const track = module.track ?? facts.track;
    const entry = v?.modules.find((m) => m.track === track && m.name.toLowerCase() === module.name.toLowerCase());
    if (!entry) {
        const tooling = v?.tooling.some((t) => t.toLowerCase() === module.name.toLowerCase());
        return module.built && !tooling ? { state: "none", reason: "" } : null;
    }
    const at = entry.atMs ?? facts.files["VERIFICATION.json"] ?? null;
    if (at !== null && (module.newestMs ?? 0) > at + SLACK_MS) return { state: "changed", verdict: entry.verdict, reason: entry.reason };
    const state = entry.verdict === "PROVEN" ? "proven" : entry.verdict === "PARTLY PROVEN" ? "partly" : "not";
    return { state, verdict: entry.verdict, reason: entry.reason };
}

/** Artifacts older than one they derive from (status §2). */
export function staleOf(facts) {
    const f = facts.files;
    const out = [];
    const older = (a, b) => f[a] != null && f[b] != null && f[a] < f[b];
    for (const input of ["ASSESSMENT.md", "topology.json", "BUSINESS_RULES.md"]) {
        if (older("MODERNIZATION_BRIEF.md", input)) {
            out.push({ artifact: "MODERNIZATION_BRIEF.md", because: `older than ${input}`, fix: cmd("brief", facts.system), why: "it no longer reflects discovery" });
        }
    }
    if (facts.track === "uplift" && f["MODERNIZATION_BRIEF.md"] != null) {
        if (f["DELTA_CATALOG.md"] == null) {
            out.push({ artifact: "MODERNIZATION_BRIEF.md", because: "an uplift brief with no DELTA_CATALOG.md", fix: cmd("brief", facts.system), why: "the phase order was decided without the version deltas" });
        } else if (older("MODERNIZATION_BRIEF.md", "DELTA_CATALOG.md")) {
            out.push({ artifact: "MODERNIZATION_BRIEF.md", because: "older than DELTA_CATALOG.md", fix: cmd("brief", facts.system), why: "the phase order was decided without the version deltas" });
        }
    }
    if (older("TOPOLOGY.html", "topology.json")) {
        out.push({ artifact: "TOPOLOGY.html", because: "older than topology.json", fix: cmd("map", facts.system), why: "rerun the render step of map" });
    }
    if (facts.track === "rewrite" && f["BUSINESS_RULES.md"] != null) {
        for (const m of facts.modules) {
            if (m.notesMs != null && m.notesMs < f["BUSINESS_RULES.md"]) {
                out.push({ artifact: `${m.name}/TRANSFORMATION_NOTES.md`, because: "older than BUSINESS_RULES.md", fix: cmd("transform", facts.system, isToken(m.name) ? m.name : "<module>"), why: "the module may not implement the latest rules" });
            }
        }
    }
    return out;
}

function approvedPhases(brief) {
    if (!brief?.approval?.signed) return [];
    const ordered = [...brief.phases].sort((a, b) => a.number - b.number);
    return /full/i.test(brief.approval.covers ?? "") ? ordered : ordered.slice(0, 1);
}

const verifyStep = (facts, module, proof) => {
    if (!proof || proof.state === "proven") return null;
    const one = (module.track ?? facts.track) !== "uplift";
    const text = cmd("verify", facts.system, one && isToken(module.name) ? module.name : undefined);
    const name = module.name;
    if (proof.state === "none") return { command: text, reason: `${name} is built but nothing has checked it against the old code yet` };
    if (proof.state === "changed") return { command: text, reason: `${name} changed after it was verified: check it again` };
    return { command: text, reason: `${name} is ${proof.verdict}${proof.reason ? `: ${proof.reason}` : ""}. Fix what the reason names, then verify again` };
};

/**
 * The single most useful next step, as {command, reason} or, where only a person can act, {action, text, reason}.
 * Order (status/SKILL.md): preflight, assess, map, extract-rules, review, brief (approval), the brief's build command,
 * verify ahead of building the next module, then harden.
 */
export function nextOf(facts, ctx) {
    const s = facts.system;
    const f = facts.files;
    const has = (name) => f[name] != null;
    const goal = facts.intent?.goal;

    if (!facts.hasAnalysis || (!has("INTENT.md") && !has("PREFLIGHT.md") && !has("ASSESSMENT.md"))) {
        return facts.legacyExists
            ? { command: cmd("start", s), reason: "start here: it asks what you want done, then gives the first step" }
            : { command: cmd("start", s, "--source", "<path to the code>"), reason: "start here: it asks where the code is and what you want done" };
    }
    if (!has("PREFLIGHT.md")) return { command: cmd("preflight", s), reason: "checks the environment and records where the code lives" };
    if (!has("ASSESSMENT.md")) return { command: cmd("assess", s), reason: "inventory, complexity, debt, security and a recommended pattern" };
    if (facts.intent?.securityFirst && !has("SECURITY_FINDINGS.md")) {
        return { command: cmd("harden", s), reason: "you asked for a security review first: it comes right after the assessment" };
    }
    if (!has("topology.json")) return { command: cmd("map", s), reason: "how the parts connect: calls, data and business flows" };
    if (!has("BUSINESS_RULES.md") && facts.track !== "uplift") {
        return { command: cmd("extract-rules", s), reason: "what the code does, as rules a business person can check" };
    }
    if (ctx.p0Open.length > 0) {
        const n = ctx.p0Open.length;
        return { command: cmd("review", s), reason: `${n} flagged P0 rule${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a person's judgement (or answer them in the review deck here)` };
    }
    const brief = facts.brief;
    if (!brief) return { command: cmd("brief", s), reason: "the phased plan a person approves before anything is built" };
    const staleBrief = ctx.stale.find((x) => x.artifact === "MODERNIZATION_BRIEF.md");
    if (staleBrief) return { command: cmd("brief", s), reason: `the brief is ${staleBrief.because}: ${staleBrief.why}` };
    if (goal === "understand") {
        return { command: cmd("status", s), reason: "the goal was to understand the code: the map, rules and plan are done, and choosing a road is the person's decision" };
    }
    if (!brief.approval.signed) {
        return brief.approval.hasBlock
            ? { action: "sign-brief", text: "Approve the brief", reason: "nothing is built until a person approves the plan: sign its approval block below, or edit §8 of MODERNIZATION_BRIEF.md" }
            : { command: cmd("brief", s), reason: "the brief has no approval block: regenerate it so a person can approve it" };
    }

    // Built work first: verify ahead of building the next module.
    for (const m of facts.modules) {
        const step = verifyStep(facts, m, ctx.proofs.get(m.name.toLowerCase()));
        if (step) return step;
    }
    const proven = facts.modules.filter((m) => ctx.proofs.get(m.name.toLowerCase())?.state === "proven");
    if (proven.length > 0 && facts.signoff && !facts.signoff.signed) {
        return { action: "sign-verification", text: "Sign VERIFICATION.md", reason: "a PROVEN verdict is evidence, not approval: a named person signs the sign-off below" };
    }

    const target = brief.target ?? (facts.intent?.to && facts.track === "rewrite" ? facts.intent.to : undefined);
    if (facts.track === "uplift") {
        const up = cmd("uplift", s);
        if (!has("DELTA_CATALOG.md")) return { command: up, reason: "first it lists what the newer version breaks in this code" };
        if (!has("BASELINE.md")) return { command: up, reason: "next it records what the tests do today, to compare against" };
        if (!has("PLAYBOOK.md")) return { command: up, reason: "next it migrates one unit first (the pilot) and writes down what it learned" };
        if (facts.upliftNotesMs == null) return { command: up, reason: "next it migrates the rest in batches, each compared with the baseline" };
    } else if (facts.track === "reimagine") {
        const re = cmd("reimagine", s, facts.intent?.to ? quoteArg(facts.intent.to) : undefined);
        if (!has("AI_NATIVE_SPEC.md")) return { command: re, reason: "first it writes down what the old system does, from its code" };
        if (!has("REIMAGINED_ARCHITECTURE.md")) return { command: re, reason: "next it designs the new architecture and checks it against the spec" };
        if (facts.reimaginedHandoffMs == null) return { command: re, reason: "next it builds each service of the approved design, with tests, and writes the AGENTS.md handoff" };
    } else {
        const built = new Map(facts.modules.map((m) => [m.name.toLowerCase(), m]));
        for (const phase of approvedPhases(brief)) {
            if (phase.command && phase.command !== "transform") continue;
            for (const id of phase.modules) {
                const m = built.get(id.toLowerCase());
                if (!m || !m.built) {
                    const named = isToken(id);
                    return {
                        command: cmd("transform", s, named ? id : "<module>", target && isToken(target) ? target : undefined),
                        reason: `Phase ${phase.number} names ${id} and it is not built yet`,
                    };
                }
            }
            if (phase.modules.length === 0) {
                return { command: cmd("transform", s, "<module>"), reason: `Phase ${phase.number} names no module: pick its first one` };
            }
        }
        if (facts.modules.length === 0) {
            return { command: cmd("transform", s, "<module>"), reason: "the approved phases name no module to build" };
        }
    }
    if (!has("SECURITY_FINDINGS.md")) return { command: cmd("harden", s), reason: "scans the legacy system for security problems, with a reviewable patch" };
    const more = brief.phases.length > approvedPhases(brief).length;
    if (more) return { command: cmd("brief", s), reason: "the approved phases are built and proven: revise the brief from what they taught, then approve the next phases" };
    return { command: cmd("status", s), reason: "everything the plan names is built, proven and signed; status says what is stale" };
}

/** The steps for the system's track, each {key, label, done, file?, mtimeMs?, detail?, stale?}. */
export function stagesOf(facts, ctx) {
    const f = facts.files;
    const st = (key, label, file, extra = {}) => ({ key, label, done: f[file] != null, file, mtimeMs: f[file] ?? null, ...extra });
    const staleFiles = new Set(ctx.stale.map((x) => x.artifact));
    const rules = facts.rules ?? [];
    const flaggedTotal = flaggedAll(rules, facts.brief).length;
    const decided = flaggedTotal - ctx.flagged.length;
    const common = [
        st("intent", "intent", "INTENT.md", facts.intent?.goal ? { detail: facts.intent.goal } : {}),
        st("preflight", "preflight", "PREFLIGHT.md"),
        st("assess", "assess", "ASSESSMENT.md"),
        st("map", "map", "topology.json", { ...(facts.mapCount ? { detail: `${facts.mapCount} modules` } : {}), stale: staleFiles.has("TOPOLOGY.html") }),
        st("extract-rules", "rules", "BUSINESS_RULES.md", rules.length ? { detail: `${rules.length} rules, ${rules.filter((r) => r.priority === "P0").length} P0` } : {}),
        {
            key: "review",
            label: "review",
            done: f["BUSINESS_RULES.md"] != null && ctx.p0Open.length === 0,
            file: "RULE_REVIEWS.json",
            mtimeMs: f["RULE_REVIEWS.json"] ?? null,
            ...(flaggedTotal ? { detail: `${decided} of ${flaggedTotal} decided` } : {}),
        },
        st("brief", "brief", "MODERNIZATION_BRIEF.md", {
            ...(facts.brief ? { detail: facts.brief.approval.signed ? "approved" : "waiting for approval" } : {}),
            stale: staleFiles.has("MODERNIZATION_BRIEF.md"),
        }),
    ];
    const proofs = [...ctx.proofs.values()];
    const verify = {
        key: "verify",
        label: "verify",
        done: proofs.length > 0 && proofs.every((p) => p.state === "proven") && !!facts.signoff?.signed,
        file: "VERIFICATION.json",
        mtimeMs: f["VERIFICATION.json"] ?? null,
        ...(proofs.length ? { detail: `${proofs.filter((p) => p.state === "proven").length} of ${proofs.length} proven${facts.signoff?.signed ? ", signed" : ""}` } : {}),
    };
    const harden = st("harden", "harden", "SECURITY_FINDINGS.md");
    const built = facts.modules.filter((m) => m.built).length;
    let build;
    if (facts.track === "uplift") {
        build = [
            st("deltas", "deltas", "DELTA_CATALOG.md", facts.deltaCount ? { detail: `${facts.deltaCount} deltas` } : {}),
            st("baseline", "baseline", "BASELINE.md"),
            st("pilot", "pilot", "PLAYBOOK.md"),
            { key: "migrate", label: "migrate", done: facts.upliftNotesMs != null, file: "UPLIFT_NOTES.md", mtimeMs: facts.upliftNotesMs ?? null, ...(facts.modules.length ? { detail: facts.upliftNotesMs != null ? "notes written" : "in progress" } : {}) },
        ];
    } else if (facts.track === "reimagine") {
        build = [
            st("spec", "spec", "AI_NATIVE_SPEC.md"),
            st("design", "design", "REIMAGINED_ARCHITECTURE.md"),
            { key: "scaffold", label: "scaffold", done: facts.reimaginedHandoffMs != null, file: "AGENTS.md", mtimeMs: facts.reimaginedHandoffMs ?? null, ...(facts.modules.length ? { detail: `${facts.modules.length} service${facts.modules.length === 1 ? "" : "s"}` } : {}) },
        ];
    } else {
        build = [
            { key: "transform", label: "transform", done: built > 0, ...(facts.modules.length ? { detail: `${built} of ${facts.modules.length} module${facts.modules.length === 1 ? "" : "s"} built` } : {}) },
        ];
    }
    // "Understand it first" stops after the brief (start/SKILL.md): no build steps are shown for it.
    if (facts.intent?.goal === "understand" && facts.modules.length === 0) return [...common, harden];
    return [...common, ...build, verify, harden];
}

/** What needs a person, as [{kind, text}], most urgent first. */
export function attentionOf(facts, ctx) {
    const out = [];
    const add = (kind, text) => out.push({ kind, text });
    if (facts.hasAnalysis && facts.files["PREFLIGHT.md"] != null && !facts.legacyExists && !facts.hasSource) {
        add("legacy", `legacy/${facts.system} does not exist: nothing can run without the code`);
    }
    if (facts.brief && !facts.brief.approval.signed) add("brief", "The brief is not approved: nothing is built until a person signs its approval block");
    if (ctx.p0Open.length) add("review", `${ctx.p0Open.length} flagged P0 rule${ctx.p0Open.length === 1 ? "" : "s"} still need${ctx.p0Open.length === 1 ? "s" : ""} a person's review`);
    const named = ctx.flagged.length - ctx.p0Open.length;
    if (named > 0) add("review", `${named} rule${named === 1 ? "" : "s"} named in the brief's open questions ${named === 1 ? "has" : "have"} no verdict yet`);
    const p0 = new Set((facts.rules ?? []).filter((r) => r.priority === "P0").map((r) => r.id));
    const discuss = Object.entries(facts.reviews).filter(([id, v]) => v.verdict === "discuss" && p0.has(id)).length;
    if (discuss) add("review", `${discuss} P0 rule${discuss === 1 ? "" : "s"} under discussion: the build commands stop on ${discuss === 1 ? "it" : "them"} until settled`);
    const wrong = Object.values(facts.reviews).filter((v) => v.verdict === "wrong").length;
    if (wrong) add("review", `${wrong} rule${wrong === 1 ? "" : "s"} marked wrong: no test oracle is built on ${wrong === 1 ? "it" : "them"}`);
    for (const m of facts.modules) {
        const p = ctx.proofs.get(m.name.toLowerCase());
        if (!p) continue;
        if (p.state === "not") add("proof", `${m.name}: NOT PROVEN${p.reason ? `: ${p.reason}` : ""}`);
        else if (p.state === "partly") add("proof", `${m.name}: PARTLY PROVEN${p.reason ? `: ${p.reason}` : ""}`);
        else if (p.state === "changed") add("proof", `${m.name}: changed since it was verified`);
        else if (p.state === "none") add("proof", `${m.name}: built, not verified yet`);
    }
    if (facts.signoff?.hasTable && !facts.signoff.signed) add("signoff", "VERIFICATION.md is not signed by a person");
    for (const s of ctx.stale) add("stale", `${s.artifact} is stale (${s.because}): ${s.fix}`);
    const sec = facts.security;
    if (sec && (sec.Critical > 0 || sec.High > 0)) {
        add("security", `Security findings: ${sec.Critical} Critical, ${sec.High} High`);
    }
    return out;
}

/** Everything progress decides for one system. */
export function progressOf(facts) {
    const proofs = new Map();
    for (const m of facts.modules) {
        const p = proofOf(facts, m);
        if (p) proofs.set(m.name.toLowerCase(), p);
    }
    const flagged = flaggedRules(facts.rules, facts.reviews, facts.brief);
    const stale = staleOf(facts);
    const p0Open = flagged.filter((r) => needsReview(r));
    const ctx = { proofs, flagged, p0Open, stale };
    return { proofs, flagged, p0Open, stale, stages: stagesOf(facts, ctx), attention: attentionOf(facts, ctx), next: nextOf(facts, ctx) };
}
