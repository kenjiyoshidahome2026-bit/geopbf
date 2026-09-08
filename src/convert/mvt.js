// convert/mvt.js ── Mapbox Vector Tile 2.1 の最小エンコーダ。protobuf ライタも自前（依存ゼロ＝worker がバンドラ無しで
// 読める）。1 タイル = 1 レイヤ。feature.id = fid。幾何はタイルローカル整数。環の向きは MVT 規則（外環＝測量公式の面積が
// 正・穴＝負）にここで揃える。復号（検定用）は mvt-decode.js。

// ── 最小 protobuf ライタ ──
class W {
	constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.pos = 0; }
	reset() { this.pos = 0; return this; }
	need(n) { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf.subarray(0, this.pos)); this.buf = b; } }
	varint(v) { this.need(10); while (v >= 0x80) { this.buf[this.pos++] = (v % 128) | 0x80; v = Math.floor(v / 128); } this.buf[this.pos++] = v; }
	tag(field, wt) { this.varint((field << 3) | wt); }
	uint(field, v) { this.tag(field, 0); this.varint(v); }
	sint(field, v) { this.tag(field, 0); this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
	double(field, v) { this.tag(field, 1); this.need(8); new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, v, true); this.pos += 8; }
	bytes(field, u8) { this.tag(field, 2); this.varint(u8.length); this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
	string(field, s) { this.bytes(field, new TextEncoder().encode(s)); }
	packed(field, arr) {   // 非負 varint の packed
		let n = 0; for (let i = 0; i < arr.length; i++) { let v = arr[i]; do { n++; v = Math.floor(v / 128); } while (v > 0); }
		this.tag(field, 2); this.varint(n); this.need(n);
		for (let i = 0; i < arr.length; i++) { let v = arr[i]; while (v >= 0x80) { this.buf[this.pos++] = (v % 128) | 0x80; v = Math.floor(v / 128); } this.buf[this.pos++] = v; }
	}
	sub() { return this.buf.subarray(0, this.pos); }
	finish() { return this.buf.slice(0, this.pos); }
}
const wTile = new W(), wLayer = new W(), wFeat = new W(), wGeom = new W(1 << 14);

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

// 幾何コマンド列を g に積む。空なら false
function geometryCommands(type, parts, g) {
	let cx = 0, cy = 0;
	const push = (x, y) => { g.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; };
	if (type === 1) {
		const p = dedupe(parts, false);
		if (!p.length) return false;
		g.push(cmd(1, p.length >> 1));
		for (let i = 0; i < p.length; i += 2) push(p[i], p[i + 1]);
		return true;
	}
	if (type === 2) {
		let any = false;
		for (const l0 of parts) {
			const l = dedupe(l0, false), n = l.length >> 1;
			if (n < 2) continue;
			any = true;
			g.push(cmd(1, 1)); push(l[0], l[1]);
			g.push(cmd(2, n - 1)); for (let i = 1; i < n; i++) push(l[i * 2], l[i * 2 + 1]);
		}
		return any;
	}
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
	return any;
}

// layer: { name, extent, features: [{ id, type: 1|2|3, tags: [[key, value], …], geometry }] } → Uint8Array | null（feature 無し）
//   geometry: type1 → number[]（点列）/ type2 → number[][]（線の配列）/ type3 → number[][][]（ポリゴン＝環配列 の配列）
export function encodeTile(layer) {
	const L = wLayer.reset();
	L.uint(15, 2);
	L.string(1, layer.name);
	// キー/値の辞書（型別 Map＝文字列連結キーを作らない）
	const keys = new Map(), strs = new Map(), nums = new Map(), keyList = [], valList = [];
	let tIdx = -1, fIdx = -1;
	const keyIdx = (k) => { let i = keys.get(k); if (i === undefined) { i = keyList.length; keys.set(k, i); keyList.push(k); } return i; };
	const valIdx = (v) => {
		if (typeof v === "boolean") { if (v) { if (tIdx < 0) { tIdx = valList.length; valList.push(true); } return tIdx; } if (fIdx < 0) { fIdx = valList.length; valList.push(false); } return fIdx; }
		const m = typeof v === "string" ? strs : nums;
		let i = m.get(v); if (i === undefined) { i = valList.length; m.set(v, i); valList.push(v); } return i;
	};
	const g = [];
	let written = 0;
	for (const f of layer.features) {
		g.length = 0;
		if (!geometryCommands(f.type, f.geometry, g)) continue;   // 退化して空なら feature ごと書かない
		written++;
		const tags = [];
		for (const [k, v] of f.tags) { if (v === null || v === undefined) continue; tags.push(keyIdx(k), valIdx(v)); }
		const F = wFeat.reset();
		if (f.id !== undefined) F.uint(1, f.id);
		F.packed(2, tags);
		F.uint(3, f.type);
		F.packed(4, g);
		L.bytes(2, F.sub());
	}
	for (const k of keyList) L.string(3, k);
	for (const v of valList) {
		const V = wFeat.reset();
		if (typeof v === "string") V.string(1, v);
		else if (typeof v === "boolean") V.uint(7, v ? 1 : 0);
		else if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) { if (v >= 0) V.uint(5, v); else V.sint(6, v); }
		else V.double(3, v);
		L.bytes(4, V.sub());
	}
	if (!written) return null;   // feature が 1 つも残らないタイルは null（呼び出し側が書かない）
	L.uint(5, layer.extent);
	const T = wTile.reset();
	T.bytes(3, L.sub());
	return T.finish();
}
