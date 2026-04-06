import {PBF} from "./pbf-extension.js";
import {pbfio} from "./pbf-io.js";
import {worker} from "./worker.js";
import {Logger} from "./logger.js";
import {topo2geo} from "./topo2geo.js";
const logger = new Logger();
const server = await pbfio("GIS/pbfDB").catch(e => { logger.warn("PBFIO initialization failed. Caching will be disabled.", e); return null; });
////===========================================================================================================
export async function geopbf(data, options = {}) {
    const isString = _ => (typeof _ == "string");
    const isObject = _ => (Object.prototype.toString.call(_) === '[object Object]'||Array.isArray(_));
    const isBuffer = _ => (_ instanceof ArrayBuffer||ArrayBuffer.isView(_));
    const isFile = _ => (_ instanceof Blob && ("name" in _));
    const isURL = _ => (isString(_) && _.match(/^https?\:\/\//));
    const isInZip = _ => (isString(_) && _.match(/.+\.zip#.+/i));
    const isPBF = _ => (_ instanceof PBF);
    if (isString(options)) options = {name:options};
    logger.title("geopbf");
    const pbf = await _geopbf(data);
    logger.success(`geopbf: ${pbf.name} (${pbf.size.toLocaleString()} bytes)`);
    return pbf;
    async function _geopbf(q) {
        if (q === undefined || q === null) return new PBF(options);
        if (isPBF(q)) return q;
        if (isBuffer(q)) return new PBF(options).set(q);
        if (isObject(q)) {
            logger.info("pbf",`reading from json object`)
            q = toFeatureCollection(q); q.features.length == 0 && logger.warn("illegal object", q);
            return await new PBF(options).set(q);
        }
        if (isFile(q)) { const name = q.name;
            logger.info("pbf",`reading from file: ${name}`)
            options.name = options.name || name.replace(/\.[^\.]+$/,"");
            if (name.match(/\.pbf$/)) return _geopbf(await q.arrayBuffer());
            else if (name.match(/\.(geo|topo)?json$/)||(options.type=="json")) return _geopbf(await file2json(q));
            else if (name.match(/\.zip$/)||(options.type=="zip")) return _geopbf(await shape2pbf(q));
            else if (name.match(/\.gz(ip)?$/)) return _geopbf(await gunzip(q));
            else if (name.match(/\.xml$/)) return _geopbf(await gmldec(q));
            else logger.error("illegal File: ", q);
        }
        if (isURL(q)) { logger.info("pbf",`reading from url: ${q}`);
            if (isInZip(q)) { const [url, target] = q.split("#"); return _geopbf(await zip2file(url, target)); }
            else if (q.match(/\.zip$/) && options.target) return _geopbf(await zip2file(q, options.target));
            const loaded = await Cache("GIS/loaded");
            let blob = options.nocache? null: await loaded(q);
            if (!blob) { await loaded(q, blob = await Fetch(q)); }
            const fname = options.name || q.split("/").reverse()[0];
            return _geopbf(new File([blob], fname, {type:"application/octet-stream"}));
        }
        if (isString(q) && server) { var pbf = await server.load(q); if(pbf) return pbf; }
        return new PBF(options);
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
            return worker(shpdec, [file, options.encoding||"utf8", options.precision||6]);
        }
        async function zip2file(url, target) {
            const f = await unzipit(url, {filter:target, cors:true, save:true});
            return f[0];
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