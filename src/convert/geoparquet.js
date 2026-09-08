// convert/geoparquet.js ── GeoPBF → GeoParquet 1.1（WKB・bbox 覆域列・geo メタデータ）。
//
// 幾何は GeoPBF のワイヤ整数（10^precision 単位・デルタ復号のみ）を GPU で IEEE754 double の bit に変換する
// （kernels.js ③＝長除算で仮数を立てて最近偶数丸め＝JS の `i / 10^p` と bit 一致）。gint（1e-7・L2 は 8 単位丸め）
// を経由しないので GeoParquet の座標は GeoPBF の値そのもの。bbox は kernels.js ④（feature 毎の整数 min/max）。
// 属性は GeoPBF の型付き値から列型を推定（BOOLEAN / INT64 / DOUBLE / TIMESTAMP / UTF8・入れ子は "a.b" に平坦化）。
import { GeoPBF } from "../pbf-base.js";
import { getDevice } from "./gpu.js";
import { createEngine, cpuEngine } from "./engine.js";
import { writeParquet, PT, REP } from "./parquet.js";

const { TAGS } = GeoPBF;
const WKB = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };
const GTYPES = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];

// GeoPBF の幾何をワイヤ整数のまま読む → { type, lens, xy: number[]（デルタ復号済み・閉じ点なし）}
function readGeomInt(pbf, pos, type) {
	const P = pbf.pbf;
	P.pos = pos;
	const lens = [], xy = [];
	let end = 0;
	P.readMessage((tag) => {
		if (tag === TAGS.LENGTH) P.readPackedVarint(lens);
		else if (tag === TAGS.COORDS) {
			end = P.readVarint() + P.pos;
			const run = (n) => { let x = 0, y = 0; for (let i = 0; i < n; i++) { x += P.readSVarint(); y += P.readSVarint(); xy.push(x, y); } };
			if (type === 0) run(1);
			else if (type === 1 || type === 2) { let x = 0, y = 0; while (P.pos < end) { x += P.readSVarint(); y += P.readSVarint(); xy.push(x, y); } }
			else if (type === 3 || type === 4) for (const n of lens) run(n);
			else if (type === 5) { let p = 0; const np = lens[p++]; for (let i = 0; i < np; i++) { const nr = lens[p++]; for (let j = 0; j < nr; j++) run(lens[p++]); } }
		}
	}, {});
	return { type, lens, xy };
}

// 1 feature の幾何（GeometryCollection は要素配列）→ WKB 組立の計画。頂点は後でまとめて大域 Int32Array へ写す
function planFeature(pbf, i, vpos) {
	const map = pbf.fmap[i];
	if (map[2] === undefined) return { start: vpos.v, count: 0, gc: false, items: [] };   // 幾何なし
	const geoms = map[2] === 6 ? map[3].map((p, j) => readGeomInt(pbf, p, map[4][j])) : [readGeomInt(pbf, map[1], map[2])];
	const plan = { start: vpos.v, gc: map[2] === 6, items: [] };
	for (const g of geoms) {
		const n = g.xy.length >> 1;
		plan.items.push({ type: g.type, lens: g.lens, n, off: vpos.v, xy: g.xy });
		vpos.v += n;
	}
	plan.count = vpos.v - plan.start;
	return plan;
}

