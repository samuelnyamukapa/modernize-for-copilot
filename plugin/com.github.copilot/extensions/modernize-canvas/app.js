// The live status page. Every string it shows comes from files written from an untrusted code base,
// so it builds the page with DOM calls and textContent only, never by parsing a string as HTML.
// It never runs a command: the Copy button puts the next command on the clipboard for a person.

const params = new URLSearchParams(location.search);
const TOKEN = params.get("t") ?? "";
const { layoutGroups } = await import(`./treemap.mjs?t=${encodeURIComponent(TOKEN)}`);

const view = {
    model: null,
    system: params.get("system"),
    activity: [],
    flashes: new Map(), // tile id -> {mode, until}
    deckPos: new Map(), // system -> index
    skipped: new Map(), // system -> Set of rule ids
    drafts: {}, // form field key -> value
    messages: {}, // section key -> {kind, text}
    tileEls: new Map(),
};

// ---------------------------------------------------------------- DOM helpers

function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = String(v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "data") for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = String(dv);
        else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

const $ = (id) => document.getElementById(id);

function ago(ms) {
    if (!ms) return "";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "just now";
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function api(path, body) {
    const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "X-Modernize-Token": TOKEN, ...(body && { "Content-Type": "application/json" }) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
    });
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
}

async function copy(text, button) {
    let ok = false;
    try {
        await navigator.clipboard.writeText(text);
        ok = true;
    } catch {
        const area = h("textarea", { "aria-hidden": "true" });
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        try {
            ok = document.execCommand("copy");
        } catch {
            ok = false;
        }
        area.remove();
    }
    button.textContent = ok ? "Copied" : "Select and copy";
    setTimeout(() => (button.textContent = "Copy"), 1600);
}

// ---------------------------------------------------------------- draft-preserving render

function field(key, el) {
    el.dataset.key = key;
    if (key in view.drafts) {
        if (el.type === "checkbox") el.checked = view.drafts[key] === true;
        else el.value = view.drafts[key];
    }
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", () => {
        view.drafts[key] = el.type === "checkbox" ? el.checked : el.value;
    });
    return el;
}

function render() {
    const active = document.activeElement?.dataset?.key;
    const caret = active && typeof document.activeElement.selectionStart === "number" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const main = $("main");
    const m = view.model;
    view.tileEls = new Map();
    renderSystems();
    if (!m) return;
    $("workspace").textContent = m.workspace?.name ?? "";
    const sys = m.systems.find((s) => s.name === view.system) ?? m.systems[0];
    if (sys) view.system = sys.name;
    const parts = sys ? systemView(sys) : [emptyView()];
    parts.push(activityView());
    main.replaceChildren(...parts);
    if (sys) drawMap(sys);
    if (active) {
        const el = main.querySelector(`[data-key="${CSS.escape(active)}"]`);
        if (el) {
            el.focus();
            if (caret && typeof el.setSelectionRange === "function") {
                try {
                    el.setSelectionRange(caret[0], caret[1]);
                } catch {
                    // not a text field
                }
            }
        }
    }
}

function renderSystems() {
    const nav = $("systems");
    const systems = view.model?.systems ?? [];
    nav.replaceChildren(
        ...(systems.length > 1
            ? systems.map((s) =>
                h("button", {
                    type: "button",
                    "aria-current": s.name === view.system ? "true" : "false",
                    onclick: () => {
                        view.system = s.name;
                        render();
                    },
                    text: s.name,
                }))
            : []),
    );
}

function emptyView() {
    const command = "/modernize:start <system> --source <path to the code>";
    const btn = h("button", { class: "btn", type: "button", text: "Copy" });
    btn.addEventListener("click", () => copy(command, btn));
    return h("section", { class: "panel next" },
        h("h2", { text: "Next" }),
        h("p", { text: "No system in this workspace yet: there is nothing under analysis/ or legacy/." }),
        h("div", { class: "next-row" }, h("code", { class: "cmd", text: command }), btn));
}

// ---------------------------------------------------------------- sections

const TRACK_WORDS = { rewrite: "rewrite", uplift: "same-stack uplift", reimagine: "reimagine" };

