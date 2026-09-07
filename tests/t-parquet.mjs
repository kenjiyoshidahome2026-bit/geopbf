#!/usr/bin/env node
// t-parquet: GeoPBF → GeoParquet（CPU 経路・決定的）。
//   ・PAR1 の骨格・footer・行数、WKB を自前で復号して GeoJSON の座標と一致、属性列の型
//   ・pyarrow があれば読み戻して schema/geo メタ/bbox 統計を確認（無ければその項目は skip 表示）
//   ・CLI（parquet サブコマンド）
globalThis.ImageData ??= class ImageData { };
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoPBF } from "../src/pbf-base.js";
import { toGeoParquet } from "../src/convert/geoparquet.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const skip = (msg) => console.log("– skip:", msg);

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", properties: { n: "A", v: 1, f: 1.5, b: true, d: new Date(86400000), j: { a: 1 }, nest: { x: "é", y: 2 } }, geometry: { type: "Polygon", coordinates: [sq(139.5, 35.5, 139.8, 35.8)] } },
	{ type: "Feature", properties: { n: "B", v: -2, f: 2, b: false }, geometry: { type: "MultiPolygon", coordinates: [[sq(15, 15, 16, 16), sq(15.2, 15.2, 15.8, 15.8)], [sq(20, 20, 21, 21)]] } },
	{ type: "Feature", properties: { n: "L", v: 3 }, geometry: { type: "LineString", coordinates: [[139.5, 35.5], [139.65, 35.3], [139.8, 35.5]] } },
	{ type: "Feature", properties: { n: "P", v: 4 }, geometry: { type: "Point", coordinates: [139.767125, 35.681236] } },
	{ type: "Feature", properties: { n: "MPt" }, geometry: { type: "MultiPoint", coordinates: [[1, 1], [2, 2]] } },
	{ type: "Feature", properties: { n: "MLS" }, geometry: { type: "MultiLineString", coordinates: [[[0.5, 0.5], [1, 1]], [[2, 2], [3, 4]]] } },
	{ type: "Feature", properties: { n: "GC" }, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [5, 5] }, { type: "LineString", coordinates: [[5, 5], [6, 6]] }] } },
	{ type: "Feature", properties: { n: "empty" }, geometry: null },
] };
const pbf = await new GeoPBF({ name: "fix", precision: 6, attribution: "t-parquet" }).set(structuredClone(fc));
const gj = pbf.geojson;
const r = await toGeoParquet(pbf, { gpu: false });
const buf = r.buffer;
ok(r.stats.engine === "cpu" && r.stats.features === 8 && r.stats.vertices === 29, `toGeoParquet: ${buf.length} B・頂点 ${r.stats.vertices}`);
const magic = (o) => String.fromCharCode(...buf.subarray(o, o + 4));
ok(magic(0) === "PAR1" && magic(buf.length - 4) === "PAR1", "PAR1 の骨格");
const footLen = new DataView(buf.buffer, buf.byteOffset).getUint32(buf.length - 8, true);
ok(footLen > 0 && footLen < buf.length - 12, `footer 長 ${footLen}`);
ok(r.geo.columns.geometry.encoding === "WKB" && r.geo.columns.geometry.geometry_types.join() === "GeometryCollection,LineString,MultiLineString,MultiPoint,MultiPolygon,Point,Polygon" && r.geo.columns.geometry.crs?.id?.code === "CRS84", "geo メタ: WKB・geometry_types・CRS84");
ok(r.geo.columns.geometry.bbox.join() === "0.5,0.5,139.8,35.8" && r.geo.columns.geometry.covering.bbox.xmin.join() === "bbox,xmin", "geo メタ: bbox と covering");

// ---- WKB を自前で復号して GeoJSON と一致（無圧縮・1 行グループで geometry 列の PLAIN を直読み）----------
const r0 = await toGeoParquet(pbf, { gpu: false, codec: "none" });
const u8 = r0.buffer, dv = new DataView(u8.buffer, u8.byteOffset);
// WKB（LE）→ GeoJSON 幾何
function readWkb(p) {
	const t = dv.getUint32(p.i + 1, true); p.i += 5;
	const pt = () => { const x = dv.getFloat64(p.i, true), y = dv.getFloat64(p.i + 8, true); p.i += 16; return [x, y]; };
	const n = () => { const v = dv.getUint32(p.i, true); p.i += 4; return v; };
	const pts = () => { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(pt()); return a; };
	const ring = () => pts();
	switch (t) {
		case 1: return { type: "Point", coordinates: pt() };
		case 2: return { type: "LineString", coordinates: pts() };
		case 3: { const c = n(), rs = []; for (let i = 0; i < c; i++) rs.push(ring()); return { type: "Polygon", coordinates: rs }; }
		case 4: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p).coordinates); return { type: "MultiPoint", coordinates: a }; }
		case 5: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p).coordinates); return { type: "MultiLineString", coordinates: a }; }
		case 6: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p).coordinates); return { type: "MultiPolygon", coordinates: a }; }
		case 7: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p)); return { type: "GeometryCollection", geometries: a }; }
	}
	throw new Error("wkb type " + t);
}
// geometry 列のページ: 直前の feature の WKB 先頭バイト列（01 03 00 00 00 …）で探す代わりに、footer から辿らず
// 「PLAIN の [len][01 ..]」が 7 個並ぶ位置を線形探索（検定用の最小手＝pyarrow がある環境ではそちらでも確認）
const expectWkb = gj.features.filter(f => f.geometry).map(f => f.geometry);
let found = 0, pos = -1;
for (let i = 4; i + 5 < u8.length; i++) {
	if (u8[i + 4] === 1 && dv.getUint32(i, true) === 21 + 0 * 0 && u8[i + 5] === 3 && u8[i + 6] === 0) { /* Point 21B? no: 最初は Polygon */ }
}
// 先頭 feature（Polygon: 1+4+4+4+5*16 = 93 B）の長さ前置 93 を探す
for (let i = 4; i + 4 < u8.length; i++) if (dv.getUint32(i, true) === 93 && u8[i + 4] === 1 && u8[i + 5] === 3 && u8[i + 6] === 0 && u8[i + 7] === 0 && u8[i + 8] === 0) { pos = i; break; }
ok(pos > 0, "geometry 列の PLAIN 値列を見つけた");
if (pos > 0) {
	const p = { i: pos }, got = [];
	for (let k = 0; k < expectWkb.length; k++) { const len = dv.getUint32(p.i, true); p.i += 4; const start = p.i; got.push(readWkb(p)); if (p.i - start !== len) { ok(false, `WKB 長が合わない（feature ${k}）`); break; } }
	found = got.length;
	ok(found === expectWkb.length && JSON.stringify(got) === JSON.stringify(expectWkb), `WKB 復号 ${found} 件が GeoJSON（precision 6）と一致（閉じ点・穴・多部・GC・double 厳密）`);
}

