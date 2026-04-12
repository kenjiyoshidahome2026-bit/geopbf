import { PBF } from "./pbf-base.js";
import { concatenate } from "./extension/concatenate.js";
import * as spatial from "./extension/spatial.js";

const setGetter = (obj, name, func) => {
    const proto = (obj || {}).prototype || {};
    (name in proto) || Object.defineProperty(proto, name, { get: func, configurable: false, enumerable: false });
};
const setPrototype = (obj, name, func) => {
    const proto = (obj || {}).prototype || {};
    (name in proto) || Object.defineProperty(proto, name, { value: func, configurable: false, enumerable: false });
};
const thenMap = async (a, func) => {
    const n = a.length, q = [];
    for (let i = 0; i < n; i++) q.push(await func(a[i], i).catch(console.error));
    return q;
};
////===========================================================================================================
//// Getters
////===========================================================================================================
setGetter(PBF, "count", _count);
setGetter(PBF, "lint", _lint);
setPrototype("concat", function (...args) { return concatenate([this, ...args], this.name()); });
setPrototype("rename", function (name) { return this.clone({ name }); });
//	setGetter(PBF, "topojson", function() { const obj = {}; obj[this._name] = this.geojson; return topojson.topology(obj) });

////===========================================================================================================
//// Data Manipulation & Spatial Analysis
////===========================================================================================================
setPrototype("centroid", function (i) { return spatial.centroid(this, i); });
setPrototype("area", function (i) { return spatial.area(this, i); });
setPrototype("contain", function (pt, one) { return spatial.contain(this, pt, one); });
setPrototype("nearPoint", function (pt, count, dist) { return spatial.nearPoint(this, pt, count, dist); });

setPrototype(PBF, "clone", _clone);
setPrototype(PBF, "rename", function (name) { return this.clone({ name }); });
setPrototype(PBF, "filter", function (filter) { return this.clone({ filter }); });
setPrototype(PBF, "map", function (map) { return this.clone({ map }); });

setPrototype(PBF, "contain", _contain);
setPrototype(PBF, "points", _points);
setPrototype(PBF, "nearPoint", _nearPoint);
setPrototype(PBF, "mergePolygonByProperty", _mergePolygonByProperty);
setPrototype(PBF, "classify", _classify);

setPrototype(PBF, "concat", function () {
    const pbfs = [this];
    for (let i = 0; i < arguments.length; i++) pbfs.push(arguments[i]);
    return PBF.concatinate(pbfs, this.name());
});
////===========================================================================================================
//// Private Implementations
////===========================================================================================================

function _count() {
    const sum = a => { let n = 0; a.forEach(t => n += t); return n; };
    if (this.counts) return this.counts;
    const counts = [0, 0, 0, 0]; // [Points, Lines, Polygons, TotalCoords]
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
    this.each(i => {
        const g = this.getGeometry(i);
        if (this.getType(i) === "GeometryCollection") g.geometries.forEach(sumup);
        else sumup(g);
    });
    return (this.counts = counts);
}

