import { PBF } from "./pbf-base.js";
import * as spatial from "./extension/spatial.js";
import * as manipulate from "./extension/manipulate.js";
import { nearPoint } from "./extension/nearPoint.js";
import { contain } from "./extension/contain.js";
import { dissolve } from "./extension/dissolve.js";
import { analyzeTopology, neighbors } from "./extension/topology.js"; // 追加
import { toTopoJSON } from "./extension/topojson.js"; // 追加

const setGetter = (name, func) => { Object.defineProperty(PBF.prototype, name, { get: func, configurable: false, enumerable: false }); };
const setPrototype = (name, func) => { Object.defineProperty(PBF.prototype, name, { value: func, configurable: false, enumerable: false }); };

Object.defineProperty(PBF, 'update', { value: manipulate.update, configurable: false, enumerable: false });
Object.defineProperty(PBF, 'concatinate', { value: manipulate.concatinate, configurable: false, enumerable: false });

setGetter("count", function () { return manipulate.count(this); });
setGetter("lint", function () { return manipulate.lint(this); });

setPrototype("centroid", function (i) { return spatial.centroid(this, i); });
setPrototype("area", function (i) { return spatial.area(this, i); });
setPrototype("contain", function (pt, one) { return contain(this, pt, one); });
setPrototype("nearPoint", function (pt, count, dist) { return nearPoint(this, pt, count, dist); });

setPrototype("clone", function (opt) { return manipulate.clone(this, opt); });
setPrototype("rename", function (name) { return manipulate.clone(this, { name }); });
setPrototype("filter", function (f) { return manipulate.clone(this, { filter: f }); });
setPrototype("map", function (m) { return manipulate.clone(this, { map: m }); });
setPrototype("classify", function (k) { return manipulate.classify(this, k); });
setPrototype("header", function (meta) { return manipulate.header(this, meta); });
setPrototype("concat", function (...args) { return manipulate.concatinate([this, ...args], this.name()); });
setPrototype("dissolve", function (p) { return dissolve(this, p); });

setPrototype("analyzeTopology", function () { return analyzeTopology(this); });
setPrototype("neighbors", function (id) { return neighbors(this, id); });
setGetter("topojson", function () { return toTopoJSON(this); });

export { PBF };