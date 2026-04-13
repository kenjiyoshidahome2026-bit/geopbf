import { PBF } from "../pbf-base.js";
import { gint } from "../gint.js";
import { purify } from "./purifier.js";
import { simplify } from "./simplify.js";

const TAGS = PBF.TAGS;

export function analyzeTopology(self) {
    if (self.structures) return self.structures;

    const structures = [[], [], []];
    const S = 1 / self.e;

    self.each((id, map) => {
        const process = (pos, type) => {
            self.pbf.pos = pos;
            let lens = [], coords = [];
            self.pbf.readMessage((tag) => {
                if (tag === TAGS.LENGTH) self.pbf.readPackedVarint(lens);
                else if (tag === TAGS.COORDS) {
                    const end = self.pbf.readVarint() + self.pbf.pos;
                    let x = 0, y = 0;
                    const read = (n) => {
                        let c = [];
                        const grab = () => {
                            let dx = self.pbf.readSVarint(), dy = self.pbf.readSVarint();
                            if (dx || dy) { x += dx; y += dy; c.push(gint.pack([x * S, y * S])); }
                        };
                        if (n === undefined) { while (self.pbf.pos < end) grab(); }
                        else { while (n-- > 0) grab(); }
                        return new BigUint64Array(c);
                    };
                    const typeGroups = [
                        () => [read(1)], // Point
                        () => [read()],  // MultiPoint
                        () => [read()],  // LineString
                        () => lens.map(t => read(t)), // MultiLineString
                        () => [lens.map(t => read(t))], // Polygon
                        () => { // MultiPolygon
                            const c = []; let p = 0;
                            for (let i = 0; i < lens[0]; i++) {
                                let len = lens[++p]; c[i] = [];
                                for (let j = 0; j < len; j++) c[i].push(read(lens[++p]));
                            }
                            return c;
                        }
                    ];
                    coords = typeGroups[type]();
                }
            });
            const tIndex = type < 2 ? 0 : type < 4 ? 1 : 2;
            coords.forEach(c => structures[tIndex].push({ id, coords: c }));
        };

        if (map[2] === 6) map[3].forEach((p, j) => process(p, map[4][j]));
        else process(map[1], map[2]);
    });

    self.point = buildPoints(structures[0]);
    purify(structures[1]);
    self.polyline = buildArcs(structures[1], "polyline");
    purify(structures[2].flatMap(t => t.coords));
    self.polygon = buildArcs(structures[2], "polygon");

    return (self.structures = structures);
}

function buildPoints(topo) {
    if (!topo.length) return null;
    const hash = new Map();
    topo.forEach(({ id, coords }) => { const a = hash.get(coords[0]) || []; a.push(id); hash.set(coords[0], a); });
    const buff = [...hash.entries()].sort((p, q) => p[0] > q[0] ? 1 : -1);
    const buffer = new BigUint64Array(buff.length), owner = buff.map(t => t[1]);
    buff.forEach(([key], i) => buffer[i] = key);
    return { count: buff.length, buffer, owner };
}

function buildArcs(topo, type) {
    const buffs = [], aHash = new Map(), vHash = new Map();
    const isTerm = (arc, i) => (i === 0 || i === arc.length - 1 || (vHash.get(arc[i]) || 0) > 2);

    const flatten = type === "polygon" ? topo.flatMap(t => t.coords.flat()) : topo.flatMap(t => t.coords);
    flatten.forEach(arc => arc.forEach(p => vHash.set(p, (vHash.get(p) || 0) + 1)));

    const processArc = (arc) => {
        let i = 0, indices = [], n = arc.length;
        while (i < n - 1) {
            let j = i + 1;
            while (j < n - 1 && !isTerm(arc, j)) j++;
            const seg = arc.subarray(i, j + 1);
            const p = seg[0], q = seg[seg.length - 1];
            const [min, max] = p > q ? [q, p] : [p, q];
            const aKey = (min << 96n) | (max << 32n) | BigInt(seg.length);
            if (!aHash.has(aKey)) { aHash.set(aKey, buffs.length); simplify(seg); buffs.push(seg); }
            const idx = aHash.get(aKey);
            indices.push(p === buffs[idx][0] ? idx : ~idx);
            i = j;
        }
        return indices;
    };

    topo.forEach(t => {
        if (type === "polygon") t.arcs = t.coords.map(r => processArc(r));
        else t.arcs = processArc(t.coords);
    });

    const total = buffs.reduce((s, b) => s + b.length, 0);
    const buffer = new BigUint64Array(total), meta = new Uint32Array(buffs.length * 8);
    let offset = 0;
    buffs.forEach((b, i) => {
        buffer.set(b, offset);
        meta.set([offset, b.length, 0, 0, 0, 0, 0, 0], i * 8);
        offset += b.length;
    });

    return { count: buffs.length, buffer, meta, mlen: 8 };
}

export function neighbors(self, id) {
    const table = [];
    if (!self.structures) analyzeTopology(self);
    // 隣接関係抽出のロジックを簡潔に実装
    self.polygon.owner.forEach(owners => {
        owners.forEach(p => {
            owners.forEach(q => {
                if (p !== q) {
                    const pid = p < 0 ? ~p : p, qid = q < 0 ? ~q : q;
                    (table[pid] = table[pid] || new Set()).add(qid);
                }
            });
        });
    });
    return id === undefined ? table.map(s => Array.from(s || [])) : Array.from(table[id] || []);
}