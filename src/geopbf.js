import {PBF} from "./pbf-extension.js";
import {worker} from "./worker.js";
import {Logger} from "./logger.js";
import {topo2geo} from "./topo2geo.js";
const isString = _ => (typeof _ == "string");
const isObject = _ => (Object.prototype.toString.call(_) === '[object Object]'||Array.isArray(_));
const isBuffer = _ => (_ instanceof ArrayBuffer||ArrayBuffer.isView(_));
const isFile = _ => (_ instanceof Blob && ("name" in _));
const isURL = _ => (isString(_) && _.match(/^https?\:\/\//));
const isPBF = _ => (_ instanceof PBF);
////===========================================================================================================
const logger = new Logger();
const set = (obj, name, value) => {
    if (typeof name == "string") {
        (name in obj) || Object.defineProperty(obj, name, { value, configurable: false, enumerable: false});
    } else Object.entries(name).map(t=>set(obj, ...t))
}
////===========================================================================================================
export async function geopbf(q, options = {}) {
    logger.title("geopbf");
    const pbf = await _geopbf(q, options);
    logger.success("geopbf");
    return pbf;
    async function _geopbf(q, options = {}) {
        if (isString(options)) options = {name:options};
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
            if (name.match(/\.pbf$/)) return _geopbf(await q.arrayBuffer(), options);
            else if (name.match(/\.(geo|topo)?json$/)||(options.type=="json")) return _geopbf(await file2json(q), options);
            else if (name.match(/\.zip$/)||(options.type=="zip")) return _geopbf(await shape2pbf(q), options);
            else if (name.match(/\.gz(ip)?$/)) return _geopbf(await gunzip(q), options);
            else if (name.match(/\.xml$/)) return _geopbf(await gmldec(q), options);
            else logger.error("illegal File: ", q);
        }
        if (isURL(q)) { logger.info("pbf",`reading from url: ${q}`);
            const loaded = await CacheIO("pbfDB/loaded");
            var blob = options.nocache? null: await loaded(q);
            if (!blob) { await loaded(q, blob = await Fetch(q)); }
            var fname = options.name || q.split("/").reverse()[0];
            return (fname.match(/\.zip$/) && options.target)?
                _geopbf(await zip2file(q, options.target), options):
                _geopbf(new File([blob], fname, {type:"application/octet-stream"}), options);
        }
        if (isString(q) && PBF.io) { var pbf = await PBF.io.get(q)||await PBF.io.load(q); if(pbf) return pbf; }
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