// convert/tiler.js ── GeoPBF（＋gint）→ PMTiles（MVT）。
//
// 入力は GintBUF（ortho-japan が GPU で描いているのと同じ派生物＝arc・VW rank・polyStream/lineStream・点）。
// GeoPBF の feature 座標を読み直すのではなく gint の arc を使う理由は 2 つ：
//   1. 共有境界は 1 本の arc＝隣接ポリゴンは同じ頂点列に簡略化される＝低ズームのタイルに隙間・重なりが出ない
//   2. rank（VW 重要度）が焼き込み済み＝ズーム毎の簡略化が「rank ≥ 閾値」の並列フィルタになる（GPU 向き）
// ズーム z の閾値は ortho-core の r=63-3z（256px 世界）を extent へ換算した 63-3(z+log2(extent/256))。
//
// 流れ: unpack → ①project（GPU/CPU）→ ②lodCount（全ズーム 1 dispatch）→ prefix sum → ②lodWrite（出力量で
// ズームを束ねて読み戻し）→ ズーム×タイル列範囲の job を worker プールへ（環/線の組立・二分クリップ・MVT・gzip・
// 内容キー）→ main で内容を寄せて PMTiles。gzip は Node=zlib / ブラウザ=CompressionStream（pako 不使用）。
import { unPackGintBuffer } from "../extension/topology.js";
import { getDevice } from "./gpu.js";
import { createEngine, cpuEngine } from "./engine.js";
import { assembleZoom } from "./assemble.js";
import { createPool, defaultWorkers } from "./pool.js";
import { gzipMany } from "./gzip.js";
import { assemblePMTiles, sameBytes } from "./pmtiles.js";

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
// opts.workers: worker 数（0＝インライン・既定＝コア数-1・最大 8）
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
	const tileGzip = (opts.tileCompression ?? "gzip") === "gzip";
	const stats = { engine: "cpu", vertices: 0, arcs: 0, kept: 0, tiles: 0, bytes: 0, workers: 0, ms: {} };

	// ── 頂点台帳: arc 群 ＋ 点（点は長さ 1 の arc として同じ経路を通す）
	const arcU32 = d.arcBuffer ? new Uint32Array(d.arcBuffer.buffer, d.arcBuffer.byteOffset, d.arcBuffer.length * 2) : new Uint32Array(0);
	const ptU32 = d.pointBuffer ? new Uint32Array(d.pointBuffer.buffer, d.pointBuffer.byteOffset, d.pointBuffer.length * 2) : new Uint32Array(0);
	const arcLen = arcU32.length >>> 1, nPts = ptU32.length >>> 1, A = d.arcCount + nPts;
	const verts = new Uint32Array((arcLen + nPts) * 2); verts.set(arcU32, 0); verts.set(ptU32, arcLen * 2);
	const arcs = new Uint32Array(A * 2);
	for (let a = 0; a < d.arcCount; a++) { arcs[a * 2] = d.arcMeta[a * 8]; arcs[a * 2 + 1] = d.arcMeta[a * 8 + 1]; }
	for (let p = 0; p < nPts; p++) { arcs[(d.arcCount + p) * 2] = arcLen + p; arcs[(d.arcCount + p) * 2 + 1] = 1; }
	stats.vertices = arcLen + nPts; stats.arcs = d.arcCount;

	// ── エンジン（GPU/CPU）
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
	const offsets = new Uint32Array(counts.length);
	let total = 0; for (let i = 0; i < counts.length; i++) { offsets[i] = total; total += counts[i]; }
	stats.kept = total;
	const zoomTotal = (k) => (k + 1 < zoomCount ? offsets[(k + 1) * A] : total) - offsets[k * A];

	// ── 属性 → tags（fid 毎に 1 回・worker へは配列で 1 回送る）
	const fields = new Map();
	const tags = new Array(pbf.length);
	for (let i = 0; i < pbf.length; i++) tags[i] = propsToTags(pbf.getProperties(i), fields);
	const S = { arcCount: d.arcCount, nPts, point: d.point ? d.point.slice() : null, polyStream: d.polyStream ? d.polyStream.slice() : null, lineStream: d.lineStream ? d.lineStream.slice() : null, extent, buffer, layerName, tags };

	// ── worker プール（失敗したらインライン）
	let pool = null;
	const NW = opts.workers ?? await defaultWorkers();
	if (NW > 0) { try { pool = await createPool(NW); await pool.init(S); } catch (e) { pool = null; opts.onWarn?.(e); } }
	stats.workers = pool ? NW : 0;

	// ── 結果の寄せ集め（内容キーで重複統合・同キー異内容は枝番）
	const items = [], contents = new Map();
	let tileCount = 0;
	const merge = (r) => {
		const remap = new Map();
		for (const [key0, bytes] of r.contents) {
			let key = key0, n = 0, cur = contents.get(key);
			while (cur && !sameBytes(cur, bytes)) { key = key0 + "~" + (++n); cur = contents.get(key); }
			if (!cur) contents.set(key, bytes);
			if (key !== key0) remap.set(key0, key);
		}
		for (const t of r.tiles) items.push({ id: t.id, key: remap.get(t.key) ?? t.key });
		tileCount += r.tiles.length;
	};

	// ── ズーム毎の job（GPU 読み戻しはズームを束ねて・組立は列範囲で分担）
	const batchVerts = opts.batchVertices ?? (32 << 20);
	let tAsm = 0, tLod2 = 0;
	const pending = [];
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
			const z = minZoom + k, ntx = 1 << z;
			const zc = counts.subarray(k * A, (k + 1) * A), zb = bbox.subarray(k * A * 4, (k + 1) * A * 4);
			const zo = sub.subarray((k - k0) * A, (k - k0 + 1) * A), zStart = zo[0], zEnd = (k - k0 + 1 < k1 - k0 ? sub[(k - k0 + 1) * A] : sum);
			const shards = Math.max(1, Math.min(ntx, pool ? pool.size * 3 : 1));
			for (let s = 0; s < shards; s++) {
				const txFrom = Math.floor(ntx * s / shards), txTo = Math.floor(ntx * (s + 1) / shards) - 1;
				const makeJob = () => {   // worker が空いた時に複製を作る＝同時に NW 個まで
					const offs = zo.slice(); for (let i = 0; i < offs.length; i++) offs[i] -= zStart;
					const o = out.slice(zStart * 2, zEnd * 2);
					const J = { z, txFrom, txTo, counts: zc.slice(), bbox: zb.slice(), offs, out: o };
					return { msg: { type: "job", J, gzip: tileGzip }, transfers: [J.counts.buffer, J.bbox.buffer, offs.buffer, o.buffer] };
				};
				if (pool) pending.push(pool.run(makeJob).then(r => { merge(r); opts.onProgress?.({ zoom: z, tiles: tileCount }); }));
				else {
					const J = makeJob().msg.J, r = assembleZoom(S, J);
					const bytes = tileGzip ? await gzipMany(r.contents.map(c => c[1])) : r.contents.map(c => c[1]);
					merge({ tiles: r.tiles, contents: r.contents.map((c, i) => [c[0], bytes[i]]) });
					opts.onProgress?.({ zoom: z, tiles: tileCount });
				}
			}
		}
		if (pool) await Promise.all(pending.splice(0));   // この束の job を待ってから out を捨てる（次の GPU 読み戻しへ）
		tAsm += now() - ta;
		k0 = k1;
	}
	stats.ms.lod_write = tLod2; stats.ms.assemble = tAsm;
	proj.destroy(); eng.destroy(); pool?.destroy();

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
	const buf = await assemblePMTiles(items, contents, metadata, { minZoom, maxZoom, bounds, tileCompression: tileGzip ? "gzip" : "none", center: opts.center });
	stats.ms.pmtiles = now() - tp;
	stats.tiles = tileCount; stats.bytes = buf.length; stats.contents = contents.size; stats.ms.total = now() - t0;
	return { buffer: buf, stats, metadata };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
