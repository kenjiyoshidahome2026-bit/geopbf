// convert/tiler.js ── GeoPBF（＋gint）→ PMTiles（MVT）。
//
// 入力は GintBUF（ortho-japan が GPU で描いているのと同じ派生物＝arc・VW rank・polyStream/lineStream・点）。
// GeoPBF の feature 座標を読み直すのではなく gint の arc を使う理由は 2 つ：
//   1. 共有境界は 1 本の arc＝隣接ポリゴンは同じ頂点列に簡略化される＝低ズームのタイルに隙間・重なりが出ない
//   2. rank（VW 重要度）が焼き込み済み＝ズーム毎の簡略化が「rank ≥ 閾値」の並列フィルタになる（GPU 向き）
// ズーム z の閾値は ortho-core の r=63-3z（256px 世界）を extent へ換算した 63-3(z+log2(extent/256))。
//
// 流れ: unpack → ①project（GPU/CPU）→ ②lodCount（全ズーム 1 dispatch）→ prefix sum → ②lodWrite（出力量で
// ズームを束ねて読み戻し）→ ズーム毎に CPU で環/線を組み立て → 二分クリップ → MVT → gzip → PMTiles。
import { unPackGintBuffer } from "../extension/topology.js";
import { getDevice } from "./gpu.js";
import { createEngine, cpuEngine } from "./engine.js";
import { splitToTiles } from "./clip.js";
import { encodeTile, signedArea2 } from "./mvt.js";
import { writePMTiles } from "./pmtiles.js";

export function lodThreshold(z, extent, lodBias = 0) {
	const v = Math.round(63 - 3 * (z + Math.log2(extent / 256)) - lodBias);
	return Math.max(0, Math.min(63, v));
}

// 属性 → MVT tags（GeoPBF の値型を MVT の値型へ。入れ子は "a.b" に平坦化・Blob/ImageData/関数は落とす）
export function propsToTags(props, fields) {
	const tags = [];
	const put = (k, v) => {
		if (v === null || v === undefined) return;
		let t;
		if (typeof v === "string") t = v;
		else if (typeof v === "number") { if (!Number.isFinite(v)) return; t = v; }
		else if (typeof v === "boolean") t = v;
		else if (v instanceof Date) t = v.toISOString();
		else if (ArrayBuffer.isView(v)) t = JSON.stringify(Array.from(v));
		else if (typeof v === "object") { if (typeof Blob !== "undefined" && v instanceof Blob) return; if (typeof ImageData !== "undefined" && v instanceof ImageData) return; t = JSON.stringify(v); }
		else return;
		tags.push([k, t]);
		if (fields) { const ty = typeof t === "number" ? "Number" : typeof t === "boolean" ? "Boolean" : "String"; const cur = fields.get(k); if (!cur) fields.set(k, ty); else if (cur !== ty) fields.set(k, "String"); }
	};
	for (const k in props) {
		const v = props[k];
		if (v && typeof v === "object" && !(v instanceof Date) && !ArrayBuffer.isView(v) && Object.getPrototypeOf(v) === Object.prototype) for (const kk in v) put(k + "." + kk, v[kk]);
		else put(k, v);
	}
	return tags;
}

