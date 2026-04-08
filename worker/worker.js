/**
 * worker/worker.js
 */

// worker ディレクトリ内の JS ファイルを Worker として一括インポート
// '?worker' クエリを付けることで、Vite はこれらを Worker コンストラクタとして処理します
const workerModules = import.meta.glob('./*.js', { 
    eager: true, 
    query: '?worker' 
});

export async function run(type, data) {
    // 例: type='shpdec' なら './shpdec.js' というキーでコンストラクタを探す
    const key = `./${type}.js`;
    const WorkerClass = workerModules[key]?.default;

    if (!WorkerClass) {
        throw new Error(`Worker script for "${type}" not found. Available: ${Object.keys(workerModules).join(', ')}`);
    }

    return new Promise((resolve, reject) => {
        // Vite が生成した Worker クラスをインスタンス化
        const worker = new WorkerClass();

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