function _lint() {
    const comma = _ => String(_).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var self = this; let str = [];
    const count = [0, 0, 0, 0, 0, 0, 0, 0];
    self.each((i, fmap) => count[fmap[2]]++);

    const types = count.map((n, i) => n ? `#${PBF.geometryTypes[i]}: ${n}` : ``).filter(t => t);
    str.push(`-------------------------------------------------`);
    str.push(` GEOPBF ${self._name}`);
    str.push(`-------------------------------------------------`);
    str.push(` FEATURES: ${self.length} ( ${types.join(" , ")} )`);
    str.push(` SIZE: ${comma(self.size)} [bytes]`);
    str.push(` PRECiSION: ${self._precision} [${1 / self.e}]`);
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
        return (c.length == 2 && PBF.dataTypeNames[c[0][0]] == "FLOAT" && PBF.dataTypeNames[c[1][0]] == "INTEGER") ?
            [[c[0][0], (c[0][1] + c[1][1])]] : c;// INTEGERはFLOATの特殊例
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

// src/pbf-extension.js

/**
 * ヘッダーのみを書き換え、既存の地物インデックス(fmap)を追従させる
 */
setPrototype(PBF, "header", function (meta = {}) {
    // 1. プロパティの更新
    if (meta.name !== undefined) this._name = meta.name;
    if (meta.description !== undefined) this._description = meta.description;
    if (meta.license !== undefined) this._license = meta.license;

    const oldBodyPos = this.bodyPos;
    // 既存の地物データ部分（FARRAYの中身）を抽出
    const bodyData = this.pbf.buf.subarray(oldBodyPos, this.end);

    // 2. 新しいバッファの構築
    this.pbf = new Pbf();
    this.setHead(this.keys, this.bufs);

    // FARRAYフィールドを手動で書き込み、新しい bodyPos を特定する
    this.pbf.writeVarint(PBF.TAGS.FARRAY << 3 | 2); // Tag 5, WireType 2
    this.pbf.writeVarint(bodyData.length);
    const newBodyPos = this.pbf.pos; // 新しいデータの開始位置
    this.pbf.writeBytes(bodyData);

    this.close();

    // 3. fmap のズレ（差分）を修正
    const diff = newBodyPos - oldBodyPos;
    if (this.fmap && diff !== 0) {
        this.fmap.forEach(f => {
            f[0] += diff; // fpos (Feature開始位置)
            f[1] += diff; // gpos (Geometry開始位置)
            if (f[2] === 6 && f[3]) { // GeometryCollection の場合
                f[3] = f[3].map(p => p + diff); // garray 内の各位置をシフト
            }
        });
    }
    this.bodyPos = newBodyPos;

    return this;
});

/**
 * 静的メソッド: ファイル名の一致などのため、バッファをパースせずにヘッダーのみ更新
 */
PBF.update = async function (buffer, meta = {}) {
    const pbf = new Pbf(new Uint8Array(buffer));
    const head = { keys: [], bufs: [], precision: 6 };
    let bodyPos = -1;

    // FARRAY が現れるまで最小限のスキャン
    while (pbf.pos < pbf.length) {
        const val = pbf.readVarint();
        const tag = val >> 3;
        if (tag === PBF.TAGS.FARRAY) {
            pbf.readVarint(); // 長さを消費
            bodyPos = pbf.pos;
            break;
        }
        if (tag === PBF.TAGS.NAME) head.name = pbf.readString();
        else if (tag === PBF.TAGS.DESCRIPTION) head.description = pbf.readString();
        else if (tag === PBF.TAGS.LICENSE) head.license = pbf.readString();
        else if (tag === PBF.TAGS.KEYS) head.keys.push(pbf.readString());
        else if (tag === PBF.TAGS.BUFS) head.bufs.push(pbf.readBytes());
        else if (tag === PBF.TAGS.PRECISION) head.precision = pbf.readVarint();
        else pbf.skip(val);
    }

    const out = new PBF({
        name: meta.name !== undefined ? meta.name : head.name,
        description: meta.description !== undefined ? meta.description : head.description,
        license: meta.license !== undefined ? meta.license : head.license,
        precision: head.precision
    });

    out.setHead(head.keys, head.bufs);
    out.pbf.writeVarint(PBF.TAGS.FARRAY << 3 | 2);
    const bodyData = new Uint8Array(buffer).subarray(bodyPos);
    out.pbf.writeVarint(bodyData.length);
    out.pbf.writeBytes(bodyData);

    return out.close().arrayBuffer;
};
async function _clone(options = {}) {
    const self = this;
    let { name, filter, map } = options;
    name = name || "";
    map = map || (t => t);
    filter = filter || (() => true);

    if (name.startsWith("@")) name = self.name() + name;
    const pbf = new PBF({ name, precision: Math.log10(self.e) });

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
        const pbf = new PBF({ name: self.name() + "@" + k, precision: Math.log10(self.e) });
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

    const pbf = new PBF({ name: self._name, precision: Math.log10(self.e) }).copyHead(self);

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
