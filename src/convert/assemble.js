// convert/assemble.js ── 1 ズーム × タイル列範囲の「組立→クリップ→MVT→内容キー」。worker（tile-worker.js）と
// インライン経路（workers:0）の共通本体＝純関数。bare import 無し（worker がバンドラ無しで読める）。
//
// S（静的・worker 初期化時に 1 回）: { arcCount, nPts, point, polyStream, lineStream, extent, buffer, layerName, tags }
// J（job）: { z, txFrom, txTo, counts, bbox, offs, out }   … このズームの arc 別 件数/外接/先頭位置（out 内）/圧縮座標
// 戻り: { tiles: [{ id, key }], contents: [[key, Uint8Array(未圧縮 MVT)]] }
import { splitToTiles } from "./clip.js";
import { encodeTile, signedArea2 } from "./mvt.js";
import { zxyToTileId, contentKey, sameBytes } from "./pmtiles.js";

export function assembleZoom(S, J) {
	const { arcCount, nPts, point, polyStream: ps, lineStream: ls, extent, buffer, layerName, tags } = S;
	const { z, counts, bbox, offs, out } = J;
	const txRange = [J.txFrom, J.txTo];
	const tileMap = new Map();
	const tileOf = (tx, ty) => { const key = tx * 4294967296 + ty; let t = tileMap.get(key); if (!t) { t = { tx, ty, polys: new Map(), lines: new Map(), points: new Map() }; tileMap.set(key, t); } return t; };
	const concat = (arcIdxs, ring) => {
		const line = [];
		let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
		for (const ai of arcIdxs) {
			const aid = ai < 0 ? ~ai : ai, n = counts[aid];
			if (!n) continue;
			const b = aid * 4;
			if (bbox[b] < bx0) bx0 = bbox[b]; if (bbox[b + 1] < by0) by0 = bbox[b + 1]; if (bbox[b + 2] > bx1) bx1 = bbox[b + 2]; if (bbox[b + 3] > by1) by1 = bbox[b + 3];
			const o = offs[aid];
			for (let j = 0; j < n; j++) {
				const i = ai < 0 ? n - 1 - j : j, x = out[(o + i) * 2], y = out[(o + i) * 2 + 1], m = line.length;
				if (m && line[m - 2] === x && line[m - 1] === y) continue;
				line.push(x, y);
			}
		}
		if (ring) { const m = line.length; if (m >= 4 && line[0] === line[m - 2] && line[1] === line[m - 1]) line.length = m - 2; }
		return { line, bbox: [bx0, by0, bx1, by1] };
	};
	// ポリゴン（外環→穴。向きは MVT 規則へ。全体 bbox で列範囲外なら組立すら省く）
	if (ps) for (let p = 0; p < ps.length;) {
		const fid = ps[p++], nr = ps[p++], rings = [];
		let bb = null;
		for (let r = 0; r < nr; r++) {
			const ac = ps[p++], idx = ps.subarray(p, p + ac); p += ac;
			if (r === 0) {   // 外環の arc bbox だけ先に見て列範囲外なら残りを読み飛ばす
				let x0 = Infinity, x1 = -Infinity;
				for (const ai of idx) { const aid = ai < 0 ? ~ai : ai; if (!counts[aid]) continue; if (bbox[aid * 4] < x0) x0 = bbox[aid * 4]; if (bbox[aid * 4 + 2] > x1) x1 = bbox[aid * 4 + 2]; }
				if (x1 < 0 || (x1 + buffer) / extent < txRange[0] || (x0 - buffer) / extent >= txRange[1] + 1) { for (let q = 1; q < nr; q++) p += ps[p] + 1; break; }
			}
			const { line, bbox: rb } = concat(idx, true);
			if (line.length < 6) { if (r === 0) break; continue; }
			const a2 = signedArea2(line);
			if (a2 === 0) { if (r === 0) break; continue; }
			if ((r === 0) !== (a2 > 0)) { const rev = []; for (let i = line.length - 2; i >= 0; i -= 2) rev.push(line[i], line[i + 1]); rings.push(rev); } else rings.push(line);
			if (r === 0) bb = rb; else { if (rb[0] < bb[0]) bb[0] = rb[0]; if (rb[1] < bb[1]) bb[1] = rb[1]; if (rb[2] > bb[2]) bb[2] = rb[2]; if (rb[3] > bb[3]) bb[3] = rb[3]; }
		}
		if (!rings.length) continue;
		splitToTiles(rings, 2, bb, z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); let l = t.polys.get(fid); if (!l) t.polys.set(fid, l = []); l.push(parts); }, txRange);
	}
	// 線
	if (ls) for (let p = 0; p < ls.length;) {
		const fid = ls[p++], ns = ls[p++];
		for (let s = 0; s < ns; s++) {
			const ac = ls[p++], idx = ls.subarray(p, p + ac); p += ac;
			const { line, bbox: lb } = concat(idx, false);
			if (line.length < 4) continue;
			splitToTiles([line], 1, lb, z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); let l = t.lines.get(fid); if (!l) t.lines.set(fid, l = []); for (const q of parts) l.push(q); }, txRange);
		}
	}
	// 点（fid 毎に束ねて MultiPoint）
	if (nPts) {
		const byFid = new Map();
		for (let i = 0; i < nPts; i++) { const a = arcCount + i; if (!counts[a]) continue; const o = offs[a]; const fid = point[i]; let l = byFid.get(fid); if (!l) byFid.set(fid, l = []); l.push(out[o * 2], out[o * 2 + 1]); }
		for (const [fid, pts] of byFid) {
			let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
			for (let i = 0; i < pts.length; i += 2) { if (pts[i] < bx0) bx0 = pts[i]; if (pts[i] > bx1) bx1 = pts[i]; if (pts[i + 1] < by0) by0 = pts[i + 1]; if (pts[i + 1] > by1) by1 = pts[i + 1]; }
			splitToTiles(pts, 0, [bx0, by0, bx1, by1], z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); const l = t.points.get(fid); if (l) l.push(...parts); else t.points.set(fid, parts.slice()); }, txRange);
		}
	}
	// ── タイル → MVT → 内容キー（同一内容は 1 回だけ持つ。内陸の全面塗り＝1 feature の 4 隅矩形は fid 毎に 1 回だけ符号化）
	const tiles = [], contents = new Map(), fullCache = new Map();
	const lo = -buffer, hi = extent + buffer;
	// 全面塗り＝4 隅が「それぞれ 1 回ずつ」現れ、面積が矩形そのもの。⚠ SH クリップは湾（凹部）の中のタイルに対して
	// 「縁を往復する面積ゼロの退化片」（例 (hi,lo)(hi,hi)(hi,hi)(hi,lo)）を返す＝隅の個数だけで見ると全面塗りに化ける
	//（コツェビュー湾が陸になった 2026-09-08）。退化片は符号化側で面積ゼロとして落ちるので、ここは厳密に。
	const isFullSquare = (rings) => {
		if (rings.length !== 1 || rings[0].length !== 8) return false;
		const r = rings[0]; let mask = 0;
		for (let i = 0; i < 8; i += 2) { const x = r[i], y = r[i + 1]; if (x === lo && y === lo) mask |= 1; else if (x === hi && y === lo) mask |= 2; else if (x === hi && y === hi) mask |= 4; else if (x === lo && y === hi) mask |= 8; else return false; }
		return mask === 15 && Math.abs(signedArea2(r)) === 2 * (hi - lo) * (hi - lo);
	};
	const keyOf = (data) => {
		let key = contentKey(data), n = 0, rec = contents.get(key);
		while (rec && !sameBytes(rec, data)) { key = key + "#" + (++n); rec = contents.get(key); }
		if (!rec) contents.set(key, data);
		return key;
	};
	for (const t of tileMap.values()) {
		const ox = t.tx * extent, oy = t.ty * extent, features = [];
		const local = (a) => { const o = new Array(a.length); for (let i = 0; i < a.length; i += 2) { o[i] = Math.round(a[i] - ox); o[i + 1] = Math.round(a[i + 1] - oy); } return o; };
		const id = zxyToTileId(z, t.tx, t.ty);
		if (t.polys.size === 1 && !t.lines.size && !t.points.size) {
			const [fid, polys] = t.polys.entries().next().value;
			if (polys.length === 1) {
				const rings = polys[0].map(local);
				if (isFullSquare(rings)) {
					// 環は正準形（固定の角順）で符号化＝どのタイルで最初に見つけても同じバイト列＝分担の有無で出力が変わらない
					let key = fullCache.get(fid);
					if (!key) { key = keyOf(encodeTile({ name: layerName, extent, features: [{ id: fid, type: 3, tags: tags[fid], geometry: [[[lo, lo, hi, lo, hi, hi, lo, hi]]] }] })); fullCache.set(fid, key); }
					tiles.push({ id, key });
					continue;
				}
			}
		}
		for (const [fid, polys] of t.polys) features.push({ id: fid, type: 3, tags: tags[fid], geometry: polys.map(rings => rings.map(local)) });
		for (const [fid, lines] of t.lines) features.push({ id: fid, type: 2, tags: tags[fid], geometry: lines.map(local) });
		for (const [fid, pts] of t.points) features.push({ id: fid, type: 1, tags: tags[fid], geometry: local(pts) });
		const data = encodeTile({ name: layerName, extent, features });
		if (!data) continue;   // 退化して feature が残らないタイルは書かない
		tiles.push({ id, key: keyOf(data) });
	}
	return { tiles, contents: [...contents] };
}
