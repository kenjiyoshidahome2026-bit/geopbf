import {PBF} from "./pbf-extension.js";
import {pbfio} from "./pbf-io.js";
import {Logger} from "./logger.js";
import {topo2geo} from "./topo2geo.js";
const logger = new Logger();
let server = null;
(async () => {server = await pbfio("GIS").catch(e => { logger.warn("PBFIO initialization failed. Caching will be disabled.", e); return null; });})();
//const server = await pbfio("GIS").catch(e => { logger.warn("PBFIO initialization failed. Caching will be disabled.", e); return null; });
////===========================================================================================================
export async function geopbf(data, options = {}) {
    const isString = _ => (typeof _ == "string");
    const isObject = _ => (Object.prototype.toString.call(_) === '[object Object]'||Array.isArray(_));
    const isBuffer = _ => (_ instanceof ArrayBuffer||ArrayBuffer.isView(_));
    const isFile = _ => (_ instanceof Blob && ("name" in _));
    const isURL = _ => (_.match(/^https?\:\/\//));
    const isInZip = _ => (_.match(/.+\.zip#.+/i));
    const isPBF = _ => (_ instanceof PBF);
    if (isString(options)) options = {name:options};
    logger.title("geopbf");
    const pbf = await _geopbf(data);
    pbf && logger.success(`geopbf: ${pbf.name} (${pbf.size.toLocaleString()} bytes)`);
    return pbf || new PBF(options);
    async function _geopbf(q) {
        if (q === undefined || q === null) {
            console.warn("geopbf: no data provided. Returning empty PBF.");
            return null;
        }
        if (isPBF(q)) return q;
        if (isBuffer(q)) return new PBF(options).set(q);
        if (isObject(q)) {
            logger.pbf(`reading from json object`);
            q = toFeatureCollection(q);
            if (q && q.features.length > 0) return await new PBF(options).set(q);
            logger.warn("illegal object");
            return null;
        }
        if (isFile(q)) { const name = q.name;
            logger.pbf(`reading from file: ${name}`);
            options.name = options.name || name.replace(/\.[^\.]+$/,"");
            if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
            else if (name.match(/\.(geo|topo)?json$/i)||(options.type=="json")) return _geopbf(await file2json(q));
            else if (name.match(/\.zip$/i)||(options.type=="zip")) return _geopbf(await shape2pbf(q));
            else if (name.match(/\.kmz$/i)) return _geopbf(await kmz2pbf(q));
            else if (name.match(/\.xml$/i)) return _geopbf(await gmldec(q));
            else if (name.match(/\.gz(ip)?$/i)) return _geopbf(await gunzip(q));
            else logger.error("illegal File: ", q);
        }
        if (isString(q) && server) {
            if (isURL(q)) { const usecache = !options.nocache;
                logger.pbf(`reading from url: ${q}`);
                if (isInZip(q)) return _geopbf(await server.fetch(q, usecache));
                else if (q.match(/\.zip$/) && options.target) return _geopbf(await server.fetch([q, options.target].join("#"), usecache));
                else return _geopbf(await server.fetch(q, usecache));
            }
            logger.pbf(`reading from server: ${q}`);
            const pbf = await server.load(q);
            if(!pbf) logger.warn(`PBF "${q}" not found in server.`);
            return _geopbf(pbf);
        }
        console.warn("geopbf: illegal data provided. Returning empty PBF.");
        return null;
        async function file2json(file) {
            const json = toFeatureCollection(JSON.parse(await file.text()));
            json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/,"");
            return json;
        }
        async function gunzip(file) { const name = file.name.replace(/\.(gz|gzip)$/i,"");
            const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
            return new File([await new Response(stream).blob()], name, {type:"application/octet-stream"});
        }
        async function shape2pbf(file) {
            const worker = new Worker(new URL('../worker/shpdec.js', import.meta.url), { type: 'module' });
            const encoding = (options.encoding||"utf8").toLowerCase().replace(/[\-\_]/g,"").replace(/shiftjis/,"sjis");
            const precision = options.precision || 6;
            return new Promise(resolve=>{
                worker.onmessage = async e => resolve(e.data? await new PBF().set(e.data): null);
                worker.postMessage({file, encoding, precision});
            });
        }
        async function kmz2pbf(file) {
            const worker = new Worker(new URL('../worker/kmzdec.js', import.meta.url), { type: 'module' });
            const precision = options.precision || 6;
            return new Promise(resolve => {
                worker.onmessage = async e => resolve(e.data ? await new PBF().set(e.data.data) : null);
                worker.postMessage({ file, precision });
            });
        }
        async function gmldec(file) {
            const worker = new Worker(new URL('../worker/gmldec.js', import.meta.url), { type: 'module' });
            const precision = options.precision || 6;
            return new Promise(resolve => {
                worker.onmessage = async e => resolve(e.data ? await new PBF().set(e.data) : null);
                worker.postMessage({ file, precision });
            });
        }
        function toFeatureCollection(q) {
            const fc = a => ({type:"FeatureCollection", features:a});
            const f = g => ({type:"Feature", geometry:g, properties:{}});
            return Array.isArray(q)? fc(q.filter(t=>isObject(t) && t.type=="Feature")):
            (q.type == "Topology")? topo2geo(q):
            (q.type == "FeatureCollection")? q:
            (q.type == "Feature")? fc([q]):
            (q.type == "GeometryCollection")?fc(q.map(f)): fc([]);
        }
    }
}
////===========================================================================================================
//// I/O & Export
////===========================================================================================================
const setPrototype = func => {  const proto = PBF.prototype || {}, name = func.name;
    (name in proto) || Object.defineProperty(proto, name, { value: func, configurable: false, enumerable: false});
};
[pbfFile, geojsonFile, topojsonFile, shape, pbf2kmz, pbf2gml].forEach(setPrototype);
async function pbfFile(flag) {
    return gz(flag, new File([this.arrayBuffer], (this._name)+".pbf", {type:"application/octet-stream"})); 
}
async function geojsonFile(flag) {
    const a = this.fmap.map((t, i) => (i ? "," : "") + JSON.stringify(this.getFeature(i)));
    a.unshift(`{"type":"FeatureCollection","name":"${this._name}","features":[`); 
    a.push(']}');
    return gz(flag, new File(a, this._name+".geojson", {type:"application/json"})); 
}
async function topojsonFile(flag) {
    return gz(flag, new File([JSON.stringify(this.topojson)], this._name+".topojson", {type:"application/json"})); 
}
async function shape(options = {}) {
    const worker = new Worker(new URL('../worker/shpenc.js', import.meta.url), { type: 'module' });
    const arrayBuffer = this.arrayBuffer, name = this._name;
    const encoding = (options.encoding||"utf8").toLowerCase().replace(/[\-\_]/g,"").replace(/shiftjis/,"sjis");
    const level = options.level || 3;
    return new Promise(resolve=>{
        worker.onmessage = async e => resolve(e.data? await new PBF().set(e.data): null);
        worker.postMessage({arrayBuffer, name, encoding, level});
    });
}
async function pbf2kmz(pbf, name) {
    const worker = new Worker(new URL('../worker/kmzenc.js', import.meta.url), { type: 'module' });
    return new Promise(resolve => {
        worker.onmessage = e => resolve(e.data);
        worker.postMessage({ arraybuffer: pbf.arrayBuffer, name });
    });
}
async function pbf2gml(pbf, name) {
    const worker = new Worker(new URL('../worker/gmlenc.js', import.meta.url), { type: 'module' });
    return new Promise(resolve => {
        worker.onmessage = e => resolve(e.data);
        worker.postMessage({ arraybuffer: pbf.arrayBuffer, name });
    });
}
async function file(options = {}) {
    const self = this, gzip = !!options.gzip;
    return options.format == "shape" ? await self.shapeFile(options) :
            options.format == "geojson" ? await self.geojsonFile(gzip) :
            options.format == "topojson" ? await self.topojsonFile(gzip) : 
            await self.pbfFile(gzip);
}


// setPrototype(PBF, "put", async function(tub) { return (tub || PBF.io || (PBF.io = await pbfio())).put(this); });
// setPrototype(PBF, "get", async function(name, tub) {
//     var buf = await (tub || PBF.io || (PBF.io = await pbfio())).get(name, true);
//     await this.empty(); 
//     return this.set(buf);
// });
// setPrototype(PBF, "save", async function(tub) { return (tub || PBF.io || (PBF.io = await pbfio())).save(this); });
// setPrototype(PBF, "load", async function(name, tub) { 
//     var buf = await (tub || PBF.io || (PBF.io = await pbfio())).load(name, true);
//     await this.empty(); 
//     return this.set(buf);
// });