// pbf: GeoPBF（属性・ヘッダ用）。opts.gint: GintBUF（ArrayBuffer）。無ければ pbf._gintBuffer（pbf.gint() 後）。
export async function toPMTiles(pbf, opts = {}) {
	const t0 = now();
	const gintBuf = opts.gint ?? pbf._gintBuffer;
	if (!gintBuf) throw new Error("toPMTiles: GintBUF が無い（await pbf.gint() か opts.gint）");
	const d = unPackGintBuffer(gintBuf);
	if (!d) throw new Error("toPMTiles: GintBUF を読めない");
	const extent = opts.extent ?? 4096, extentShift = Math.log2(extent);
	if (!Number.isInteger(extentShift) || extent < 256 || extent > 65536) throw new Error("extent は 256〜65536 の 2 の冪");
	const minZoom = opts.minZoom ?? 0, maxZoom = opts.maxZoom ?? 14;
	if (!(minZoom >= 0 && maxZoom >= minZoom && maxZoom <= 32 - extentShift && maxZoom - minZoom < 32)) throw new Error(`zoom 範囲が不正（0 ≤ min ≤ max ≤ ${32 - extentShift}）`);
	const buffer = opts.buffer ?? 80, lodBias = opts.lodBias ?? 0;
	const layerName = opts.layer ?? pbf.name?.() ?? "layer";
	const stats = { engine: "cpu", vertices: 0, arcs: 0, kept: 0, tiles: 0, bytes: 0, ms: {} };

	// ── 頂点台帳: arc 群 ＋ 点（点は長さ 1 の arc として同じ経路を通す）
	const arcU32 = d.arcBuffer ? new Uint32Array(d.arcBuffer.buffer, d.arcBuffer.byteOffset, d.arcBuffer.length * 2) : new Uint32Array(0);
	const ptU32 = d.pointBuffer ? new Uint32Array(d.pointBuffer.buffer, d.pointBuffer.byteOffset, d.pointBuffer.length * 2) : new Uint32Array(0);
	const arcLen = arcU32.length >>> 1, nPts = ptU32.length >>> 1, A = d.arcCount + nPts;
	const verts = new Uint32Array((arcLen + nPts) * 2); verts.set(arcU32, 0); verts.set(ptU32, arcLen * 2);
	const arcs = new Uint32Array(A * 2);
	for (let a = 0; a < d.arcCount; a++) { arcs[a * 2] = d.arcMeta[a * 8]; arcs[a * 2 + 1] = d.arcMeta[a * 8 + 1]; }
	for (let p = 0; p < nPts; p++) { arcs[(d.arcCount + p) * 2] = arcLen + p; arcs[(d.arcCount + p) * 2 + 1] = 1; }
	stats.vertices = arcLen + nPts; stats.arcs = d.arcCount;

	// ── エンジン
	let device = null;
	if (opts.gpu !== false) device = await getDevice(typeof opts.gpu === "object" ? { gpu: opts.gpu } : {});
	const eng = device ? createEngine(device) : cpuEngine();
	stats.engine = eng.kind; stats.gpu = eng.info;
	const t1 = now();
	const proj = eng.project(verts);
	const zoomCount = maxZoom - minZoom + 1;
	const thresholds = Array.from({ length: zoomCount }, (_, k) => lodThreshold(minZoom + k, extent, lodBias));
	const params = { arcCount: A, zoomCount, minZoom, extentShift, thresholds };
	const { counts, bbox } = await eng.lodCount(proj, arcs, params);
	stats.ms.project_lod = now() - t1;
	// prefix sum（全ズーム通し）
	const offsets = new Uint32Array(counts.length);
	let total = 0; for (let i = 0; i < counts.length; i++) { offsets[i] = total; total += counts[i]; }
	stats.kept = total;
	const zoomTotal = (k) => (k + 1 < zoomCount ? offsets[(k + 1) * A] : total) - offsets[k * A];

	// ── 属性 → tags（fid 毎に 1 回）
	const fields = new Map();
	const tagCache = new Array(pbf.length);
	const tagsOf = (fid) => tagCache[fid] ??= propsToTags(pbf.getProperties(fid), fields);

	// ── ズーム毎の組立
	const tiles = [];
	const batchVerts = opts.batchVertices ?? (32 << 20);   // lodWrite 1 回の読み戻し上限（頂点数・8B/頂点）
	let tAsm = 0, tLod2 = 0;
	for (let k0 = 0; k0 < zoomCount;) {
		let k1 = k0 + 1, sum = zoomTotal(k0);
		while (k1 < zoomCount && sum + zoomTotal(k1) <= batchVerts) sum += zoomTotal(k1++);
		const base0 = offsets[k0 * A], sub = offsets.slice(k0 * A, k1 * A);
		for (let i = 0; i < sub.length; i++) sub[i] -= base0;
		const tw = now();
		const out = sum ? await eng.lodWrite(proj, arcs, params, sub, sum, k0, k1) : new Uint32Array(0);
		tLod2 += now() - tw;
		const ta = now();
		for (let k = k0; k < k1; k++) {
			const z = minZoom + k;
			const slotBase = (k - k0) * A, slotAbs = k * A;
			const pt = (slot, i) => [out[(sub[slot - slotAbs + slotBase] + i) * 2], out[(sub[slot - slotAbs + slotBase] + i) * 2 + 1]];
			const cnt = (slot) => counts[slot];
			const tileMap = new Map();
			const tileOf = (tx, ty) => { const key = tx * 4294967296 + ty; let t = tileMap.get(key); if (!t) { t = { tx, ty, polys: new Map(), lines: new Map(), points: new Map() }; tileMap.set(key, t); } return t; };
			const concat = (arcIdxs, ring) => {
				const line = [];
				let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
				for (const ai of arcIdxs) {
					const aid = ai < 0 ? ~ai : ai, slot = slotAbs + aid, n = cnt(slot);
					if (!n) continue;
					const b = slot * 4;
					if (bbox[b] < bx0) bx0 = bbox[b]; if (bbox[b + 1] < by0) by0 = bbox[b + 1]; if (bbox[b + 2] > bx1) bx1 = bbox[b + 2]; if (bbox[b + 3] > by1) by1 = bbox[b + 3];
					const o = sub[slot - slotAbs + slotBase];
					for (let j = 0; j < n; j++) {
						const i = ai < 0 ? n - 1 - j : j, x = out[(o + i) * 2], y = out[(o + i) * 2 + 1], m = line.length;
						if (m && line[m - 2] === x && line[m - 1] === y) continue;
						line.push(x, y);
					}
				}
				if (ring) { const m = line.length; if (m >= 4 && line[0] === line[m - 2] && line[1] === line[m - 1]) line.length = m - 2; }
				return { line, bbox: [bx0, by0, bx1, by1] };
			};
			// ポリゴン
			const ps = d.polyStream;
			if (ps) for (let p = 0; p < ps.length;) {
				const fid = ps[p++], nr = ps[p++], rings = [];
				let bb = null;
				for (let r = 0; r < nr; r++) {
					const ac = ps[p++], idx = ps.subarray(p, p + ac); p += ac;
					const { line, bbox: rb } = concat(idx, true);
					if (line.length < 6) { if (r === 0) break; continue; }
					const a2 = signedArea2(line);
					if (a2 === 0) { if (r === 0) break; continue; }
					if ((r === 0) !== (a2 > 0)) { const rev = []; for (let i = line.length - 2; i >= 0; i -= 2) rev.push(line[i], line[i + 1]); rings.push(rev); } else rings.push(line);
					if (r === 0) bb = rb; else { if (rb[0] < bb[0]) bb[0] = rb[0]; if (rb[1] < bb[1]) bb[1] = rb[1]; if (rb[2] > bb[2]) bb[2] = rb[2]; if (rb[3] > bb[3]) bb[3] = rb[3]; }
				}
				if (!rings.length) continue;
				splitToTiles(rings, 2, bb, z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); let l = t.polys.get(fid); if (!l) t.polys.set(fid, l = []); l.push(parts); });
			}
			// 線
			const ls = d.lineStream;
			if (ls) for (let p = 0; p < ls.length;) {
				const fid = ls[p++], ns = ls[p++];
				for (let s = 0; s < ns; s++) {
					const ac = ls[p++], idx = ls.subarray(p, p + ac); p += ac;
					const { line, bbox: lb } = concat(idx, false);
					if (line.length < 4) continue;
					splitToTiles([line], 1, lb, z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); let l = t.lines.get(fid); if (!l) t.lines.set(fid, l = []); for (const q of parts) l.push(q); });
				}
			}
			// 点（fid 毎に束ねて MultiPoint）
			if (nPts) {
				const byFid = new Map();
				for (let i = 0; i < nPts; i++) { const slot = slotAbs + d.arcCount + i; if (!cnt(slot)) continue; const [x, y] = pt(slot, 0); const fid = d.point[i]; let l = byFid.get(fid); if (!l) byFid.set(fid, l = []); l.push(x, y); }
				for (const [fid, pts] of byFid) {
					let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
					for (let i = 0; i < pts.length; i += 2) { if (pts[i] < bx0) bx0 = pts[i]; if (pts[i] > bx1) bx1 = pts[i]; if (pts[i + 1] < by0) by0 = pts[i + 1]; if (pts[i + 1] > by1) by1 = pts[i + 1]; }
					splitToTiles(pts, 0, [bx0, by0, bx1, by1], z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); const l = t.points.get(fid); if (l) l.push(...parts); else t.points.set(fid, parts.slice()); });
				}
			}
			// ── タイル → MVT
			// 内陸の「全面塗り」タイル（1 feature・4 隅の矩形だけ）は fid 毎に 1 回だけ符号化して使い回す＝面被覆データでは
			// 高ズームのタイルの大半がこれ（PMTiles 側の内容重複畳み込みと対＝符号化もしない）。
			const fullCache = new Map();
			const lo = -buffer, hi = extent + buffer;
			const isFullSquare = (rings) => {
				if (rings.length !== 1 || rings[0].length !== 8) return false;
				const r = rings[0]; let c = 0;
				for (let i = 0; i < 8; i += 2) { const x = r[i], y = r[i + 1]; if ((x === lo || x === hi) && (y === lo || y === hi)) c++; }
				return c === 4 && !(r[0] === r[2] && r[1] === r[3]) && !(r[0] === r[4] && r[1] === r[5]);
			};
			for (const t of tileMap.values()) {
				const ox = t.tx * extent, oy = t.ty * extent, features = [];
				const local = (a) => { const o = new Array(a.length); for (let i = 0; i < a.length; i += 2) { o[i] = Math.round(a[i] - ox); o[i + 1] = Math.round(a[i + 1] - oy); } return o; };
				if (t.polys.size === 1 && !t.lines.size && !t.points.size) {
					const [fid, polys] = t.polys.entries().next().value;
					if (polys.length === 1) {
						const rings = polys[0].map(local);
						if (isFullSquare(rings)) {
							let data = fullCache.get(fid);
							if (!data) { data = encodeTile({ name: layerName, extent, features: [{ id: fid, type: 3, tags: tagsOf(fid), geometry: [rings] }] }); fullCache.set(fid, data); }
							tiles.push({ z, x: t.tx, y: t.ty, data });
							continue;
						}
					}
				}
				for (const [fid, polys] of t.polys) features.push({ id: fid, type: 3, tags: tagsOf(fid), geometry: polys.map(rings => rings.map(local)) });
				for (const [fid, lines] of t.lines) features.push({ id: fid, type: 2, tags: tagsOf(fid), geometry: lines.map(local) });
				for (const [fid, pts] of t.points) features.push({ id: fid, type: 1, tags: tagsOf(fid), geometry: local(pts) });
				const data = encodeTile({ name: layerName, extent, features });
				tiles.push({ z, x: t.tx, y: t.ty, data });
			}
			opts.onProgress?.({ zoom: z, tiles: tiles.length });
		}
		tAsm += now() - ta;
		k0 = k1;
	}
	stats.ms.lod_write = tLod2; stats.ms.assemble = tAsm;
	proj.destroy(); eng.destroy();

	// ── PMTiles
	const tp = now();
	const bounds = d.bbox;
	const metadata = {
		name: layerName, format: "pbf", type: "overlay", version: "1",
		description: pbf.description?.() || undefined, attribution: pbf.attribution?.() || undefined, license: pbf.license?.() || undefined,
		minzoom: String(minZoom), maxzoom: String(maxZoom), bounds: bounds.join(","),
		vector_layers: [{ id: layerName, description: "", minzoom: minZoom, maxzoom: maxZoom, fields: Object.fromEntries(fields) }],
		generator: "geopbf",
		...(opts.metadata || {}),
	};
	for (const k of Object.keys(metadata)) if (metadata[k] === undefined) delete metadata[k];
	// gzip: Node なら zlib（ネイティブ・pako の数倍速い）、無ければ pako。opts.compress で差し替え可。
	let compress = opts.compress;
	if (!compress && typeof process !== "undefined" && process.versions?.node) { try { const z = await import("node:zlib"); compress = (u8) => new Uint8Array(z.gzipSync(u8)); } catch {} }
	const buf = writePMTiles(tiles, metadata, { minZoom, maxZoom, bounds, tileCompression: opts.tileCompression ?? "gzip", center: opts.center, compress });
	stats.ms.pmtiles = now() - tp;
	stats.tiles = tiles.length; stats.bytes = buf.length; stats.ms.total = now() - t0;
	return { buffer: buf, stats, metadata };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
