import { PBF } from "../pbf-base.js";

const thenMap = async (a, func) => {
    const q = []; for (let i = 0; i < a.length; i++) q.push(await func(a[i], i).catch(console.error));
    return q;
};

export function count(self) {
    const sum = a => { let n = 0; a.forEach(t => n += t); return n; };
    if (self.counts) return self.counts;
    const counts = [0, 0, 0, 0];
    const sumup = g => {
        const { type, coordinates: c } = g; if (!c) return;
        const t = PBF.geometryMap[type];
        switch (t) {
            case 0: counts[0] += 1; counts[3] += 1; break;
            case 1: counts[0] += c.length; counts[3] += c.length; break;
            case 2: counts[1] += 1; counts[3] += c.length; break;
            case 3: counts[1] += c.length; counts[3] += sum(c.map(t => t.length)); break;
            case 4: counts[2] += 1; counts[3] += sum(c.map(t => t.length)); break;
            case 5: counts[2] += c.length; counts[3] += sum(c.map(t => sum(t.map(u => u.length)))); break;
        }
    };
    self.each(i => {
        const g = self.getGeometry(i);
        if (self.getType(i) === "GeometryCollection") g.geometries.forEach(sumup);
        else sumup(g);
    });
    return (self.counts = counts);
}

export function lint(self) {
    const comma = _ => String(_).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    let str = []; const countArr = [0, 0, 0, 0, 0, 0, 0, 0];
    self.each((i, fmap) => countArr[fmap[2]]++);
    const types = countArr.map((n, i) => n ? `#${PBF.geometryTypes[i]}: ${n}` : ``).filter(t => t);
    str.push(`-------------------------------------------------`, ` GEOPBF ${self._name}`, `-------------------------------------------------`);
    str.push(` FEATURES: ${self.length} ( ${types.join(" , ")} )`, ` SIZE: ${comma(self.size)} [bytes]`, ` PRECiSION: ${self._precision} [${1 / self.e}]`, ` BBOX: ${JSON.stringify(self.bbox)}`);
    const [point_count, line_count, poly_count, coords_count] = self.count.map(comma);
    str.push(`-------------------------------------------------`, ` GEOMETRY SECTION`, `-------------------------------------------------`, ` # POINT: ${point_count}`, ` # LINE: ${line_count}`, ` # POLYGON: ${poly_count}`, ` # TOTAL COORDINATES: ${coords_count}`);
    str.push(`-------------------------------------------------`, ` PROPERTIES SECTION (${self.keys.length} properties)`, `-------------------------------------------------`);
    const typesort = a => {
        const q = {}; a.forEach(t => q[t] = (q[t] || 0) + 1);
        const c = Object.entries(q).sort((p, q) => q[1] - p[1]);
        return (c.length == 2 && PBF.dataTypeNames[c[0][0]] == "FLOAT" && PBF.dataTypeNames[c[1][0]] == "INTEGER") ? [[c[0][0], (c[0][1] + c[1][1])]] : c;
    };
    var a = Array.from({ length: self.keys.length }, () => []);
    self.props.forEach((t) => t.forEach((s, j) => { if (s !== undefined) a[j].push(s); }));
    a.forEach((values, i) => {
        var typeStr = typesort(values.map(t => PBF.dataType(t))).map(t => `${PBF.dataTypeNames[t[0]]}:${t[1]}`).join("|");
        str.push(` ${self.keys[i]}: ${typeStr}`);
    });
    str.push(`-------------------------------------------------`, new Date().toString());
    return str.join("\n") + "\n";
}