// WKB バイト数
function wkbSize(item) {
	const { type, lens, n } = item;
	switch (type) {
		case 0: return n ? 21 : 0;
		case 1: return 9 + n * 21;
		case 2: return 9 + n * 16;
		case 3: return 9 + lens.reduce((s, l) => s + 9 + l * 16, 0);
		case 4: return 9 + lens.reduce((s, l) => s + 4 + (l + 1) * 16, 0);
		case 5: { let s = 9, p = 0; const np = lens[p++]; for (let i = 0; i < np; i++) { const nr = lens[p++]; s += 9; for (let j = 0; j < nr; j++) s += 4 + (lens[p++] + 1) * 16; } return s; }
	}
	return 0;
}
// dbl: Uint8Array（頂点 v の座標 double が [v*16, v*16+16)）。out へ WKB を書き、次位置を返す
function writeWkb(out, dv, p, item, dbl) {
	const { type, lens } = item;
	let v = item.off;
	const hdr = (t) => { out[p] = 1; dv.setUint32(p + 1, t, true); p += 5; };
	const cnt = (c) => { dv.setUint32(p, c, true); p += 4; };
	const pts = (n) => { out.set(dbl.subarray(v * 16, (v + n) * 16), p); p += n * 16; v += n; };
	const ring = (n) => { cnt(n + 1); const s = v; pts(n); out.set(dbl.subarray(s * 16, s * 16 + 16), p); p += 16; };
	switch (type) {
		case 0: hdr(1); pts(1); break;
		case 1: hdr(4); cnt(item.n); for (let i = 0; i < item.n; i++) { hdr(1); pts(1); } break;
		case 2: hdr(2); cnt(item.n); pts(item.n); break;
		case 3: hdr(5); cnt(lens.length); for (const l of lens) { hdr(2); cnt(l); pts(l); } break;
		case 4: hdr(3); cnt(lens.length); for (const l of lens) ring(l); break;
		case 5: { hdr(6); let q = 0; const np = lens[q++]; cnt(np); for (let i = 0; i < np; i++) { const nr = lens[q++]; hdr(3); cnt(nr); for (let j = 0; j < nr; j++) ring(lens[q++]); } break; }
	}
	return p;
}

const CRS84 = { "$schema": "https://proj.org/schemas/v0.7/projjson.schema.json", type: "GeographicCRS", name: "WGS 84 (CRS84)",
	datum_ensemble: { name: "World Geodetic System 1984 ensemble", members: [
		{ name: "World Geodetic System 1984 (Transit)", id: { authority: "EPSG", code: 1166 } }, { name: "World Geodetic System 1984 (G730)", id: { authority: "EPSG", code: 1152 } },
		{ name: "World Geodetic System 1984 (G873)", id: { authority: "EPSG", code: 1153 } }, { name: "World Geodetic System 1984 (G1150)", id: { authority: "EPSG", code: 1154 } },
		{ name: "World Geodetic System 1984 (G1674)", id: { authority: "EPSG", code: 1155 } }, { name: "World Geodetic System 1984 (G1762)", id: { authority: "EPSG", code: 1156 } },
		{ name: "World Geodetic System 1984 (G2139)", id: { authority: "EPSG", code: 1309 } }],
		ellipsoid: { name: "WGS 84", semi_major_axis: 6378137, inverse_flattening: 298.257223563 }, accuracy: "2.0", id: { authority: "EPSG", code: 6326 } },
	coordinate_system: { subtype: "ellipsoidal", axis: [{ name: "Geodetic longitude", abbreviation: "Lon", direction: "east", unit: "degree" }, { name: "Geodetic latitude", abbreviation: "Lat", direction: "north", unit: "degree" }] },
	scope: "Not known.", area: "World.", bbox: { south_latitude: -90, west_longitude: -180, north_latitude: 90, east_longitude: 180 }, id: { authority: "OGC", code: "CRS84" } };

