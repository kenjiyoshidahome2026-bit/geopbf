// convert/mvt.js ── Mapbox Vector Tile 2.1 の最小エンコーダ／デコーダ（pbf ライタ・依存追加なし）。
// エンコード: 1 タイル = 1 レイヤ（GeoPBF 1 ファイル = 1 レイヤ）。feature.id = fid（GeoPBF の feature 添字）。
// 幾何はタイルローカル整数。環の向きは MVT 規則（外環＝測量公式の面積が正・穴＝負）にここで揃える。
import Pbf from "pbf";

const zz = (v) => (v << 1) ^ (v >> 31);
const cmd = (id, n) => (id & 7) | (n << 3);

// 連続重複除去（環は閉じ点も落とす）。coords: number[]（整数）
function dedupe(a, ring) {
	const out = [];
	for (let i = 0; i < a.length; i += 2) { const n = out.length; if (n && out[n - 2] === a[i] && out[n - 1] === a[i + 1]) continue; out.push(a[i], a[i + 1]); }
	if (ring) { const n = out.length; if (n >= 4 && out[0] === out[n - 2] && out[1] === out[n - 1]) out.length = n - 2; }
	return out;
}
export function signedArea2(r) {   // 測量公式 ×2（y 下向きの座標系のまま）
	let s = 0; const n = r.length >> 1;
	for (let i = 0, j = n - 1; i < n; j = i++) s += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
	return s;
}
const reverse = (r) => { const out = []; for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]); return out; };

function writeGeometry(pbf, type, parts) {
	const g = [];
	let cx = 0, cy = 0;
	const push = (x, y) => { g.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; };
	if (type === 1) {
		const p = dedupe(parts, false);
		if (!p.length) return false;
		g.push(cmd(1, p.length >> 1));
		for (let i = 0; i < p.length; i += 2) push(p[i], p[i + 1]);
	} else if (type === 2) {
		let any = false;
		for (const l0 of parts) {
			const l = dedupe(l0, false), n = l.length >> 1;
			if (n < 2) continue;
			any = true;
			g.push(cmd(1, 1)); push(l[0], l[1]);
			g.push(cmd(2, n - 1)); for (let i = 1; i < n; i++) push(l[i * 2], l[i * 2 + 1]);
		}
		if (!any) return false;
	} else {
		let any = false;
		for (const rings of parts) {   // parts = ポリゴンの配列・各ポリゴン = 環の配列（[0] 外環）
			let outerOk = false;
			for (let r = 0; r < rings.length; r++) {
				let ring = dedupe(rings[r], true);
				const n = ring.length >> 1;
				if (n < 3) { if (r === 0) break; continue; }
				const a2 = signedArea2(ring);
				if (a2 === 0) { if (r === 0) break; continue; }
				if ((r === 0) !== (a2 > 0)) ring = reverse(ring);
				if (r === 0) outerOk = true;
				g.push(cmd(1, 1)); push(ring[0], ring[1]);
				g.push(cmd(2, n - 1)); for (let i = 1; i < n; i++) push(ring[i * 2], ring[i * 2 + 1]);
				g.push(cmd(7, 1));
			}
			if (outerOk) any = true;
		}
		if (!any) return false;
	}
	pbf.writePackedVarint(4, g);
	return true;
}

// 書き出しの作業バッファ（タイル毎の new/realloc を避ける。finish() は必要長だけ複製して返す）
let scratch = new Uint8Array(1 << 20), scratchGeom = new Uint8Array(1 << 18);
const fresh = (pbf, sc) => { const r = pbf.finish(); return r.buffer === sc.buffer ? r.slice() : r; };   // 溢れて realloc されていれば既に独立

