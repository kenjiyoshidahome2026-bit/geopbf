#!/usr/bin/env node
// verify-convert-gpu: tests/t-convert-gpu.html を Playwright の Chromium で走らせ、CPU/GPU の bit 一致を数字で確かめる。
// GPU 無しの環境でも Chromium 同梱の SwiftShader（Vulkan ソフトウェア実装）で WebGPU が立つ＝CI で回せる。
// 使い方: node scripts/verify-convert-gpu.mjs [--show]                      … カーネルの bit 一致ゲート
//         node scripts/verify-convert-gpu.mjs --bench <dir> <name> [--maxzoom N] … <dir>/<name>.geopbf + .gint で GPU/CPU の実測と出力一致
// （playwright は devDependency ではなく、グローバル/近傍から解決）
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const req = createRequire(import.meta.url);
let pw = null;
for (const c of ["playwright", "playwright-core", "/opt/node22/lib/node_modules/playwright/index.mjs", "/usr/lib/node_modules/playwright/index.mjs"]) {
	try { pw = await import(c.startsWith("/") ? c : req.resolve(c)); break; } catch {}
}
if (!pw) { console.error("playwright が見つからない（npm i -g playwright）"); process.exit(2); }

const bi = process.argv.indexOf("--bench");
const bench = bi > 0 ? { dir: path.resolve(process.argv[bi + 1]), name: process.argv[bi + 2], maxzoom: process.argv.includes("--maxzoom") ? process.argv[process.argv.indexOf("--maxzoom") + 1] : "8" } : null;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const srv = http.createServer(async (q, s) => {
	try {
		const u = decodeURIComponent(q.url.split("?")[0]);
		const p = bench && u.startsWith("/data/") ? path.join(bench.dir, u.slice(6)) : path.join(root, u);
		const body = await readFile(p);
		s.setHeader("content-type", MIME[path.extname(p)] || "application/octet-stream");
		s.end(body);
	} catch { s.statusCode = 404; s.end("nf"); }
}).listen(0);
const port = srv.address().port;

const exe = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(p => p && existsSync(p));
const browser = await pw.chromium.launch({
	headless: !process.argv.includes("--show"),
	...(exe ? { executablePath: exe } : {}),
	ignoreDefaultArgs: ["--headless"],
	args: ["--headless=new", "--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--use-vulkan=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
page.on("console", m => { if (m.type() === "error" && !/404/.test(m.text())) console.error("[page]", m.text()); });
page.on("pageerror", e => console.error("[pageerror]", e.message));
await page.goto(bench ? `http://localhost:${port}/tests/t-convert-bench.html?data=${encodeURIComponent(bench.name)}&maxzoom=${bench.maxzoom}` : `http://localhost:${port}/tests/t-convert-gpu.html`);
await page.waitForFunction(() => window.__result, null, { timeout: 1800000 });
const r = await page.evaluate(() => window.__result);
await browser.close(); srv.close();
console.log(r.lines.join("\n"));
if (bench) { const bad = r.error || r.same === false || r.parquetSame === false; console.log(bad ? "\n✗ 不一致/エラー" : "\n出力一致"); process.exit(bad ? 1 : 0); }
console.log(r.fails ? `\n${r.fails} 件失敗` : `\n全件通過（${(r.ms | 0)} ms・${JSON.stringify(r.info || null)}）`);
process.exit(r.fails ? 1 : 0);
