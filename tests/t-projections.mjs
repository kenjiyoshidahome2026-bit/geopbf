#!/usr/bin/env node
// t-projections: modules/projections.js の図法と、それを使う extension/preview.js の描き口を Node で検定する。
//   ・Equal Earth（geoEqualEarth）＝等積であること（|∂(x,y)/∂(λ,φ)| = cos φ）・逆変換が戻ること・
//     図郭（±180°/±90°）の寸法・中央経線を振っても縫い目が東縁で反転しないこと（wrap は +180 を保つ）
//   ・preview(pbf, canvas, props)＝canvas を渡した時に props が生き残ること（旧＝isObject で canvas を props と
//     取り違え、projection も fill も黙って捨てていた＝多層の地図が真っ白になった・2026-09-17）
globalThis.ImageData ??= class ImageData { };   // Node に無い（pbf-base のエンコード経路が参照）
import { geoEqualEarth, geoEquirectangular, geoMercator, geoOrthographic } from "../src/modules/projections.js";
import { preview } from "../src/extension/preview.js";
import { GeoPBF } from "../src/pbf.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- Equal Earth: 等積（ヤコビアンが cos φ）----
{
	const p = geoEqualEarth().scale(1).translate([0, 0]);
	const h = 1e-5, r2 = (Math.PI / 180) ** 2;
	let worst = 0;
	for (const [lon, lat] of [[0, 0], [40, 30], [-100, 60], [10, -80], [170, 85], [-45, -15]]) {
		const [ax] = p([lon + h, lat]), [bx] = p([lon - h, lat]);
		const [, cy] = p([lon, lat + h]), [, dy] = p([lon, lat - h]);
		const J = Math.abs(((ax - bx) / (2 * h)) * ((cy - dy) / (2 * h))) / r2;   // ∂y/∂λ = 0（擬円筒）＝対角積だけ
		worst = Math.max(worst, Math.abs(J / Math.cos(lat * Math.PI / 180) - 1));
	}
	ok(worst < 1e-6, `Equal Earth は等積（|J|/cos φ の最大ずれ ${worst.toExponential(1)}）`);
}

// ---- Equal Earth: 逆変換・図郭・縫い目 ----
{
	const p = geoEqualEarth().scale(1).translate([0, 0]);
	let worst = 0;
	for (const q of [[0, 0], [139.7, 35.7], [-77, 38.9], [-120, 60], [30, -45], [179.9, -89.9], [-12.3, 71.2]]) {
		const b = p.invert(p(q));
		worst = Math.max(worst, Math.abs(b[0] - q[0]), Math.abs(b[1] - q[1]));
	}
	ok(worst < 1e-7, `Equal Earth の invert が戻る（最大ずれ ${worst.toExponential(1)}°）`);

	const [bx, by] = p.bounds();
	ok(near(bx, 2.7066299837, 1e-9) && near(by, 1.3173627592, 1e-9), `図郭の半幅/半高 = ${bx.toFixed(6)} / ${by.toFixed(6)}（原論文の係数どおり）`);
	ok(near(p([180, 0])[0], bx) && near(p([-180, 0])[0], -bx), "λ=±180° が図郭の東西端（+180 を -180 へ畳まない）");
	ok(near(p([180, 90])[0] / p([180, 0])[0], 0.5924, 1e-4), "極線の長さは赤道の 0.59 倍（極は点ではなく線）");
	ok(near(p([0, 90])[1], -by) && near(p([0, -90])[1], by), "φ=±90° が図郭の上下端（y は画面座標＝下向き）");

	const q = geoEqualEarth().scale(1).translate([0, 0]).rotate([-150, 0, 0]);   // 中央経線 150°E
	ok(near(q([150, 0])[0], 0), "rotate で中央経線を振れる（150°E が図の中心）");
	// 経度は畳まない＝縫い目の向こうは図郭の外へ出る（縁で折り返すのは描き手＝preview の repeat の仕事）
	ok(near(q([-30, 0])[0], -bx) && q([-31, 0])[0] < -bx, `振った先の縫い目（-30°）の外は図郭の外（${q([-31, 0])[0].toFixed(3)} < ${(-bx).toFixed(3)}）`);

	const f = geoEqualEarth().fitExtent([[0, 0], [1000, 500]]);
	ok(near(f([-180, 0])[0], 0) && near(f([180, 0])[0], 1000) && near(f([0, 0])[1], 250), "fitExtent が幅いっぱいに収める");
}

