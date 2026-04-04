{
import("fl3luS1M");// antimeridianFeature
////---------------------------------------------------------------------------------------------------------
//// ArrayBufferの圧縮・伸長
////---------------------------------------------------------------------------------------------------------
	const pipe = async(q, filter) => new Response(new Blob([q]).stream().pipeThrough(filter)).arrayBuffer();
	const enc = q => pipe(q, new CompressionStream("deflate-raw"));
	const dec = q => pipe(q, new DecompressionStream("deflate-raw"));
////---------------------------------------------------------------------------------------------------------
//// bufferTub (ArrayBufferを効率的に、アレイ化)
////---------------------------------------------------------------------------------------------------------
	class bufferTub {
		constructor() { this.tub = []; }
		set(q) { if (q instanceof ArrayBuffer) return abset(this.tub, q); }
		async close() { const a = this.tub.sort((p,q)=>p[1]>q[1]?1:-1).map(t=>t[0]); this.tub = [];
			return thenMap(a, enc);
		}
	}
	function abcomp(buf1, buf2) {
		if (buf1 === buf2) return 0;
		let d = (buf2.byteLength - buf1.byteLength); if (d) return d;
		var view1 = new DataView(buf1), view2 = new DataView(buf2);
		var n = buf1.byteLength;
		for (let i = 0; i < n; i++) { d = view2.getUint8(i) - view1.getUint8(i); if (d) return d; }
		return 0;
	};
	function abset(a, buf) { //buf = buf.buffer || buf;
		var len = a.length; if (len == 0) { a[0] = [buf, len]; return len; }
		return (function cmp(m0, m1) {
			const v0 = abcomp(a[m0][0], buf); if (!v0) return a[m0][1];
			const v1 = abcomp(buf, a[m1][0]); if (!v1) return a[m1][1];
			if (v0 < 0) { a.unshift([buf, len]); return len; }
			if (v1 < 0) { a.push([buf, len]); return len; }
			if (m1 - m0 == 1) { a.splice(m0+1, 0, [buf,len]); return len }
			var mm = ~~((m0+m1)/2);
			var v = abcomp(a[mm][0], buf); if (!v) return a[mm][1];
			if (v > 0) return cmp(mm, m1);
			if (v < 0) return cmp(m0, mm);
		})(0, len - 1);
	}
////---------------------------------------------------------------------------------------------------------
	const thenEach = async(a, func) => { const n = a.length;
		for (let i = 0; i < n; i++) await func(a[i],i).catch(console.error);
	};
	const thenMap = async(a, func) => { const n = a.length, q = [];
		for (let i = 0; i < n; i++) q.push(await func(a[i],i).catch(console.error)); return q;
	};
////---------------------------------------------------------------------------------------------------------
	const isSimpleObject = _ => Object.prototype.toString.call(_) === '[object Object]' && Object.keys(_).length;
	const isNumber = _ => typeof _ == "number";
	const isFloat = _ => isNumber(_) && (_ % 1 !== 0);
	const isBbox = _ => _ && _.length == 4 && _.every(isNumber)
		&& (-180<=_[0]&&_[0]<=_[2]&&_[2]<=180) && (-90<=_[1]&&_[1]<=_[3]&&_[3]<=90);
////===============================================================================================
//// class PBF 
////===============================================================================================
	const TAGS = { NAME:1, KEYS:2, PRECISION:3, BUFS:4, FARRAY:5, FEATURE:6, GEOMETRY:7, GTYPE:8, LENGTH:9, COORDS:10, VALUE:11, INDEX:12, GARRAY:13, DESCRIPTION:14, LISENCE:15 };
	const geometryTypes = ["Point","MultiPoint","LineString","MultiLineString","Polygon","MultiPolygon","GeometryCollection"];
	const geometryMap = {}; geometryTypes.forEach((t,i)=>geometryMap[t] = i);
	const dataTypeNames = ["NULL","BOOL","INTEGER","FLOAT","STRING","DATE","COLOR","FUNC","JSON","BBOX","BLOB","IMAGE"];
	const DATATYPE = {}; dataTypeNames.map((s,i)=>DATATYPE[s]=i); DATATYPE.UNKNOWN = -1;
////---------------------------------------------------------------------------------------------------------
	class PBF {
		constructor(options = {}) { 
			this.pbf = new Pbf();
			this._name = options.name||"";
			this._description = options.description||"";
			this._lisence = options.lisence||"";
			this.e = Math.pow(10, this._precision = options.precision || 6);
			this.noprop = !!options.noprop;
			this.logger = new Logger();
		}
	////------------------------------context---------------------------------------
		name(s) { if (s === undefined) return this._name; this._name = s; return this; }
		description(s) { if (s === undefined) return this._description; this._description = s; return this; }
		lisence(s) { if (s === undefined) return this._lisence; this._lisence = s; return this; }
		precision(s) { if (s === undefined) return this._precision; this.e = Math.pow(10, this._precision = s); return this; }
		init() { this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = []; delete this.end; delete this.ctx; delete this.proj; return this; }
		empty() { this.pbf = new Pbf(); this.init(); this.name(""); return this; }
		async set(q) { const self = this;
			if (q instanceof ArrayBuffer||ArrayBuffer.isView(q)) self.pbf = new Pbf(q);
			else if (isSimpleObject(q)) await json(q);
			else return (console.error("PBF set: setting illegal value", q), this);
			return await self.getPosition();
			async function json(obj) {
				const [keys, buffs] = self.noprop? [[],[]]: await makeKeys(obj.features.map(t=>t.properties));
				("name" in obj) && self.name(obj.name);
				return self.setHead(keys, buffs).setBody(obj).close();
			}
		}
		async getPosition() { const self = this;
			const {pbf, keys, e, fmap, props} = self.init();
			const bufs = [];
			let pos;
			pbf.readFields(tag => {
				if (tag === TAGS.NAME) self.name(pbf.readString());
				else if (tag === TAGS.DESCRIPTION) self.description(pbf.readString());
				else if (tag === TAGS.LISENCE) self.lisence(pbf.readString());
				else if (tag === TAGS.KEYS) keys.push(pbf.readString());
				else if (tag === TAGS.BUFS) bufs.push(pbf.readBytes());
				else if (tag === TAGS.PRECISION) self.e = Math.pow(10, self._precision = pbf.readVarint());
				else if (tag === TAGS.FARRAY) pos = pbf.pos;
			});
			const tobuf = v => v.buffer.slice(v.byteOffset, v.byteLength + v.byteOffset);
			self.bufs = await thenMap(bufs.map(tobuf), dec);
			self.end = pbf.pos;
		//	self.bboxPos = self.keys.indexOf("bbox");
			pbf.pos = pos; pbf.readMessage(featureCollection);
			return self;
			function featureCollection(tag) { if (tag !== TAGS.FEATURE) return;
				var fpos, gpos, type, garray, tarray;
				const values = [], q = new Array(keys.length);
				garray = [], tarray = [];
				fpos = pbf.pos, pbf.readMessage(feature);
				fmap.push(type==6?[fpos,gpos,type,garray,tarray]:[fpos,gpos,type]);
				props.push(q);
				function feature(tag) { 
					if (tag === TAGS.GEOMETRY) (gpos = pbf.pos, pbf.readMessage(geometry));
					else if (tag === TAGS.VALUE) (pbf.readVarint(), values.push(readValue(self)));
					else if (tag === TAGS.INDEX) propline();
					function geometry(tag) { 
						if (tag === TAGS.GTYPE)  type = pbf.readVarint(); 
						else if (tag === TAGS.GARRAY) {
							pbf.readMessage(tag => {
								if (tag === TAGS.GEOMETRY) { garray.push(pbf.pos);
									pbf.readMessage(tag=>{
										(tag === TAGS.GTYPE) && tarray.push(pbf.readVarint()); 
									});
								};
							});
						}
					}
					function propline() { var end = pbf.readVarint() + pbf.pos, pos = 0;
						while (pbf.pos < end) q[pbf.readVarint()] = values[pos++];
					}
				}
			}
		}
		get size() { return this.end; }
		get length() { return (this.fmap||[]).length; }
		each(func) { return (this.fmap||[]).map((t,i)=>func(i, t, this.getProperties(i))); }
		filter(func) { if (typeof func !== 'function') return this;
			const pbf = new PBF({name: this._name, description: this._description, precision:this._precision}).copyHead(this);
			pbf.setBody(()=>{
				this.each(i=>func(this.getProperties(i)) && pbf.setMessage(PBF.TAGS.FEATURE, ()=> { pbf.copyGeometry(this,i); pbf.copyProperties(this, i); }));
			}).close();
			return pbf.getPosition();
		}
		clone() { return this.filter(()=>true); }
	////---------------------------------------------------------------------
		setMessage(tag, func) { this.pbf.writeMessage(tag, func); return this; }
		setHead(keys, bufs) { this.keys = keys; this.bufs = bufs||[]; this.keytub = {};
			this._name && this.pbf.writeStringField(TAGS.NAME, this._name);
			this._description && this.pbf.writeStringField(TAGS.DESCRIPTION, this._description);
			this._precision == 6 || this.pbf.writeVarintField(TAGS.PRECISION, this._precision);
			this.keys.forEach((t,i)=>{this.pbf.writeStringField(TAGS.KEYS, t); this.keytub[t] = i; });
			this.bufs.forEach((t,i)=>{this.pbf.writeBytesField(TAGS.BUFS, new Uint8Array(t))});
			return this;
		}
		setBody(obj) { const func = (obj instanceof Function)? obj: ()=>obj.features.forEach(t=>this.setFeature(t))
			return this.setMessage(TAGS.FARRAY, func); }
		setFeature(q) { antimeridianFeature(q);//// <========= ((重要)) GEOJSONの正当性を担保
			return this.setMessage(TAGS.FEATURE, () => this.setGeometry(q.geometry).setProperties(q.properties));
		}
		setGeometry(q) { return writeGeometry(this, q); }
		setProperties(q) { return writeProperties(this, q); }
		close() { this.end = this.pbf.pos; this.pbf.finish(); return this; }
	////---------------------------------------------------------------------
		getFeature(i) { return {type: "Feature", geometry: this.getGeometry(i), properties: this.getProperties(i)}; }
		getGeometry(i,j) { return readGeometry(this, i, j); }		
		getProperties(i) { return readProperties(this, i); }
		getType(i) { return i === undefined? this.each(i=>this.getType(i)): geometryTypes[this.fmap[i][2]]; }
		getBbox(i) { if (i === undefined) return this.each(i=>this.getBbox(i));
			let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
			const calcBbox = c => {
				if (typeof c[0] === 'number') {
					if (c[0] < xmin) xmin = c[0]; if (c[0] > xmax) xmax = c[0];
					if (c[1] < ymin) ymin = c[1]; if (c[1] > ymax) ymax = c[1];
				} else c.forEach(calcBbox);
			};
			const geom = this.getGeometry(i);
			(geom.type=="GeometryCollection")? geom.geometries.forEach(t=>calcBbox(t.coordinates)): calcBbox(geom.coordinates);
			return [xmin, ymin, xmax, ymax].map(v => Math.round(v * this.e) / this.e);
		}
		get bboxes() { return this._bboxes || (this._bboxes = this.getBbox()); }
		get bbox() { if (this._bbox) return this._bbox;
			let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
			this.bboxes.filter(isBbox).forEach(t=>{
				xmin = Math.min(xmin, t[0]); ymin = Math.min(ymin, t[1]);
				xmax = Math.max(xmax, t[2]); ymax = Math.max(ymax, t[3]);
			});
			return this._bbox = [xmin, ymin, xmax, ymax];
		}
		getGeometryBuffer(i, j) { const map = this.fmap[i];
			const pos = this.pbf.pos = (map[2] == 6 && j !== undefined)? map[3][j]:map[1], len = this.pbf.readVarint();
			var n = len < 128?1: len < 16384?2: len < 2097152?3:4;
			return this.pbf.buf.slice(pos - 1, pos+len+n);
		}
		setGeometryBuffer(a) {  this.pbf.realloc(a.length); this.pbf.buf.set(a, this.pbf.pos); this.pbf.pos += a.length; return this; }
		copyGeometry(pbf, i) { this.setGeometryBuffer(pbf.getGeometryBuffer(i)) }
		copyProperties(pbf, i) { this.setProperties(pbf.getProperties(i)) }
		copyHead(pbf) { return this.setHead(pbf.keys,pbf.bufs); }
		get features() { return this.each(i=>this.getFeature(i)); }
		get geometries() { return this.each(i=>this.getGeometry(i)); }
		get properties() { return this.each(i=>this.getProperties(i)); }
		get propertiesTable() { return [this.keys].concat(this.props); }
		get arrayBuffer() { return this.pbf.buf.buffer.slice(0,this.end); }
		get geojson() { return { type:"FeatureCollection", features:this.features, name:this.name() }; }
	}
////===============================================================================================
	async function makeKeys(q) { const tub = {};
		const buffs = new bufferTub();
		await thenEach(q.filter(isSimpleObject), loop);
		return [Object.keys(tub).sort(), await buffs.close()];
		async function loop(q) {
			for (let key in q) { const v = q[key]; tub[key] = true;
				if (v instanceof Blob) q[key].id = buffs.set(await v.arrayBuffer());
				else if (v instanceof ImageData) q[key].id = buffs.set(v.data.buffer);
				else if (isSimpleObject(v)) {
					for (let k in v) { const u = v[k]; tub[`${key}.${k}`] = true;
						if (u instanceof Blob) u.id = buffs.set(await u.arrayBuffer());
						if (u instanceof ImageData) u.id = buffs.set(u.data.buffer);
					}
				}
			}
		}
	}
////---------------------------------------------------------------------
	function dataType(q) {
		const isColor = s => s.trim().match(/^rgba?\s*\([0-9,\.\s]+\)$/)||s.trim().match(/^\#[0-9a-f]{3,6}$/);
		if (q == null) return DATATYPE.NULL;
		const type = typeof q;
		if (type === "string") return isColor(q)? DATATYPE.COLOR: DATATYPE.STRING;
		else if (type === "number") return isFloat(q)? DATATYPE.FLOAT: DATATYPE.INTEGER;
		else if (type === "boolean") return DATATYPE.BOOL;
		else if (type === "function") return DATATYPE.FUNC;
		else if (q instanceof Date) return DATATYPE.DATE;
		else if (q instanceof Blob) return DATATYPE.BLOB;
		else if (q instanceof ImageData) return DATATYPE.IMAGE;
		else if (type === "object") return isBbox(q)? DATATYPE.BBOX: DATATYPE.JSON;
		else {
			console.error("unknown type:", q)
			return DATATYPE.UNKNOWN;
		}
	}
////===============================================================================================
	function writeValue(self, q) { const {pbf} = self;
		if (q == null||q == undefined) return;
		const type = dataType(q)
		switch(type) {
		case DATATYPE.STRING: return pbf.writeStringField(type, q)
		case DATATYPE.FLOAT: return pbf.writeDoubleField(type, q);
		case DATATYPE.INTEGER: return pbf.writeSVarintField(type, q);
		case DATATYPE.BOOL: return pbf.writeBooleanField(type, q);
		case DATATYPE.JSON: return pbf.writeStringField(type, JSON.stringify(q));
		case DATATYPE.BLOB: return pbf.writeStringField(type, [q.name||"", q.type||"", q.id].join(":"));
		case DATATYPE.FUNC: return pbf.writeStringField(type, q.toString());
		case DATATYPE.IMAGE: return pbf.writeStringField(type, [q.width, q.height, q.id].join(":"));
		case DATATYPE.DATE: return pbf.writeSVarintField(type, Math.round(+q/1000));
		case DATATYPE.BBOX: return pbf.writePackedDouble(type, q);
		case DATATYPE.COLOR: return pbf.writeBytesField(type, color(q));	
		}
		function color(s) { s = s.replace(/\s/g,""); var r;
			r = s.match(/^rgba\((\d+),(\d+),(\d+),([\d\.]+)\)$/); if (r) return [+r[1],+r[2],+r[3],~~(+r[4]*255)];
			r = s.match(/^rgb\((\d+),(\d+),(\d+)\)$/); if (r) return [+r[1],+r[2],+r[3],255];
			r = s.match(/^\#[0-9a-f]{6}$/); if (r) return [parseInt(s.substring(1,3),16),parseInt(s.substring(3,5),16),parseInt(s.substring(5,7),16),255];
			r = s.match(/^\#[0-9a-f]{3}$/); if (r) return [parseInt(s.substring(1,2),16)*16,parseInt(s.substring(2,3),16)*16,parseInt(s.substring(3,4),16)*16,255];
			console.warn("bad format color: ", s);
			return [0,0,0,0];
		}
	}
////---------------------------------------------------------------------
	function readValue(self) { const {pbf, bufs, bin} = self;
		switch(pbf.readVarint() >> 3) {
		case DATATYPE.STRING: return pbf.readString();
		case DATATYPE.FLOAT: return pbf.readDouble();
		case DATATYPE.INTEGER: return pbf.readSVarint();
		case DATATYPE.BOOL: return pbf.readBoolean();
		case DATATYPE.JSON: return JSON.parse(pbf.readString());
		case DATATYPE.BLOB: return blob(pbf.readString());
		case DATATYPE.FUNC: return eval(pbf.readString());
		case DATATYPE.IMAGE: return image(pbf.readString());
		case DATATYPE.DATE: return new Date(pbf.readSVarint()*1000);
		case DATATYPE.BBOX: return new Float32Array(pbf.readPackedDouble());
		case DATATYPE.COLOR: return color(pbf.readBytes());;
		}
		return null;
		function color(a) {
			return a.length == 3||a[3]==255? `rgb(${a[0]},${a[1]},${a[2]})`:
			`rgba(${a[0]},${a[1]},${a[2]},${(a[3]/255).toFixed(2)})`;
		}
		function blob(s) { if (s in bin) return bin[s];
			const [name,type,id] = s.split(":"), buf = bufs[+id];
			return bin[s] = name? new File([buf], name, {type}): new Blob([buf], {type});
		}
		function image(s) { if (s in bin) return bin[s];
			const [width, height, id] = s.split(":").map(t=>+t);
			return bin[s] = new ImageData(new Uint8ClampedArray(bufs[id]), width, height);
		}
	}
////===============================================================================================
	function writeProperties(self, q) { const {pbf, keytub} = self;
		var index = [];
		if (self.noprop) return
		for (var key in q) if (q[key]!=null) { var v = q[key];
			if (isSimpleObject(v) && Object.keys(v).every(k=>`${key}.${k}` in keytub)) {
				for (let k in v) if (v[k]!=null) { pbf.writeMessage(TAGS.VALUE, ()=>writeValue(self, v[k])); index.push(keytub[`${key}.${k}`]); }
			} else { pbf.writeMessage(TAGS.VALUE, ()=>writeValue(self, v)); index.push(keytub[key]); }
		}
		pbf.writePackedVarint(TAGS.INDEX, index);
	}
////---------------------------------------------------------------------
	function readProperties(self, n) {
		const {pbf, keys, props} = self, q = {};
		props[n].forEach((v,i)=>{ const key = keys[i].split(/\./);
			if (key.length == 1) q[key[0]] = v;
			else { q[key[0]] = q[key[0]]||{}; q[key[0]][key.slice(1).join(".")] = v; }
		});
		return q;
	}
////===============================================================================================
	function writeGeometry(self, q) { const {pbf, e} = self;
		return self.setMessage(TAGS.GEOMETRY, ()=>{
			const fix = n => { while(n<-180) n += 360; while(n>180) n -= 360; return n; }; //// <==== 経度: -180~180 を担保
			const type = geometryMap[q.type];
			if (type == null) return console.error("illegal geometry type: ", q.type);
			pbf.writeVarintField(TAGS.GTYPE, type);
			if (type == 6) return pbf.writeMessage(TAGS.GARRAY,()=>q.geometries.forEach(t=>writeGeometry(self, t)));
			let c = q.coordinates;
			[write0,write1,write1,write2,write2,write3][type]();
			pbf.writePackedSVarint(TAGS.COORDS, c.flat(Infinity));
			function len2() { return c.map(t=>t.length); }
			function len3() { const l = [c.length]; c.forEach(t=>{ l.push(t.length); t.forEach(u=>l.push(u.length));}); return l; }
			function write0() { c = [Math.round(fix(c[0]) * e), Math.round(c[1] * e)]; }
			function write1() { c = diff(c); }
			function write2() { c = c.map(diff); pbf.writePackedVarint(TAGS.LENGTH, len2());  }
			function write3() { c = c.map(t=>t.map(diff)); pbf.writePackedVarint(TAGS.LENGTH, len3());  }
			function diff(line) { if (!line || !line.length) return [];
				let sum = [0, 0], p = [];		
				let src = [];
				for (let i = 0, len = line.length; i < len; i++) {// 整数化と重複除去（ループの高速化とメモリ確保の最適化）
					let x = Math.round(fix(line[i][0]) * e);
					let y = Math.round(line[i][1] * e);
					if (src.length > 0 && src[src.length - 1][0] === x && src[src.length - 1][1] === y) continue;
					src.push([x, y]);
				}
				if (type > 3 && src.length >= 3) src = cleanCoords(src);
				for (let i = 0, len = src.length; i < len; i++) {// 3. 差分エンコード
					let t = src[i];
					p.push([t[0] - sum[0], t[1] - sum[1]]);
					sum[0] = t[0]; sum[1] = t[1]; // sumの更新
				}
				if (type > 3 && p.length > 0) p.pop();
				return p;
			}
		});
	}
	function cleanCoords(pts) {
		if (pts.length < 3) return pts;
		const eps = 1e-9, q = [];
		const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (c[0] - a[0]) * (b[1] - a[1]);
		for (let p of pts) {// 重複と折り返しの除去（ポリゴンとしての循環も考慮）
			while (q.length >= 2) {
				const [a, b] = [q[q.length-2], q[q.length-1]];
				const [v1, v2] = [[b[0]-a[0], b[1]-a[1]], [p[0]-b[0], p[1]-b[1]]];
				if (Math.abs(v1[0]*v2[1] - v1[1]*v2[0]) < eps && v1[0]*v2[0] + v1[1]*v2[1] <= 0) q.pop();
				else break;
			}
			if (!q.length || Math.hypot(q[q.length-1][0]-p[0], q[q.length-1][1]-p[1]) > eps) q.push(p);
		}
		for (let i = 0; i < q.length - 3; i++) {　// 交差除去（i = -1 で変更時に最初から再走査）
			for (let j = 2; j <= 3 && i + j + 1 < q.length; j++) {
				const [p1, p2, p3, p4] = [q[i], q[i+1], q[i+j], q[i+j+1]];
				if (ccw(p1,p2,p3) * ccw(p1,p2,p4) < 0 && ccw(p3,p4,p1) * ccw(p3,p4,p2) < 0) {
					q.splice(i + 1, j); i = -1; break;
				}
			}
		}
		const [f, l] = [q[0], q[q.length-1]];　// 始点と終点のつなぎ目を正規化（ポリゴンの「口」を閉じる）
		if (f[0] === l[0] && f[1] === l[1]) q.pop(); // 一旦末尾を消して判定
		if (q.length > 2) {　// つなぎ目（最後→最初→2番目）が一直線なら始点を消去
			const [a, b, c] = [q[q.length-1], q[0], q[1]];
			const [v1, v2] = [[b[0]-a[0], b[1]-a[1]], [c[0]-b[0], c[1]-b[1]]];
			if (Math.abs(v1[0]*v2[1] - v1[1]*v2[0]) < eps && v1[0]*v2[0] + v1[1]*v2[1] <= 0) q.shift();
		}
		q.push([...q[0]]); // 最後に綺麗に閉じる
		return q;
	}
////---------------------------------------------------------------------
	function readGeometry(self, n, m) { const {pbf, fmap, e} = self, map = fmap[n]; 
		return (map[2] < 6)? read(map[1], map[2]):
			m !== undefined? read(map[3][m], map[4][m]):
			{type:geometryTypes[6], geometries: map[3].map((t,i)=>read(t, map[4][i]))};
			
		function read(pos, type)  { pbf.pos = pos;
			var q = {type: geometryTypes[type]}, isPoly = type > 3, lens = [], end;
			const funcs = [read0, read1, read1, read2, read2, read3][type];
			return pbf.readMessage(field, q);
			function field(tag, q) {
				if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
				else if (tag === TAGS.COORDS) { end = pbf.readVarint() + pbf.pos;
					q.coordinates = funcs();
				}
			}
			function readCoords(p) { p = p||[0,0]; p[0] += pbf.readSVarint(); p[1] += pbf.readSVarint(); return p; }
			function magCoords(p) { return [p[0]/e, p[1]/e]; }
			function read_n(n) { var c = [], p = [0,0];
				while (n-- > 0) c.push(magCoords(p = readCoords(p)));
				isPoly && c.push(c[0]); return c;
			}
			function read0() { return magCoords(readCoords()); }
			function read1() { var c = [], p = [0,0];
				while (pbf.pos < end) c.push(magCoords(readCoords(p)));
				return c;
			}
			function read2() { return lens.map(t=>read_n(t)); }
			function read3() { const c = []; let pos = 0;
				for (var i = 0; i < lens[0]; i++) { var n = lens[++pos]; c[i] = [];
					for (var j = 0; j < n; j++) c[i].push(read_n(lens[++pos]));
				}
				return c;
			}
		}
	}
////---------------------------------------------------------------------
//#inline("C6x7ZVaB"); //getTopology
////===============================================================================================
	const set = (obj, name, value) => {
		if (typeof name == "string") {
			(name in obj) || Object.defineProperty(obj, name, { value, configurable: false, enumerable: false});
		} else Object.entries(name).map(t=>set(obj, ...t))
	}
	set(PBF, {TAGS, makeKeys, dataType, dataTypeNames, geometryTypes, geometryMap, concatinate});
	set(this, {PBF});
	async function concatinate(pbfs, name) { pbfs = pbfs.filter(t=> t instanceof PBF);
		if (pbfs.length == 0) return new PBF(); else if (pbfs.length == 1) return pbfs[0];
		const precisions = pbfs.map(t=>t.precision());
		if (!precisions.slice(1).every(t=>t==precisions[0])) return (console.error("PBF concatinate: precision is not equal."), null);
		name = name||pbfs[0].name();
		const props = pbfs.map(pbf=>pbf.properties);
		const pbf = new PBF({name}).setHead(...(await makeKeys(props.flat())));
		pbf.setBody(()=>pbfs.forEach((t, n)=>{
			t.each(i=>pbf.setMessage(PBF.TAGS.FEATURE, ()=> { pbf.copyGeometry(t,i); pbf.setProperties(props[n][i]); }));
		})).close();
		return pbf.getPosition();
	}
}