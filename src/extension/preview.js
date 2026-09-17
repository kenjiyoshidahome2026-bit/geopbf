import { isObject } from "../modules/utility.js";
import { geoOrthographic, geoMercator, geoEquirectangular, geoEqualEarth } from "../modules/projections.js";

export function preview(self, canvas, props = {}) {
	if (!self.length && !props.outline) return null;   // 地物ゼロでも outline だけは描ける（図郭は図法の産物＝データではない）
	// canvas も props も「オブジェクト」＝isObject では見分かない（HTMLCanvasElement/OffscreenCanvas を渡すと
	// props として飲み込まれ、projection も fill も黙って捨てられていた）。描き口があるかで判定する。
	if (!(canvas && typeof canvas.getContext === "function")) { if (isObject(canvas)) props = canvas; canvas = null; }
	const dpr = props.dpr || 1;
	const ownCanvas = !canvas;
	const size = props.size || 512;
	const width  = canvas ? canvas.width  / dpr : size;
	const height = canvas ? canvas.height / dpr : size;

	const projection = props.projection || "";
	const proj = projection.match(/orthographic/i) ? geoOrthographic() : projection.match(/mercator/i) ? geoMercator() : projection.match(/equal.?earth|eqearth/i) ? geoEqualEarth() : geoEquirectangular();
	let bbox = props.bbox || self.bbox || [-180, -90, 180, 90];   // 地物ゼロ（outline だけ）でも図郭は描ける
	// antimeridian-split datasets can have bbox spanning ~360° even when features don't individually
	// cross the antimeridian (e.g. western Alaska polygons at -180° + Near Islands at +173°E).
	// Fix: 3D-vector centroid of small-span features → re-wrap all bbox coords relative to that
	// centroid longitude so the tight geographic extent is computed in a consistent frame.
	if (!props.bbox && bbox[2] - bbox[0] > 180) {
		const d2r = Math.PI / 180;
		let sx = 0, sy = 0, sz = 0, nc = 0;
		self.forEach(n => {
			const b = self.getBbox(n);
			if (b[2] - b[0] > 180) return;
			const lng = (b[0] + b[2]) / 2, lat = (b[1] + b[3]) / 2;
			sx += Math.cos(lat * d2r) * Math.cos(lng * d2r);
			sy += Math.cos(lat * d2r) * Math.sin(lng * d2r);
			sz += Math.sin(lat * d2r);
			nc++;
		});
		if (nc > 0) {
			const norm = Math.sqrt(sx * sx + sy * sy + sz * sz);
			const cLng = norm > 0.01 ? Math.atan2(sy, sx) / d2r : 0;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			self.forEach(n => {
				const b = self.getBbox(n);
				if (b[2] - b[0] > 180) return;
				let bx0 = b[0], bx1 = b[2];
				const bc = (bx0 + bx1) / 2;
				if (bc - cLng > 180) { bx0 -= 360; bx1 -= 360; }
				else if (cLng - bc > 180) { bx0 += 360; bx1 += 360; }
				if (bx0 < x0) x0 = bx0;
				if (b[1] < y0) y0 = b[1];
				if (bx1 > x1) x1 = bx1;
				if (b[3] > y1) y1 = b[3];
			});
			if (x0 < Infinity) {
				// Preserve lonSpan but shift the center to the 3D centroid cLng.
				const shift = cLng - (x0 + x1) / 2;
				bbox = [x0 + shift, y0, x1 + shift, y1];
			}
		}
	}
	const pbf = self.pbf, e = self.e;
	const radius = props.radius || 1.5;

	const cx = (bbox[0] + bbox[2]) / 2;
	const cy = (bbox[1] + bbox[3]) / 2;
	const lonSpan = Math.max(bbox[2] - bbox[0], 1e-3);
	const latSpan = Math.max(bbox[3] - bbox[1], 1e-3);
	// 図法の赤道での x/λ（proj.k・経緯度線形の図法は 1）で割る＝Equal Earth のように x が λ に比例しない図法でも
	// 同じ bbox が同じ幅に収まる（旧＝k を見ないので Equal Earth だけ 86% に縮んで描かれた）。
	const scale = Math.min(width / lonSpan, height / latSpan) * (180 / Math.PI) * 0.9 / (proj.k || 1);
	proj.rotate([-cx, -cy, 0]).scale(scale).translate([width / 2, height / 2]);
	if (props.scale) proj.scale(props.scale);

	const offcanvas = ownCanvas ? new OffscreenCanvas(width * dpr, height * dpr) : canvas;
	const ctx = offcanvas.getContext("2d");
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 同じ canvas へ層を重ねて呼ぶ（多層の地図）と ctx.scale は前回の変換に積まれる＝毎回置き換える

	if (props.background) { ctx.fillStyle = props.background; ctx.fillRect(0, 0, width, height); }

	const out = b => (bbox[0] > b[2] || bbox[1] > b[3] || bbox[2] < b[0] || bbox[3] < b[1]);
	const minDist = props.minDist || 1;
	const minDist2 = minDist * minDist;

	// 図郭＝いまの窓（中央経線 ±180°・bbox の緯度幅）の輪郭。図法が決めるものでデータではないので、ここで作る。
	// repeat の切り抜きと props.outline（海の塗り／外枠）で共用する。
	const framePath = () => {
		const cap = projection.match(/mercator/i) ? 85 : 90;             // メルカトルの極は無限遠＝図郭は緯度で頭打ち
		const lat0 = Math.max(bbox[1], -cap), lat1 = Math.min(bbox[3], cap);
		ctx.beginPath();
		let i = 0;
		const edge = (ln, lt) => { const q = proj([ln, lt]); if (q) ctx[i++ ? "lineTo" : "moveTo"](q[0], q[1]); };
		for (let t = lat0; t <= lat1; t++) edge(cx - 180, t);
		for (let t = -180; t <= 180; t += 2) edge(cx + t, lat1);
		for (let t = lat1; t >= lat0; t--) edge(cx + 180, t);
		for (let t = 180; t >= -180; t -= 2) edge(cx + t, lat0);
		ctx.closePath();
	};
	// outline={fill,stroke,lineWidth}＝図郭を塗る（地物の下）／縁取る（地物の上）。海の色と外枠はこれで足りる
	const outline = props.outline || null;
	if (outline && outline.fill) { framePath(); ctx.fillStyle = outline.fill; ctx.fill(); }

	// repeat＝世界を ±360° ずらして重ね描きし、図郭で切り抜く。中央経線を振った世界図で、縫い目を跨ぐ地物が
	// 片側で途切れず、反対の縁から続けて出る＝**幾何を切り直さずに**振れる（切るのは encoder の仕事であって、
	// 図を描くだけならこちらが速い：切り直しの再エンコードが要らない）。x が経度に単調な図法（擬円筒・正距円筒・
	// メルカトル）でだけ意味を持つので、呼び手が明示した時だけ効かせる。
	const repeat = !!props.repeat;
	if (repeat) { ctx.save(); framePath(); ctx.clip(); }

	ctx.lineWidth = props.lineWidth || 1 / dpr;
	ctx.fillStyle = props.fill || "#ccc";
	ctx.strokeStyle = props.stroke || "#000";

	for (const off of repeat ? [0, -360, 360] : [0]) {
	if (off) proj.rotate([-cx + off, -cy, 0]);
	self.forEach((n, map) => {
		const b = self.getBbox(n);
		if (out([b[0] + off, b[1], b[2] + off, b[3]])) return;
		ctx.beginPath();

		const drawCoords = (pos, type) => {
			pbf.pos = pos;
			let lens = [];

			pbf.readMessage(tag => {
				if (tag === 9) pbf.readPackedVarint(lens);
				else if (tag === 10) {
					const end = pbf.readVarint() + pbf.pos;
					let p = [0, 0];
					const readNext = () => {
						p[0] += pbf.readSVarint();
						p[1] += pbf.readSVarint();
						return proj([p[0] / e, p[1] / e]);
					};

					if (type === 0) {
						const pt = readNext();
						if (pt) { ctx.moveTo(pt[0] + radius, pt[1]); ctx.arc(pt[0], pt[1], radius, 0, Math.PI * 2); }
					} else if (type === 1) {
						while (pbf.pos < end) {
							const pt = readNext();
							if (pt) { ctx.moveTo(pt[0] + radius, pt[1]); ctx.arc(pt[0], pt[1], radius, 0, Math.PI * 2); }
						}
					} else if (type === 2) {
						let i = 0;
						while (pbf.pos < end) {
							const pt = readNext();
							if (pt) ctx[i++ ? "lineTo" : "moveTo"](...pt);
						}
					} else if (type === 3) {
						// lens = [nPts_sub0, nPts_sub1, ...] (flat, one entry per sub-line)
						// each sub-line is diff-encoded from [0,0] independently
						for (let si = 0; si < lens.length; si++) {
							p[0] = 0; p[1] = 0;
							let i = 0;
							for (let pi = 0; pi < lens[si]; pi++) {
								const pt = readNext();
								if (pt) ctx[i++ ? "lineTo" : "moveTo"](...pt);
							}
						}
					} else {
						let pos = 0;
						const drawRing = (n) => {
							let pRing = [0, 0], lx, ly, i = 0;
							while (n-- > 0) {
								pRing[0] += pbf.readSVarint();
								pRing[1] += pbf.readSVarint();
								const pt = proj([pRing[0] / e, pRing[1] / e]);
								if (!pt) continue;
								if (i === 0) { ctx.moveTo(...pt); lx = pt[0]; ly = pt[1]; i++; continue; }
								const dx = pt[0] - lx, dy = pt[1] - ly;
								if (dx*dx + dy*dy < minDist2 && n > 0) continue;
								ctx.lineTo(...pt); lx = pt[0]; ly = pt[1];
							}
							ctx.closePath();
						};
						if (type === 4) lens.forEach(drawRing);
						else {
							for (let i = 0; i < lens[0]; i++) {
								const nRings = lens[++pos];
								for (let j = 0; j < nRings; j++) drawRing(lens[++pos]);
							}
						}
					}
				}
			});
		};

		if (map[2] === 6) map[3].forEach((t, i) => drawCoords(t, map[4][i]));
		else drawCoords(map[1], map[2]);

		if (map[2] < 2 || map[2] > 3) ctx.fill();
		ctx.stroke();
	});
	}
	if (repeat) { proj.rotate([-cx, -cy, 0]); ctx.restore(); }
	if (outline && outline.stroke) { framePath(); ctx.strokeStyle = outline.stroke; ctx.lineWidth = outline.lineWidth || props.lineWidth || 1 / dpr; ctx.stroke(); }

	return ownCanvas ? offcanvas.transferToImageBitmap() : canvas;
}
