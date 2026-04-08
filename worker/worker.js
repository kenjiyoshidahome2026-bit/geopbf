const base = new URL('.', import.meta.url).href;
console.log(`[worker] Base URL: ${base}`);
export async function run(type, data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(`./${type}.js`, base), { type: 'module' });
        worker.onmessage = e => {
            worker.terminate();
            if (e.data && e.data.error) reject(e.data.error);
            else resolve(e.data);
        };
        worker.onerror = e => {
            worker.terminate();
            reject(e);
        };
         const transfer = [];
        if (data.arraybuffer instanceof ArrayBuffer) transfer.push(data.arraybuffer);
        if (data.file instanceof ArrayBuffer) transfer.push(data.file);
        worker.postMessage(data, transfer);
    });
}

export async function inline(func, val, imports = []) {
    return new Promise((resolve, reject) => {
        const importSrc = imports.map(i => `import ${i.name} from '${i.url}';`).join('\n') + "\n";
        const src = `onmessage = async e => {
            try {
                const result = await (${func.toString()})(...e.data);
                postMessage({ result });
            } catch (error) {
                postMessage({ error: error.message });
            }
        };`;
        const url = URL.createObjectURL(new Blob([importSrc, src], { type: 'application/javascript' }));
        const w = new Worker(url, { type: 'module' });
        w.onmessage = e => {
            w.terminate();
            URL.revokeObjectURL(url);
            e.data.error ? reject(e.data.error) : resolve(e.data.result);
        };
        w.onerror = e => { w.terminate(); URL.revokeObjectURL(url); reject(e); };
        w.postMessage(Array.isArray(val) ? val : [val]);
    });
}