function systemView(s) {
    const intent = s.intent?.from || s.intent?.to ? `${s.intent.from ?? "?"} → ${s.intent.to ?? "?"}` : "";
    return [
        h("section", { class: "sys-head" },
            h("h1", { class: "sys-name", text: s.name }),
            h("span", { class: "track", title: s.trackWhy, text: s.intent?.goal === "understand" && !s.modules.length ? "understand first" : (TRACK_WORDS[s.track] ?? s.track) }),
            s.intent?.goal ? h("span", { class: "intent", text: `goal: ${s.intent.goal}` }) : null,
            intent ? h("span", { class: "intent", text: intent }) : null),
        nextView(s),
        h("section", { class: "panel" }, h("h2", { text: "Steps" }), stepsView(s)),
        mapPanel(s),
        h("div", { class: "grid2" }, attentionView(s), modulesView(s)),
        h("div", { class: "grid2" }, planView(s), securityView(s)),
        deckView(s),
        signView(s),
    ];
}

function nextView(s) {
    const n = s.next;
    const row = h("div", { class: "next-row" });
    if (n.command) {
        const btn = h("button", { class: "btn primary", type: "button", text: "Copy" });
        btn.addEventListener("click", () => copy(n.command, btn));
        row.append(h("code", { class: "cmd", text: n.command }), btn);
    } else {
        row.append(h("strong", { text: n.text }),
            h("button", { class: "btn primary", type: "button", text: "Go to sign-off", onclick: () => $("signoff")?.scrollIntoView({ behavior: "smooth" }) }));
    }
    return h("section", { class: "panel next" },
        h("h2", { text: "Next" }),
        row,
        h("p", { class: "note-line", text: n.reason }),
        n.command ? h("p", { class: "note-line", text: "Paste it into the session yourself: this page never runs commands." }) : null);
}

function stepsView(s) {
    return h("ol", { class: "steps" },
        s.stages.map((st) => h("li", {
            class: `step${st.done ? " done" : ""}${st.stale ? " stale" : ""}`,
            title: [st.file, st.mtimeMs ? `written ${new Date(st.mtimeMs).toLocaleString()}` : "", st.stale ? "stale" : ""].filter(Boolean).join(" · "),
        },
        h("span", { class: "mark", "aria-hidden": "true", text: st.stale ? "!" : st.done ? "✓" : "○" }),
        st.label,
        st.detail ? h("span", { class: "detail", text: st.detail }) : null,
        st.mtimeMs ? h("span", { class: "detail", text: ago(st.mtimeMs) }) : null)));
}

const STATE_WORDS = { todo: "not started", progress: "in progress", built: "built", proven: "proven" };

function mapPanel(s) {
    const map = s.map;
    const note = map.source === "topology"
        ? `From topology.json: one tile per module, sized by ${map.unit}, grouped by domain.`
        : map.source === "folders"
            ? `No map yet: one tile per top-level folder of ${map.groups[0]?.name ?? "the legacy tree"}, sized by file count.`
            : "No map yet, and no legacy tree to read: run /modernize:map once the code is linked.";
    const used = new Set(map.groups.flatMap((g) => g.tiles.map((t) => t.state)));
    return h("section", { class: "panel" },
        h("h2", { text: "Map" }),
        h("p", { class: "muted", text: note + (map.truncated ? " The walk stopped early: the tree is large." : "") }),
        map.groups.length ? h("div", { class: "map", id: "map", role: "img", "aria-label": `Map of ${s.name}` }) : null,
        map.groups.length
            ? h("ul", { class: "legend" },
                ["todo", "progress", "built", "proven"].filter((k) => used.has(k)).map((k) => h("li", { class: k, text: STATE_WORDS[k] })),
                h("li", { class: "read", text: "being read" }),
                h("li", { class: "write", text: "being written" }))
            : null);
}

