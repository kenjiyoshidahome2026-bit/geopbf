async function gmlenc(pbfBuffer, name) {
	const ns = {
		gml: `http://www.opengis.net/gml/3.2`,
		xsi: `http://www.w3.org/2001/XMLSchema-instance`
	};
	const pos = (coords) => `<gml:pos>${coords[1]} ${coords[0]}</gml:pos>`;
	const posList = (coords) => `<gml:posList>${coords.map(c => `${c[1]} ${c[0]}`).join(" ")}</gml:posList>`;
	let count = 0;
	const nextId = () => "g" + (++count);
	const buildGeometry = (geom) => {
		const {type, coordinates: c} = geom, id = nextId();
		const tag = i => i === 0 ? "exterior" : "interior";
		let g;
		switch (PBF.geometryMap[type]) {
			case 0: return `<gml:Point gml:id="${id}">${pos(c)}</gml:Point>`;
			case 1: g = c.map(t => `<gml:pointMember><gml:Point gml:id="${nextId()}">${pos(t)}</gml:Point></gml:pointMember>`);
				return `<gml:MultiPoint gml:id="${id}">${g.join("")}</gml:MultiPoint>`;
			case 2: return `<gml:LineString gml:id="${id}">${posList(c)}</gml:LineString>`;
			case 3: g = c.map(t => `<gml:curveMember><gml:LineString gml:id="${nextId()}">${posList(t)}</gml:LineString></gml:curveMember>`);
				return `<gml:MultiCurve gml:id="${id}">${g.join("")}</gml:MultiCurve>`;
			case 4: g = c.map((t, i) => `<gml:${tag(i)}><gml:LinearRing>${posList(t)}</gml:LinearRing></gml:${tag(i)}>`);
				return `<gml:Polygon gml:id="${id}">${g.join("")}</gml:Polygon>`;
			case 5: g = c.map(t => `<gml:surfaceMember><gml:Polygon gml:id="${nextId()}">${t.map((r, i) => `<gml:${tag(i)}><gml:LinearRing>${posList(r)}</gml:LinearRing></gml:${tag(i)}>`).join("")}</gml:Polygon></gml:surfaceMember>`);
				return `<gml:MultiSurface gml:id="${id}">${g.join("")}</gml:MultiSurface>`;
			default: return "";
		}
	};
	let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
	xml += `<gml:FeatureCollection xmlns:gml="${ns.gml}" xmlns:xsi="${ns.xsi}">\n`;
	const pbf = await new PBF().name(name).set(pbfBuffer);
	pbf.fmap.forEach((t, i) => {
		const f = pbf.getFeature(i);
		const fid = f.id || f.properties.id || `f${i}`;
		xml += `<gml:featureMember><gml:GenericFeature gml:id="${fid}">`;
		xml += `<gml:geometryProperty>${buildGeometry(f.geometry)}</gml:geometryProperty>`;
		for (const [key, val] of Object.entries(f.properties)) {
			if (val !== null && typeof val !== 'object' && key !== "id") {
				const safeKey = key.replace(/^[^a-zA-Z_]/, '_');
				xml += `<${safeKey}>${val}</${safeKey}>`;
			}
		}
		xml += `</gml:GenericFeature></gml:featureMember>\n`;
	});
	return xml + `</gml:FeatureCollection>`;
}