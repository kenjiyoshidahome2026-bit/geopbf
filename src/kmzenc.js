async function kmzenc(pbfBuffer, name) {
    const pbf = await new PBF().name(name).set(pbfBuffer);
    const zip = new JSZip();
    
    // 1. スタイルと画像の管理
    const iconManager = {
        map: new Map(), // blobUrl -> filename
        count: 0,
        get: function(blob) {
            if (!blob || !(blob instanceof Blob)) return null;
            if (this.map.has(blob)) return this.map.get(blob);
            const fname = `files/icon_${this.count++}.png`;
            this.map.set(blob, fname);
            zip.file(fname, blob);
            return fname;
        }
    };

    // 2. KMLの構築
    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    kml += `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n\t<name>${name}</name>\n`;

    // 内部ユーティリティ: RGBA -> AABBGGRR
    const toKmlColor = (rgba) => {
        if (!rgba) return "ffffffff";
        const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return "ffffffff";
        const f = (n) => Math.round(n).toString(16).padStart(2, '0');
        const a = f((m[4] === undefined ? 1 : parseFloat(m[4])) * 255);
        return `${a}${f(m[3])}${f(m[2])}${f(m[1])}`; // AABBGGRR
    };

    // ジオメトリ変換: GeoJSON -> KML
    const toKmlGeom = (geom) => {
        const c2s = (coords) => coords.map(c => c.join(',')).join(' ');
        switch (geom.type) {
            case "Point":
                return `<Point><coordinates>${geom.coordinates.join(',')}</coordinates></Point>`;
            case "LineString":
                return `<LineString><coordinates>${c2s(geom.coordinates)}</coordinates></LineString>`;
            case "Polygon":
                const rings = geom.coordinates.map((r, i) => {
                    const tag = i === 0 ? "outerBoundaryIs" : "innerBoundaryIs";
                    return `<${tag}><LinearRing><coordinates>${c2s(r)}</coordinates></LinearRing></${tag}>`;
                }).join('');
                return `<Polygon>${rings}</Polygon>`;
            case "MultiPolygon":
                return `<MultiGeometry>${geom.coordinates.map(p => toKmlGeom({type:"Polygon", coordinates:p})).join('')}</MultiGeometry>`;
            default: return "";
        }
    };

    // 3. 特徴（Placemark）の生成
    pbf.fmap.forEach((t, i) => {
        const feat = pbf.getFeature(i);
        const props = feat.properties;
        
        kml += `\t<Placemark>\n`;
        if (props.name) kml += `\t\t<name>${props.name}</name>\n`;
        if (props.description) kml += `\t\t<description><![CDATA[${props.description}]]></description>\n`;

        // インラインスタイルの構築
        kml += `\t\t<Style>\n`;
        if (props.icon || props.style) {
            const iconPath = iconManager.get(props.icon);
            if (iconPath) {
                kml += `\t\t\t<IconStyle><Icon><href>${iconPath}</href></Icon></IconStyle>\n`;
            }
            if (props.style) {
                if (props.style.stroke) kml += `\t\t\t<LineStyle><color>${toKmlColor(props.style.stroke)}</color><width>${props.style.weight || 1}</width></LineStyle>\n`;
                if (props.style.fill) kml += `\t\t\t<PolyStyle><color>${toKmlColor(props.style.fill)}</color></PolyStyle>\n`;
            }
        }
        kml += `\t\t</Style>\n`;

        // ExtendedData (決め打ちしない属性の復元)
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
    
    // 4. ZIPにまとめて出力
    zip.file(`${name}.kml`, kml);
    const blob = await zip.generateAsync({type: "blob", compression: "DEFLATE"});
    console.log(`[Export] KMZ created with ${iconManager.count} icons.`);
    return new File([blob], `${name}.kmz`, {type: "application/vnd.google-earth.kmz"});
}