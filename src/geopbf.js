import { worker } from "./worker.js"; 
import { PBF } from "./pbf-extension.js";
import { pbfio } from "./pbf-io.js";
import { Logger } from "./logger.js";
import { topo2geo } from "./topo2geo.js";
// native-bucket から gzip 機能をインポート
import { gzip, gunzip, isGzip } from "../../native-bucket/src/gzip.js";
const logger = new Logger();
let serverPromise = null;
/**
 * PBFIO の初期化を管理
 */
async function getServer() {
    if (!serverPromise) {
        serverPromise = pbfio("GIS").catch(e => {
            logger.warn("PBFIO initialization failed.", e);
            return null;
        });
    }
    return await serverPromise;
}
/**
 * メイン関数: 全ての GIS データを PBF 化
 */
export async function geopbf(data, options = {}) {
    const isString = _ => (typeof _ == "string");
    const isObject = _ => (Object.prototype.toString.call(_) === '[object Object]' || Array.isArray(_));
    const isBuffer = _ => (_ instanceof ArrayBuffer || ArrayBuffer.isView(_));
    const isFile = _ => (_ instanceof Blob && ("name" in _));
    const isURL = _ => (_.match(/^https?\:\/\//));
    const isInZip = _ => (_.match(/.+\.zip#.+/i));
    const isPBF = _ => (_ instanceof PBF);
    if (isString(options)) options = { name: options };
    logger.title("geopbf");
    const pbf = await _geopbf(data);
    pbf && logger.success(`geopbf: ${pbf.name} (${pbf.size.toLocaleString()} bytes)`);
    return pbf || new PBF(options);
    async function _geopbf(q) { 
        if (!q) return null;
        if (isPBF(q)) return q;
        if (isBuffer(q)) return new PBF(options).set(q);
        if (isObject(q)) {
            q = toFeatureCollection(q);
            return (q && q.features.length > 0) ? await new PBF(options).set(q) : null;
        }
        if (isFile(q)) {
            if (await isGzip(q)) return _geopbf(await gunzip(q));
            const name = q.name;
            options.name = options.name || name.replace(/\.[^\.]+$/, "");
            if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
            if (name.match(/\.(geo|topo)?json$/i)) return _geopbf(await file2json(q));
            if (name.match(/\.zip$/i)) return _geopbf(await decoder("shp", q));
            if (name.match(/\.kmz$/i)) return _geopbf(await decoder("kmz", q));
            if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
            if (name.match(/\.gz(ip)?$/i)) return _geopbf(await gunzip(q));
        }
        const server = await getServer();
        if (isString(q) && server) {
            const usecache = !options.nocache;
            if (isURL(q)) {
                const fetchUrl = isInZip(q) ? q : (q.match(/\.zip$/) && options.target) ? [q, options.target].join("#") : q;
                return _geopbf(await server.fetch(fetchUrl, usecache));
            }
            return _geopbf(await server.load(q));
        }
        return null;
        async function file2json(file) {
            // 大容量(100MB〜)は worker.js で非同期パース
            // if (file.size > 100 * 1024 * 1024) {
            //     const json = await worker(async (f) => JSON.parse(await f.text()), file);
            //     return toFeatureCollection(json);
            // }
            try {
                const json = toFeatureCollection(JSON.parse(await file.text()));
                json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
                return json;
            } catch (e) { return null; }
        }
        async function decoder(type, file) {
            const params = { 
                file, 
                precision: options.precision || 6,
                encoding: (options.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis")
            };
            const workerUrl = new URL(`../worker/${type}dec.js`, import.meta.url);
            const w = new Worker(workerUrl, { type: 'module' });
            return new Promise(resolve => {
                w.onmessage = e => { w.terminate(); resolve(e.data ? new PBF(options).set(e.data.data) : null); };
                w.onerror = () => { w.terminate(); resolve(null); };
                w.postMessage(params);
            });
        }
        function toFeatureCollection(q) {
            const fc = a => ({ type: "FeatureCollection", features: a });
            const f = g => ({ type: "Feature", geometry: g, properties: {} });
            return Array.isArray(q) ? fc(q.filter(t => isObject(t) && t.type == "Feature")) :
                (q.type == "Topology") ? topo2geo(q) :
                (q.type == "FeatureCollection") ? q :
                (q.type == "Feature") ? fc([q]) :
                (q.type == "GeometryCollection") ? fc(q.map(f)) : fc([]);
        }
    }
}
// --- Prototype Extensions ---
async function save() {
    const server = await getServer();
    const name = await server.save(this);
    return name? this: null;
}
async function encoder(type, pbf) {
    const workerUrl = new URL(`../worker/${type}enc.js`, import.meta.url);
    const w = new Worker(workerUrl, { type: 'module' });
    return new Promise(resolve => {
        w.onmessage = e => { w.terminate(); resolve(e.data); };
        w.postMessage({ arraybuffer: pbf.arrayBuffer, name: pbf._name });
    });
}
const gz = (flag,file) => flag? gzip(file):file;
async function pbfFile(flag) { return gz(flag, new File([this.arrayBuffer], this._name + ".pbf", { type: "application/x-geopbf" })); }
async function geojsonFile(flag) {
    const a = [`{"type":"FeatureCollection","name":"${this._name}","features":[`, ...this.fmap.map((_, i) => (i ? "," : "") + JSON.stringify(this.getFeature(i))), ']}'];
    return gz(flag, new File(a, this._name + ".geojson", { type: "application/json" }));
}
async function topojsonFile(flag) { return gz(flag, new File([JSON.stringify(this.topojson)], this._name + ".topojson", { type: "application/json" })); }
async function shape() { return encoder("shp", this); }
async function kmz(flag) { return gz(flag, await encoder("kmz", this)); }
async function gml(flag) { return gz(flag, await encoder("gml", this)); }

[save, pbfFile, geojsonFile, topojsonFile, shape, kmz, gml].forEach(func => {
    Object.defineProperty(PBF.prototype, func.name, { value: func, configurable: false, enumerable: false });
});