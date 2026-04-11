import { PBF } from "../src/pbf-base.js";
import * as topojson from 'https://esm.sh/topojson-server@3';

self.onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new PBF().name(name).set(buf);
        const feats = [];
        for (let i = 0, len = pbf.length; i < len; i++) feats.push(pbf.getFeature(i));

        const topo = topojson.topology({ [name]: { type: "FeatureCollection", features: feats } });
        const resStr = JSON.stringify(topo);

        let res = resStr;
        if (gz) {
            const out = new Response(new Blob([resStr]).stream().pipeThrough(new CompressionStream("gzip")));
            res = await out.blob();
        }

        self.postMessage(new File([res], `${name}.topojson${gz ? ".gz" : ""}`, {
            type: gz ? "application/gzip" : "application/json"
        }));
    } catch (err) { self.postMessage(null); }
};