// 属性列の推定: GeoPBF の keys（"a.b" 平坦化済み）× 全行の値の型
function inferColumns(pbf) {
	const rows = pbf.propertiesTable.slice(1), keys = pbf.keys;
	const cols = [];
	keys.forEach((key, ki) => {
		let kinds = 0, any = false;   // 1 bool / 2 int / 4 float / 8 string / 16 date / 32 other(json) / 64 skip(blob 等)
		for (const row of rows) {
			const v = row[ki];
			if (v === null || v === undefined) continue;
			any = true;
			const t = typeof v;
			if (t === "boolean") kinds |= 1; else if (t === "number") kinds |= Number.isInteger(v) ? 2 : 4; else if (t === "string") kinds |= 8;
			else if (v instanceof Date) kinds |= 16; else if (t === "function") kinds |= 64;
			else if (typeof Blob !== "undefined" && v instanceof Blob) kinds |= 64; else if (typeof ImageData !== "undefined" && v instanceof ImageData) kinds |= 64;
			else kinds |= 32;
		}
		if (!any || kinds === 64) return;
		let type, logical = null, conv;
		if (kinds === 1) { type = PT.BOOLEAN; conv = v => v; }
		else if (kinds === 2) { type = PT.INT64; conv = v => v; }
		else if ((kinds & ~6) === 0) { type = PT.DOUBLE; conv = v => v; }
		else if (kinds === 16) { type = PT.INT64; logical = "TIMESTAMP_MILLIS"; conv = v => +v; }
		else { type = PT.BYTE_ARRAY; logical = (kinds & ~32) === 0 ? "JSON" : "UTF8"; conv = v => typeof v === "string" ? v : v instanceof Date ? v.toISOString() : (typeof v === "object" && !(ArrayBuffer.isView(v))) ? JSON.stringify(v) : ArrayBuffer.isView(v) ? JSON.stringify(Array.from(v)) : String(v); }
		const skip = (v) => v === null || v === undefined || typeof v === "function" || (typeof Blob !== "undefined" && v instanceof Blob) || (typeof ImageData !== "undefined" && v instanceof ImageData) || (typeof v === "number" && !Number.isFinite(v));
		cols.push({ name: key, type, logical, get: (i) => { const v = rows[i][ki]; return skip(v) ? null : conv(v); } });
	});
	return cols;
}