function drawMap(s) {
    const box = $("map");
    if (!box) return;
    const w = box.clientWidth;
    const hgt = box.clientHeight;
    if (!w || !hgt) return;
    const groups = s.map.groups.map((g) => ({ name: g.name, items: g.tiles.map((t) => ({ item: t, size: t.size })) }));
    const placed = layoutGroups(groups, { x: 0, y: 0, w, h: hgt }, { floor: 0.08, pad: 2, labelHeight: groups.length > 1 ? 15 : 0 });
    const els = [];
    const px = (v) => `${Math.round(v * 10) / 10}px`;
    for (const g of placed) {
        const ge = h("div", { class: "group", title: g.name });
        Object.assign(ge.style, { left: px(g.rect.x), top: px(g.rect.y), width: px(g.rect.w), height: px(g.rect.h) });
        if (groups.length > 1 && g.rect.h > 30) ge.append(h("span", { class: "group-label", text: g.name }));
        els.push(ge);
        for (const p of g.items) {
            const t = p.item;
            const te = h("div", { class: `tile ${t.state}`, title: `${t.label} · ${t.size.toLocaleString()} ${s.map.unit} · ${STATE_WORDS[t.state]}${t.file ? ` · ${t.file}` : ""}` });
            Object.assign(te.style, { left: px(p.rect.x), top: px(p.rect.y), width: px(Math.max(0, p.rect.w)), height: px(Math.max(0, p.rect.h)) });
            if (p.rect.w > 46 && p.rect.h > 16) te.append(h("span", { text: t.label }));
            view.tileEls.set(t.id, te);
            els.push(te);
        }
    }
    box.replaceChildren(...els);
    applyFlashes();
}

function applyFlashes() {
    const now = Date.now();
    for (const [id, f] of view.flashes) {
        if (f.until < now) {
            view.flashes.delete(id);
            continue;
        }
        const el = view.tileEls.get(id);
        if (el) el.classList.add(f.mode === "write" ? "flash-write" : "flash-read");
    }
}

function flash(system, tile, mode) {
    if (system !== view.system) return;
    const until = Date.now() + 3500;
    view.flashes.set(tile, { mode, until });
    const el = view.tileEls.get(tile);
    if (!el) return;
    el.classList.remove("flash-read", "flash-write");
    el.classList.add(mode === "write" ? "flash-write" : "flash-read");
    setTimeout(() => {
        if ((view.flashes.get(tile)?.until ?? 0) <= Date.now()) el.classList.remove("flash-read", "flash-write");
    }, 3600);
}

function attentionView(s) {
    return h("section", { class: "panel" },
        h("h2", { text: "Needs attention" }),
        s.attention.length
            ? h("ul", { class: "plain attention" }, s.attention.map((a) => h("li", {}, h("span", { class: "kind", text: a.kind }), h("span", { class: "reason", text: a.text }))))
            : h("p", { class: "muted", text: "Nothing waiting on a person." }));
}

const PROOF_WORDS = { proven: "PROVEN", partly: "PARTLY PROVEN", not: "NOT PROVEN", changed: "changed since verified", none: "not verified yet" };

function modulesView(s) {
    const title = s.track === "reimagine" ? "Services" : "Built modules";
    const rows = s.modules.map((m) => {
        const p = m.proof;
        const chip = p ? h("span", { class: `chip ${p.state}`, text: PROOF_WORDS[p.state] }) : h("span", { class: "chip none", text: m.built ? "built" : "in progress" });
        return h("li", {},
            h("div", { class: "phase-head" }, h("strong", { text: m.name }), chip,
                m.track !== s.track ? h("span", { class: "muted", text: `(${m.track})` }) : null,
                m.onDisk === false ? h("span", { class: "muted", text: "folder not found" }) : null),
            p?.reason ? h("div", { class: "reason", text: p.reason }) : null);
    });
    const so = s.verification?.signoff;
    return h("section", { class: "panel" },
        h("h2", { text: title }),
        rows.length ? h("ul", { class: "plain" }, rows) : h("p", { class: "muted", text: "Nothing built yet." }),
        s.verification
            ? h("p", { class: "note-line" }, `Overall: ${s.verification.overall ?? "no verdict"}. `,
                so?.signed ? h("span", { class: "signed", text: `Signed by ${so.name}${so.role ? `, ${so.role}` : ""}${so.date ? ` on ${so.date}` : ""}: ${so.decision}.` }) : "Not signed by a person yet.")
            : null);
}

