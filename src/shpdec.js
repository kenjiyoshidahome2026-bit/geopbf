import {PBF} from "./pbf-base.js";
import {decodeZIP} from "../../native-bucket/src/decodeZIP.js";
////-------------------------------------------------------------------------------------------------------
const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
const thenMap = async(a, func) => { const n = a.length, q = [];
	for (let i = 0; i < n; i++) q.push(await func(a[i],i).catch(console.error));
	return q;
};
////=====================================================================================================================
function keys(source, enc) {
	const dec = new TextDecoder(enc);
	const keys = [];
	for (var n = 32; source[n] !== 0x0d; n += 32) {
		for (var j = 0; j < 11; ++j) if (source[n + j] === 0) break;
		keys.push(dec.decode(source.subarray(n,n+j)).trim());
	}
	return keys;
}
class DBF {
	constructor(source, enc) { //source = new RBUF(source);
		var head = view(source.subarray(0, 32)), len = head.getUint16(8, true);
		var body = view(source.subarray(32, len));
		this.source = source.subarray(len);
		this.len = head.getUint16(10, true);
		this.dec = new TextDecoder(enc);
		this.fields = [];
		for (var n = 0; body.getUint8(n) !== 0x0d; n += 32) {
			for (var j = 0; j < 11; ++j) if (body.getUint8(n + j) === 0) break;
			this.fields.push({
				name: this.dec.decode(new Uint8Array(body.buffer, body.byteOffset + n, j)).trim(),
				type: String.fromCharCode(body.getUint8(n + 11)),
				length: body.getUint8(n + 16)
			});
		}
	}
	read() {
		const boolean = v => /^[nf]$/i.test(v) ? false: /^[yt]$/i.test(v) ? true: null;
		const date = v => new Date([v.substring(0, 4), v.substring(4, 6), +v.substring(6, 8)].join("-"));
		const number = v => { v = +v.trim(); return isNaN(v)? null : v; }
		const string = v => { v = v.trim().replace(/\x00/g,"");
			const parse = v => { try { return Function(`return (${v})`)(); } catch(e) { return v; } };
			return v.length? v.match(/(^\[.*\]$|^\{.*\}$|function|\=\>)/)?parse(v): v: null;
		};
		const value = this.source.subarray(0, this.len); this.source = this.source.subarray(this.len);
		var i = 1
		if (!value || (value[0] == 0x1a)) return null;
		const q = {};
		this.fields.map(field=>{
			const val = value.subarray(i, i += field.length);
			const func = { B: number, F: number, M: number, N: number, C: string, D: date, L: boolean}[field.type];
			const v = func(this.dec.decode(val)); v && (q[field.name] = v);
		});
		return q;
	}
}
////=====================================================================================================================
const Point = q => ({type: "Point", coordinates: [q.getFloat64(4, true), q.getFloat64(12, true)]});
const MultiPoint = q => { let pos = 40;
	const n = q.getInt32(36, true), coordinates = new Array(n);
	for (let i = 0; i < n; ++i, pos += 16) coordinates[i] = [q.getFloat64(pos, true), q.getFloat64(pos + 8, true)];
	return {type: "MultiPoint", coordinates};
};
const PolyLine = q => { let pos = 44;
	const n = q.getInt32(36, true), m = q.getInt32(40, true), parts = new Array(n), points = new Array(m);
	for (let i = 0; i < n; ++i, pos += 4) parts[i] = q.getInt32(pos, true);
	for (let i = 0; i < m; ++i, pos += 16) points[i] = [q.getFloat64(pos, true), q.getFloat64(pos + 8, true)];
	const lines = parts.map((i, j) => points.slice(i, parts[j + 1]));
	return n === 1? {type: "LineString", coordinates: lines[0]}: {type: "MultiLineString", coordinates: lines};
};
const Polygon = q => { let pos = 44;
	const getbbox = coords => {
		const res = [Infinity, Infinity, -Infinity, -Infinity];
		coords.flat().forEach(c => {
			if (res[0] > c[0]) res[0] = c[0];
			if (res[1] > c[1]) res[1] = c[1];
			if (res[2] < c[0]) res[2] = c[0];
			if (res[3] < c[1]) res[3] = c[1];
		});
		return res;
	};
	const n = q.getInt32(36, true), m = q.getInt32(40, true), parts = new Array(n), points = new Array(m), polygons = [], holes = [];
	for (let i = 0; i < n; ++i, pos += 4) parts[i] = q.getInt32(pos, true);
	for (let i = 0; i < m; ++i, pos += 16) points[i] = [q.getFloat64(pos, true), q.getFloat64(pos + 8, true)];
	parts.forEach((pos, j) => { var ring = points.slice(pos, parts[j + 1]);
		clockwise(ring)? polygons.push([ring]): holes.push(ring);
	});
	const bboxes = polygons.map(t=>getbbox(t));
	const includes = (b,pt) => !(b[0]>pt[0]||b[2]<pt[0]||b[1]>pt[1]||b[3]<pt[1]);
	const noinc = [];
	if (polygons.length == 0 && holes.length == 1) return {type: "Polygon", coordinates: [holes.reverse()]};
	if (polygons.length == 1) return {type: "Polygon", coordinates: polygons[0].concat(holes)};
	holes.forEach(hole => { var pt = hole[0];
		const inc = polygons.filter((t,i)=>includes(bboxes[i], pt));
		inc.length == 1? inc[0].push(hole):
		inc.some(polygon => {
			if (contains(polygon[0], pt)) { polygon.push(hole); return true; }
		}) || noinc.push([hole.reverse()]);
	});
	if (noinc.length) console.warn("isolated hole: ", JSON.stringify(noinc));
	return polygons.length === 1? {type: "Polygon", coordinates: polygons[0]}: {type: "MultiPolygon", coordinates: polygons};
	function clockwise(ring) {
		if ((n = ring.length) < 4) return false;
		var i = 0, n, area = ring[n - 1][1] * ring[0][0] - ring[n - 1][0] * ring[0][1];
		while (++i < n) area += ring[i - 1][1] * ring[i][0] - ring[i - 1][0] * ring[i][1];
		return area >= 0;
	}
	function contains(ring, point) {
		var x = point[0], y = point[1], contains = -1;
		for (var i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
			var pi = ring[i], xi = pi[0], yi = pi[1],
				pj = ring[j], xj = pj[0], yj = pj[1];
			if (((yi > y) !== (yj > y)) && ((x < (xj - xi) * (y - yi) / (yj - yi) + xi))) {
				contains = -contains;
			}
		}
		return contains;
	}
};
class SHP {
	constructor(source) {
		const header = view(source.subarray(0, 100));
		const type = this.type = header.getInt32(32, true);
		this.source = source.subarray(100); this.pos = 0;
		this.parse = { 0: () => null,
		1: Point, 11: Point, 21: Point,
		3: PolyLine, 13: PolyLine, 23: PolyLine,
		5: Polygon, 15: Polygon, 25: Polygon,
		8: MultiPoint, 18: MultiPoint, 28: MultiPoint }[type];
		if (!(this.parse)) throw new Error("unsupported shape type: " + type);
	}
	read() { ++this.pos;
		if (!this.source.byteLength) return null;
		const length = view(this.source.subarray(4, 8)).getInt32(0, false) * 2, type = view(this.source.subarray(8, 12)).getInt32(0, true);
		const s = this.source.subarray(8, 8+length); this.source = this.source.subarray(8+length);
		return type == this.type? this.parse(view(s)): this.read();
	}
}
////=====================================================================================================================
self.onmessage = async (e) => {
	const { file, encoding, precision } = e.data;
	console.log(`--------------------------\n    Shape File => PBF\n--------------------------`)
	const zip = await decodeZIP(file);
	const names = Object.keys(zip.files).filter(t=>t.match(/\.shp$/)).map(t=>t.replace(/\.shp$/,""));
	if (!names.length) return null;
	const keytub = {"bbox":true};
	const dbs = await thenMap(names, async fname=> {
		const shp = await zip.file(fname+".shp").async("uint8array");
		const dbf = await zip.file(fname+".dbf").async("uint8array");
		const enc = Object.keys(zip.files).includes(fname+".cpg")? await zip.file(fname+".cpg").async("string"):
			(dbf[29]/*LDID*/ == 0x13/*日本語*/)? 'sjis': encoding;
		keys(dbf, enc).forEach(t=>keytub[t]= true);
		console.log(`extracting: ${fname} (encoding:${enc})`);
		return [fname, new SHP(shp), new DBF(dbf, enc)];
	});
	var pbf = new PBF({name:file.name.replace(/\.zip$/,""), precision});
	pbf.setHead(Object.keys(keytub).sort());
	pbf.setBody(() => {
		dbs.forEach(([fname,shp,dbf])=>{
			console.log(`converting: ${fname}`);
			while(1) { const s = shp.read(), d = dbf.read(); if (!s || !d) break; 
				pbf.setFeature({type:"Feature", geometry:s, properties:d});
			};
			shp = dbf = null;
		});
	});
	pbf.close();
	console.log(" => Done : ", pbf.arrayBuffer);
	self.postMessage({type: "shpdec", data: pbf.arrayBuffer},[pbf.arrayBuffer]);
}