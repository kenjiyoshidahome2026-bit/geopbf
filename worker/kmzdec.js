async function kmzdec(file) {
	const kmlColor = (c) => {
		if (!c || c.length !== 8) return null;
		const a = parseInt(c.substring(0, 2), 16) / 255;
		const b = parseInt(c.substring(2, 4), 16);
		const g = parseInt(c.substring(4, 6), 16);
		const r = parseInt(c.substring(6, 8), 16);
		return `rgba(${r},${g},${b},${a.toFixed(2)})`;
	};
	const parseCoords = (str) => {
		return (str || "").trim().split(/[\s\n\t]+/).map(pair => {
			const c = pair.split(',').map(Number);
			return [c[0], c[1]]; // 高度がある場合は c[2]
		}).filter(c => c.length >= 2);
	};
	let kmlStr = null;
	const resourceMap = {}; // リソース（画像）の事前抽出
	if (file.name.match(/\.kmz$/i)) {
		const zip = await JSZip.loadAsync(file);
		for (const [path, zipFile] of Object.entries(zip.files)) {
			if (path.match(/\.kml$/i)) {
				kmlStr = await zipFile.async("string");
			} else if (path.match(/\.(png|jpg|jpeg|gif)$/i)) { // 画像ファイルを Blob として確保
				resourceMap[path] = await zipFile.async("blob");
			}
		}
	} else kmlStr = await file.text();
	const xml = new DOMParser().parseFromString(kmlStr, "text/xml");
	const features = [];
	xml.querySelectorAll("Placemark").forEach(pm => {
		const props = {};
		for (const node of pm.children) {
			const tag = node.tagName;
			if (tag === "ExtendedData") {
				node.querySelectorAll("Data, SimpleData").forEach(d => {
					const k = d.getAttribute("name");
					const v = d.querySelector("value")?.textContent || d.textContent;
					if (k) props[k] = v;
				});
			} else if (node.children.length === 0 && node.textContent.trim()) {
				props[tag] = node.textContent.trim();
			}
		}
		const style = pm.querySelector("Style");
		if (style) {
			props.style = {};
			const lc = style.querySelector("LineStyle color")?.textContent;
			if (lc) props.style.stroke = kmlColor(lc);
			const lw = style.querySelector("LineStyle width")?.textContent;
			if (lw) props.style.weight = parseFloat(lw);
			const pc = style.querySelector("PolyStyle color")?.textContent;
			if (pc) props.style.fill = kmlColor(pc);
	
			const href = style.querySelector("Icon href")?.textContent;
			if (href) {
				const path = href.replace(/^(\.\/|files\/)/, "");
				const blob = resourceMap[href] || resourceMap[path];
				props.icon = blob || href;
			}
		}
		let geometry = null; // 【ジオメトリ抽出】
		const pt = pm.querySelector("Point coordinates");
		const ls = pm.querySelector("LineString coordinates");
		const py = pm.querySelector("Polygon outerBoundaryIs coordinates");
		if (pt) {
			geometry = { type: "Point", coordinates: parseCoords(pt.textContent)[0] };
		} else if (ls) {
			geometry = { type: "LineString", coordinates: parseCoords(ls.textContent) };
		} else if (py) {
			const rings = [parseCoords(py.textContent)];
			pm.querySelectorAll("Polygon innerBoundaryIs coordinates").forEach(i => {
				rings.push(parseCoords(i.textContent));
			});
			geometry = { type: "Polygon", coordinates: rings };
		}
		if (geometry) features.push({ type: "Feature", geometry, properties: props });
	});
	const pbf = new PBF({ name: file.name.split('.')[0] });
	const [sortedKeys, bufs] = await PBF.makeKeys(features);
	pbf.setHead(sortedKeys, bufs);
	pbf.setBody(() => features.forEach(f => pbf.setFeature(f))).close();
	console.log(`[Done] ${features.length} features cleaned and imported.`);
	return pbf.arrayBuffer;
}