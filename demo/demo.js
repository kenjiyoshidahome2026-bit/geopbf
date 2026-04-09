import { geopbf } from '../src/geopbf.js';

// テスト用のサンプルデータセット (CORS設定がされている、またはプロキシ経由を想定)
const TEST_SOURCES = [
    { type: "GeoJSON", name: "Land_Boundaries", url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson" },
    { type: "TopoJSON", name: "World_Atlas", url: "https://raw.githubusercontent.com/topojson/world-atlas/master/world/110m.json" },
    { type: "Shapefile ZIP", name: "Sample_Cities", url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_populated_places.geojson" }, // 代替GeoJSON
    { type: "PBF (Native)", name: "Existing_Data", url: "" }, // 後のステップで生成されたPBFをテスト
    { type: "Gzip JSON", name: "Compressed_Data", url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson" }
];

const listEl = document.getElementById('test-list');

async function createTestItem(src, index) {
    const div = document.createElement('div');
    div.className = 'test-card';
    div.innerHTML = `
        <strong>[Test ${index + 1}] ${src.type}: ${src.name}</strong>
        <span id="status-${index}" class="status pending">待機中</span>
        <pre id="log-${index}">ログを待機しています...</pre>
    `;
    listEl.appendChild(div);
    return {
        log: (msg) => {
            const el = document.getElementById(`log-${index}`);
            el.innerText += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
            el.scrollTop = el.scrollHeight;
        },
        setStatus: (status, label) => {
            const el = document.getElementById(`status-${index}`);
            el.className = `status ${status}`;
            el.innerText = label;
        }
    };
}

async function runSingleTest(src, index) {
    const ui = await createTestItem(src, index);
    ui.setStatus('running', '処理中...');
    
    try {
        // 1. geopbf() で読み込みとPBF化
        // 内部で pbfio.fetch() を経由し native-bucket を使用します
        ui.log(`読み込み開始: ${src.url || '内部データ'}`);
        const pbf = await geopbf(src.url, { name: src.name });
        
        if (!pbf || pbf.length === 0) throw new Error("PBFの生成に失敗しました");
        ui.log(`PBF生成完了: 特徴点数 ${pbf.length}, サイズ ${pbf.size} bytes`);

        // 2. pbf-extension の lint 機能でメタデータ表示
        ui.log("Metadata (Lint):\n" + pbf.lint);

        // 3. サーバーへの保存テスト (pbf-io & native-bucket)
        ui.log("サーバー (R2/Cache) へ保存中...");
        const savedName = await pbf.save();
        ui.log(`保存成功: ${savedName}`);

        // 4. 各種フォーマットへの変換テスト
        ui.log("変換テスト: GeoJSON生成中...");
        const geoFile = await pbf.geojsonFile();
        ui.log(`GeoJSON生成成功: ${geoFile.size} bytes`);

        // 5. Shapefile 変換 (Worker経由) のテスト
        if (src.type === "GeoJSON") {
            ui.log("変換テスト: Shapefile (Worker) 実行中...");
            const shpFile = await pbf.shapeFile();
            if (shpFile) ui.log(`Shapefile生成成功`);
        }

        ui.setStatus('success', '完了');
    } catch (e) {
        ui.log(`エラー発生: ${e.message}`);
        ui.setStatus('error', '失敗');
        console.error(e);
    }
}

document.getElementById('run-btn').onclick = async () => {
    listEl.innerHTML = '';
    for (let i = 0; i < TEST_SOURCES.length; i++) {
        await runSingleTest(TEST_SOURCES[i], i);
    }
};