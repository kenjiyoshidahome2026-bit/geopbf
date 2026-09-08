#!/usr/bin/env node
// t-pmtiles: GeoPBF → gint（wasm）→ PMTiles の端から端まで（CPU 経路・決定的）。
//   ・ヘッダ/メタ/ディレクトリを自前リーダで読み戻し、タイルを MVT 復号して幾何・属性・向きを見る
//   ・共有境界: 隣接 2 ポリゴンの境界頂点列がタイル内で完全一致（gint の arc が 1 本＝隙間なし）
//   ・全面塗りタイルの内容重複が畳まれる（numTileContents < addressed・runLength > 1）
//   ・CLI（pmtiles サブコマンド）
globalThis.ImageData ??= class ImageData { };
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoPBF } from "../src/pbf-base.js";
import { bakeGint } from "../src/convert/node-gint.js";
import { toPMTiles, lodThreshold } from "../src/convert/tiler.js";
import { readPMTiles } from "../src/convert/pmtiles.js";
import { signedArea2 } from "../src/convert/mvt.js";
import { decodeTile } from "../src/convert/mvt-decode.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- フィクスチャ：共有辺（中間点付き）を持つ隣接 2 面・穴付き・多面・線・点 -----------------
const shared = [[11, 10], [11.0004, 10.2], [10.9996, 10.4], [11.0003, 10.6], [11, 10.8], [11, 11]];   // x≈11 の境界（微小な蛇行）
const A = [[10, 10], ...shared, [10, 11], [10, 10]];                     // 東側が共有辺（南→北）
const B = [[12, 10], [12, 11], ...shared.slice().reverse(), [12, 10]];   // 西側が共有辺（北→南）
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", properties: { n: "A", v: 1 }, geometry: { type: "Polygon", coordinates: [A] } },
	{ type: "Feature", properties: { n: "B", v: 2, b: true }, geometry: { type: "Polygon", coordinates: [B] } },
	{ type: "Feature", properties: { n: "H" }, geometry: { type: "Polygon", coordinates: [sq(20, 20, 30, 30), sq(23, 23, 27, 27)] } },
	{ type: "Feature", properties: { n: "MP" }, geometry: { type: "MultiPolygon", coordinates: [[sq(40, 40, 41, 41)], [sq(42, 40, 43, 41)]] } },
	{ type: "Feature", properties: { n: "L", d: new Date(0) }, geometry: { type: "LineString", coordinates: [[10, 9], [10.5, 8.5], [11, 9]] } },
	{ type: "Feature", properties: { n: "P" }, geometry: { type: "Point", coordinates: [10.5, 10.5] } },
	{ type: "Feature", properties: { n: "MPt" }, geometry: { type: "MultiPoint", coordinates: [[1, 1], [2, 2]] } },
] };
const pbf = await new GeoPBF({ name: "fix", precision: 6, attribution: "t-pmtiles" }).set(structuredClone(fc));
const gint = await bakeGint(pbf);
ok(gint instanceof ArrayBuffer && gint.byteLength > 64, `gint を wasm で焼く（${gint.byteLength} B）`);

// ---- 変換（CPU 明示）------------------------------------------------------------------
const r = await toPMTiles(pbf, { gint, gpu: false, minZoom: 0, maxZoom: 9, dropRate: 1 });
ok(r.stats.engine === "cpu" && r.buffer.length > 127, `toPMTiles: ${r.stats.tiles} タイル・${r.buffer.length} B・engine=${r.stats.engine}`);
const pm = await readPMTiles(r.buffer);
const h = pm.header;
ok(h.minZoom === 0 && h.maxZoom === 9 && h.tileType === 1 && h.tc === 2 && h.ic === 2 && h.clustered === 1, "ヘッダ: zoom/型/圧縮/clustered");
ok(Math.abs(h.bounds[0] - 1) < 1e-6 && Math.abs(h.bounds[2] - 43) < 1e-6 && Math.abs(h.bounds[3] - 41) < 1e-6, `ヘッダ: bounds ${h.bounds.map(v => +v.toFixed(3))}`);
ok(pm.metadata.vector_layers?.[0]?.id === "fix" && pm.metadata.vector_layers[0].fields.v === "Number" && pm.metadata.vector_layers[0].fields.b === "Boolean" && pm.metadata.attribution === "t-pmtiles", "メタ: vector_layers.fields と attribution");
ok(h.addressed === r.stats.tiles && h.entries <= h.addressed && h.contents <= h.entries, `ディレクトリ: addressed ${h.addressed} ≥ entries ${h.entries} ≥ contents ${h.contents}`);