// ---- pyarrow（あれば）--------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "geopbf-pq-"));
const pqPath = join(dir, "fix.parquet"); writeFileSync(pqPath, buf);
const py = spawnSync("python3", ["-c", `
import json, sys
try:
    import pyarrow.parquet as pq
except Exception as e:
    print("NOPYARROW"); sys.exit(0)
t = pq.read_table(sys.argv[1]); md = pq.read_metadata(sys.argv[1])
rows = t.to_pylist()
geo = json.loads(md.metadata[b"geo"])
st = md.row_group(0).column(md.num_columns - 4).statistics
print(json.dumps({"rows": t.num_rows, "cols": t.num_columns, "types": {f.name: str(f.type) for f in t.schema},
  "r0": {k: (v if not isinstance(v, (bytes, dict)) else ("bytes:%d" % len(v) if isinstance(v, bytes) else v)) for k, v in rows[0].items() if k != "d"},
  "d0": rows[0]["d"].isoformat(), "r7geom": rows[7]["geometry"], "geo_primary": geo["primary_column"], "xmin_stats": [st.has_min_max, st.min, st.max, st.null_count],
  "created": md.created_by, "kv": sorted(k.decode() for k in md.metadata.keys())}, default=str))
`, pqPath], { encoding: "utf8" });
if (py.status !== 0 || !py.stdout) skip(`pyarrow 検定（python3 が無い: ${(py.stderr || "").split("\n")[0]}）`);
else if (py.stdout.startsWith("NOPYARROW")) skip("pyarrow 検定（pyarrow 未導入）");
else {
	const o = JSON.parse(py.stdout);
	ok(o.rows === 8 && o.cols === 10, `pyarrow: 8 行 10 列（${o.rows}×${o.cols}）`);
	ok(o.types.b === "bool" && o.types.v === "int64" && o.types.f === "double" && o.types.n === "string" && o.types.d === "timestamp[ms, tz=UTC]" && /^struct<xmin: double not null/.test(o.types.bbox) && o.types.geometry === "binary", `pyarrow: 列型 ${JSON.stringify(o.types)}`);
	ok(o.r0.n === "A" && o.r0.v === 1 && o.r0.f === 1.5 && o.r0.b === true && o.r0["j.a"] === 1 && o.r0["nest.x"] === "é" && o.r0.geometry === "bytes:93" && o.r0.bbox.xmin === 139.5 && o.r0.bbox.ymax === 35.8, "pyarrow: 行 0 の値（入れ子は a.b 列・bbox struct）");
	ok(o.d0.startsWith("1970-01-02"), `pyarrow: TIMESTAMP(ms, UTC) ${o.d0}`);
	ok(o.r7geom === null, "pyarrow: geometry 無し feature は null");
	ok(o.geo_primary === "geometry" && o.xmin_stats[0] === true && o.xmin_stats[1] === 0.5 && o.xmin_stats[2] === 139.767125 && o.xmin_stats[3] === 1, `pyarrow: geo メタと bbox.xmin の統計 ${JSON.stringify(o.xmin_stats)}`);
	ok(o.created === "geopbf" && o.kv.includes("geopbf:attribution"), "pyarrow: created_by と geopbf:attribution");
}

// ---- 行グループ分割 -------------------------------------------------------------------------
const r3 = await toGeoParquet(pbf, { gpu: false, rowGroupSize: 3 });
ok(r3.buffer.length > buf.length, "rowGroupSize=3 で 3 行グループ（footer が大きい）");

// ---- CLI --------------------------------------------------------------------------------------
const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const inPath = join(dir, "fix.geopbf"); writeFileSync(inPath, Buffer.from(pbf.arrayBuffer));
const out = run("parquet", inPath, join(dir, "cli.parquet"), "--no-gpu", "--compression", "none");
ok(/features 8/.test(out) && /CPU/.test(out) && /Polygon/.test(out), "CLI parquet: 実行報告");
const cliBuf = readFileSync(join(dir, "cli.parquet"));
ok(cliBuf.subarray(0, 4).toString() === "PAR1" && cliBuf.length === r0.buffer.length, "CLI parquet: 出力（無圧縮）がライブラリ経路と同じ長さ");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
