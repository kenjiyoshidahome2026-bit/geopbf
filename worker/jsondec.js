import { PBF } from "../src/pbf-base.js";

// ストリーム用の Feature 抽出ヘルパー
async function streamGeoJSON(file, callback) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const featurePattern = /\{\s*"type"\s*:\s*"Feature"/gi;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let lastIndex = 0;
        const matches = [...buffer.matchAll(featurePattern)];
        for (let i = 0; i < matches.length - 1; i++) {
            const start = matches[i].index;
            const nextStart = matches[i + 1].index;
            const jsonStr = buffer.substring(start, nextStart).trim().replace(/,$/, "");
            try { callback(JSON.parse(jsonStr)); } catch (e) {}
            lastIndex = nextStart;
        }
        if (lastIndex > 0) buffer = buffer.substring(lastIndex);
    }
    const finalMatch = buffer.match(featurePattern);
    if (finalMatch) {
        const lastPart = buffer.substring(finalMatch.index).replace(/\s*\]\s*\}\s*$/, "").replace(/,$/, "");
        try { callback(JSON.parse(lastPart)); } catch (e) {}
    }
}

self.onmessage = async (e) => {
    const { file, precision } = e.data;
    const LIMIT = 100 * 1024 * 1024; // 100MB
    const useStream = file.size > LIMIT;

    console.log(`[jsondec] Mode: ${useStream ? 'Stream' : 'FastParse'} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    const keytub = { "bbox": true };
    const pbf = new PBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });

    if (!useStream) {
        // --- 通常のパース (100MB以下) ---
        const json = JSON.parse(await file.text());
        const features = json.features || (Array.isArray(json) ? json : [json]);
        
        // Pass 1: キー収集
        features.forEach(f => {
            if (f.properties) Object.keys(f.properties).forEach(k => keytub[k] = true);
        });
        
        pbf.setHead(Object.keys(keytub).sort());
        
        // Pass 2: 書き込み
        pbf.setBody(() => features.forEach(f => pbf.setFeature(f)));
    } else {
        // --- ストリームパース (100MB超) ---
        // Pass 1: キー収集
        await streamGeoJSON(file, (f) => {
            if (f.properties) Object.keys(f.properties).forEach(k => keytub[k] = true);
        });

        pbf.setHead(Object.keys(keytub).sort());

        // Pass 2: 書き込み
        pbf.setBody(async () => {
            await streamGeoJSON(file, (f) => pbf.setFeature(f));
        });
    }

    pbf.close();
    self.postMessage({ type: "jsondec", data: pbf.arrayBuffer }, [pbf.arrayBuffer]);
};