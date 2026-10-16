// The squarified treemap: areas proportional to sizes, no overlap, everything inside the bounds.
//   node --test plugin/tools/tests/canvas/treemap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { CANVAS } from "./fixtures.mjs";

const { layout, layoutGroups } = await import(new URL("treemap.mjs", CANVAS));

const EPS = 1e-6;
const area = (r) => r.w * r.h;

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > EPS && h > EPS ? w * h : 0;
}

function checkPlaced(placed, rect, sizes) {
    const total = sizes.reduce((s, x) => s + x, 0);
    for (const p of placed) {
        const r = p.rect;
        assert.ok(r.w >= -EPS && r.h >= -EPS, "no negative sides");
        assert.ok(r.x >= rect.x - 1e-6 && r.y >= rect.y - 1e-6, "inside, top-left");
        assert.ok(r.x + r.w <= rect.x + rect.w + 1e-6 && r.y + r.h <= rect.y + rect.h + 1e-6, "inside, bottom-right");
        const expected = (p.size / total) * area(rect);
        assert.ok(Math.abs(area(r) - expected) <= Math.max(1e-6, expected * 1e-6), `area ${area(r)} proportional to ${expected}`);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.equal(overlap(placed[i].rect, placed[j].rect), 0, `tiles ${i} and ${j} overlap`);
    const covered = placed.reduce((s, p) => s + area(p.rect), 0);
    assert.ok(Math.abs(covered - area(rect)) < 1e-6 * area(rect) + 1e-6, "the tiles fill the rectangle");
}

test("random sizes: proportional, no overlap, inside the bounds, fully covered", () => {
    const rand = rng(42);
    for (let round = 0; round < 50; round++) {
        const n = 1 + Math.floor(rand() * 60);
        const sizes = Array.from({ length: n }, () => 1 + Math.floor(rand() * 5000));
        const rect = { x: rand() * 20, y: rand() * 20, w: 50 + rand() * 900, h: 50 + rand() * 500 };
        const placed = layout(sizes.map((size, i) => ({ item: i, size })), rect);
        assert.equal(placed.length, n);
        checkPlaced(placed, rect, placed.map((p) => p.size));
        assert.deepEqual(placed.map((p) => p.item).sort((a, b) => a - b), sizes.map((_, i) => i));
    }
});

test("largest first, and squarified tiles are not slivers for equal sizes", () => {
    const placed = layout([1, 1, 1, 1].map((size, i) => ({ item: i, size })), { x: 0, y: 0, w: 200, h: 200 });
    for (const p of placed) assert.ok(Math.abs(p.rect.w - 100) < 1e-9 && Math.abs(p.rect.h - 100) < 1e-9);
    const sorted = layout([{ item: "s", size: 1 }, { item: "b", size: 9 }], { x: 0, y: 0, w: 100, h: 100 });
    assert.equal(sorted[0].item, "b");
});

test("zero, negative and missing sizes do not break the layout; a floor lifts tiny tiles", () => {
    const placed = layout([{ item: "a", size: 0 }, { item: "b", size: -5 }, { item: "c", size: NaN }, { item: "d", size: 10 }], { x: 0, y: 0, w: 100, h: 50 });
    assert.equal(placed.length, 4);
    for (const p of placed) assert.ok(Number.isFinite(p.rect.x + p.rect.y + p.rect.w + p.rect.h));
    const lifted = layout([{ item: "tiny", size: 1 }, { item: "huge", size: 10_000 }], { x: 0, y: 0, w: 100, h: 100 }, 0.2);
    const tiny = lifted.find((p) => p.item === "tiny");
    assert.ok(area(tiny.rect) > 500, "the floor made the tiny tile visible");
    assert.deepEqual(layout([], { x: 0, y: 0, w: 10, h: 10 }), []);
    assert.deepEqual(layout([{ item: 1, size: 1 }], { x: 0, y: 0, w: 0, h: 10 }), []);
});

test("groups: each group's items stay inside the group's inner rectangle and the groups do not overlap", () => {
    const rand = rng(7);
    const groups = Array.from({ length: 6 }, (_, g) => ({ name: `g${g}`, items: Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, i) => ({ item: `${g}.${i}`, size: 1 + Math.floor(rand() * 900) })) }));
    groups.push({ name: "empty", items: [] });
    const rect = { x: 0, y: 0, w: 800, h: 400 };
    const placed = layoutGroups(groups, rect, { pad: 2, labelHeight: 15 });
    assert.equal(placed.length, 6, "an empty group is left out");
    const totals = groups.filter((g) => g.items.length).map((g) => g.items.reduce((s, x) => s + x.size, 0));
    checkPlaced(placed.map((g) => ({ rect: g.rect, size: totals[groups.findIndex((x) => x.name === g.name)] })), rect, totals);
    for (const g of placed) {
        const inner = g.items.length ? g.items : [];
        const bounds = g.rect.w > 12 && g.rect.h > 27 ? { x: g.rect.x + 2, y: g.rect.y + 17, w: g.rect.w - 4, h: g.rect.h - 19 } : g.rect;
        checkPlaced(inner, bounds, inner.map((p) => p.size));
    }
});
