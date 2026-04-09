import { worker } from "./worker.js"; // src/ 内のユーティリティをインポート
import { PBF } from "./pbf-extension.js"; //
import { pbfio } from "./pbf-io.js"; //
import { Logger } from "./logger.js"; //
import { topo2geo } from "./topo2geo.js"; //
// native-bucket から gzip 機能をインポート
import { gzip, gunzip, isGzip } from "../../native-bucket/src/gzip.js";

const logger = new Logger();
let serverPromise = null;

/**
 * PBFIO の初期化を待機する内部関数
 */
async function getServer() {
    if (!serverPromise) {
        serverPromise = pbfio("GIS").catch(e => {
            logger.warn("PBFIO initialization failed. Caching will be disabled.", e);
            return null;
        });
    }
    return await serverPromise;
}

/**
 * メイン関数: あらゆる GIS データを PBF オブジェクトに変換
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
        if (q === undefined || q === null) {
            logger.warn("geopbf: no data provided.");
            return null;
        }
        if (isPBF(q)) return q;
        if (isBuffer(q)) return new PBF(options).set(q);
        
        if (isObject(q)) {
            logger.pbf(`reading from json object`);
            q = toFeatureCollection(q);
            return (q && q.features.length > 0) ? await new PBF(options).set(q) : null;
        }

        if (isFile(q)) {
            const name = q.name;
            logger.pbf(`reading from file: ${name}`);

            if (await isGzip(q)) {
                logger.log("Gzip detected.");
                return _geopbf(await gunzip(q));
            }           

            options.name = options.name || name.replace(/\.[^\.]+$/, "");

            if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
            if (name.match(/\.(geo|topo)?json$/i)) return _geopbf(await file2json(q));
            
            // 各種 Worker デコーダーの実行
            if (name.match(/\.zip$/i)) return _geopbf(await decoder("shp", q));
            if (name.match(/\.kmz$/i)) return _geopbf(await decoder("kmz", q));
            if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
            if (name.match(/\.gz(ip)?$/i)) return _geopbf(await gunzip(q));
        }

        const server = await getServer();
        if (isString(q) && server) {
            const usecache = !options.nocache;
            if (isURL(q)) {
                logger.pbf(`reading from url: ${q}`);
                const fetchUrl = isInZip(q) ? q : (q.match(/\.zip$/) && options.target) ? [q, options.target].join("#") : q;
                return _geopbf(await server.fetch(fetchUrl, usecache));
            }
            logger.pbf(`reading from server: ${q}`);
            return _geopbf(await server.load(q));
        }
        return null;

        async function file2json(file) {
            if (file.size > 100 * 1024 * 1024) {
                logger.pbf(`Big GeoJSON detected. Using worker for parsing.`);
                // worker ユーティリティを使用してパースをバックグラウンド化
                const json = await worker(async (f) => JSON.parse(await f.text()), file);
                return toFeatureCollection(json);
            }
            try {
                const json = toFeatureCollection(JSON.parse(await file.text()));
                json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
                return json;
            } catch (e) {
                logger.error("JSON parse error", e);
                return null;
            }
        }

        /**
         * worker ユーティリティを使用して外部ファイルを呼び出す
         */
        async function decoder(type, file) {
            const precision = options.precision || 6;
            const encoding = (options.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
            const workerUrl = new URL(`../worker/${type}dec.js`, import.meta.url).href;
            
            // worker ユーティリティに「Workerを生成してメッセージを待つ関数」を渡して実行
            const result = await worker(async (url, params) => {
                const w = new Worker(url, { type: 'module' });
                return new Promise(resolve => {
                    w.onmessage = e => { w.terminate(); resolve(e.data); };
                    w.postMessage(params);
                });
            }, [workerUrl, { file, precision, encoding }]);
            
            return result ? new PBF(options).set(result) : null;
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

// ===========================================================================================================
// PBF Prototype 拡張
// ===========================================================================================================

async function gz(flag, file) { return flag ? gzip(file) : file; }

/**
 * Worker エンコーダーの呼び出し
 */
async function encoder(type, pbf) {
    const workerUrl = new URL(`../worker/${type}enc.js`, import.meta.url).href;
    
    // worker ユーティリティを利用
    return await worker(async (url, params) => {
        const w = new Worker(url, { type: 'module' });
        return new Promise(resolve => {
            w.onmessage = e => { w.terminate(); resolve(e.data); };
            w.postMessage(params);
        });
    }, [workerUrl, { arraybuffer: pbf.arrayBuffer, name: pbf._name }]);
}

async function save() {
    const server = await getServer();
    if (!server) return;
    const name = await server.save(this);
    return name ? await server.load(name) : null;
}

async function pbfFile(flag) {
    return gz(flag, new File([this.arrayBuffer], (this._name) + ".pbf", { type: "application/x-geopbf" })); 
}

async function geojsonFile(flag) {
    const a = this.fmap.map((t, i) => (i ? "," : "") + JSON.stringify(this.getFeature(i)));
    a.unshift(`{"type":"FeatureCollection","name":"${this._name}","features":[`); 
    a.push(']}');
    return gz(flag, new File(a, this._name + ".geojson", { type: "application/json" })); 
}

async function topojsonFile(flag) {
    return gz(flag, new File([JSON.stringify(this.topojson)], this._name + ".topojson", { type: "application/json" })); 
}

async function shape() { return encoder("shp", this); }
async function kmz(flag) { return gz(flag, await encoder("kmz", this)); }
async function gml(flag) { return gz(flag, await encoder("gml", this)); }

// PBF クラスのプロトタイプに一括登録
[save, pbfFile, geojsonFile, topojsonFile, shape, kmz, gml].forEach(func => { 
    const proto = PBF.prototype || {};
    if (!(func.name in proto)) {
        Object.defineProperty(proto, func.name, { value: func, configurable: false, enumerable: false });
    }
});