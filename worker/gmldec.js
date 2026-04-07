async function gmldec(file) {debugger
    const SCAN_SIZE = 4 * 1024 * 1024; // 最後4MBを読み込む
    const offset = Math.max(0, file.size - SCAN_SIZE);
    const blob = file.slice(offset, file.size);
    const text = await blob.text();

    // 地物（ksj:***）の開始タグを探す
    // ※ <ksj:Dataset> 以外のタグを見つける
    const featureStartRegex = /<(ksj:(?!Dataset)[a-zA-Z0-9_]+)\s+gml:id="[^"]+">/g;
    let match = featureStartRegex.exec(text);
	console.log(match)
    if (!match) {
        // もし見つからなければ、ファイルの先頭も少し探す（データが小さい場合用）
        return []; 
    }

    const tagName = match[1]; // 例: "ksj:AdministrativeBoundary"
    const startIdx = match.index;
    const endTag = `</${tagName}>`;
    const endIdx = text.indexOf(endTag, startIdx);

    if (endIdx === -1) return [];

    // 地物1件分のXMLを抽出
    const segment = text.substring(startIdx, endIdx + endTag.length);
    const xmlDoc = new DOMParser().parseFromString(segment, "text/xml");
    const featureNode = xmlDoc.firstElementChild;

    if (!featureNode) return [];

    // 子要素のタグ名（localName）を順番通りに取得
    console.log(Array.from(featureNode.children).map(child => child.localName));
    return Array.from(featureNode.children).map(child => child.localName);
}
async function gmldecx(file, options = {}) {
    const prefixMatch = file.name.match(/([A-Z]\d{2})/i);
    const prefix = prefixMatch ? prefixMatch[1].toUpperCase() : "ATTR";
    const geometryCache = new Map();
    const uniqueTags = new Set();
    let featureTag = "";

    const parsePosList = (str) => {
        const raw = str.trim().split(/[\s\n\r]+/).map(Number);
        const res = [];
        for (let i = 0; i < raw.length; i += 2) {
            if (!isNaN(raw[i])) res.push([raw[i + 1], raw[i]]);
        }
        return res;
    };

    // ---------------------------------------------------------name
    // PASS 1: スキーマ・座標解析 (Datasetをスルーする)
    // ---------------------------------------------------------
    await robustStream(file, (chunk) => {
        // 1. 座標キャッシュ
        const geoMatches = chunk.matchAll(/<(gml:(?:Surface|Curve|Point|MultiCurve|MultiSurface))\s+gml:id="([^"]+)">([\s\S]+?)<\/\1>/g);
        for (const m of geoMatches) {
            const posLists = [...m[3].matchAll(/<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/g)];
            if (posLists.length > 0) {
                geometryCache.set(m[2], posLists.flatMap(pl => parsePosList(pl[1])));
            } else {
                const pos = m[3].match(/<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/);
                if (pos) geometryCache.set(m[2], parsePosList(pos[1])[0]);
            }
        }

        // 2. 地物タグの特定 (Datasetという名前のタグは無視する)
        if (!featureTag) {
            const m = chunk.matchAll(/<ksj:([a-zA-Z0-9]+)\s+gml:id="/g);
            for (const found of m) {
                if (found[1] !== "Dataset") {
                    featureTag = found[1];
                    console.log(`[Cleanser] Feature Tag detected: ${featureTag}`);
                    break;
                }
            }
        }

        // 3. 属性タグ収集
        const tagMatches = chunk.matchAll(/<ksj:([a-zA-Z0-9]+)>([^<]+)<\/ksj:\1>/g);
        for (const m of tagMatches) {
            if (!["pos", "posList", "geometry", "position", "bounds", "location"].some(t => m[1].includes(t))) {
                uniqueTags.add(m[1]);
            }
        }
    });

    const sortedTags = Array.from(uniqueTags).sort();
    const tagToCode = new Map();
    const finalKeys = sortedTags.map((tag, i) => {
        const code = `${prefix}_${String(i + 1).padStart(3, '0')}`;
        tagToCode.set(tag, code);
        return code;
    });

    const pbf = new PBF({ name: options.name || file.name, precision: options.precision || 7 });
    pbf.init(); 
    pbf.setHead(finalKeys);

    // ---------------------------------------------------------
    // PASS 2: 地物構築 (正規表現を極限まで柔軟に)
    // ---------------------------------------------------------
    let count = 0;
    // タグ名との間に改行や余計な属性があっても拾えるように [^>]* を追加
    const fRegex = new RegExp(`<ksj:${featureTag}[^>]*?gml:id="([^"]+)"[^>]*?>([\\s\\S]*?)<\/ksj:${featureTag}>`, "g");

    await robustStream(file, (chunk) => {
        let fMatch;
        while ((fMatch = fRegex.exec(chunk)) !== null) {
            const xml = fMatch[2];
            const props = {};
            
            // 属性
            const tRegex = /<ksj:([a-zA-Z0-9]+)>([^<]+)<\/ksj:\1>/g;
            let tMatch;
            while ((tMatch = tRegex.exec(xml)) !== null) {
                const code = tagToCode.get(tMatch[1]);
                if (code) props[code] = tMatch[2].trim();
            }

            // 座標参照 (シングルクォートやID内のエスケープにも対応)
            const ref = xml.match(/xlink:href=["']#([^"']+)["']/);
            if (ref) {
                const coords = geometryCache.get(ref[1]);
                if (coords) {
                    const isPoint = !Array.isArray(coords[0]);
                    pbf.setFeature({
                        type: "Feature", properties: props,
                        geometry: { type: isPoint ? "Point" : "Polygon", coordinates: isPoint ? coords : [coords] }
                    });
                    count++;
                }
            }
        }
    });

    console.log(`%c[GML-Refiner] 成功: ${count} 件の地物を処理しました。`, "color: #28a745; font-weight: bold;");
	pbf.getPosition()
    pbf.close();
//	console.log(" => Done : ", pbf.arrayBuffer);
	return pbf;
}

/**
 * ストリーミング：ksjの閉じタグを意識して分割
 */
async function robustStream(file, callback) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // ksj または gml の閉じタグ（>）までを確実にバッファに保持
        const lastTagIdx = buffer.lastIndexOf('>');
        if (lastTagIdx > 0 && buffer.length > 1024 * 512) { 
            callback(buffer.substring(0, lastTagIdx + 1));
            buffer = buffer.substring(lastTagIdx + 1);
        }
    }
    if (buffer) callback(buffer);
}

//{
//  "layer": "N03-240101",
//  "description": "行政区域(2024)",
//  "source": {
//	"organization": "国土交通省",
//	"dataset": "国土数値情報（行政区域）",
//	"version": "3.1",
//	"origin": "https://nlftp.mlit.go.jp/ksj/gml/data/.../.../....zip",
//	"document": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03.html"
//  },
//  "crs": "WGS84",
//  "schema": [
//	["key", "gml_tag"],
//	["N03_001", "prefectureName"],
//	["N03_004", "municipalityName"],
//	["N03_007", "administrativeAreaCode"]
//  ]
//}