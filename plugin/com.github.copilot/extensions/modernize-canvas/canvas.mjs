// The `modernize-status` canvas: its declaration, actions and open handler, as the options object
// the SDK's createCanvas takes. No SDK import, so the tests and convert/check_sdk.mjs can load it.
import { isSystemName } from "./parsers.mjs";
import { summaryOf } from "./reader.mjs";

export const CANVAS_ID = "modernize-status";

const SYSTEM_INPUT = {
    type: "object",
    properties: { system: { type: "string", description: "The system's folder name under analysis/ (letters, digits, - and _)." } },
};

// The directory this process started in, captured when the module loads: extension.mjs moves the
// process out of the plugin folder afterwards, so process.cwd() is no longer the starting one.
const STARTED_IN = process.cwd();

/** The working directory a request names, else the one this process started in. */
export const workspaceOf = (ctx) =>
    typeof ctx?.session?.workingDirectory === "string" && ctx.session.workingDirectory.trim() !== "" ? ctx.session.workingDirectory : STARTED_IN;

const systemOf = (ctx) => {
    const s = ctx?.input && typeof ctx.input === "object" ? ctx.input.system : undefined;
    return isSystemName(s) ? s : undefined;
};

/** createCanvas options for the live status canvas, bound to a hub (hub.mjs). */
export function canvasOptions(hub) {
    return {
        id: CANVAS_ID,
        displayName: "Modernize",
        description: "Live status of a legacy modernization: steps done, the map of the code, verdicts, what needs a person, and the next /modernize command.",
        inputSchema: SYSTEM_INPUT,
        actions: [
            {
                name: "summary",
                description: "A compact summary of every system in the workspace: stage, next command, verdicts and what needs attention.",
                inputSchema: { type: "object", properties: {} },
                handler: (ctx) => summaryOf(hub.model(workspaceOf(ctx))),
            },
            {
                name: "show_system",
                description: "Switch the open page to one system.",
                inputSchema: { ...SYSTEM_INPUT, required: ["system"] },
                handler: (ctx) => {
                    const system = systemOf(ctx);
                    if (!system) return { ok: false, error: "system must be a folder name of letters, digits, - and _" };
                    return hub.show(workspaceOf(ctx), system) ? { ok: true, system } : { ok: false, error: "the canvas is not open for this workspace: open it first" };
                },
            },
            {
                name: "refresh",
                description: "Read the workspace's files again and update the page.",
                inputSchema: { type: "object", properties: {} },
                handler: (ctx) => ({ ok: hub.refresh(workspaceOf(ctx)) }),
            },
        ],
        open: (ctx) => hub.open(workspaceOf(ctx), systemOf(ctx)),
        onClose: () => {
            // The server stays up for the next open in this session: it costs nothing while no page listens.
        },
    };
}