// z0: 全 feature が 1 タイルに
const t0 = decodeTile(await pm.getTile(0, 0, 0))[0];
ok(t0 && t0.name === "fix" && t0.features.length === 7, `z0: 7 feature（${t0?.features.length}）`);
const byId = new Map(t0.features.map(f => [f.id, f]));
ok(byId.get(0).type === 3 && byId.get(4).type === 2 && byId.get(5).type === 1 && byId.get(6).type === 1, "z0: 型（面/線/点/多点）");
ok(byId.get(0).props.n === "A" && byId.get(0).props.v === 1 && byId.get(1).props.b === true && byId.get(4).props.d === "1970-01-01T00:00:00.000Z", "z0: 属性（Date は ISO 文字列）");
ok(byId.get(2).geometry.length === 2 && signedArea2(byId.get(2).geometry[0]) > 0 && signedArea2(byId.get(2).geometry[1]) < 0, "z0: 穴付き面＝外環正・穴負");
ok(byId.get(3).geometry.length === 2 && byId.get(3).geometry.every(g => signedArea2(g) > 0), "z0: MultiPolygon は外環 2 つ");
ok(byId.get(6).geometry.length === 2, "z0: MultiPoint 2 点");

// 共有境界：A と B の境界頂点が一致（z0〜z9 の各ズームで、A の x≈境界の頂点は B にもある）
const key = (p) => p[0] + "," + p[1];
for (const z of [0, 3, 6, 9]) {
	const n = 1 << z, tx = Math.floor((11 + 180) / 360 * n);
	const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + 10.5 * Math.PI / 360)) / (2 * Math.PI)) * n, ty = Math.floor(y);
	const tile = await pm.getTile(z, tx, ty);
	if (!tile) { ok(false, `z${z}: 境界タイル ${tx}/${ty} が無い`); continue; }
	const l = decodeTile(tile)[0], a = l.features.find(f => f.id === 0), b = l.features.find(f => f.id === 1);
	if (!a || !b) { ok(false, `z${z}: A/B が同じタイルに無い`); continue; }
	const ra = a.geometry[0], rb = b.geometry[0], setB = new Set();
	for (let i = 0; i < rb.length; i += 2) setB.add(rb[i] + "," + rb[i + 1]);
	const xs = []; for (let i = 0; i < ra.length; i += 2) xs.push(ra[i]);
	const xEdge = Math.round(((11 + 180) / 360 * n - tx) * 4096);
	let miss = 0, onEdge = 0;
	for (let i = 0; i < ra.length; i += 2) if (Math.abs(ra[i] - xEdge) <= 8) { onEdge++; if (!setB.has(ra[i] + "," + ra[i + 1])) miss++; }
	ok(onEdge >= 2 && miss === 0, `z${z}: 共有境界の頂点 ${onEdge} 個が A/B で一致（不一致 ${miss}・閾値 rank ${lodThreshold(z, 4096)}）`);
}
// 簡略化: 低ズームでは共有辺の中間点が落ち、高ズームでは残る
{
	const cnt = async (z) => { const n = 1 << z, tx = Math.floor((11 + 180) / 360 * n), ty = Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + 10.5 * Math.PI / 360)) / (2 * Math.PI)) * n); const l = decodeTile(await pm.getTile(z, tx, ty))[0]; return l.features.find(f => f.id === 0).geometry[0].length / 2; };
	const c0 = await cnt(0), c9 = await cnt(9);
	ok(c0 < c9, `LOD: A の頂点数 z0=${c0} < z9=${c9}`);
}
// 全面塗りタイルの畳み込み（H は 10°×10°＝z9 で数千タイル）
ok(h.contents < h.entries && h.entries < h.addressed, `全面塗りタイルの重複畳み込み（contents ${h.contents} < entries ${h.entries} < addressed ${h.addressed}）`);
ok(pm.root.some(e => e.runLength > 1) || pm.root.some(e => e.runLength === 0), "runLength > 1 の entry（または leaf）がある");
// 内陸タイルの中身＝バッファ込みの矩形 1 つ
{
	const n = 1 << 9, tx = Math.floor((25 + 180) / 360 * n), ty = Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + 21 * Math.PI / 360)) / (2 * Math.PI)) * n);
	const l = decodeTile(await pm.getTile(9, tx, ty))[0];
	ok(l.features.length === 1 && l.features[0].id === 2 && l.features[0].geometry.length === 1 && l.features[0].geometry[0].length === 8, "z9 内陸タイル: H の外環だけの矩形（穴の外）");
	const tx2 = Math.floor((25 + 180) / 360 * n), ty2 = Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + 25 * Math.PI / 360)) / (2 * Math.PI)) * n);
	const l2 = decodeTile(await pm.getTile(9, tx2, ty2))[0];
	ok(l2.features.length === 1 && l2.features[0].geometry.length === 2 && signedArea2(l2.features[0].geometry[1]) < 0, "z9 穴の内側タイル: 外環＋穴の 2 矩形（塗りは打ち消し）");
}
// 範囲外・空
ok(await pm.getTile(3, 0, 7) === null, "何も無いタイルは null");
// オプション検証
let threw = false; try { await toPMTiles(pbf, { gint, gpu: false, extent: 1000 }); } catch { threw = true; } ok(threw, "extent が 2 の冪でなければ例外");
threw = false; try { await toPMTiles(pbf, { gint, gpu: false, maxZoom: 21 }); } catch { threw = true; } ok(threw, "extent 4096 で maxZoom > 20 は例外");
threw = false; try { await toPMTiles(pbf, { gpu: false }); } catch { threw = true; } ok(threw, "gint が無ければ例外");
// extent 512 / 無圧縮
const r2 = await toPMTiles(pbf, { gint, gpu: false, minZoom: 2, maxZoom: 4, extent: 512, tileCompression: "none", layer: "L2", dropRate: 1 });
const pm2 = await readPMTiles(r2.buffer);
ok(pm2.header.tc === 1 && pm2.header.minZoom === 2 && decodeTile(await pm2.getTile(2, 2, 1))[0].extent === 512 && decodeTile(await pm2.getTile(2, 2, 1))[0].name === "L2", "extent 512・無圧縮・レイヤ名");

