(function(PBF) {
	const gz = (flag, file) => flag ? gzip(file, true) : file;
	const setGetter = (obj, name, func) => { 
		const proto = (obj || {}).prototype || {};
		(name in proto) || Object.defineProperty(proto, name, { get: func, configurable: false, enumerable: false});
	};
	const setPrototype = (obj, name, func) => { 
		const proto = (obj || {}).prototype || {};
		(name in proto) || Object.defineProperty(proto, name, { value: func, configurable: false, enumerable: false});
	};
	const sum = a => { let n = 0; a.forEach(t => n += t); return n; };
	const comma = _ => String(_).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const thenMap = async(a, func) => { 
		const n = a.length, q = [];
		for (let i = 0; i < n; i++) q.push(await func(a[i], i).catch(console.error)); 
		return q;
	};

	////===========================================================================================================
	//// Getters
	////===========================================================================================================
	setGetter(PBF, "count", _count);
	setGetter(PBF, "lint", _lint);
//	setGetter(PBF, "topojson", function() { const obj = {}; obj[this._name] = this.geojson; return topojson.topology(obj) });

	////===========================================================================================================
	//// Native Spatial Math (Zero-Dependency)
	////===========================================================================================================
	
	// 1. Centroid: ジオメトリの全座標の算術平均を算出
	setPrototype(PBF, "centroid", function(i) { 
		const geom = this.getGeometry(i);
		let x = 0, y = 0, count = 0;
		const add = c => {
			if (typeof c[0] === 'number') { x += c[0]; y += c[1]; count++; }
			else c.forEach(add);
		};
		if (geom.type === "GeometryCollection") geom.geometries.forEach(g => add(g.coordinates || []));
		else add(geom.coordinates || []);
		
		return count ? [Math.round((x / count) * this.e) / this.e, Math.round((y / count) * this.e) / this.e] : [0, 0];
	});

	// 2. Area: 球面ポリゴン面積計算 (WGS84, 単位: 平方メートル)
	setPrototype(PBF, "area", function(i) { 
		const geom = this.getGeometry(i);
		const r2d = Math.PI / 180;
		const R = 6378137; // WGS84 Equatorial Radius
		const ringArea = coords => {
			let area = 0, n = coords.length;
			if (n > 2) {
				for (let j = 0; j < n; j++) {
					let p1 = coords[j === 0 ? n - 1 : j - 1];
					let p2 = coords[j];
					let p3 = coords[j === n - 1 ? 0 : j + 1];
					area += (p3[0] - p1[0]) * r2d * Math.sin(p2[1] * r2d);
				}
			}
			return Math.abs(area * R * R / 2);
		};
		
		let total = 0;
		const calc = (g) => {
			if (g.type === "Polygon") {
				total += ringArea(g.coordinates[0]); // 外周加算
				for (let j = 1; j < g.coordinates.length; j++) total -= ringArea(g.coordinates[j]); // 内周（穴）減算
			} else if (g.type === "MultiPolygon") {
				g.coordinates.forEach(poly => {
					total += ringArea(poly[0]);
					for (let j = 1; j < poly.length; j++) total -= ringArea(poly[j]);
				});
			} else if (g.type === "GeometryCollection") {
				g.geometries.forEach(calc);
			}
		};
		calc(geom);
		return Math.round(total);
	});

	// 3. PathLength: 大円航路距離の合計 (Haversine formula, 単位: メートル)
	setPrototype(PBF, "pathLength", function(i) { 
		const geom = this.getGeometry(i);
		const r2d = Math.PI / 180;
		const R = 6371000; // Mean Earth Radius
		const dist = (c1, c2) => {
			const dLat = (c2[1] - c1[1]) * r2d, dLon = (c2[0] - c1[0]) * r2d;
			const a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(c1[1] * r2d) * Math.cos(c2[1] * r2d) * Math.pow(Math.sin(dLon / 2), 2);
			return R * 2 * Math.asin(Math.sqrt(a));
		};
		const lineLen = coords => {
			let d = 0;
			for (let j = 0; j < coords.length - 1; j++) d += dist(coords[j], coords[j+1]);
			return d;
		};
		
		let total = 0;
		const calc = g => {
			if (g.type === "LineString") total += lineLen(g.coordinates);
			else if (g.type === "MultiLineString" || g.type === "Polygon") g.coordinates.forEach(c => total += lineLen(c));
			else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(c => total += lineLen(c)));
			else if (g.type === "GeometryCollection") g.geometries.forEach(calc);
		};
		calc(geom);
		return Math.round(total);
	});

	////===========================================================================================================
	//// Data Manipulation & Spatial Analysis
	////===========================================================================================================
	setPrototype(PBF, "clone", _clone);
	setPrototype(PBF, "rename", function(name) { return this.clone({name}); });
	setPrototype(PBF, "filter", function(filter) { return this.clone({filter}); });
	setPrototype(PBF, "map", function(map) { return this.clone({map}); });
	
	setPrototype(PBF, "contain", _contain);
	setPrototype(PBF, "points", _points);
	setPrototype(PBF, "nearPoint", _nearPoint);
	setPrototype(PBF, "mergePolygonByProperty", _mergePolygonByProperty);
	setPrototype(PBF, "classify", _classify);
	
	setPrototype(PBF, "concat", function() { 
		const pbfs = [this];
		for (let i = 0; i < arguments.length; i++) pbfs.push(arguments[i]);
		return PBF.concatinate(pbfs, this.name());
	});

	////===========================================================================================================
	//// I/O & Export
	////===========================================================================================================
	setPrototype(PBF, "pbfFile", async function(flag) {
		return gz(flag, new File([this.arrayBuffer], (this._name)+".pbf", {type:"application/octet-stream"})); 
	});
	setPrototype(PBF, "geojsonFile", async function(flag) {
		const a = this.fmap.map((t, i) => (i ? "," : "") + JSON.stringify(this.getFeature(i)));
		a.unshift(`{"type":"FeatureCollection","name":"${this._name}","features":[`); 
		a.push(']}');
		return gz(flag, new File(a, this._name+".geojson", {type:"application/json"})); 
	});
	setPrototype(PBF, "topojsonFile", async function(flag) {
		return gz(flag, new File([JSON.stringify(this.topojson)], this._name+".topojson", {type:"application/json"})); 
	});
	setPrototype(PBF, "shapeFile", async function(options = {}) {
		return worker(shpenc, [this.arrayBuffer, this._name, options.encoding, options.level]); 
	});

	setPrototype(PBF, "file", async function(options = {}) {
		const self = this, gzip = !!options.gzip;
		return options.format == "shape" ? await self.shapeFile(options) :
			   options.format == "geojson" ? await self.geojsonFile(gzip) :
			   options.format == "topojson" ? await self.topojsonFile(gzip) : 
			   await self.pbfFile(gzip);
	});
	setPrototype(PBF, "download", async function(options = {}) {
		const file = await this.file(options);
		const a = document.createElement('a'); 
		a.download = file.name;
		const url = a.href = URL.createObjectURL(file);
		a.click(); 
		a.remove();
		URL.revokeObjectURL(url);
	});

	setPrototype(PBF, "put", async function(tub) { return (tub || PBF.io || (PBF.io = await pbfio())).put(this); });
	setPrototype(PBF, "get", async function(name, tub) {
		var buf = await (tub || PBF.io || (PBF.io = await pbfio())).get(name, true);
		await this.empty(); 
		return this.set(buf);
	});
	setPrototype(PBF, "save", async function(tub) { return (tub || PBF.io || (PBF.io = await pbfio())).save(this); });
	setPrototype(PBF, "load", async function(name, tub) { 
		var buf = await (tub || PBF.io || (PBF.io = await pbfio())).load(name, true);
		await this.empty(); 
		return this.set(buf);
	});

	////===========================================================================================================
	//// Private Implementations
	////===========================================================================================================
	
	function _count() { 
		if (this.counts) return this.counts;
		const counts = [0, 0, 0, 0]; // [Points, Lines, Polygons, TotalCoords]
		
		const sumup = g => { 
			const { type, coordinates: c } = g; if (!c) return;
			const t = PBF.geometryMap[type];
			switch(t) {
			case 0: counts[0] += 1; counts[3] += 1; break;
			case 1: counts[0] += c.length; counts[3] += c.length; break;
			case 2: counts[1] += 1; counts[3] += c.length; break;
			case 3: counts[1] += c.length; counts[3] += sum(c.map(t => t.length)); break;
			case 4: counts[2] += 1; counts[3] += sum(c.map(t => t.length)); break;
			case 5: counts[2] += c.length; counts[3] += sum(c.map(t => sum(t.map(u => u.length)))); break;
			}
		};
		
		this.each(i => { 
			const g = this.getGeometry(i);
			if (this.getType(i) === "GeometryCollection") g.geometries.forEach(sumup);
			else sumup(g);
		});
		return (this.counts = counts);
	}

	function _lint() { 
		var self = this; let str = [];
		const count = [0,0,0,0,0,0,0,0]; 
		self.each((i, fmap) => count[fmap[2]]++);
		
		const types = count.map((n, i) => n ? `#${PBF.geometryTypes[i]}: ${n}` : ``).filter(t => t);
		str.push(`-------------------------------------------------`);
		str.push(` GEOPBF ${self._name}`);
		str.push(`-------------------------------------------------`);
		str.push(` FEATURES: ${self.length} ( ${types.join(" , ")} )`);
		str.push(` SIZE: ${comma(self.size)} [bytes]`);
		str.push(` PRECiSION: ${self._precision} [${1/self.e}]`);
		str.push(` BBOX: ${JSON.stringify(self.bbox)}`);
		
		const [point_count, line_count, poly_count, coords_count] = self.count.map(comma);
		str.push(`-------------------------------------------------`);
		str.push(` GEOMETRY SECTION`);
		str.push(`-------------------------------------------------`);
		str.push(` # POINT: ${point_count}`);
		str.push(` # LINE: ${line_count}`);
		str.push(` # POLYGON: ${poly_count}`);
		str.push(` # TOTAL COORDINATES: ${coords_count}`);
		str.push(`-------------------------------------------------`);
		str.push(` PROPERTIES SECTION (${self.keys.length} properties)`);
		str.push(`-------------------------------------------------`);
		
		const typesort = a => { 
			const q = {};
			a.forEach(t => { q[t] = (q[t] || 0) + 1; });
			const c = Object.entries(q).sort((p, q) => q[1] - p[1]);
			return (c.length == 2 && PBF.dataTypeNames[c[0][0]] == "FLOAT" && PBF.dataTypeNames[c[1][0]] == "INTEGER")?
			[[c[0][0],(c[0][1]+c[1][1])]]:c;// INTEGERはFLOATの特殊例
		};
		
		var a = Array.from({ length: self.keys.length }, () => []);
		self.props.forEach((t) => t.forEach((s, j) => { if (s !== undefined) a[j].push(s); }));
		
		a.forEach((values, i) => {
			var typeStr = typesort(values.map(t => PBF.dataType(t))).map(t => `${PBF.dataTypeNames[t[0]]}:${t[1]}`).join("|");
			str.push(` ${self.keys[i]}: ${typeStr}`);
		});
		str.push(`-------------------------------------------------`);
		str.push(new Date().toString());
		return str.join("\n") + "\n";
	}

	async function _clone(options = {}) { 
		const self = this;
		let { name, filter, map } = options; 
		name = name || ""; 
		map = map || (t => t); 
		filter = filter || (() => true);
		
		if (name.startsWith("@")) name = self.name() + name;
		const pbf = new PBF({name, precision: Math.log10(self.e)});
		
		const sels = self.each((i) => i).filter(i => filter(self.getProperties(i), self.getType(i), self.getBbox(i), i));
		const props = sels.map(i => map(self.getProperties(i), self.getType(i), self.getBbox(i)));
		
		pbf.setHead(...(await PBF.makeKeys(props)));
		pbf.setBody(() => sels.forEach((n, i) => pbf.setMessage(PBF.TAGS.FEATURE, () => { 
			pbf.copyGeometry(self, n); 
			pbf.setProperties(props[i]); 
		}))).close();
		return pbf.getPosition();
	}

	async function _classify(key) { 
		const self = this;
		const a = {};
		self.each(i => { 
			const p = self.getProperties(i);
			const s = (typeof key === "function") ? key(p, self.getType(i), self.getBbox(i), i) : p[key];
			if (s !== undefined) {
				a[s] = a[s] || []; 
				a[s].push(i);
			}
		});
		
		return thenMap(Object.entries(a).sort((p, q) => p[0] > q[0] ? 1 : -1), async ([k, v]) => {
			const pbf = new PBF({name: self.name() + "@" + k, precision: Math.log10(self.e)});
			const props = v.map(i => self.getProperties(i));
			pbf.setHead(...(await PBF.makeKeys(props)));
			pbf.setBody(() => v.forEach((n, i) => pbf.setMessage(PBF.TAGS.FEATURE, () => { 
				pbf.copyGeometry(self, n); 
				pbf.setProperties(props[i]); 
			}))).close();
			return pbf.getPosition();
		});
	}

	async function _mergePolygonByProperty(pname) { 
		const self = this;
		const keyIdx = self.keys.indexOf(pname); 
		if (keyIdx < 0) return self;
		
		const tub = {};
		self.props.forEach((propArr, i) => {
			const val = propArr[keyIdx];
			if (val !== undefined) {
				tub[val] = tub[val] || [];
				tub[val].push(i);
			}
		});
		
		const groups = Object.entries(tub).sort((p, q) => p[0] > q[0] ? 1 : -1).map(t => t[1]);
		
		const props = groups.map(indices => { 
			const groupProps = indices.map(idx => self.props[idx]);
			const base = groupProps[0];
			const propObj = {};
			
			for (let i = 1; i < groupProps.length; i++) {
				base.forEach((v, j) => { if (base[j] !== groupProps[i][j]) delete base[j]; });
			}
			
			base.forEach((v, i) => {
				const keys = self.keys[i].split(".");
				if (keys.length === 1) propObj[keys[0]] = v;
				else { 
					propObj[keys[0]] = propObj[keys[0]] || {}; 
					propObj[keys[0]][keys.slice(1).join(".")] = v; 
				}
			});
			return propObj;
		});
		
		const pbf = new PBF({name: self._name, precision: Math.log10(self.e)}).copyHead(self);
		
		pbf.setBody(() => {
			groups.forEach((indices, idx) => { 
				let mergedCoords = [];
				const addGeom = g => { 
					const { type, coordinates } = g;
					if (type === "Polygon") mergedCoords.push(coordinates);
					else if (type === "MultiPolygon") mergedCoords.push(...coordinates);
				};
				
				indices.map(i => self.getGeometry(i)).forEach(g => {
					if (g.type === "GeometryCollection") g.geometries.forEach(addGeom);
					else addGeom(g);
				});
				
				if (!mergedCoords.length) return;
				const isMulti = mergedCoords.length > 1;
				const geometry = { type: isMulti ? "MultiPolygon" : "Polygon", coordinates: isMulti ? mergedCoords : mergedCoords[0] };
				
				pbf.setFeature({ type: "Feature", geometry, properties: props[idx] });
			});
		}).close();
		
		return await pbf.getPosition();
	}

	function _contain([px, py], getOneFlag) { 
		const self = this;
		const out = b => (px < b[0] || px > b[2] || py < b[1] || py > b[3]);
		
		if (out(self.bbox)) return getOneFlag ? -1 : [];
		
		// Ray-Casting Algorithm
		const rayCast = ring => {
			let inside = false;
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const xi = ring[i][0], yi = ring[i][1];
				const xj = ring[j][0], yj = ring[j][1];
				const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
				if (intersect) inside = !inside;
			}
			return inside;
		};

		const checkPoly = coords => {
			if (!rayCast(coords[0])) return false;
			for (let i = 1; i < coords.length; i++) if (rayCast(coords[i])) return false;
			return true;
		};

		const isContain = n => { 
			const fmap = self.fmap[n], type = fmap[2];
			if (type < 4) return false;
			if (out(self.getBbox(n))) return false;
			
			const geom = self.getGeometry(n);
			if (type === 4) return checkPoly(geom.coordinates);
			if (type === 5) return geom.coordinates.some(checkPoly);
			
			if (type === 6) { 
				return geom.geometries.some(g => {
					if (g.type === "Polygon") return checkPoly(g.coordinates);
					if (g.type === "MultiPolygon") return g.coordinates.some(checkPoly);
					return false;
				});
			}
			return false;
		};
		
		const a = [];
		for (let i = 0; i < self.length; i++) {
			if (isContain(i)) {
				if (getOneFlag) return i;
				a.push(i);
			}
		}
		return getOneFlag ? -1 : a;
	}

	function _points() { 
		if (this.kdbush) return this;
		const self = this;
		const length = self.count[0];
		const kdbush = self.kdbush = new KDBush(length);
		const index = self.kdIndex = []; 
		
		const add = (n, coords) => { kdbush.add(coords[0], coords[1]); index.push(n); };
		
		self.each(n => { 
			const fmap = self.fmap[n], type = fmap[2];
			if (type === 0) add(n, self.getGeometry(n).coordinates);
			else if (type === 1) self.getGeometry(n).coordinates.forEach(t => add(n, t));
			else if (type === 6) {
				const geom = self.getGeometry(n);
				geom.geometries.forEach(g => {
					if (g.type === "Point") add(n, g.coordinates);
					else if (g.type === "MultiPoint") g.coordinates.forEach(t => add(n, t));
				});
			}
		});
		kdbush.finish();
		return self;
	}

	function _nearPoint([x, y], maxCount = 1, maxDistance = Infinity) {
		const self = this;
		self.kdbush || self.points();
	//	#inline("oRWKMw3P");
		return nearPoint(self.kdbush, x, y, maxCount, maxDistance).map(t => self.kdIndex[t]);
	}

})(this.PBF || {});