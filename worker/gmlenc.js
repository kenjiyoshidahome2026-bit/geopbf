import {PBF} from "../src/pbf-extension.js";
import {encodeZIP} from "../../native-bucket/src/encodeZIP.js";

self.onmessage = async (e) => {
    const { arraybuffer, name } = e.data;
    console.log(`--------------------------\n    PBF => GML (ZIP)\n--------------------------`);

    const pbf = await new PBF().name(name).set(arraybuffer);
    
    const pos = (c) => `${c[1]} ${c[0]}`;
    const posList = (coords) => coords.map(c => `${c[1]} ${c[0]}`).join(" ");

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;

    let count = 0;
    pbf.fmap.forEach((t, i) => {
        const f = pbf.getFeature(i);
        const fid = f.id || `f${i}`;
        
        xml += `  <gml:featureMember>\n    <gml:GenericFeature gml:id="${fid}">\n`;
        
        // ジオメトリ変換
        const {type, coordinates: c} = f.geometry;
        xml += `      <gml:geometryProperty>\n`;
        if (type === "Point") {
            xml += `        <gml:Point gml:id="p${i}"><gml:pos>${pos(c)}</gml:pos></gml:Point>\n`;
        } else if (type === "LineString") {
            xml += `        <gml:LineString gml:id="l${i}"><gml:posList>${posList(c)}</gml:posList></gml:LineString>\n`;
        } else if (type === "Polygon") {
            xml += `        <gml:Polygon gml:id="s${i}">\n`;
            c.forEach((ring, j) => {
                const tag = j === 0 ? "exterior" : "interior";
                xml += `          <gml:${tag}><gml:LinearRing><gml:posList>${posList(ring)}</gml:posList></gml:LinearRing></gml:${tag}>\n`;
            });
            xml += `        </gml:Polygon>\n`;
        }
        xml += `      </gml:geometryProperty>\n`;

        // 属性
        for (const [key, val] of Object.entries(f.properties)) {
            if (val !== null && typeof val !== 'object' && key !== "id") {
                const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
                xml += `      <${safeKey}>${val}</${safeKey}>\n`;
            }
        }
        
        xml += `    </gml:GenericFeature>\n  </gml:featureMember>\n`;
    });

    xml += `</gml:FeatureCollection>`;

    // KMZ(ZIP)と同様に、ZIPに包んでFileとして返す
    const gmlFile = new File([xml], `${name}.gml`, { type: "application/gml+xml" });
    const zipFile = await encodeZIP([gmlFile], `${name}_gml.zip`);

    console.log(" => Done : ", zipFile.name, zipFile.size.toLocaleString(), "bytes");
    self.postMessage(zipFile);
};