function planView(s) {
    const b = s.brief;
    if (!b) return h("section", { class: "panel" }, h("h2", { text: "Plan" }), h("p", { class: "muted", text: "No brief yet." }));
    const a = b.approval;
    const approval = a.signed
        ? h("p", { class: "signed", text: `Approved by ${a.by}${a.date ? ` on ${a.date}` : ""}${a.covers ? ` · covers: ${a.covers}` : ""}` })
        : h("p", { class: "error", text: a.hasBlock ? "Not approved yet." : "The brief has no Approval Block." });
    const tick = (list) => `${list.filter((c) => c.ticked).length}/${list.length}`;
    return h("section", { class: "panel" },
        h("h2", { text: "Plan" }),
        approval,
        h("ul", { class: "plain" }, b.phases.map((p) => h("li", {},
            h("div", { class: "phase-head" },
                h("strong", { text: `Phase ${p.number} — ${p.title}` }),
                p.command ? h("span", { class: "chip", text: p.command }) : null,
                p.scale ? h("span", { class: "chip", text: p.scale }) : null),
            p.modules.length ? h("div", { class: "reason", text: `Modules: ${p.modules.slice(0, 10).join(", ")}${p.modules.length > 10 ? ` and ${p.modules.length - 10} more` : ""}` }) : null,
            h("details", {},
                h("summary", { text: `entry ${tick(p.entry)} · exit ${tick(p.exit)} criteria ticked` }),
                [["Entry", p.entry], ["Exit", p.exit]].map(([label, list]) => list.length
                    ? h("div", {}, h("div", { class: "muted", text: label }), list.map((c) => h("div", { class: "crit", text: `${c.ticked ? "☑" : "☐"} ${c.text}` })))
                    : null))))),
        b.openQuestions ? h("p", { class: "note-line", text: `${b.openQuestions} open question${b.openQuestions === 1 ? "" : "s"} unticked in §7.` }) : null);
}

function securityView(s) {
    const sec = s.security;
    return h("section", { class: "panel" },
        h("h2", { text: "Security" }),
        sec
            ? h("div", { class: "sev" },
                ["Critical", "High", "Medium", "Low"].map((k) => h("span", { class: `chip ${k === "Critical" && sec[k] ? "crit-c" : k === "High" && sec[k] ? "crit-h" : ""}`, text: `${k} ${sec[k] ?? 0}` })))
            : h("p", { class: "muted", text: "No scan yet (/modernize:harden)." }));
}

// ---------------------------------------------------------------- review deck

function deckView(s) {
    const skipped = view.skipped.get(s.name) ?? new Set();
    const queue = s.deck.filter((r) => !skipped.has(r.id));
    const msg = view.messages[`deck:${s.name}`];
    const head = h("h2", { text: "Rules waiting for a person" });
    if (!s.deck.length) {
        return h("section", { class: "panel", id: "deck" }, head,
            h("p", { class: "muted", text: s.rules ? "No flagged rule is waiting: every one has a verdict." : "No BUSINESS_RULES.md yet." }),
            msg ? h("p", { class: msg.kind, text: msg.text }) : null);
    }
    if (!queue.length) {
        return h("section", { class: "panel", id: "deck" }, head,
            h("p", { class: "muted", text: `You skipped all ${s.deck.length}.` }),
            h("button", { class: "btn", type: "button", text: "Show them again", onclick: () => { view.skipped.delete(s.name); render(); } }));
    }
    const pos = Math.min(view.deckPos.get(s.name) ?? 0, queue.length - 1);
    const r = queue[pos];
    const noteKey = `note:${s.name}:${r.id}`;
    const note = field(noteKey, h("textarea", { placeholder: "Optional: what is right, or the question that needs answering, in your words", "aria-label": "Note" }));
    const answer = (verdict) => async (ev) => {
        const buttons = ev.currentTarget.parentElement.querySelectorAll("button");
        buttons.forEach((b) => (b.disabled = true));
        try {
            await api("/api/review", { system: s.name, rule: r.id, verdict, ...(note.value.trim() && { note: note.value.trim() }) });
            delete view.drafts[noteKey];
            view.messages[`deck:${s.name}`] = { kind: "success", text: `${r.id} recorded as ${verdict} in RULE_REVIEWS.json.` };
            render();
        } catch (err) {
            view.messages[`deck:${s.name}`] = { kind: "error", text: `Not recorded: ${err.message}` };
            buttons.forEach((b) => (b.disabled = false));
            render();
        }
    };
    return h("section", { class: "panel", id: "deck" }, head,
        h("p", { class: "muted", text: `/modernize:review's flagged scope: P0 rules with a suspected defect, an SME question or below High confidence, plus rules the brief's open questions name. ${queue.length} left · card ${pos + 1} of ${queue.length}.` }),
        h("article", { class: "card" },
            h("h3", { text: `${r.id}: ${r.title}` }),
            h("div", { class: "card-meta" },
                r.priority ? h("span", { class: "chip", text: r.priority }) : null,
                r.category ? h("span", { class: "chip", text: r.category }) : null,
                r.confidence ? h("span", { class: "chip", text: `confidence ${r.confidence}` }) : null),
            r.plain ? h("p", { text: r.plain }) : null,
            r.given || r.when || r.then
                ? h("dl", { class: "gwt" },
                    r.given ? [h("dt", { text: "Given" }), h("dd", { text: r.given })] : null,
                    r.when ? [h("dt", { text: "When" }), h("dd", { text: r.when })] : null,
                    r.then ? [h("dt", { text: "Then" }), h("dd", { text: r.then })] : null)
                : null,
            r.citation ? h("p", {}, h("span", { class: "muted", text: "Cited: " }), h("code", { text: r.citation })) : null,
            r.defect ? h("div", { class: "box defect" }, h("strong", { text: "Suspected defect" }), r.defect) : null,
            r.sme ? h("div", { class: "box sme" }, h("strong", { text: "Question for someone who knows the business" }), r.sme) : null,
            note,
            h("div", { class: "actions" },
                h("button", { class: "btn ok", type: "button", text: "Right", onclick: answer("confirmed") }),
                h("button", { class: "btn bad", type: "button", text: "Wrong, or not wanted", onclick: answer("wrong") }),
                h("button", { class: "btn warn", type: "button", text: "Not sure", onclick: answer("discuss") }),
                h("button", {
                    class: "btn", type: "button", text: "Skip",
                    onclick: () => {
                        if (queue.length > 1) view.deckPos.set(s.name, (pos + 1) % queue.length);
                        else {
                            skipped.add(r.id);
                            view.skipped.set(s.name, skipped);
                        }
                        render();
                    },
                }))),
        msg ? h("p", { class: msg.kind, text: msg.text }) : null);
}