export async function clone(self, options = {}) {
    let { name, filter, map } = options;
    name = name || ""; map = map || (t => t); filter = filter || (() => true);
    if (name.startsWith("@")) name = self.name() + name;
    const pbf = new PBF({ name, precision: Math.log10(self.e) });
    const sels = self.each(i => i).filter(i => filter(self.getProperties(i), self.getType(i), self.getBbox(i), i));
    const props = sels.map(i => map(self.getProperties(i), self.getType(i), self.getBbox(i)));
    pbf.setHead(...(await PBF.makeKeys(props)));
    pbf.setBody(() => sels.forEach((n, i) => pbf.setMessage(PBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
    return pbf.getPosition();
}

export async function classify(self, key) {
    const a = {};
    self.each(i => {
        const p = self.getProperties(i), s = (typeof key === "function") ? key(p, self.getType(i), self.getBbox(i), i) : p[key];
        if (s !== undefined) { a[s] = a[s] || []; a[s].push(i); }
    });
    return thenMap(Object.entries(a).sort((p, q) => p[0] > q[0] ? 1 : -1), async ([k, v]) => {
        const pbf = new PBF({ name: self.name() + "@" + k, precision: Math.log10(self.e) }), props = v.map(i => self.getProperties(i));
        pbf.setHead(...(await PBF.makeKeys(props)));
        pbf.setBody(() => v.forEach((n, i) => pbf.setMessage(PBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
        return pbf.getPosition();
    });
}

export async function mergePolygonByProperty(self, pname) {
    const keyIdx = self.keys.indexOf(pname); if (keyIdx < 0) return self;
    const tub = {};
    self.props.forEach((propArr, i) => { const val = propArr[keyIdx]; if (val !== undefined) { tub[val] = tub[val] || []; tub[val].push(i); } });
    const groups = Object.entries(tub).sort((p, q) => p[0] > q[0] ? 1 : -1).map(t => t[1]);
    const props = groups.map(indices => {
        const groupProps = indices.map(idx => self.props[idx]), base = groupProps[0], propObj = {};
        for (let i = 1; i < groupProps.length; i++) { base.forEach((v, j) => { if (base[j] !== groupProps[i][j]) delete base[j]; }); }
        base.forEach((v, i) => {
            const keys = self.keys[i].split(".");
            if (keys.length === 1) propObj[keys[0]] = v;
            else { propObj[keys[0]] = propObj[keys[0]] || {}; propObj[keys[0]][keys.slice(1).join(".")] = v; }
        });
        return propObj;
    });
    const pbf = new PBF({ name: self._name, precision: Math.log10(self.e) }).copyHead(self);
    pbf.setBody(() => {
        groups.forEach((indices, idx) => {
            let mergedCoords = [];
            const addGeom = g => { if (g.type === "Polygon") mergedCoords.push(g.coordinates); else if (g.type === "MultiPolygon") mergedCoords.push(...g.coordinates); };
            indices.map(i => self.getGeometry(i)).forEach(g => { if (g.type === "GeometryCollection") g.geometries.forEach(addGeom); else addGeom(g); });
            if (!mergedCoords.length) return;
            const isMulti = mergedCoords.length > 1;
            pbf.setFeature({ type: "Feature", geometry: { type: isMulti ? "MultiPolygon" : "Polygon", coordinates: isMulti ? mergedCoords : mergedCoords[0] }, properties: props[idx] });
        });
    }).close();
    return await pbf.getPosition();
}

export function header(self, meta = {}) {
    return self.updateHeader(meta);
}

export async function update(buffer, meta = {}) {
    return PBF.update(buffer, meta);
}

export async function concatinate(pbfs, name) {
    pbfs = pbfs.filter(t => t instanceof PBF);
    if (pbfs.length == 0) return new PBF(); if (pbfs.length == 1) return pbfs[0];
    if (!pbfs.map(t => t.precision()).slice(1).every((t, i, a) => t == pbfs[0].precision())) { console.error("PBF concatenate: precision is not equal."); return null; }
    name = name || pbfs[0].name();
    const props = pbfs.map(pbf => pbf.properties), [keys, bufs] = await PBF.makeKeys(props.flat()), pbf = new PBF({ name }).setHead(keys, bufs);
    pbf.setBody(() => pbfs.forEach((t, n) => { t.each(i => pbf.setMessage(PBF.TAGS.FEATURE, () => { pbf.copyGeometry(t, i); pbf.setProperties(props[n][i]); })); })).close();
    return pbf.getPosition();
}