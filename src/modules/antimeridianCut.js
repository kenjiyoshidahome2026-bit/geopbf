// modules/antimeridianCut.js ── ±180 の縫い目で環／線を切る。
//
// 環の切り方＝「経度の連続化（unwrap）→ 360° の窓ごとに Sutherland–Hodgman」。跨ぎを何回しても割れる。
//   旧＝跨ぎは高々 2 回という前提で交点を対にしていた（3 回目以降は捨てる／片方のバケツが常に空）。
//   結果、縫い目を 3 回以上跨ぐ環は割れずに 1 枚のまま残り、±180 を結ぶ辺が世界を横断する帯になった
//   ——中央経線を振った世界図（150°E でグリーンランドが北極線に沿って帯化・南極は極線の頂点が落ちる）で
//   露見（2026-09-17）。窓ごとの半平面クリップは跨ぎ回数に依らず正しく、縁に沿った閉じ合わせも SH が担う。
//
// 縫い目に**沿う**辺（両端とも ±180・南極型の極線）は跨ぎではない＝連続化では動かない量として扱う。
// 跨ぎが 1 つも無ければ環は無傷で返す（antimeridianFeature の入口判定と同じ約束）。
//
// 一周して経度が ±360 戻る環＝球面では閉じているが経緯度では極が特異点＝極を回り込む環。最初の跨ぎ点から
// 辿ると縫い目が窓の縁に揃うので、縫い目→極→縫い目の柱で閉じて 1 面のまま出せる（RFC 7946 の極表現）。
//
// 片は「縫い目のどちら側か（＝360° の窓）」で 1 つずつ。同じ側に離れた塊がいくつあっても 1 環にまとまり、
// 塊どうしは縫い目上の幅ゼロの辺で繋がる（SH の性質・タイル切り出し convert/clip.js と同じ流儀）。
// 塗り・面積・点の内外判定は変わらない（幅ゼロ＝巻き数に寄与しない）。
//
// 縫い目に落ちる頂点の緯度は大円と子午線の交点（seamLat）＝「頂点間は大円」という gint/encoder の約束に合わせる
//（線形内挿ではない）。両端が同じ子午線に載る辺（極の柱）だけは大円が定まらないので経度で線形に割る。
export function antimeridianCut(points, isLine = false) {
	const { PI, sin, cos, atan2, abs, floor } = Math, d2r = PI / 180, tub = [];
	if (!points?.length) return tub;
	const is_ring = _ => _.length > 1 && _[0][0] === _[_.length - 1][0] && _[0][1] === _[_.length - 1][1];
	const fix = x => x === 180 ? 180 : ((((x + 180) % 360) + 360) % 360) - 180;   // +180 は保つ（-180 へ書き換えると西側の縫い目頂点が偽の跨ぎになる）
	const pts = points.filter(t => t && typeof t[0] === 'number').map(t => [fix(t[0]), t[1]]);
	if (!pts.length) return tub;
	const north = (pts.reduce((s, t) => s + t[1], 0) / pts.length) > 0;
	const onSeam = x => x === 180 || x === -180;
	// 跨ぎ＝隣接頂点が混符号かつ経度差 > 180。両端とも ±180 のペアは同じ子午線上の移動＝縫い目に沿うだけで跨ぎではない
	const straddle = (a, b) => a[0] * b[0] < 0 && abs(a[0] - b[0]) > 180 && !(onSeam(a[0]) && onSeam(b[0]));
	// 経度の連続化で足す量（最短側・縫い目に沿う辺は 0）。跨ぎ辺はここで初めて「±360 の跳び」でなく小さな差になる
	const step = (a, b) => {
		if (onSeam(a[0]) && onSeam(b[0])) return 0;
		let d = b[0] - a[0];
		while (d > 180) d -= 360;
		while (d < -180) d += 360;
		return d;
	};
	// 大円 a—b が ±180 の子午線を切る緯度
	const seamLat = ([x0, y0], [x1, y1]) => {
		const x = sin((y0 - y1) * d2r) * sin((x0 + x1) / 2 * d2r) * cos((x0 - x1) / 2 * d2r) - sin((y0 + y1) * d2r) * cos((x0 + x1) / 2 * d2r) * sin((x0 - x1) / 2 * d2r);
		const z = cos(y0 * d2r) * cos(y1 * d2r) * sin((x0 - x1) * d2r), r = (z < 0 ? -1 : 1) * atan2(x, abs(z)) / d2r;
		return isNaN(r) ? y0 : r;
	};
	// 連続化した座標の辺 a—b が窓の縁 val（±180 の奇数倍）を切る点
	const crossing = (a, b, val) => {
		const na = fix(a[0]), nb = fix(b[0]);
		if (onSeam(na) && onSeam(nb)) return [val, a[1] + (val - a[0]) / (b[0] - a[0]) * (b[1] - a[1])];   // 同じ子午線に載る辺（極の柱）＝大円が定まらない
		return [val, seamLat([na, a[1]], [nb, b[1]])];
	};
	(is_ring(pts) && !isLine ? splitPolygon : splitPolyLine)(pts);
	return tub;

	function splitPolygon(p) {
		let s = 0; for (let i = 0; i < p.length - 1; i++) s += (p[i + 1][0] - p[i][0]) * (p[i + 1][1] + p[i][1]);
		if (s < 0) p.reverse();
		const v = p.slice(0, p.length - 1), n = v.length;   // 閉じ重複を除く＝以降は循環で扱う
		if (n < 3) return tub.push(p);

		let first = -1, cuts = 0, wrap = 0;
		for (let i = 0; i < n; i++) {
			const a = v[i], b = v[(i + 1) % n];
			if (straddle(a, b)) { cuts++; if (first < 0) first = i; }
			wrap += step(a, b);
		}
		if (!cuts) return tub.push(p);   // 跨がない＝無傷（縫い目に接するだけの南極型もここで素通り）

		const ring = [];   // 経度を連続化した環（この上で窓ごとに切る）
		if (abs(wrap) > 180) {
			// 一周で経度が ±360 ずれる＝極を回り込む。最初の跨ぎ点から辿る＝縫い目が窓の縁に揃い、1 面のまま柱で閉じられる
			const head = v[(first + 1) % n], lat = seamLat(v[first], head), pole = north ? 90 : -90;
			const s0 = head[0] < 0 ? -180 : 180;
			let u = s0, prev = [s0, lat];
			ring.push([u, lat]);
			for (let k = 1; k <= n; k++) { const b = v[(first + k) % n]; u += step(prev, b); ring.push([u, b[1]]); prev = b; }
			u += step(prev, [-s0, lat]);
			ring.push([u, lat], [u, pole], [s0, pole]);
		} else {
			let u = v[0][0];
			ring.push([u, v[0][1]]);
			for (let i = 1; i < n; i++) { u += step(v[i - 1], v[i]); ring.push([u, v[i][1]]); }
		}

		let lo = Infinity, hi = -Infinity;
		for (const q of ring) { if (q[0] < lo) lo = q[0]; if (q[0] > hi) hi = q[0]; }
		for (let k = floor((lo + 180) / 360); k <= floor((hi + 180) / 360); k++) {
			const c = 360 * k;
			let r = ring;
			if (hi > c + 180) r = clipHalf(r, c + 180, true);
			if (lo < c - 180) r = clipHalf(r, c - 180, false);
			const out = finish(r, c);
			if (out) tub.push(out);
		}
	}

	// 半平面（x ≤ val ／ x ≥ val）で環を切る（Sutherland–Hodgman）。縁上の頂点は「内側」＝接するだけの辺で交点を作らない
	function clipHalf(r, val, less) {
		const out = [], m = r.length, inside = q => less ? q[0] <= val : q[0] >= val;
		for (let i = 0; i < m; i++) {
			const a = r[(i + m - 1) % m], b = r[i], ia = inside(a), ib = inside(b);
			if (ia !== ib) out.push(crossing(a, b, val));
			if (ib) out.push(b);
		}
		return out;
	}

	// 窓を [-180,180] に戻し、重複と「縫い目上の幅ゼロの棘」（SH が縁を出入りするたびに残す）を落として閉じる。
	// 3 点未満・縫い目に張り付いただけの薄片（全頂点が同じ経度）は面にならないので捨てる。
	function finish(r, c) {
		const a = [];
		for (const q of r) {
			const x = q[0] - c, y = q[1], last = a[a.length - 1];
			if (last && last[0] === x && last[1] === y) continue;
			if (a.length >= 2 && onSeam(x) && a[a.length - 1][0] === x && a[a.length - 2][0] === x) a.pop();
			a.push([x, y]);
		}
		while (a.length > 1 && a[0][0] === a[a.length - 1][0] && a[0][1] === a[a.length - 1][1]) a.pop();
		if (a.length < 3) return null;
		let flat = true;
		for (const q of a) if (q[0] !== a[0][0]) { flat = false; break; }
		if (flat) return null;
		a.push([...a[0]]);
		return a;
	}

	// 線は跨ぐたびに分ける。縁の経度は「跨ぐ手前の点がどちら側か」で決まる（旧＝線の先頭の符号で決めており、
	// 経度 0 を渡って反対側から縫い目に達する線では ±180 が逆に付いた）。
	function splitPolyLine(p) {
		let head = p;
		for (;;) {
			let i = 0;
			for (; i < head.length - 1; i++) if (straddle(head[i], head[i + 1])) break;
			if (i >= head.length - 1) return void tub.push(head);
			const [, lat] = crossing(head[i], head[i + 1], head[i][0] < 0 ? -180 : 180);
			const s0 = head[i][0] < 0 ? -180 : 180;
			tub.push(head.slice(0, i + 1).concat([[s0, lat]]));
			head = [[-s0, lat]].concat(head.slice(i + 1));
		}
	}
}
