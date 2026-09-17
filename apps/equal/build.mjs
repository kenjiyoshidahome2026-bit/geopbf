#!/usr/bin/env node
// apps/equal/build.mjs ── Natural Earth 10m → GeoPBF → gint の LOD → このアプリが読む data.json。
//
// 経路は全部このリポジトリのもの：
//   ① Natural Earth 公式 S3 から shapefile の zip を取る（--cache に置いて 2 回目からは読み直さない）
//   ② src/decoder/shape.js（ブラウザの worker 脚本）を Node で直に叩いて GeoPBF にする
//   ③ src/extension/gint.js の L1toL2（Visvalingam）で頂点に重みを付け、1 画素に満たない頂点を落とす
//      ＝ズームを決め打った LOD。しきい値は npx geopbf lod の表と同じ物差し（rank ≥ th を残す）
//   ④ 0.01°（≒1 km・2000 px 幅の世界図で 1/20 画素）の格子へ丸め、Int16 の base64 にして JSON へ
//
// 使い方:
//   node apps/equal/build.mjs                  # data.json を作る（既定のしきい値 52 ≒ 2000 px 幅の 1 画素）
//   node apps/equal/build.mjs --rank 48        # 細かく残す（rank を下げるほど頂点が増える）
//   node apps/equal/build.mjs --inline out.html  # data.json を index.html に焼いた 1 枚ページ（配布・貼り付け用）
globalThis.ImageData ??= class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GeoPBF } from "../../src/pbf-base.js";
import { gint } from "../../src/extension/gint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NE = "https://naturalearth.s3.amazonaws.com/";
const LAYERS = [
	{ id: "land",       path: "10m_physical/ne_10m_land.zip",                        kind: "poly" },
	{ id: "lakes",      path: "10m_physical/ne_10m_lakes.zip",                       kind: "poly" },
	{ id: "rivers",     path: "10m_physical/ne_10m_rivers_lake_centerlines.zip",     kind: "line" },
	{ id: "boundaries", path: "10m_cultural/ne_10m_admin_0_boundary_lines_land.zip", kind: "line" },
];

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : (process.argv[i + 1] ?? true); };
const RANK = +arg("rank", 52);          // 残す最小ランク（gint の重み・小さいほど細かい）
const CACHE = String(arg("cache", join(HERE, ".cache")));
const INLINE = arg("inline", null);

// worker 脚本（自分で onmessage を張り postMessage で返す）を Node から 1 回叩く＝tests/t-encoders.mjs と同じ流儀
async function runWorker(url, data) {
	globalThis.onmessage = null;
	const got = new Promise(resolve => { globalThis.postMessage = m => resolve(m); });
	await import(url + "?v=" + Date.now());
	if (typeof globalThis.onmessage !== "function") throw new Error(`${url}: onmessage not installed`);
	globalThis.onmessage({ data });
	return got;
}

async function fetchZip(rel) {
	const file = join(CACHE, rel.replace(/\//g, "_"));
	if (existsSync(file)) return new Uint8Array(await readFile(file));
	await mkdir(CACHE, { recursive: true });
	const res = await fetch(NE + rel);
	if (!res.ok) throw new Error(`fetch failed: ${NE + rel} (HTTP ${res.status})`);
	const buf = new Uint8Array(await res.arrayBuffer());
	await writeFile(file, buf);
	return buf;
}

// gint の重みで間引く：端点と L1（terminal）は必ず残し、rank < RANK の頂点を落とす
function thin(ring, stat) {
	stat.total += ring.length;
	if (ring.length <= 4) { stat.kept += ring.length; return ring; }
	const arc = new BigUint64Array(ring.length);
	for (let i = 0; i < ring.length; i++) arc[i] = gint.pack(ring[i]);
	gint.L1toL2(arc);
	const keep = [];
	for (let i = 0; i < arc.length; i++) {
		const terminal = (arc[i] & gint.TERMINAL_BIT) !== 0n;
		if (i === 0 || i === arc.length - 1 || terminal || Number(arc[i] & gint.WEIGHT_MASK) >= RANK) keep.push(ring[i]);
	}
	stat.kept += keep.length;
	return keep;
}

const out = {};
for (const layer of LAYERS) {
	const name = layer.path.split("/").pop();
	const zip = await fetchZip(layer.path);
	const res = await runWorker(new URL("../../src/decoder/shape.js", import.meta.url).href,
		{ file: new File([zip], name), encoding: "utf8", precision: 6 });
	if (!res?.data) throw new Error(`${name}: shape decoder returned nothing`);
	const gj = (await new GeoPBF().set(res.data)).geojson;

	// xy＝全頂点（0.01° 格子の Int16）、rings＝環ごとの頂点数、groups＝1 パスにまとめる環の数（面の外環＋穴）
	const xy = [], rings = [], groups = [], stat = { total: 0, kept: 0 };
	const push = (ring) => {
		const r = thin(ring, stat);
		if (r.length < 2) return 0;
		for (const p of r) xy.push(Math.round(p[0] * 100), Math.round(p[1] * 100));
		rings.push(r.length);
		return 1;
	};
	for (const f of gj.features) {
		const g = f.geometry; if (!g) continue;
		if (layer.kind === "poly") {
			const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
			for (const poly of polys) { let n = 0; for (const ring of poly) n += push(ring); if (n) groups.push(n); }
		} else {
			const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
			for (const line of lines) if (push(line)) groups.push(1);
		}
	}
	const i16 = Int16Array.from(xy);
	out[layer.id] = { kind: layer.kind, xy: Buffer.from(i16.buffer).toString("base64"), rings, groups };
	console.log(`${layer.id.padEnd(11)} ${gj.features.length.toLocaleString("en-US").padStart(6)} features  `
		+ `${stat.total.toLocaleString("en-US").padStart(9)} → ${stat.kept.toLocaleString("en-US").padStart(7)} vertices `
		+ `(${(stat.kept / stat.total * 100).toFixed(1)}%)  ${(i16.byteLength / 1024).toFixed(0)} KB`);
}

const json = JSON.stringify(out);
if (INLINE && INLINE !== true) {
	const html = await readFile(join(HERE, "index.html"), "utf8");
	const marker = '/*__BLOB__*/ await (await fetch("./data.json")).json()';
	if (!html.includes(marker)) throw new Error("index.html: data.json を読む目印が見つからない");
	const page = html.replace(marker, json)
		.replace(/^[\s\S]*?<meta name="viewport"[^>]*>\n/, "")   // 外枠（DOCTYPE/html/head/meta）は載せ先の骨組みが持つ
		.replace(/<\/head>\n<body>/, "").replace(/\n<\/body>\n<\/html>\n?$/, "\n");
	await writeFile(String(INLINE), page);
	console.log(`\n${INLINE}  ${(json.length / 1024 / 1024).toFixed(2)} MB（1 枚ページ・外部取得なし）`);
} else {
	await writeFile(join(HERE, "data.json"), json);
	console.log(`\napps/equal/data.json  ${(json.length / 1024 / 1024).toFixed(2)} MB（rank ≥ ${RANK}）`);
}
