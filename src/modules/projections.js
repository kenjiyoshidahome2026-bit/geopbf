const { PI, abs, max, min, sin, asin, cos, sqrt, log, tan, atan, atan2, exp } = Math, rad = PI / 180;

export function geoOrthographic() {
	let r = [0, 0, 0], s = 150, t = [480, 250], sφ, cφ, sγ, cγ;
	const up = () => (sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad));
	const p = ([ln, lt]) => {
		const l = (ln + r[0]) * rad, φ = lt * rad, cp = cos(φ), sp = sin(φ), cl = cos(l), sl = sin(l);
		const x = cp * sl, y = sp, z = cp * cl, yr = y * cφ + z * sφ, zr = z * cφ - y * sφ;
		return zr < 0 ? null : [t[0] + s * (x * cγ - yr * sγ), t[1] - s * (x * sγ + yr * cγ)];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s, y = (t[1] - py) / s, xr = x * cγ + y * sγ, yr = -x * sγ + y * cγ, ρ2 = xr * xr + yr * yr;
		if (ρ2 > 1) return null;
		const zr = sqrt(1 - ρ2), ln = atan2(xr, zr * cφ + yr * sφ) / rad - r[0];
		return [((ln + 180) % 360 + 360) % 360 - 180, asin(max(-1, min(1, yr * cφ - zr * sφ))) / rad];
	};
	p.rotate = v => v === undefined ? r : (r = v, up(), p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w, h) / 2, t = [e[0][0] + w / 2, e[0][1] + h / 2], up(), p;
	};
	return up(), p;
}

export function geoMercator() {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const p = ([ln, lt]) => {
		const x = (ln + r[0]) * rad;
		const y = log(tan(PI / 4 + (lt + r[1]) * rad / 2));
		return [t[0] + s * x, t[1] - s * y];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s;
		const y = (t[1] - py) / s;
		return [x / rad - r[0], 2 * atan(exp(y)) / rad - 90 - r[1]];   // 旧＝`90/180*360`＝180 を引いており、逆変換の緯度が 90° ずれていた（2026-09-17・t-projections で発覚）
	};
	p.rotate = v => v === undefined ? r : (r = v, p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w, h) / (2 * PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}
export function geoEquirectangular() {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const p = ([ln, lt]) => {
		const x = (ln + r[0]) * rad;
		const y = (lt + r[1]) * rad;
		return [t[0] + s * x, t[1] - s * y];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s;
		const y = (t[1] - py) / s;
		return [x / rad - r[0], y / rad - r[1]];
	};
	p.rotate = v => v === undefined ? r : (r = v, p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
		return s = min(w / (2 * PI), h / PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}
// Equal Earth（Šavrič–Patterson–Jenny 2018）＝擬円筒の等積図法。世界全図の既定になりつつある形で、
// 緯線は水平な直線・極は点でなく線・面積は球と厳密に比例する（ヤコビアン |∂(x,y)/∂(λ,φ)| = cos φ）。
// 係数 A1〜A4 は原論文のまま。sin θ = (√3/2)·sin φ を通して y = A1θ + A2θ³ + A3θ⁷ + A4θ⁹、
// x = 2√3·λ·cos θ / (3·dy/dθ)。逆変換は y から θ を Newton で解く（原論文の手）。
// 経度は ±180 に畳む＝中央経線 r[0] を振っても図の外へ飛ばない（跨ぐ環の切断は encoder の
// antimeridian 切断の仕事＝ここでは点ごとの畳み込みだけ）。緯度の回転 r[1] は素の加算（他の擬円筒と同じ約束）。
export function geoEqualEarth() {
	let r = [0, 0, 0], s = 150, t = [480, 250];
	const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = sqrt(3) / 2, R3 = 2 * sqrt(3);
	const fy = (th) => { const t2 = th * th; return th * (A1 + t2 * (A2 + t2 * t2 * (A3 + A4 * t2))); };          // A1θ + A2θ³ + A3θ⁷ + A4θ⁹
	const dy = (th) => { const t2 = th * th, t6 = t2 * t2 * t2; return A1 + 3 * A2 * t2 + 7 * A3 * t6 + 9 * A4 * t6 * t2; };   // dy/dθ
	const wrap = x => x === 180 ? 180 : ((((x + 180) % 360) + 360) % 360) - 180;   // +180 は保つ（-180 へ書き換えると図郭の東縁が西縁へ飛ぶ）
	// 経度は畳まない＝中央経線を振ると図郭の外へ出る点がそのまま外に出る。縁で折り返すのは描き手の仕事
	// （preview の repeat＝±360° ずらして重ね描き＋図郭で切り抜き）。ここで畳むと、縫い目を跨ぐ環が
	// 図の反対側へ飛んで世界を横断する帯になる。
	const p = ([ln, lt]) => {
		const l = (ln + r[0]) * rad, th = asin(M * sin(max(-90, min(90, lt + r[1])) * rad));
		return [t[0] + s * R3 * l * cos(th) / (3 * dy(th)), t[1] - s * fy(th)];
	};
	p.invert = ([px, py]) => {
		const x = (px - t[0]) / s, y = (t[1] - py) / s;
		let th = y;                                    // y は θ に単調（dy/dθ ≥ A1 − |3A2| > 0）＝Newton は数回で収束
		for (let i = 0; i < 24; i++) { const d = (fy(th) - y) / dy(th); th -= d; if (abs(d) < 1e-12) break; }
		const ln = 3 * x * dy(th) / (R3 * cos(th)) / rad - r[0];
		return [wrap(ln), asin(max(-1, min(1, sin(th) / M))) / rad - r[1]];
	};
	p.rotate = v => v === undefined ? r : (r = v, p);
	p.scale = v => v === undefined ? s : (s = v, p);
	p.translate = v => v === undefined ? t : (t = v, p);
	p.k = R3 / (3 * A1);                               // 赤道での x/λ（<1＝同じ scale でも経緯度線形の図法より横に縮む・preview の寸法合わせ用）
	p.bounds = () => [PI * p.k, fy(PI / 3)];           // 図郭の半幅・半高（scale=1 のとき）＝λ=±180°・φ=±90°
	p.fitExtent = (e) => {
		const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1], [bx, by] = p.bounds();
		return s = min(w / (2 * bx), h / (2 * by)), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
	};
	return p;
}