// ---- 他の図法も往復する（回帰の網）----
for (const [name, p] of [["equirectangular", geoEquirectangular()], ["mercator", geoMercator()], ["orthographic", geoOrthographic()]]) {
	const q = [39.7, 35.7], b = p.invert(p(q));   // 正射は裏側が null＝中心（rotate 既定 [0,0,0]）の見える側で検する
	ok(Math.abs(b[0] - q[0]) < 1e-6 && Math.abs(b[1] - q[1]) < 1e-6, `${name}: invert が戻る`);
}

// ---- preview(): canvas を渡しても props が効く ----
{
	const fc = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]] } },
	]};
	const pbf = await new GeoPBF({ name: "t-proj" }).set(fc);
	const calls = [];
	const ctx = new Proxy({}, {
		get: (_, k) => k === "moveTo" || k === "lineTo" ? ((x, y) => calls.push([k, x, y]))
			: (...a) => calls.push([String(k), ...a]),
		set: (t, k, v) => (calls.push(["set:" + String(k), v]), true),
	});
	const canvas = { width: 800, height: 400, getContext: () => ctx };
	preview(pbf, canvas, { projection: "equalearth", bbox: [-180, -90, 180, 90], fill: "#123456", stroke: "#654321", lineWidth: 2, dpr: 1 });
	const styles = calls.filter(c => c[0].startsWith("set:")).map(c => `${c[0]}=${c[1]}`);
	ok(styles.includes("set:fillStyle=#123456") && styles.includes("set:strokeStyle=#654321"),
		`canvas を渡しても props の色が効く（${styles.join(" ")}）`);
	ok(calls.some(c => c[0] === "fill") && calls.some(c => c[0] === "stroke"), "面は fill と stroke の両方が走る");

	// 描かれた座標が geoEqualEarth と一致する（preview 内の scale/translate ごと突き合わせる）
	const pts = calls.filter(c => c[0] === "moveTo" || c[0] === "lineTo").map(c => [c[1], c[2]]);
	const proj = geoEqualEarth().rotate([0, 0, 0]).scale(Math.min(800 / 360, 400 / 180) * (180 / Math.PI) * 0.9 / geoEqualEarth().k).translate([400, 200]);
	const [ex, ey] = proj([-10, -10]);
	ok(pts.length >= 4 && near(pts[0][0], ex, 1e-6) && near(pts[0][1], ey, 1e-6),
		`最初の頂点が Equal Earth の像（描画 ${pts[0]?.map(v => v.toFixed(2))} / 期待 ${[ex, ey].map(v => v.toFixed(2))}）`);
}

// ---- preview(): repeat＝±360° ずらして重ね描き＋図郭で切り抜き ----
{
	// 中央経線 150°E（bbox の中心）から見て西の縫い目の外にある地物＝+360° の回で図の東端に出る
	const far = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-40, 0], [-35, 0], [-35, 5], [-40, 5], [-40, 0]]] } },
	]};
	const pbf = await new GeoPBF({ name: "t-rep" }).set(far);
	const run = (repeat) => {
		const calls = [];
		const ctx = new Proxy({}, { get: (_, k) => (...a) => calls.push([String(k), ...a]), set: () => true });
		preview(pbf, { width: 800, height: 400, getContext: () => ctx }, { projection: "equalearth", bbox: [-30, -90, 330, 90], dpr: 1, repeat });
		return calls;
	};
	const off = run(false), on = run(true);
	ok(!off.some(c => c[0] === "moveTo"), "repeat 無し＝縫い目の外の地物は描かれない（図郭の外）");
	const after = on.slice(on.findIndex(c => c[0] === "clip") + 1);   // 図郭（clip 用のパス）の点は数えない
	const pts = after.filter(c => c[0] === "moveTo" || c[0] === "lineTo").map(c => [c[1], c[2]]);
	ok(pts.length >= 4 && pts.every(p => p[0] > 400), `repeat 有り＝東端に回り込んで描かれる（x ${pts[0]?.[0].toFixed(0)} > 中心 400）`);
	ok(on.some(c => c[0] === "clip") && on.some(c => c[0] === "save") && on.some(c => c[0] === "restore"), "図郭で切り抜く（save/clip/restore）");
}

console.log(fails ? `\n${fails} test(s) failed` : "\nall passed");
process.exit(fails ? 1 : 0);