// 点の間引き（dropRate）: 多数の点で z0 は疎・maxZoom は全点・残る点は入れ子
{
	const pts = { type: "FeatureCollection", features: Array.from({ length: 2000 }, (_, i) => ({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: [10 + (i % 50) * 0.01, 10 + Math.floor(i / 50) * 0.01] } })) };
	const pp = await new GeoPBF({ name: "pts", precision: 6 }).set(structuredClone(pts));
	const pg = await bakeGint(pp);
	const rp = await toPMTiles(pp, { gint: pg, gpu: false, minZoom: 0, maxZoom: 6, dropRate: 2.5 });
	const pmp = await readPMTiles(rp.buffer);
	const at = async (z, x, y) => { const t = await pmp.getTile(z, x, y); return t ? decodeTile(t)[0].features : []; };
	const z0 = await at(0, 0, 0), z6 = [];
	for (const e of pmp.root) for (let k = 0; k < e.runLength; k++) { const [z, x, y] = (await import("../src/convert/pmtiles.js")).tileIdToZxy(e.tileId + k); if (z === 6) z6.push(...await at(z, x, y)); }
	const ids6 = new Set(z6.map(f => f.id)), ids0 = new Set(z0.map(f => f.id));
	ok(ids6.size === 2000, `dropRate: maxZoom には全点（${ids6.size}）`);
	ok(z0.length > 0 && z0.length < 2000 / 50 && [...ids0].every(i => ids6.has(i)), `dropRate 2.5: z0 は 2.5^-6≈0.4% ＝ ${z0.length} 点（入れ子）`);
	const rp1 = await toPMTiles(pp, { gint: pg, gpu: false, minZoom: 0, maxZoom: 6, dropRate: 1 });
	ok(decodeTile(await (await readPMTiles(rp1.buffer)).getTile(0, 0, 0))[0].features.length === 2000, "dropRate 1: z0 にも全点");
}

// ---- CLI ---------------------------------------------------------------------------------
const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname, dir = mkdtempSync(join(tmpdir(), "geopbf-pmt-"));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const inPath = join(dir, "fix.geopbf"); writeFileSync(inPath, gzipSync(Buffer.from(pbf.arrayBuffer)));
const out = run("pmtiles", inPath, join(dir, "fix.pmtiles"), "--maxzoom", "5", "--no-gpu", "--drop-rate", "1");
ok(/タイル [\d,]+/.test(out) && /CPU/.test(out), "CLI pmtiles: 実行報告（タイル数・エンジン）");
const cliPm = await readPMTiles(new Uint8Array(readFileSync(join(dir, "fix.pmtiles"))));
ok(cliPm.header.maxZoom === 5 && decodeTile(await cliPm.getTile(0, 0, 0))[0].features.length === 7, "CLI pmtiles: 出力が読める（gzip GeoPBF 入力・gint はその場で焼く）");
writeFileSync(join(dir, "fix.gint"), Buffer.from(gint));
const out2 = run("pmtiles", inPath, join(dir, "fix2.pmtiles"), "--maxzoom", "3", "--gint", join(dir, "fix.gint"), "--layer", "cli");
ok(/gint 読込/.test(out2) && decodeTile(await (await readPMTiles(new Uint8Array(readFileSync(join(dir, "fix2.pmtiles"))))).getTile(0, 0, 0))[0].name === "cli", "CLI pmtiles: --gint と --layer");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
