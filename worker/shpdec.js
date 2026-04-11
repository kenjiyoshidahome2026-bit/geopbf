import { PBF } from "../src/pbf-base.js";
import { decodeZIP } from "../../native-bucket/src/decodeZIP.js";

const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
const thenMap = async (a, f) => {
	const r = [];
	for (let i = 0; i < a.length; i++) r.push(await f(a[i], i).catch(console.error));
	return r;
};

class DBF {
	constructor(s, enc) {
		const h = view(s.subarray(0, 32)), l = h.getUint16(8, true);
		const b = view(s.subarray(32, l));
		this.src = s.subarray(l); this.len = h.getUint16(10, true);
		this.dec = new TextDecoder(enc); this.fields = [];
		for (let n = 0; b.getUint8(n) !== 0x0d; n += 32) {
			let j = 0; while (j < 11 && b.getUint8(n + j) !== 0) j++;
			this.fields.push({
				name: this.dec.decode(new Uint8Array(b.buffer, b.byteOffset + n, j)).trim(),
				type: String.fromCharCode(b.getUint8(n + 11)),
				length: b.getUint8(n + 16)
			});
		}
	}
	read() {
		const val = this.src.subarray(0, this.len); this.src = this.src.subarray(this.len);
		if (!val || val[0] === 0x1a) return null;
		const q = {}, parse = {
			B: v => +v.trim(), F: v => +v.trim(), N: v => +v.trim(),
			L: v => /^[yt]$/i.test(v), D: v => new Date(v.replace(/(....)(..)(..)/, "$1-$2-$3")),
			C: v => { v = v.trim().replace(/\x00/g, ""); return v.length ? v : null; }
		};
		let i = 1;
		this.fields.forEach(f => {
			const raw = this.dec.decode(val.subarray(i, i += f.length));
			const v = (parse[f.type] || parse.C)(raw);
			if (v !== null) q[f.name] = v;
		});
		return q;
	}
}

const Point = q => ({ type: "Point", coordinates: [q.getFloat64(4, true), q.getFloat64(12, true)] });
const PolyLine = q => {
	let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
	const parts = [], pts = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	const lines = parts.map((st, i) => pts.slice(st, parts[i + 1]));
	return n === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
};
const Polygon = q => {
	let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
	const parts = [], pts = [], polys = [], holes = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	parts.forEach((st, i) => {
		const ring = pts.slice(st, parts[i + 1]);
		let area = 0;
		for (let j = 0, l = ring.length; j < l; j++) {
			const a = ring[j], b = ring[(j + 1) % l];
			area += a[0] * b[1] - b[0] * a[1];
		}
		area >= 0 ? polys.push([ring]) : holes.push(ring);
	});
	if (polys.length === 1) return { type: "Polygon", coordinates: polys[0].concat(holes) };
	return { type: "MultiPolygon", coordinates: polys }; // 簡易化: 実際はホール割当てが必要
};

class SHP {
	constructor(s) {
		const h = view(s.subarray(0, 100));
		this.type = h.getInt32(32, true); this.src = s.subarray(100);
		this.parse = { 1: Point, 3: PolyLine, 5: Polygon, 8: Point, 11: Point, 13: PolyLine, 15: Polygon }[this.type];
	}
	read() {
		if (!this.src.byteLength) return null;
		const len = view(this.src.subarray(4, 8)).getInt32(0, false) * 2;
		const type = view(this.src.subarray(8, 12)).getInt32(0, true);
		const s = this.src.subarray(8, 8 + len); this.src = this.src.subarray(8 + len);
		return type === this.type ? this.parse(view(s)) : this.read();
	}
}

self.onmessage = async (e) => {
	const { file, encoding, precision } = e.data;
	const zip = await decodeZIP(file);
	const shpFiles = Object.keys(zip.files).filter(t => t.match(/\.shp$/));
	const dbs = await thenMap(shpFiles, async f => {
		const base = f.replace(/\.shp$/, ""), shp = await zip.file(f).async("uint8array");
		const dbf = await zip.file(base + ".dbf").async("uint8array");
		const cpg = zip.file(base + ".cpg") ? await zip.file(base + ".cpg").async("string") : null;
		const enc = cpg || (dbf[29] === 0x13 ? 'sjis' : encoding);
		return [new SHP(shp), new DBF(dbf, enc)];
	});

	const pbf = new PBF({ name: file.name.replace(/\.zip$/, ""), precision });
	pbf.setBody(() => {
		dbs.forEach(([shp, dbf]) => {
			while (1) {
				const s = shp.read(), d = dbf.read();
				if (!s || !d) break;
				pbf.setFeature({ type: "Feature", geometry: s, properties: d });
			}
		});
	});
	pbf.close();
	self.postMessage({ type: "shpdec", data: pbf.arrayBuffer }, [pbf.arrayBuffer]);
};