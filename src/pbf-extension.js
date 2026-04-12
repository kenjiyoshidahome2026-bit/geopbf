import { PBF } from "./pbf-base.js";
import * as spatial from "./extension/spatial.js";
import * as manipulate from "./extension/manipulate.js";

const setGetter = (name, func) => {
    Object.defineProperty(PBF.prototype, name, { get: func, configurable: false, enumerable: false });
};
const setPrototype = (name, func) => {
    Object.defineProperty(PBF.prototype, name, { value: func, configurable: false, enumerable: false });
};

// --- 静的メソッド ---
Object.defineProperty(PBF, 'update', { value: manipulate.update, configurable: false, enumerable: false });
Object.defineProperty(PBF, 'concatinate', { value: manipulate.concatinate, configurable: false, enumerable: false });

// --- Getters ---
setGetter("count", function () { return manipulate.count(this); });
setGetter("lint", function () { return manipulate.lint(this); });

// --- 空間演算 ---
setPrototype("centroid", function (i) { return spatial.centroid(this, i); });
setPrototype("area", function (i) { return spatial.area(this, i); });
setPrototype("contain", function (pt, one) { return spatial.contain(this, pt, one); });
setPrototype("nearPoint", function (pt, count, dist) { return spatial.nearPoint(this, pt, count, dist); });

// --- データ操作 ---
setPrototype("clone", function (opt) { return manipulate.clone(this, opt); });
setPrototype("rename", function (name) { return manipulate.clone(this, { name }); });
setPrototype("filter", function (f) { return manipulate.clone(this, { filter: f }); });
setPrototype("map", function (m) { return manipulate.clone(this, { map: m }); });
setPrototype("classify", function (k) { return manipulate.classify(this, k); });
setPrototype("mergePolygonByProperty", function (p) { return manipulate.mergePolygonByProperty(this, p); });
setPrototype("header", function (meta) { return manipulate.header(this, meta); });

export { PBF };