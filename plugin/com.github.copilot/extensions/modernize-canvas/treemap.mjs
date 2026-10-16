// A squarified treemap, two levels deep: groups (domains) first, then each group's items inside
// its rectangle. Pure and dependency-free: the server's tests import it in Node and the page
// imports the same file in the browser. Sizes in, fractional rectangles out.
// Adapted from anthropics/claude-plugins-official plugins/code-modernization/hooks/map/treemap.ts
// (Apache-2.0): the terminal-cell aspect correction and the rounding to whole cells are gone.

function worst(row, side) {
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const v of row) {
        sum += v;
        if (v > max) max = v;
        if (v < min) min = v;
    }
    if (sum === 0 || side === 0) return Infinity;
    const s2 = sum * sum;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/** Squarified layout of `areas` (already scaled to sum to the rectangle's area), in the order given. */
function squarify(areas, rect) {
    const out = [];
    let { x, y, w, h } = rect;
    let i = 0;
    while (i < areas.length) {
        const wide = w >= h;
        const side = wide ? h : w;
        const row = [];
        while (i < areas.length) {
            const next = areas[i];
            if (row.length > 0 && worst([...row, next], side) > worst(row, side)) break;
            row.push(next);
            i += 1;
        }
        const sum = row.reduce((a, b) => a + b, 0);
        const thick = side > 0 ? sum / side : 0;
        let offset = 0;
        for (const a of row) {
            const len = thick > 0 ? a / thick : 0;
            out.push(wide ? { x, y: y + offset, w: thick, h: len } : { x: x + offset, y, w: len, h: thick });
            offset += len;
        }
        if (wide) {
            x += thick;
            w = Math.max(0, w - thick);
        } else {
            y += thick;
            h = Math.max(0, h - thick);
        }
    }
    return out;
}

/**
 * Lays `entries` ([{item, size}]) out in `rect`, largest first. `floor` (0..1) lifts a tiny item to that share of
 * the mean size so it stays visible; 0 keeps every area exactly proportional to its size.
 * Returns [{item, size, rect}] where size is the size actually laid out.
 */
export function layout(entries, rect, floor = 0) {
    if (!entries.length || !(rect.w > 0) || !(rect.h > 0)) return [];
    const positive = entries.map((e) => ({ item: e.item, size: Number.isFinite(e.size) && e.size > 0 ? e.size : 0 }));
    const mean = positive.reduce((s, e) => s + e.size, 0) / positive.length || 1;
    const lifted = positive
        .map((e) => ({ ...e, size: Math.max(e.size, mean * floor, Number.EPSILON) }))
        .sort((a, b) => b.size - a.size);
    const total = lifted.reduce((s, e) => s + e.size, 0);
    const area = rect.w * rect.h;
    const rects = squarify(lifted.map((e) => (e.size / total) * area), rect);
    return lifted.map((e, i) => ({ item: e.item, size: e.size, rect: rects[i] }));
}

/**
 * Two-level layout: [{name, items:[{item, size}]}] → [{name, rect, items:[{item, size, rect}]}]. Groups are sized by
 * their items' total; `pad` insets each group's items (for its border and label) when there is room.
 */
export function layoutGroups(groups, rect, { floor = 0, pad = 0, labelHeight = 0 } = {}) {
    const sized = groups
        .filter((g) => g.items.length > 0)
        .map((g) => ({ item: g, size: g.items.reduce((s, e) => s + (Number.isFinite(e.size) && e.size > 0 ? e.size : 0), 0) }));
    return layout(sized, rect, floor).map((placed) => {
        const r = placed.rect;
        const room = r.w > pad * 2 + 8 && r.h > pad * 2 + labelHeight + 8;
        const inner = room ? { x: r.x + pad, y: r.y + pad + labelHeight, w: r.w - pad * 2, h: r.h - pad * 2 - labelHeight } : r;
        return { name: placed.item.name, rect: r, items: layout(placed.item.items, inner, floor) };
    });
}
