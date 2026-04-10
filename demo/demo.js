import './demo.scss';
import { geopbf } from '../src/geopbf.js';

const TEST_CASES = [
    { type: "GeoJSON", name: "World Countries", url: "https://raw.githubusercontent.com/datasets/geo-boundaries-world-110m/master/countries.geojson" },
    { type: "TopoJSON", name: "World Atlas", url: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json" },
    { type: "Shapefile ZIP", name: "Natural Earth Land", url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/zips/ne_110m_land.zip" },
    { type: "KMZ", name: "KML Samples", url: "https://developers.google.com/kml/documentation/KML_Samples.kmz" },
    { type: "GML", name: "OSM Sample", url: "https://raw.githubusercontent.com/openlayers/ol3/master/test/spec/ol/format/gml/osm.gml" }
];

const listEl = document.getElementById('test-list');

async function runTest(test, index) {
    const card = document.createElement('div');
    card.className = 'test-card';
    card.innerHTML = `
        <div class="card-header">
            <div class="info">
                <h3>${test.name}</h3>
                <small>${test.type}</small>
            </div>
            <span id="status-${index}" class="status-badge pending">READY</span>
        </div>
        <div id="log-${index}" class="log-window"></div>
    `;
    listEl.appendChild(card);

    const logEl = document.getElementById(`log-${index}`);
    const statusEl = document.getElementById(`status-${index}`);
    
    // ここで log を定義
    const log = (msg) => { 
        logEl.innerText += `\n[${new Date().toLocaleTimeString()}] ${msg}`; 
        logEl.scrollTop = logEl.scrollHeight; 
    };

    // try {
        statusEl.className = "status-badge running";
        statusEl.innerText = "RUNNING";

        log(`[Step 1] Fetching & Encoding...`);
        const pbf = await geopbf(test.url, { name: test.name });
        if (!pbf) throw new Error("PBF encoding failed.");
        console.log(pbf.geojson)
        console.log(pbf.getBbox())
        log(`SUCCESS: Created PBF (${pbf.length} features)`);

        log(`[Step 2] Skipped server save.`);

        log(`[Step 3] Exporting to GeoJSON...`);
        const geoFile = await pbf.geojsonFile(true);
        console.log(geoFile);
        log(`SUCCESS: Generated ${geoFile.name}`);

        log(`[Step 4] Exporting to Shapefile...`);
        const shpFile = await pbf.shape();
        if (shpFile) log(`SUCCESS: Shapefile generated.`);

        statusEl.className = "status-badge success";
        statusEl.innerText = "PASSED";
    // } catch (e) {
    //     log(`!! ERROR: ${e.message}`);
    //     statusEl.className = "status-badge error";
    //     statusEl.innerText = "FAILED";
    //     console.error(e);
    // }
}

// --- ボタンのイベントリスナー（ここが重要！） ---
const runBtn = document.getElementById('run-all');
if (runBtn) {
    runBtn.onclick = async () => {
        runBtn.disabled = true;
        listEl.innerHTML = ''; // リセット
        for (let i = 0; i < TEST_CASES.length; i++) {
            await runTest(TEST_CASES[i], i);
        }
        runBtn.disabled = false;
    };
    console.log("Test button initialized.");
} else {
    console.error("Button 'run-all' not found.");
}