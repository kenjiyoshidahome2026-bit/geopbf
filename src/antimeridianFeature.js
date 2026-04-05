import {antimeridianCut} from "./antimeridianCut.js";
export function antimeridianFeature(feature) {
	const { PI, sin, cos, sqrt, asin, atan2, floor, round, abs } = Math;
	const d2r = PI / 180, r2d = 180 / PI;
	const p = feature.properties = feature.properties || {}, geom = feature.geometry, type = geom.type;
	if (type === "Point" || type === "MultiPoint") return feature;
	let c = geom.coordinates, xmin = Infinity, xmax = -Infinity;
	const calcBbox = a => {
		if (typeof a[0] !== 'number') return a.forEach(calcBbox);
		if (a[0] < xmin) xmin = a[0]; if (a[0] > xmax) xmax = a[0];
	};
	calcBbox(c);
	if (xmin >= -180 && xmax <= 180 && xmax - xmin < 180) return feature;
	c = type.startsWith("Multi") ? c : [c];
	if (type.includes("LineString")) {
		c = c.flatMap(t => antimeridianCut(t, true));
		feature.geometry = { type: c.length > 1 ? "MultiLineString" : "LineString", coordinates: c.length > 1 ? c : c[0] };
	} else if (type.includes("Polygon")) {
		c = c.flatMap(poly => {
			const a = antimeridianCut(poly[0]);
			if (a.length === 1 || poly.length === 1) return a.length === 1 ? [poly] : a;
			const hole = poly.slice(1).flatMap(antimeridianCut);
			return a.map(t => subFeature({ geometry: { type: "Polygon", coordinates: t }, properties: p }, { geometry: { type: "MultiPolygon", coordinates: hole } }));
		});
		feature.geometry = { type: c.length > 1 ? "MultiPolygon" : "Polygon", coordinates: c.length > 1 ? c : c[0] };
	}
	return toClockwise(feature);
	////-----------------------------------------------------------------------------------------------------
	function greatCircleArc(p1, p2, n) {
		const L1 = p1[0] * d2r, l1 = p1[1] * d2r, L2 = p2[0] * d2r, l2 = p2[1] * d2r;
		const dist = 2 * asin(sqrt(sin((l1 - l2) / 2) ** 2 + cos(l1) * cos(l2) * sin((L1 - L2) / 2) ** 2));
		return Array.from({ length: n - 1 }, (_, i) => {
			const f = (i + 1) / n, A = sin((1 - f) * dist) / sin(dist), B = sin(f * dist) / sin(dist);
			const x = A * cos(l1) * cos(L1) + B * cos(l2) * cos(L2), y = A * cos(l1) * sin(L1) + B * cos(l2) * sin(L2);
			return [atan2(y, x) * r2d, atan2(A * sin(l1) + B * sin(l2), sqrt(x * x + y * y)) * r2d];
		});
	}
	function dividePoints(f, tub) {
		const arr = f.geometry.type.startsWith("Multi") ? f.geometry.coordinates : [f.geometry.coordinates];
		return arr.map(rngs => rngs.map(r => r.reduce((q, p1, i) => {
			if (!i) return [p1];
			const p0 = r[i - 1], n = 1 + floor(abs(p0[0] - p1[0]));
			if (n > 2) greatCircleArc(p0, p1, n).forEach(p => (tub[`${p[0]},${p[1]}`] = 1, q.push(p)));
			return q.push(p1), q;
		}, [])));
	}
	function subFeature(P, Q) {
		const tub = {}, bP = getBbox(P), bQ = getBbox(Q);
		if (bP[2] < bQ[0] || bP[0] > bQ[2] || bP[3] < bQ[1] || bP[1] > bQ[3]) return P;
		let pA = dividePoints(P, tub);
		let qA = dividePoints(Q, tub).flatMap(t => antimeridianCut(t[0]).map(cut => [cut[0], ...t.slice(1)]));
		pA = pA.flatMap(t => polygonClipping.xor([t], polygonClipping.intersection([t], qA)));
		const coords = pA.map(v => v.map(t => t.filter(u => !tub[`${u[0]},${u[1]}`])));
		return coords.length ? toClockwise({ geometry: { type: coords.length > 1 ? "MultiPolygon" : "Polygon", coordinates: coords.length > 1 ? coords : coords[0] }, properties: P.properties }) : null;
	}
	function getBbox(f) {
		if (f.properties?.bbox) return f.properties.bbox;
		let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
		const calc = a => {
			if (typeof a[0] === 'number') {
				if (a[0] < bx1) bx1 = a[0]; if (a[0] > bx2) bx2 = a[0];
				if (a[1] < by1) by1 = a[1]; if (a[1] > by2) by2 = a[1];
			} else a.forEach(calc);
		};
		calc(f.geometry.coordinates);
		return [bx1, by1, bx2, by2];
	}
	function toClockwise(f) {
		const fix = c => c.forEach((r, i) => {
			let s = 0; for (let j = 0; j < r.length - 1; j++) s += (r[j + 1][0] - r[j][0]) * (r[j + 1][1] + r[j][1]);
			if ((!i && s < 0) || (i && s > 0)) r.reverse();
		});
		const rw = t => t.type === "Polygon" ? fix(t.coordinates) : t.type === "MultiPolygon" && t.coordinates.forEach(fix);
		f.type === "FeatureCollection" ? f.features.forEach(x => rw(x.geometry)) : rw(f.geometry || f);
		return f;
	}
}