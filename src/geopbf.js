import { PBF } from "./pbf-extension.js";
import { pbfio } from "./pbf-io.js";
import { Logger } from "./logger.js";
import { topo2geo } from "./topo2geo.js";
import { gunzip, isGzip } from "../../native-bucket/src/gzip.js";
const logger = new Logger();
//  ----------------------------------------------------------------------------------------
let serverPromise = null;
const getServer = async () => serverPromise || (serverPromise = pbfio("GIS")
        .catch(e => { logger.warn("PBFIO initialization failed.", e); return null; }));
//  ----------------------------------------------------------------------------------------
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
            const json = toFeatureCollection(JSON.parse(await file.text()));
            json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
            return json;
        }
        async function decoder(type, file) {
            const params = {
                file, // ArrayBuffer ではなく File オブジェクトをそのまま渡す
                precision: options.precision || 6,
                encoding: (options.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis")
            };
            const url = new URL(`../worker/${type}dec.js`, import.meta.url);
            const w = new Worker(url, { type: 'module' });
            return new Promise(resolve => {
                w.onmessage = async e => {
                    w.terminate();
                    // Worker からは arrayBuffer が返ってくるので、それを set する
                    resolve(e.data ? new PBF(options).set(e.data.data) : null);
                };
                w.onerror = () => { w.terminate(); resolve(null); };
                w.postMessage(params); // File オブジェクトの受け渡しはクローンにより安全
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
//  ---------------------------------------------------------------------------------------- Prototype Extensions 
const runEncoder = (pbf, type, gz, encoding) => {
    const url = new URL(`../worker/${type}enc.js`, import.meta.url)
    const w = new Worker(url, { type: 'module' });
    const name = pbf._name, buf = pbf.arrayBuffer; 
    return new Promise(resolve => { 
        w.onmessage = e => { w.terminate(); resolve(e.data); };
        w.onerror = () => { w.terminate(); logger.error(`encode error: [${type}]`); resolve(null); };
        w.postMessage({ buf, name, gz, encoding }, [buf]);
    });
};
const methods = {
    async save() { const s = await getServer(); return s && await s.save(this) ? this : null; },
    async pbfFile(flag) { return runEncoder(this, "pbf", flag); },
    async geojsonFile(flag) { return runEncoder(this, "json", flag); },
    async topojsonFile(flag) { return runEncoder(this, "topo", flag); },
    async shape(encoding = "utf8") { return runEncoder(this, "shp", false, encoding); },
    async kmz(flag = true) { return runEncoder(this, "kmz", flag); },//flag: true=>kmz, false=>kml
    async gml(flag) { return runEncoder(this, "gml", flag); }
};

Object.entries(methods).forEach(([name, func]) => {
    Object.defineProperty(PBF.prototype, name, { value: func, configurable: false, enumerable: false });
});