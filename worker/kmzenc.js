import {PBF} from "../src/pbf-extension.js";
import {encodeZIP} from "../../native-bucket/src/encodeZIP.js";

self.onmessage = async (e) => {
    const { arraybuffer, name } = e.data;
    console.log(`--------------------------\n    PBF => KMZ\n--------------------------`);

    const pbf = await new PBF().name(name).set(arraybuffer);
    const zipFiles = []; // encodeZIP に渡す File オブジェクト配列
    const iconMap = new Map();
    let iconCount = 0;

    const toKmlColor = (rgba) => {
        if (!rgba) return "ffffffff";
        const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return "ffffffff";
        const f = (n) => Math.round(n).toString(16).padStart(2, '0');
        const a = f((m[4] === undefined ? 1 : parseFloat(m[4])) * 255);
        return `${a}${f(m[3])}${f(m[2])}${f(m[1])}`;
    };

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n\t<name>${name}</name>\n`;

    pbf.fmap.forEach((t, i) => {
        const feat = pbf.getFeature(i);
        const props = feat.properties;
        kml += `\t<Placemark>\n`;
        if (props.name) kml += `\t\t<name>${props.name}</name>\n`;
        
        // アイコン処理 (Blobがある場合)
        if (props.icon instanceof Blob) {
            let fname = iconMap.get(props.icon);
            if (!fname) {
                fname = `files/icon_${iconCount++}.png`;
                iconMap.set(props.icon, fname);
                zipFiles.push(new File([props.icon], fname, { type: props.icon.type }));
            }
            kml += `\t\t<Style><IconStyle><Icon><href>${fname}</href></Icon></IconStyle></Style>\n`;
        }

        // ジオメトリ変換 (簡略化して記述)
            kml += `\t\t<ExtendedData>\n`;
        for (let key in props) {
            if (["name", "description", "style", "icon", "bbox"].includes(key)) continue;
            const val = typeof props[key] === 'object' ? JSON.stringify(props[key]) : props[key];
            kml += `\t\t\t<Data name="${key}"><value>${val}</value></Data>\n`;
        }
        kml += `\t\t</ExtendedData>\n`;

        kml += `\t\t${toKmlGeom(feat.geometry)}\n`;
        kml += `\t</Placemark>\n`;
    });
    kml += `</Document>\n</kml>`;
    zipFiles.unshift(new File([kml], `${name}.kml`, { type: "application/vnd.google-earth.kml+xml" }));

    console.log(`preparing deflation...`);
    const file = await encodeZIP(zipFiles, name + ".kmz");
    console.log(" => Done : ", file.name, file.size.toLocaleString(), "bytes");
    self.postMessage(file);
};