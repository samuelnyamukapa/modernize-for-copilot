// One live status server per workspace, started on the first open and reused after that, plus the
// file watching and session activity that keep its page current. No SDK import: extension.mjs
// hands it session events, and the tests drive it directly.
import fs from "node:fs";
import path from "node:path";

import { readWorkspace, pathRootsOf, locatePath, tileFor } from "./reader.mjs";
import { startServer } from "./server.mjs";
import { writeReview, writeSignoff, writeApproval, WriteError } from "./writers.mjs";
import { toActivity, newActivityState } from "./activity.mjs";
import { isSystemName } from "./parsers.mjs";

const ACTIVITY_KEEP = 60;
const DEBOUNCE_MS = 300;
export const POLL_MS = 5000;

export function createHub({ start = startServer, pollMs = POLL_MS } = {}) {
    const entries = new Map();
    const early = [];

    function stateOf(entry) {
        return { ...entry.model, activity: entry.activity.slice(-ACTIVITY_KEEP), show: entry.lastSystem ?? null };
    }

    function reread(entry) {
        const model = readWorkspace(entry.ws, { cache: entry.cache });
        const key = JSON.stringify(model.systems);
        entry.model = model;
        entry.roots = pathRootsOf(entry.ws, model);
        if (key !== entry.key) {
            entry.key = key;
            return true;
        }
        return false;
    }

    function refresh(entry, force = false) {
        const changed = reread(entry);
        if ((changed || force) && entry.server) entry.server.broadcast("state", stateOf(entry));
        return changed;
    }

    function schedule(entry) {
        clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => refresh(entry), DEBOUNCE_MS);
        entry.debounce.unref?.();
    }

    function watch(entry) {
        const tries = [
            [path.join(entry.ws, "analysis"), { recursive: true }],
            [path.join(entry.ws, "modernized"), { recursive: false }],
            [entry.ws, { recursive: false }],
        ];
        for (const [dir, opts] of tries) {
            try {
                const w = fs.watch(dir, { ...opts, persistent: false }, () => schedule(entry));
                w.on("error", () => {});
                entry.watchers.push(w);
            } catch {
                // the folder may not exist yet, or recursive watching is unsupported: the poll covers it
            }
        }
    }

    function setPolling(entry, clients) {
        if (clients > 0 && !entry.poll) {
            entry.poll = setInterval(() => refresh(entry), pollMs);
            entry.poll.unref?.();
        } else if (clients === 0 && entry.poll) {
            clearInterval(entry.poll);
            entry.poll = null;
        }
    }

    function addActivity(entry, event) {
        const item = toActivity(event, entry.activityState, (p) => locatePath(entry.ws, entry.roots, p));
        if (!item) return;
        for (const t of item.touches ?? []) {
            const tile = tileFor(entry.model.systems.find((s) => s.name === t.system), t.area, t.rel);
            if (tile) t.tile = tile;
        }
        entry.activity.push(item);
        if (entry.activity.length > ACTIVITY_KEEP * 2) entry.activity.splice(0, entry.activity.length - ACTIVITY_KEEP);
        entry.server?.broadcast("activity", item);
        if (item.status === "done" && item.touches?.some((t) => t.mode === "write")) schedule(entry);
    }

    /** The entry for a workspace, its server started (once). */
    async function ensure(ws) {
        const key = path.resolve(ws);
        let entry = entries.get(key);
        if (entry) {
            await entry.ready;
            return entry;
        }
        entry = { ws: key, cache: new Map(), activity: [], activityState: newActivityState(), watchers: [], poll: null, debounce: null, key: "", lastSystem: null };
        entries.set(key, entry);
        entry.ready = (async () => {
            reread(entry);
            entry.server = await start({
                getState: () => stateOf(entry),
                review: (body) => writeReview(entry.ws, body),
                signoff: (body) => {
                    if (body.kind === "verification") return writeSignoff(entry.ws, body);
                    if (body.kind === "brief") return writeApproval(entry.ws, body);
                    throw new WriteError(400, "kind must be verification or brief");
                },
                onWrite: () => refresh(entry, true),
                onClients: (n) => setPolling(entry, n),
            });
            watch(entry);
            for (const e of early.splice(0)) addActivity(entry, e);
        })();
        try {
            await entry.ready;
        } catch (err) {
            entries.delete(key);
            throw err;
        }
        return entry;
    }

    return {
        ensure,
        /** Opens (or reuses) the page for a workspace: {url, title, status}. */
        async open(ws, system) {
            const entry = await ensure(ws);
            if (isSystemName(system)) {
                entry.lastSystem = system;
                entry.server.broadcast("show", { system });
            }
            refresh(entry);
            const systems = entry.model.systems;
            const pick = systems.find((s) => s.name === entry.lastSystem) ?? systems[0];
            const status = pick
                ? `${systems.length} system${systems.length === 1 ? "" : "s"} · ${pick.name}: ${pick.next.command ?? pick.next.text}`
                : "No system yet: /modernize:start";
            return { url: entry.server.pageUrl(isSystemName(system) ? system : undefined), title: `Modernize — ${entry.model.workspace.name}`, status: status.slice(0, 200) };
        },
        /** The model for a workspace, from its open page when there is one, else read now. */
        model(ws) {
            const entry = entries.get(path.resolve(ws));
            if (entry?.model) {
                reread(entry);
                return entry.model;
            }
            return readWorkspace(ws, { cache: new Map() });
        },
        refresh(ws) {
            const entry = entries.get(path.resolve(ws));
            if (!entry) return false;
            refresh(entry, true);
            return true;
        },
        show(ws, system) {
            const entry = entries.get(path.resolve(ws));
            if (!entry || !isSystemName(system)) return false;
            entry.lastSystem = system;
            entry.server.broadcast("show", { system });
            return true;
        },
        /** A session event: shown on every open page (the session has one working directory). */
        event(e) {
            if (entries.size === 0) {
                early.push(e);
                if (early.length > 40) early.shift();
                return;
            }
            for (const entry of entries.values()) if (entry.server) addActivity(entry, e);
        },
        async close() {
            for (const entry of entries.values()) {
                clearTimeout(entry.debounce);
                if (entry.poll) clearInterval(entry.poll);
                for (const w of entry.watchers) w.close();
                await entry.server?.close();
            }
            entries.clear();
        },
    };
}
