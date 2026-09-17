# apps/equal — Equal Earth 10m

Natural Earth **10m** の世界図を Equal Earth 図法（Šavrič–Patterson–Jenny 2018・等積）で描く 1 枚ページ。
中央経線はスライダで連続に振れ、カーソルの経緯度は図法の逆変換で出す。外部取得も worker も要らない。

```
node apps/equal/build.mjs          # data.json を作る（Natural Earth の zip を取ってきて焼く）
npx vite   # か python3 -m http.server → apps/equal/index.html を開く（fetch のため file:// は不可）
```

## 作り（何をこのリポジトリのコードでやっているか）

`build.mjs` が焼くところまでが geopbf の仕事、`index.html` は焼き上がりを描くだけ。

| 段 | 使うもの | 結果 |
| --- | --- | --- |
| Natural Earth 10m の shapefile（zip）を取る | `fetch`（`--cache` に保存） | 4 層 8.7 MB |
| zip → GeoPBF | `src/decoder/shape.js` を Node から直に叩く（worker 脚本の契約どおり） | 3,353 features |
| 1 画素に満たない頂点を落とす | `src/extension/gint.js` の `L1toL2`（Visvalingam の重み）で rank ≥ 52 を残す | 944,000 → 73,003 頂点（7.7%） |
| 0.01°（≒1 km）格子へ丸めて Int16 の base64 | — | `data.json` 0.44 MB |

`--rank` を下げるほど細かく残る（`npx geopbf lod <file>` の表と同じ物差し。z=3 相当が 52〜54）。
`--inline out.html` で `data.json` を焼き込んだ 1 枚ページも出せる（配布・貼り付け用）。

## 描き方（`index.html`・依存ゼロ）

* 図法は 20 行（`sin θ = √3/2·sin φ` → `x = 2√3·λ·cos θ / (3·dy/dθ)`、逆変換は y から θ を Newton で解く）。
* 中央経線は**幾何を切り直さない**：世界を −360° / 0 / +360° の 3 回描き、図郭（λ0±180°・φ=±90°）で切り抜く。
  縫い目を跨ぐ形は反対の縁から続けて出る。同じ手はライブラリ側にもある（`preview` の `repeat` / `outline`）。
* 環ごとに経度の幅を持っておき、窓に入らない回は描かない＝3 回描いても実費はほぼ 1 回分。

ライブラリ経由で**実データを毎回ブラウザで変換する**版は `examples/equal-earth.html`（S3 から zip を取り、
decoder worker で GeoPBF にして `preview()` で重ね描きする）。こちらは「焼いたものを最小の依存で見せる」側。

データ: [Natural Earth](https://www.naturalearthdata.com/) 10m（public domain）。
