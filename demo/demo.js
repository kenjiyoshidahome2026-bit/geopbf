import './demo.scss';
import { geopbf } from '../src/geopbf.js';
// native-bucket から必要なツールをインポート (demo用)
// 実際には URL#file をパースして部分取得する関数を想定
async function fetchRemoteEntry(urlWithHash) {
    const [url, entry] = urlWithHash.split('#');
    // ここで native-bucket のロジックを使用して ZIP 内から entry を fetch
    // 今回はデモ用に fetch して Blob 化
    const res = await fetch(url);
    const blob = await res.blob();
    // 実際には native-bucket.unzip() 等を呼ぶ
    // return entryFile; 
}

const dz = document.getElementById('drop-zone');
const logContent = document.getElementById('log-content');
let currentPBF = null;

function log(msg, color = '#8b949e') {
    const div = document.createElement('div');
    div.style.color = color;
    div.innerHTML = `> ${msg}`;
    logContent.appendChild(div);
    logContent.scrollTop = logContent.scrollHeight;
}

async function handleData(file) {
    document.getElementById('result-container').style.display = 'none';
    log(`Loading: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, '#fff');
    
    const start = performance.now();
    try {
        currentPBF = await geopbf(file);
        const end = performance.now();
        
        log(`Success: PBF conversion took ${Math.round(end - start)}ms`, '#3fb950');
        renderUI(Math.round(end - start));
    } catch (e) {
        log(`Error: ${e.message}`, '#f85149');
    }
}

function renderUI(ms) {
    document.getElementById('result-container').style.display = 'block';
    document.getElementById('pbf-filename').innerText = currentPBF.name() + '.pbf';
    document.getElementById('stat-count').innerText = currentPBF.fmap.length.toLocaleString();
    document.getElementById('stat-size').innerText = (currentPBF.arrayBuffer.byteLength / 1024).toFixed(1) + ' KB';
    document.getElementById('stat-time').innerText = ms + 'ms';
    
    document.getElementById('meta-name').value = currentPBF.name();
    document.getElementById('meta-license').value = currentPBF.license();
    document.getElementById('meta-desc').value = currentPBF.description();
}

// Events
dz.ondragover = e => { e.preventDefault(); dz.classList.add('hover'); };
dz.ondragleave = () => dz.classList.remove('hover');
dz.ondrop = e => {
    e.preventDefault();
    dz.classList.remove('hover');
    if (e.dataTransfer.files[0]) handleData(e.dataTransfer.files[0]);
};

document.querySelectorAll('.presets button').forEach(btn => {
    btn.onclick = async () => {
     //   const url = btn.dataset.url; // "https://...zip#N03-20250101.geojson"
     //   const [url,name] = btn.dataset.url.split('#');
        log(`Fetching via native-bucket...`, 'var(--accent)');
        
        try {
debugger
            const file = await geopbf(btn.dataset.url);

            if (file) {
                log(`Success: <b>${file.name}</b> resolved.`, 'var(--success)');
                // そのまま geopbf のロジックへ流し込む
                handleData(file);
            } else {
                throw new Error("Could not resolve file from the given URL.");
            }
        } catch (err) {
            log(`Fetch Error: ${err.message}`, '#f85149');
            console.error(err);
        }
    };
});

document.getElementById('btn-update').onclick = () => {
    const start = performance.now();
    currentPBF.header({
        name: document.getElementById('meta-name').value,
        license: document.getElementById('meta-license').value,
        description: document.getElementById('meta-desc').value
    });
    const end = performance.now();
    log(`Binary Header Synced in ${(end - start).toFixed(2)}ms (No re-parsing!)`, '#58a6ff');
    renderUI(0);
};

document.getElementById('btn-download').onclick = () => {
    const blob = new Blob([currentPBF.arrayBuffer], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${currentPBF.name()}.pbf`;
    a.click();
};

log('Ready. Drop GIS files or select a preset.');