// ---------------------------------------------------------------- sign-off

function signForm(s, kind, fields, submitText, done) {
    const key = (f) => `${kind}:${s.name}:${f}`;
    const inputs = {};
    const rows = fields.map((f) => {
        let el;
        if (f.options) el = h("select", {}, f.options.map((o) => h("option", { value: o, text: o })));
        else el = h("input", { type: f.type ?? "text", maxlength: 120, autocomplete: "off" });
        if (f.value && !(key(f.name) in view.drafts)) el.value = f.value;
        inputs[f.name] = field(key(f.name), el);
        return h("label", {}, f.label, el);
    });
    const confirm = field(key("confirm"), h("input", { type: "checkbox" }));
    const msg = view.messages[`${kind}:${s.name}`];
    const submit = h("button", { class: "btn primary", type: "button", text: submitText });
    submit.addEventListener("click", async () => {
        const body = { kind, system: s.name };
        for (const [k, el] of Object.entries(inputs)) body[k] = el.value.trim();
        if (!confirm.checked) {
            view.messages[`${kind}:${s.name}`] = { kind: "error", text: "Tick the box: only the person signing fills this in." };
            render();
            return;
        }
        submit.disabled = true;
        try {
            await api("/api/signoff", body);
            for (const f of [...fields.map((x) => x.name), "confirm"]) delete view.drafts[key(f)];
            view.messages[`${kind}:${s.name}`] = { kind: "success", text: done };
        } catch (err) {
            view.messages[`${kind}:${s.name}`] = { kind: "error", text: `Not signed: ${err.message}` };
        }
        render();
    });
    return h("div", {},
        h("div", { class: "form" }, rows,
            h("label", { class: "check wide" }, confirm, "I am this person, and I am signing this myself."),
            h("div", { class: "wide" }, submit)),
        msg ? h("p", { class: msg.kind, text: msg.text }) : null);
}

