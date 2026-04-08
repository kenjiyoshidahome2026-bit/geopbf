import { PBF } from "../src/pbf-base.js";
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
    const pbf = new PBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });
    await streamGeoJSON(file, f => f.properties && Object.keys(f.properties).forEach(k => keytub[k] = true));
    pbf.setHead(Object.keys(keytub).sort());
    pbf.setBody(async () => await streamGeoJSON(file, f => pbf.setFeature(f)));
    pbf.close();
    self.postMessage({ type: "jsondec", data: pbf.arrayBuffer }, [pbf.arrayBuffer]);
};