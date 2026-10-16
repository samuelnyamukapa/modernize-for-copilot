// Session events → compact activity items for the live status page. Pure: the caller supplies a
// `locate(path)` that says whether a path is inside legacy/<system>/ or modernized/<system>*/.
// Event names and shapes are from @github/copilot-sdk 1.0.22 dist/generated/session-events.d.ts.

/** The session events the canvas follows. */
export const ACTIVITY_EVENTS = [
    "tool.execution_start",
    "tool.execution_complete",
    "subagent.started",
    "subagent.completed",
    "subagent.failed",
    "workflow.run_started",
    "workflow.run_updated",
    "workflow.run_settled",
    "skill.invoked",
];

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const short = (v, max = 120) => {
    if (typeof v !== "string") return "";
    const flat = v.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const WRITE_TOOL = /edit|write|create|patch|replace|insert|delete|remove|move|rename|mkdir|save/i;
const SHELL_TOOL = /^(bash|powershell|pwsh|shell|execute|run_in_terminal|terminal|cmd)$/i;

/** Path-like strings in a tool's arguments: string values (and words of a command line), depth and count capped. */
export function pathsIn(args) {
    const out = [];
    const visit = (v, depth) => {
        if (out.length >= 40 || depth > 4) return;
        if (typeof v === "string") {
            if (v.length > 4000) return;
            for (const word of v.split(/[\s"'`=(),;|&<>]+/)) {
                if (out.length >= 40) break;
                if (/[\\/]/.test(word) && word.length <= 1000) out.push(word);
            }
        } else if (Array.isArray(v)) {
            for (const x of v.slice(0, 50)) visit(x, depth + 1);
        } else if (v && typeof v === "object") {
            for (const x of Object.values(v).slice(0, 50)) visit(x, depth + 1);
        }
    };
    visit(args, 0);
    return out;
}

const timeOf = (e) => (typeof e?.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)) ? e.timestamp : new Date().toISOString());

/**
 * One event → an item {at, kind, label, status?, touches?: [{system, area, rel, mode}]} or null for one not shown.
 * `state` is a small per-process memory ({calls: Map, runs: Map}) so a completion can be named after its start.
 */
export function toActivity(event, state, locate = () => null) {
    if (!event || typeof event.type !== "string" || !event.data || typeof event.data !== "object") return null;
    const d = event.data;
    const at = timeOf(event);
    const sub = typeof event.agentId === "string" ? "agent " : "";
    const touchesOf = (paths, mode) => {
        const seen = new Set();
        const out = [];
        for (const p of paths) {
            const hit = locate(p);
            if (!hit) continue;
            const key = `${hit.system}:${hit.area}:${hit.rel}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ...hit, mode });
            if (out.length >= 8) break;
        }
        return out;
    };
    switch (event.type) {
        case "tool.execution_start": {
            const name = short(d.toolName, 60) || "tool";
            const shell = SHELL_TOOL.test(name);
            const mode = shell ? (d.shellToolInfo?.hasWriteFileRedirection ? "write" : "read") : WRITE_TOOL.test(name) ? "write" : "read";
            const paths = [...pathsIn(d.arguments), ...(Array.isArray(d.shellToolInfo?.possiblePaths) ? d.shellToolInfo.possiblePaths.slice(0, 20) : [])];
            const touches = touchesOf(paths, mode);
            const what = touches[0] ? `${touches[0].area}/${touches[0].system}/${touches[0].rel}` : short(d.toolTitle, 80) || "";
            const label = short(`${sub}${name}${what ? ` ${what}` : ""}`);
            if (typeof d.toolCallId === "string") {
                state.calls.set(d.toolCallId, name);
                if (state.calls.size > 500) state.calls.delete(state.calls.keys().next().value);
            }
            return { at, kind: "tool", status: "start", label, ...(touches.length && { touches }) };
        }
        case "tool.execution_complete": {
            const name = state.calls.get(d.toolCallId) ?? "tool";
            state.calls.delete(d.toolCallId);
            const edits = Array.isArray(d.fileEdits) ? d.fileEdits.map((e) => e?.path).filter((p) => typeof p === "string") : [];
            const touches = touchesOf(edits, "write");
            if (d.success !== false && !touches.length) return null;
            return {
                at,
                kind: "tool",
                status: d.success === false ? "failed" : "done",
                label: short(`${sub}${name} ${d.success === false ? "failed" : `wrote ${touches.length} file${touches.length === 1 ? "" : "s"}`}`),
                ...(touches.length && { touches }),
            };
        }
        case "subagent.started":
            return { at, kind: "agent", status: "start", label: short(`${short(d.agentDisplayName || d.agentName, 60) || "agent"} started`) };
        case "subagent.completed":
            return { at, kind: "agent", status: "done", label: short(`${short(d.agentDisplayName || d.agentName, 60) || "agent"} finished`) };
        case "subagent.failed":
            return { at, kind: "agent", status: "failed", label: short(`${short(d.agentDisplayName || d.agentName, 60) || "agent"} failed: ${short(d.error, 80)}`) };
        case "workflow.run_started": {
            const name = short(d.workflowName, 60) || "workflow";
            if (typeof d.runId === "string") state.runs.set(d.runId, { name, at: 0 });
            return { at, kind: "workflow", status: "start", label: `${name} started` };
        }
        case "workflow.run_updated": {
            const run = state.runs.get(d.runId);
            const now = Date.parse(at);
            if (!run || now - run.at < 5000) return null;
            run.at = now;
            return { at, kind: "workflow", status: "update", label: `${run.name} running` };
        }
        case "workflow.run_settled": {
            const run = state.runs.get(d.runId);
            state.runs.delete(d.runId);
            const status = short(d.status, 20) || "settled";
            return { at, kind: "workflow", status: status === "completed" ? "done" : "failed", label: `${run?.name ?? "workflow"} ${status}` };
        }
        case "skill.invoked":
            return { at, kind: "skill", status: "start", label: short(`skill ${short(d.name, 60)}`) };
        default:
            return null;
    }
}

export const newActivityState = () => ({ calls: new Map(), runs: new Map() });
