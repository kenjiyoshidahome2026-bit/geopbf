import {PBF} from "../src/pbf-extension.js";
import {decodeZIP} from "../../native-bucket/src/decodeZIP.js";

// ヘルパー: タグの中身を1つずつ見つける (メモリ節約用イテレータ)
function* getTags(src, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(src)) !== null) yield match[1];
}

// ヘルパー: タグ内の属性値を取得
const getAttr = (src, attr) => {
    const match = new RegExp(`${attr}=["']([^"']*)["']`, 'i').exec(src);
    return match ? match[1] : null;
};

// ヘルパー: KMLカラー変換
const kmlColor = (c) => {
    if (!c || c.length !== 8) return null;
    const a = parseInt(c.substring(0, 2), 16) / 255;
    const b = parseInt(c.substring(2, 4), 16);
    const g = parseInt(c.substring(4, 6), 16);
    const r = parseInt(c.substring(6, 8), 16);
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
};

self.onmessage = async (e) => {
    const { file, precision } = e.data;
    console.log(`--------------------------\n    KMZ/KML => PBF\n--------------------------`);

    let kmlStr = null;
    const resourceMap = {};

    // 1. native-bucket で ZIP 展開
    if (file.name.match(/\.kmz$/i)) {
        const entries = await decodeZIP(file); // File[] が返る
        for (const f of entries) {
            if (f.name.match(/\.kml$/i)) kmlStr = await f.text();
            else if (f.name.match(/\.(png|jpg|jpeg|gif)$/i)) resourceMap[f.name] = f;
        }
    } else {
        kmlStr = await file.text();
    }

    if (!kmlStr) return null;

    // 2. パス1: プロパティキーの全収集 (メモリ節約のため先にキーを確定させる)
    const keytub = { "bbox": true, "name": true, "description": true, "style": true, "icon": true };
    for (const pm of getTags(kmlStr, "Placemark")) {
        const extData = [...getTags(pm, "ExtendedData")][0];
        if (extData) {
            for (const d of getTags(extData, "Data")) {
                const k = getAttr(d, "name");
                if (k) keytub[k] = true;
            }
        }
    }

    // 3. パス2: 地物のパースとPBF書き込み
    const pbf = new PBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });
    pbf.setHead(Object.keys(keytub).sort());

    pbf.setBody(() => {
        for (const pm of getTags(kmlStr, "Placemark")) {
            const props = {};
            const name = [...getTags(pm, "name")][0]; if (name) props.name = name;
            const desc = [...getTags(pm, "description")][0]; if (desc) props.description = desc;
            
            // ジオメトリパース (簡略化)
            const parseCoords = s => (s||"").trim().split(/[\s\n\t]+/).map(p => p.split(',').map(Number)).filter(c => c.length >= 2);
            let geometry = null;
            const pt = [...getTags(pm, "Point")][0];
            const ls = [...getTags(pm, "LineString")][0];
            const py = [...getTags(pm, "Polygon")][0];

            if (pt) geometry = { type: "Point", coordinates: parseCoords([...getTags(pt, "coordinates")][0])[0] };
            else if (ls) geometry = { type: "LineString", coordinates: parseCoords([...getTags(ls, "coordinates")][0]) };
            else if (py) {
                const outer = [...getTags([...getTags(py, "outerBoundaryIs")][0]||"", "coordinates")][0];
                const rings = [parseCoords(outer)];
                for (const inner of getTags(py, "innerBoundaryIs")) {
                    rings.push(parseCoords([...getTags(inner, "coordinates")][0]));
                }
                geometry = { type: "Polygon", coordinates: rings };
            }

            if (geometry) pbf.setFeature({ type: "Feature", geometry, properties: props });
        }
    });

    pbf.close();
    console.log(" => Done : ", pbf.arrayBuffer.byteLength, "bytes");
    self.postMessage({ type: "kmzdec", data: pbf.arrayBuffer }, [pbf.arrayBuffer]);
};