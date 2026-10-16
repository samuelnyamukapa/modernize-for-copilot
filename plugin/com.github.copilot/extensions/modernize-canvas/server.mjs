// The live status page's local HTTP server: loopback only, one random token per process.
//
//   GET  /?t=<token>            the page (page.html; the bundled assets carry the token too)
//   GET  /<asset>?t=<token>     app.js, styles.css, treemap.mjs: a fixed whitelist, never a workspace file
//   GET  /api/state             the model of every system            (X-Modernize-Token header)
//   GET  /api/events            Server-Sent Events: state, activity   (X-Modernize-Token header)
//   POST /api/review            a rule verdict                         (header + application/json)
//   POST /api/signoff           {kind: "verification" | "brief", ...}  (header + application/json)
//
// Every request must name this server by Host (127.0.0.1:<port> or localhost:<port>), which a
// DNS-rebinding page cannot; every request must carry the token; POSTs must be JSON (a cross-site
// form cannot send that without a preflight), at most 64 KB, and from this origin when an Origin
// header is sent. No SDK import, so the tests load it directly.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WriteError } from "./writers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The only files the server ever sends, by URL path. */
export const ASSETS = {
    "/": { file: "page.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/treemap.mjs": { file: "treemap.mjs", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

export const MAX_BODY = 64 * 1024;

export const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'";

const BASE_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
};

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
    const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(payload), ...extra });
    res.end(payload);
}

const fail = (res, status, message) => send(res, status, { ok: false, error: message });

function sameToken(given, token) {
    if (typeof given !== "string" || given.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new WriteError(413, "request body is larger than 64 KB"));
            req.resume();
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        req.on("data", (c) => {
            if (done) return;
            size += c.length;
            if (size > limit) {
                done = true;
                reject(new WriteError(413, "request body is larger than 64 KB"));
                req.resume();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
        });
        req.on("error", (e) => {
            if (!done) reject(e);
        });
    });
}

/**
 * Starts the server and resolves to {port, token, origin, pageUrl(system?), broadcast(event, data), clients(), close()}.
 *
 * @param {object} o
 * @param {() => object} o.getState    the current model (with recent activity)
 * @param {(body) => object} o.review  writes a verdict (writers.writeReview bound to the workspace)
 * @param {(body) => object} o.signoff writes a sign-off ({kind: "verification" | "brief", ...})
 * @param {() => void} [o.onWrite]     called after a successful write (the hub re-reads and pushes)
 * @param {(n: number) => void} [o.onClients] called when the number of event-stream clients changes
 */
export function startServer({ getState, review, signoff, onWrite = () => {}, onClients = () => {}, assetsDir = HERE, token = crypto.randomBytes(32).toString("hex") }) {
    const streams = new Set();
    let port = 0;

    const hostOk = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    const originOk = (origin) => origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

    const server = http.createServer(async (req, res) => {
        try {
            if (!hostOk(req.headers.host)) return fail(res, 403, "wrong host");
            let url;
            try {
                url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            } catch {
                return fail(res, 400, "bad url");
            }
            const isApi = url.pathname.startsWith("/api/");
            const given = isApi ? req.headers["x-modernize-token"] : url.searchParams.get("t");
            if (!sameToken(given, token)) return fail(res, 403, "missing or wrong token");

            if (!isApi) {
                if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method not allowed");
                const asset = Object.hasOwn(ASSETS, url.pathname) ? ASSETS[url.pathname] : null;
                if (!asset) return fail(res, 404, "not found");
                let body = fs.readFileSync(path.join(assetsDir, asset.file));
                if (asset.file === "page.html") body = body.toString("utf8").replaceAll("{{TOKEN}}", token);
                return send(res, 200, body, asset.type);
            }

            if (url.pathname === "/api/state") {
                if (req.method !== "GET") return fail(res, 405, "method not allowed");
                return send(res, 200, getState());
            }
            if (url.pathname === "/api/events") {
                if (req.method !== "GET") return fail(res, 405, "method not allowed");
                res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
                res.write(`retry: 3000\n\nevent: state\ndata: ${JSON.stringify(getState())}\n\n`);
                streams.add(res);
                onClients(streams.size);
                const drop = () => {
                    if (streams.delete(res)) onClients(streams.size);
                };
                req.on("close", drop);
                res.on("error", drop);
                return undefined;
            }
            if (url.pathname === "/api/review" || url.pathname === "/api/signoff") {
                if (req.method !== "POST") return fail(res, 405, "method not allowed");
                if (!originOk(req.headers.origin)) return fail(res, 403, "wrong origin");
                const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
                if (type !== "application/json") return fail(res, 415, "Content-Type must be application/json");
                const raw = await readBody(req, MAX_BODY);
                let body;
                try {
                    body = JSON.parse(raw);
                } catch {
                    return fail(res, 400, "body is not JSON");
                }
                if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(res, 400, "body must be a JSON object");
                const result = url.pathname === "/api/review" ? review(body) : signoff(body);
                onWrite();
                return send(res, 200, result);
            }
            return fail(res, 404, "not found");
        } catch (err) {
            if (err instanceof WriteError) return fail(res, err.status, err.message);
            return fail(res, 500, "internal error");
        }
    });

    const heartbeat = setInterval(() => {
        for (const s of streams) s.write(": keep-alive\n\n");
    }, 25_000);
    heartbeat.unref();

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            port = server.address().port;
            server.unref();
            resolve({
                port,
                token,
                origin: `http://127.0.0.1:${port}`,
                pageUrl: (system) => `http://127.0.0.1:${port}/?t=${token}${system ? `&system=${encodeURIComponent(system)}` : ""}`,
                broadcast(event, data) {
                    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                    for (const s of streams) s.write(frame);
                },
                clients: () => streams.size,
                close() {
                    clearInterval(heartbeat);
                    for (const s of streams) s.end();
                    streams.clear();
                    return new Promise((r) => server.close(() => r()));
                },
            });
        });
    });
}