// layer: { name, extent, features: [{ id, type: 1|2|3, tags: [[key, value], …], geometry }] }
//   geometry: type1 → number[]（点列）/ type2 → number[][]（線の配列）/ type3 → number[][][]（ポリゴン＝環配列 の配列）
export function encodeTile(layer) {
	const pbf = new Pbf(scratch);
	pbf.writeMessage(3, writeLayer, layer);
	const out = fresh(pbf, scratch);
	if (pbf.buf.length > scratch.length) scratch = new Uint8Array(pbf.buf.length);   // 大きなタイルに合わせて成長
	return out;
}
function writeLayer(layer, pbf) {
	pbf.writeVarintField(15, 2);
	pbf.writeStringField(1, layer.name);
	// キー/値の辞書。値は型別 Map（"型:値" の文字列連結キーは feature×tag 回の文字列生成＝GC の主因だった）
	const keys = new Map(), strs = new Map(), nums = new Map(), keyList = [], valList = [];
	let tIdx = -1, fIdx = -1;
	const keyIdx = (k) => { let i = keys.get(k); if (i === undefined) { i = keyList.length; keys.set(k, i); keyList.push(k); } return i; };
	const valIdx = (v) => {
		if (typeof v === "boolean") { if (v) { if (tIdx < 0) { tIdx = valList.length; valList.push(true); } return tIdx; } if (fIdx < 0) { fIdx = valList.length; valList.push(false); } return fIdx; }
		const m = typeof v === "string" ? strs : nums;
		let i = m.get(v); if (i === undefined) { i = valList.length; m.set(v, i); valList.push(v); } return i;
	};
	for (const f of layer.features) {
		// 幾何が退化して空なら feature ごと書かない＝先に幾何だけ別バッファへ試し書き
		const geom = new Pbf(scratchGeom);
		if (!writeGeometry(geom, f.type, f.geometry)) continue;
		const gb = geom.finish();
		if (geom.buf.length > scratchGeom.length) scratchGeom = new Uint8Array(geom.buf.length);
		const tags = [];
		for (const [k, v] of f.tags) { if (v === null || v === undefined) continue; tags.push(keyIdx(k), valIdx(v)); }
		pbf.writeMessage(2, (f, pbf) => {
			if (f.id !== undefined) pbf.writeVarintField(1, f.id);
			pbf.writePackedVarint(2, tags);
			pbf.writeVarintField(3, f.type);
			pbf.realloc(gb.length); pbf.buf.set(gb, pbf.pos); pbf.pos += gb.length;
		}, f);
	}
	for (const k of keyList) pbf.writeStringField(3, k);
	for (const v of valList) pbf.writeMessage(4, writeValue, v);
	pbf.writeVarintField(5, layer.extent);
}
function writeValue(v, pbf) {
	if (typeof v === "string") pbf.writeStringField(1, v);
	else if (typeof v === "boolean") pbf.writeBooleanField(7, v);
	else if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) { if (v >= 0) pbf.writeVarintField(5, v); else pbf.writeSVarintField(6, v); }
	else pbf.writeDoubleField(3, v);
}

// 検定用デコーダ → [{ name, extent, features: [{ id, type, props, geometry: [[x,y,…]…] }] }]
export function decodeTile(buf) {
	const pbf = new Pbf(buf), layers = [];
	pbf.readFields((tag) => { if (tag === 3) layers.push(pbf.readMessage(readLayer, { name: "", extent: 4096, features: [], keys: [], values: [], raw: [] })); });
	for (const l of layers) {
		for (const f of l.raw) {
			const props = {};
			for (let i = 0; i < f.tags.length; i += 2) props[l.keys[f.tags[i]]] = l.values[f.tags[i + 1]];
			l.features.push({ id: f.id, type: f.type, props, geometry: decodeGeom(f.geom) });
		}
		delete l.raw; delete l.keys; delete l.values;
	}
	return layers;
}
function readLayer(tag, l, pbf) {
	if (tag === 15) l.version = pbf.readVarint();
	else if (tag === 1) l.name = pbf.readString();
	else if (tag === 2) l.raw.push(pbf.readMessage(readFeature, { id: undefined, tags: [], type: 0, geom: [] }));
	else if (tag === 3) l.keys.push(pbf.readString());
	else if (tag === 4) l.values.push(pbf.readMessage(readValue, {}).v);
	else if (tag === 5) l.extent = pbf.readVarint();
}
function readFeature(tag, f, pbf) {
	if (tag === 1) f.id = pbf.readVarint();
	else if (tag === 2) pbf.readPackedVarint(f.tags);
	else if (tag === 3) f.type = pbf.readVarint();
	else if (tag === 4) pbf.readPackedVarint(f.geom);
}
function readValue(tag, o, pbf) {
	if (tag === 1) o.v = pbf.readString(); else if (tag === 2) o.v = pbf.readFloat(); else if (tag === 3) o.v = pbf.readDouble();
	else if (tag === 4) o.v = pbf.readVarint(true); else if (tag === 5) o.v = pbf.readVarint(); else if (tag === 6) o.v = pbf.readSVarint(); else if (tag === 7) o.v = pbf.readBoolean();
}
function decodeGeom(g) {   // → リング/線/点列の配列（number[]・ClosePath は閉じ点を付けない）
	const parts = []; let cur = null, x = 0, y = 0;
	for (let i = 0; i < g.length;) {
		const c = g[i] & 7, n = g[i] >> 3; i++;
		if (c === 1) { for (let k = 0; k < n; k++) { x += (g[i] >> 1) ^ -(g[i] & 1); y += (g[i + 1] >> 1) ^ -(g[i + 1] & 1); i += 2; cur = [x, y]; parts.push(cur); } }
		else if (c === 2) { for (let k = 0; k < n; k++) { x += (g[i] >> 1) ^ -(g[i] & 1); y += (g[i + 1] >> 1) ^ -(g[i + 1] & 1); i += 2; cur.push(x, y); } }
		else if (c === 7) { /* close */ }
	}
	return parts;
}
