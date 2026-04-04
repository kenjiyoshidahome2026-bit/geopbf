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
	function antimeridianCut(points, isLine = false) {
		const tub = [];
		const is_ring = _ => (_[0][0] == _[_.length - 1][0]) && (_[0][1] == _[_.length - 1][1]);
		const is_clockwise = _ => {
			let sum = 0;
			for (let i = 0; i < _.length - 1; i++) sum += (_[i + 1][0] - _[i][0]) * (_[i + 1][1] + _[i][1]);
			return sum > 0;
		};
		const sum = a => { let s = 0; a.forEach(t => s += t); return s; };
		const north = sum(points.map(t => t[1])) > 0; // 北半球か南半球か？
		const fix = x => x + (x < -180 ? 360 : x > 180 ? -360 : 0);
		points = points.map(t => [fix(t[0]), t[1]]);
		const straddles = p => {
			const a = [[], []];
			for (let i = 0; i < p.length - 1; i += 1) if (p[i][0] * p[i + 1][0] < 0) {
				var flag = ((p[i][0] > 0) ? (p[i + 1][0] < p[i][0] - 180) : (p[i][0] < p[i + 1][0] - 180)) ? 0 : 1;
				a[flag].push(i);
			}
			return a;
		};
		function intersect([x0, y0], [x1, y1], flag = 1) {
			const x = sin((y0 - y1) * d2r) * sin((x0 + x1) / 2 * d2r) * cos((x0 - x1) / 2 * d2r)
					- sin((y0 + y1) * d2r) * cos((x0 + x1) / 2 * d2r) * sin((x0 - x1) / 2 * d2r);
			const z = cos(y0 * d2r) * cos(y1 * d2r) * sin((x0 - x1) * d2r);
			return (flag * z < 0 ? -1 : 1) * atan2(x, sqrt(z * z)) / d2r;
		}
		const poleFilter = a => {
			const n = a.length, pole = north ? 90 : -90;
			return (abs(a[0][0] - a[1][0]) > 179) ?
				[].concat(a.slice(0, 1), [[a[0][0], pole], [(a[0][0] + a[1][0]) / 2, pole], [a[1][0], pole]], a.slice(1)) :
				(abs(a[n - 1][0] - a[n - 2][0]) > 179) ?
				[].concat(a.slice(0, n - 1), [[a[n - 2][0], pole], [(a[n - 1][0] + a[n - 2][0]) / 2, pole], [a[n - 1][0], pole]], a.slice(n - 1)) : a;
		};
		((is_ring(points) && !isLine) ? splitPolygon : splitPloyLine)(points);
		return tub;
		function splitPolygon(p) {
			is_clockwise(p) || p.reverse();
			const crossings = straddles(p);
			if (crossings[0].length === 0) { tub.push([p]); return; }
			var [start, end] = crossings[0].map(i => [intersect(p[i], p[i + 1], 1), i]).sort(([p], [q]) => north ? p - q : q - p);
			var reverse = crossings[1].map(i => [intersect(p[i], p[i + 1], -1), i]).sort(([p], [q]) => north ? q - p : p - q)[0];
			cut(start, 1, end || reverse, end ? 1 : 0);
			cut(end || reverse, end ? 1 : 0, start, 1);
			function cut(start, s, end, e) {
				const a = [];
				let i = (start[1] < p.length - 2) ? start[1] + 1 : 0;
				const degree = 180 * (p[i][0] < 0 ? -1 : 1);
				a.push([s ? degree : 0, start[0]]); a.push(p[i]);
				while (i !== end[1]) a.push(p[i = (i < p.length - 2) ? i + 1 : 0]);
				a.push([e ? degree : 0, end[0]]); a.push(a[0]);
				splitPolygon(s & e ? a : poleFilter(a));
			}
		}
		function splitPloyLine(p) {
			let i = 0;
			for (; i < p.length - 1; i++) if (p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) break;
			if (i == p.length - 1) { tub.push(p); return; }
			var lat = intersect(p[i], p[i + 1], 1);
			tub.push(p.slice(0, i + 1).concat([[180 * (p[0][0] < 0 ? -1 : 1), lat]]));
			splitPloyLine([[180 * (p[0][0] < 0 ? 1 : -1), lat]].concat(p.slice(i + 1)));
		}
	}
}