// opts: { gpu, codec: "gzip"|"none", rowGroupSize, compress, geometryName="geometry", bboxColumn="auto"|true|false }
export async function toGeoParquet(pbf, opts = {}) {
	const t0 = now();
	const stats = { engine: "cpu", features: pbf.length, vertices: 0, ms: {} };
	const D = Math.pow(10, pbf.precision());
	// ── 幾何の計画（デルタ復号＝直列・CPU）
	const vpos = { v: 0 }, plans = new Array(pbf.length);
	for (let i = 0; i < pbf.length; i++) plans[i] = planFeature(pbf, i, vpos);
	const ivA = new Int32Array(vpos.v * 2);
	for (const pl of plans) for (const it of pl.items) { ivA.set(it.xy, it.off * 2); it.xy = null; }
	stats.vertices = vpos.v;
	const parts = new Uint32Array(pbf.length * 2);
	for (let i = 0; i < pbf.length; i++) { parts[i * 2] = plans[i].start; parts[i * 2 + 1] = plans[i].count; }
	stats.ms.decode = now() - t0;
	// ── GPU/CPU: 整数 → double bit ・ feature bbox
	let device = null;
	if (opts.gpu !== false) device = await getDevice(typeof opts.gpu === "object" ? { gpu: opts.gpu } : {});
	const eng = device ? createEngine(device) : cpuEngine();
	stats.engine = eng.kind; stats.gpu = eng.info;
	const t1 = now();
	const dblU32 = await eng.wkb(ivA, D);
	const bb = await eng.bbox(ivA, parts);
	eng.destroy();
	stats.ms.kernels = now() - t1;
	const dbl = new Uint8Array(dblU32.buffer, dblU32.byteOffset, dblU32.byteLength);
	// ── WKB 組立
	const t2 = now();
	const wkb = new Array(pbf.length), types = new Set();
	let gminx = Infinity, gminy = Infinity, gmaxx = -Infinity, gmaxy = -Infinity;
	const bbox = new Float64Array(pbf.length * 4);
	for (let i = 0; i < pbf.length; i++) {
		const pl = plans[i];
		if (!pl.count) { wkb[i] = null; continue; }
		let size = pl.gc ? 9 : 0;
		for (const it of pl.items) size += wkbSize(it);
		const out = new Uint8Array(size), dv = new DataView(out.buffer);
		let p = 0;
		if (pl.gc) { out[0] = 1; dv.setUint32(1, 7, true); dv.setUint32(5, pl.items.length, true); p = 9; types.add("GeometryCollection"); }
		for (const it of pl.items) { p = writeWkb(out, dv, p, it, dbl); if (!pl.gc) types.add(GTYPES[it.type]); }
		wkb[i] = out;
		const x0 = bb[i * 4] / D, y0 = bb[i * 4 + 1] / D, x1 = bb[i * 4 + 2] / D, y1 = bb[i * 4 + 3] / D;
		bbox[i * 4] = x0; bbox[i * 4 + 1] = y0; bbox[i * 4 + 2] = x1; bbox[i * 4 + 3] = y1;
		if (x0 < gminx) gminx = x0; if (y0 < gminy) gminy = y0; if (x1 > gmaxx) gmaxx = x1; if (y1 > gmaxy) gmaxy = y1;
	}
	stats.ms.wkb = now() - t2;
	// ── スキーマ・列
	// bbox 覆域列：既定 "auto"＝点だけのデータでは省く（点の bbox は点そのもの＝列 4 本ぶん丸ごと冗長）。true/false で明示可
	const gname = opts.geometryName ?? "geometry";
	const withBbox = opts.bboxColumn === undefined || opts.bboxColumn === "auto" ? !(types.size && [...types].every(t => t === "Point" || t === "MultiPoint")) : !!opts.bboxColumn;
	const props = inferColumns(pbf);
	const schema = [{ name: "schema", numChildren: props.length + 1 + (withBbox ? 1 : 0) }];
	const columns = [];
	for (const c of props) { schema.push({ name: c.name, type: c.type, repetition: REP.OPTIONAL, logical: c.logical }); columns.push({ path: [c.name], type: c.type, get: c.get }); }
	schema.push({ name: gname, type: PT.BYTE_ARRAY, repetition: REP.OPTIONAL });
	columns.push({ path: [gname], type: PT.BYTE_ARRAY, get: (i) => wkb[i] });
	if (withBbox) {
		schema.push({ name: "bbox", repetition: REP.OPTIONAL, numChildren: 4 });
		["xmin", "ymin", "xmax", "ymax"].forEach((n, k) => { schema.push({ name: n, type: PT.DOUBLE, repetition: REP.REQUIRED }); columns.push({ path: ["bbox", n], type: PT.DOUBLE, stats: true, get: (i) => wkb[i] ? bbox[i * 4 + k] : null }); });
	}
	const geo = { version: "1.1.0", primary_column: gname, columns: { [gname]: {
		encoding: "WKB", geometry_types: [...types].sort(), crs: CRS84,
		...(wkb.some(Boolean) ? { bbox: [gminx, gminy, gmaxx, gmaxy] } : {}),
		...(withBbox ? { covering: { bbox: { xmin: ["bbox", "xmin"], ymin: ["bbox", "ymin"], xmax: ["bbox", "xmax"], ymax: ["bbox", "ymax"] } } } : {}),
	} } };
	const keyValue = { geo: JSON.stringify(geo) };
	const meta = { name: pbf.name?.(), description: pbf.description?.(), license: pbf.license?.(), attribution: pbf.attribution?.() };
	for (const k in meta) if (meta[k]) keyValue["geopbf:" + k] = meta[k];
	const t3 = now();
	const buffer = await writeParquet({ schema, columns, numRows: pbf.length }, { rowGroupSize: opts.rowGroupSize, codec: opts.codec ?? "gzip", keyValue, createdBy: "geopbf", compress: opts.compress });
	stats.ms.parquet = now() - t3; stats.ms.total = now() - t0; stats.bytes = buffer.length;
	return { buffer, stats, geo };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
