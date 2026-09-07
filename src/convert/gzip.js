// convert/gzip.js ── 圧縮の一本化。Node（main も worker_threads も）は node:zlib のネイティブ、ブラウザは CompressionStream。
// pako は使わない（純 JS の deflate は zlib の数倍遅く、呼び出し毎の状態確保が GC を食う＝実測 575k タイルで 170 秒）。
// どちらも非同期の同じ契約 gzip(u8) → Promise<Uint8Array>。
let zlib = null, probed = null;
const probe = () => probed ??= (async () => {
	if (typeof process !== "undefined" && process.versions?.node) { try { zlib = await import("node:zlib"); } catch { zlib = null; } }
})();
// Blob→Response 経由（new Response(blob.stream().pipeThrough(ts)).arrayBuffer()）は 1 片あたり ≈700µs＝writer/reader を
// 直接叩くと ≈170µs（Chromium 実測・小さなタイル多数では 4 倍差）。
const pipe = async (u8, ts) => {
	const w = ts.writable.getWriter(); w.write(u8); w.close();
	const r = ts.readable.getReader(), chunks = []; let n = 0;
	for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); n += value.length; }
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(n); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
	return out;
};

export async function gzip(u8) {
	await probe();
	if (zlib) return new Uint8Array(zlib.gzipSync(u8));
	return pipe(u8, new CompressionStream("gzip"));
}
export async function gunzip(u8) {
	await probe();
	if (zlib) return new Uint8Array(zlib.gunzipSync(u8));
	return pipe(u8, new DecompressionStream("gzip"));
}
// 多数の小片を並列に（CompressionStream はストリーム毎の固定費が大きい＝同時に流す。zlib は同期なので順に）
export async function gzipMany(list, concurrency = 64) {
	await probe();
	const out = new Array(list.length);
	if (zlib) { for (let i = 0; i < list.length; i++) out[i] = new Uint8Array(zlib.gzipSync(list[i])); return out; }
	for (let i = 0; i < list.length; i += concurrency) {
		const part = await Promise.all(list.slice(i, i + concurrency).map(u8 => pipe(u8, new CompressionStream("gzip"))));
		for (let j = 0; j < part.length; j++) out[i + j] = part[j];
	}
	return out;
}
