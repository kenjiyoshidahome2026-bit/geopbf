import { PBF } from "../pbf-base.js";
import { nearPoint as _nearPointLogic } from "./nearPoint.js";

const r2d = Math.PI / 180;

export const centroid = (self, i) => {
    const geom = self.getGeometry(i); let x = 0, y = 0, count = 0;
    const add = c => { if (typeof c[0] === 'number') { x += c[0]; y += c[1]; count++; } else c.forEach(add); };
    if (geom.type === "GeometryCollection") geom.geometries.forEach(g => add(g.coordinates || []));
    else add(geom.coordinates || []);
    return count ? [Math.round((x / count) * self.e) / self.e, Math.round((y / count) * self.e) / self.e] : [0, 0];
};

export const area = (self, i) => {
    const geom = self.getGeometry(i), R = 6378137;
    const ringArea = coords => {
        let area = 0, n = coords.length;
        if (n > 2) { for (let j = 0; j < n; j++) { let p1 = coords[j === 0 ? n - 1 : j - 1], p2 = coords[j], p3 = coords[j === n - 1 ? 0 : j + 1]; area += (p3[0] - p1[0]) * r2d * Math.sin(p2[1] * r2d); } }
        return Math.abs(area * R * R / 2);
    };
    let total = 0;
    const calc = (g) => {
        if (g.type === "Polygon") { total += ringArea(g.coordinates[0]); for (let j = 1; j < g.coordinates.length; j++) total -= ringArea(g.coordinates[j]); }
        else if (g.type === "MultiPolygon") { g.coordinates.forEach(poly => { total += ringArea(poly[0]); for (let j = 1; j < poly.length; j++) total -= ringArea(poly[j]); }); }
        else if (g.type === "GeometryCollection") g.geometries.forEach(calc);
    };
    calc(geom); return Math.round(total);
};

export const contain = (self, [px, py], getOneFlag) => {
    const out = b => (px < b[0] || px > b[2] || py < b[1] || py > b[3]);
    if (out(self.bbox)) return getOneFlag ? -1 : [];
    const rayCast = ring => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    };
    const checkPoly = coords => { if (!rayCast(coords[0])) return false; for (let i = 1; i < coords.length; i++) if (rayCast(coords[i])) return false; return true; };
    const isContain = n => {
        const fmap = self.fmap[n], type = fmap[2]; if (type < 4 || out(self.getBbox(n))) return false;
        const geom = self.getGeometry(n);
        if (type === 4) return checkPoly(geom.coordinates);
        if (type === 5) return geom.coordinates.some(checkPoly);
        return type === 6 && geom.geometries.some(g => (g.type === "Polygon" ? checkPoly(g.coordinates) : (g.type === "MultiPolygon" ? g.coordinates.some(checkPoly) : false)));
    };
    const a = []; for (let i = 0; i < self.length; i++) if (isContain(i)) { if (getOneFlag) return i; a.push(i); }
    return getOneFlag ? -1 : a;
};

export const nearPoint = (self, pt, maxCount, maxDistance) => {
    if (!self.kdbush) {
        const length = self.count[0], kdbush = self.kdbush = new KDBush(length), index = self.kdIndex = [];
        const add = (n, coords) => { kdbush.add(coords[0], coords[1]); index.push(n); };
        self.each(n => {
            const fmap = self.fmap[n], type = fmap[2];
            if (type === 0) add(n, self.getGeometry(n).coordinates);
            else if (type === 1) self.getGeometry(n).coordinates.forEach(t => add(n, t));
            else if (type === 6) self.getGeometry(n).geometries.forEach(g => (g.type === "Point" ? add(n, g.coordinates) : (g.type === "MultiPoint" ? g.coordinates.forEach(t => add(n, t)) : null)));
        });
        kdbush.finish();
    }
    return _nearPointLogic(self.kdbush, pt[0], pt[1], maxCount, maxDistance).map(t => self.kdIndex[t]);
};