function signView(s) {
    const v = s.verification?.signoff;
    const a = s.brief?.approval;
    const verify = !s.verification || !v?.hasTable
        ? h("p", { class: "muted", text: s.verification ? "VERIFICATION.md has no Sign-off table to fill in." : "VERIFICATION.md appears after /modernize:verify." })
        : v.signed
            ? h("p", { class: "signed", text: `Signed by ${v.name}${v.role ? `, ${v.role}` : ""}${v.date ? ` on ${v.date}` : ""}: ${v.decision}.` })
            : signForm(s, "verification", [
                { name: "name", label: "Name" },
                { name: "role", label: "Role" },
                { name: "date", label: "Date", type: "date", value: today() },
                { name: "decision", label: "Decision", options: ["accept", "accept with conditions", "reject"] },
            ], "Sign VERIFICATION.md", "Signed: the Sign-off table in VERIFICATION.md now holds your name and decision.");
    const brief = !s.brief
        ? h("p", { class: "muted", text: "The brief's approval appears after /modernize:brief." })
        : !a.hasBlock
            ? h("p", { class: "muted", text: "The brief has no Approval Block: regenerate it with /modernize:brief." })
            : a.signed
                ? h("p", { class: "signed", text: `Approved by ${a.by}${a.date ? ` on ${a.date}` : ""}${a.covers ? ` · covers: ${a.covers}` : ""}.` })
                : signForm(s, "brief", [
                    { name: "name", label: "Name" },
                    { name: "role", label: "Role" },
                    { name: "date", label: "Date", type: "date", value: today() },
                    { name: "covers", label: "Approval covers", options: ["Phase 1 only", "Full plan"] },
                ], "Approve the brief", "Approved: the brief's Approval Block now holds your name, the date and what it covers.");
    return h("section", { class: "panel", id: "signoff" },
        h("h2", { text: "Sign-off" }),
        h("p", { class: "muted", text: "Only a person fills these in. The agent never signs." }),
        h("div", { class: "grid2" },
            h("div", {}, h("h3", { text: "Brief approval" }), brief),
            h("div", {}, h("h3", { text: "Verification sign-off" }), verify)));
}

// ---------------------------------------------------------------- activity

function activityView() {
    const items = view.activity.slice(-40).reverse();
    return h("section", { class: "panel", id: "activity" },
        h("h2", { text: "Session activity" }),
        items.length
            ? h("ul", { class: "plain activity" }, items.map((a) => h("li", {},
                h("span", { class: "t", text: new Date(a.at).toLocaleTimeString() }),
                h("span", { class: "kind", text: a.kind }),
                h("span", { class: `label${a.status === "failed" ? " failed" : ""}`, text: a.label }))))
            : h("p", { class: "muted", text: "Nothing yet in this session. Tool calls, agents, workflows and skills appear here as they run." }));
}

function onActivity(item) {
    view.activity.push(item);
    if (view.activity.length > 80) view.activity.splice(0, view.activity.length - 60);
    for (const t of item.touches ?? []) if (t.tile) flash(t.system, t.tile, t.mode);
    $("activity")?.replaceWith(activityView());
}

// ---------------------------------------------------------------- live updates

function setConn(state) {
    const el = $("conn");
    el.className = `conn ${state === "live" ? "live" : state === "down" ? "down" : ""}`;
    el.textContent = state === "live" ? "live" : state === "down" ? "reconnecting" : "connecting";
}

function applyState(state) {
    view.model = state;
    if (state.show && !params.get("system") && !view.system) view.system = state.show;
    if (Array.isArray(state.activity) && !view.activity.length) view.activity = state.activity.slice(-60);
    render();
}

async function stream() {
    let wait = 1000;
    for (;;) {
        try {
            const res = await fetch("/api/events", { headers: { "X-Modernize-Token": TOKEN }, cache: "no-store" });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            setConn("live");
            wait = 1000;
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += value;
                let cut;
                while ((cut = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, cut);
                    buf = buf.slice(cut + 2);
                    let event = "message";
                    const data = [];
                    for (const l of frame.split("\n")) {
                        if (l.startsWith("event:")) event = l.slice(6).trim();
                        else if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
                    }
                    if (!data.length) continue;
                    let payload;
                    try {
                        payload = JSON.parse(data.join("\n"));
                    } catch {
                        continue;
                    }
                    if (event === "state") applyState(payload);
                    else if (event === "activity") onActivity(payload);
                    else if (event === "show" && typeof payload.system === "string") {
                        view.system = payload.system;
                        render();
                    }
                }
            }
        } catch {
            // fall through to the retry
        }
        setConn("down");
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 15000);
    }
}

let resizeTimer;
new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const sys = view.model?.systems.find((s) => s.name === view.system);
        if (sys) drawMap(sys);
    }, 120);
}).observe(document.body);

setInterval(() => {
    if (view.flashes.size) applyFlashes();
}, 1000);

try {
    applyState(await api("/api/state"));
} catch {
    setConn("down");
}
stream();
