import {PBF} from "../src/pbf-extension.js";
import {decodeZIP} from "../../native-bucket/src/decodeZIP.js";

// ヘルパー: タグ抽出イテレータ
function* getTags(src, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(src)) !== null) yield match[1];
}

const getAttr = (src, attr) => {
    const match = new RegExp(`${attr}=["']([^"']*)["']`, 'i').exec(src);
    return match ? match[1] : null;
};

self.onmessage = async (e) => {
    const { file, precision } = e.data;
    console.log(`--------------------------\n    GML => PBF\n--------------------------`);

    let gmlStr = "";
    if (file.name.match(/\.zip$/i)) {
        const entries = await decodeZIP(file);
        const gmlFile = entries.find(f => f.name.match(/\.gml$/i));
        if (!gmlFile) return;
        gmlStr = await gmlFile.text();
    } else {
        gmlStr = await file.text();
    }

    // --- Pass 1: ジオメトリキャッシュとキーの収集 ---
    const geometryCache = new Map();
    const keytub = { "bbox": true };
    
    // GMLの地物タグ（ksj:等）を特定
    const featureTagMatch = /<([^:>\s]+:[^:>\s]+)\s+gml:id="/.exec(gmlStr);
    const featureTag = featureTagMatch ? featureTagMatch[1] : null;
    
    // 座標定義（Surface, Curve等）のキャッシュ
    const geoRegex = /<(gml:(?:Surface|Curve|Point|MultiCurve|MultiSurface))\s+gml:id="([^"]+)">([\s\S]+?)<\/\1>/gi;
    let gMatch;
    while ((gMatch = geoRegex.exec(gmlStr)) !== null) {
        const id = gMatch[2];
        const posList = /<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(gMatch[3]);
        const pos = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(gMatch[3]);
        
        if (posList) {
            const coords = posList[1].trim().split(/[\s\n\r]+/).map(Number);
            const pts = [];
            for(let i=0; i<coords.length; i+=2) pts.push([coords[i+1], coords[i]]);
            geometryCache.set(id, pts);
        } else if (pos) {
            const c = pos[1].trim().split(/[\s\n\r]+/).map(Number);
            geometryCache.set(id, [c[1], c[0]]);
        }
    }

    // 属性キーの収集
    if (featureTag) {
        for (const pm of getTags(gmlStr, featureTag)) {
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                if (!aMatch[1].match(/(pos|geometry|location|bound)/i)) {
                    keytub[aMatch[1].replace(/:/g, '_')] = true;
                }
            }
        }
    }

    // --- Pass 2: PBF構築 ---
    const pbf = new PBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 7 });
    pbf.setHead(Object.keys(keytub).sort());

    pbf.setBody(() => {
        if (!featureTag) return;
        for (const pm of getTags(gmlStr, featureTag)) {
            const props = {};
            // 属性の抽出
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                const key = aMatch[1].replace(/:/g, '_');
                if (keytub[key]) props[key] = aMatch[2].trim();
            }

            // ジオメトリ参照の解決
            const ref = /xlink:href=["']#([^"']+)["']/.exec(pm);
            if (ref) {
                const coords = geometryCache.get(ref[1]);
                if (coords) {
                    const isPoint = !Array.isArray(coords[0]);
                    pbf.setFeature({
                        type: "Feature", properties: props,
                        geometry: { type: isPoint ? "Point" : "Polygon", coordinates: isPoint ? coords : [coords] }
                    });
                }
            }
        }
    });

    pbf.close();
    console.log(" => Done : ", pbf.arrayBuffer.byteLength, "bytes");
    self.postMessage({ type: "gmldec", data: pbf.arrayBuffer }, [pbf.arrayBuffer]);
};