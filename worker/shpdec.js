import { PBF } from "../src/pbf-base.js";
import { decodeZIP } from "../../native-bucket/src/decodeZIP.js";
const getbbox = r => {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    r.forEach(p => {
        if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
    });
    return [xmin, ymin, xmax, ymax];
};
const includes = (b, pt) => !(b[0] > pt[0] || b[2] < pt[0] || b[1] > pt[1] || b[3] < pt[1]);
const contains = (ring, pt) => {
    let [x, y] = pt, inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        let xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
};
const Polygon = q => {
    let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
    const parts = [], pts = [], polys = [], holes = [];
    for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
    for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
    parts.forEach((st, i) => {
        const ring = pts.slice(st, parts[i + 1]);
        let s = 0; 
        for (let j = 0, l = ring.length; j < l; j++) {
            const a = ring[j], b = ring[(j + 1) % l];
            s += (b[0] - a[0]) * (b[1] + a[1]);
        }
        s >= 0 ? polys.push([ring]) : holes.push(ring);
    });
    const bboxes = polys.map(t => getbbox(t[0]));
    holes.forEach(hole => {
        const pt = hole[0];
        const idx = polys.findIndex((_, i) => includes(bboxes[i], pt) && contains(polys[i][0], pt));
        if (idx !== -1) polys[idx].push(hole);
    });
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
};
self.onmessage = async (e) => {
	const { file, encoding, precision } = e.data; // インターフェースは File
	const entries = await decodeZIP(file); 
	if (!entries) return;
    const keySet = new Set();
	const shpFiles = entries.filter(t => t.name.match(/\.shp$/i));
	const dbs = await Promise.all(shpFiles.map(async f => {
		const base = f.name.replace(/\.shp$/i, "");
		const dbfFile = entries.find(t => t.name === base + ".dbf");
		const cpgFile = entries.find(t => t.name === base + ".cpg");
		if (!dbfFile) return null;
		const shpBuf = new Uint8Array(await f.arrayBuffer());
		const dbfBuf = new Uint8Array(await dbfFile.arrayBuffer());
		const enc = (cpgFile ? await cpgFile.text() : (dbfBuf[29] === 0x13 ? 'sjis' : encoding)).trim();
        const dbf = new DBF(dbfBuf, enc);
        dbf.fields.forEach(field => keySet.add(field.name)); 
		return [new SHP(shpBuf), dbf];
	}));
	const pbf = new PBF({ name: file.name.replace(/\.zip$/, ""), precision });
    pbf.setHead(Array.from(keySet).sort());
	pbf.setBody(() => {
		dbs.filter(t => t).forEach(([shp, dbf]) => {
			while (1) {
				const s = shp.read(), d = dbf.read();
				if (!s || !d) break;
				pbf.setFeature({ type: "Feature", geometry: s, properties: d });
			}
		});
	});
	pbf.close();
    const res = pbf.arrayBuffer;
	self.postMessage({ type: "shpdec", data: res }, [res]);
};