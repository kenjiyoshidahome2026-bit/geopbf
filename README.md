# geopbf

[![npm](https://img.shields.io/npm/v/geopbf)](https://www.npmjs.com/package/geopbf) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> **Repo layout note** — development happens in the [ortho-earth monorepo](https://github.com/kenjiyoshidahome2026-bit/ortho-earth) (`packages/geopbf`); this standalone repo is a read-only mirror synced on each release. Issues are welcome here; patches land in the monorepo. / 開発はモノレポ側で行い、ここはリリースごとに同期される公開ミラーです（Issue歓迎・変更はモノレポへ）。

**Carry geometry as geometry.** GeoPBF is a compact binary container for geospatial features that keeps shapes as shapes — instead of flattening them into draw-only tiles — plus **Gint**, a GPU-readable topology layer that makes the data *answerable*: instant point-in-polygon identify, shared-edge topology, choropleth painting by feature id.

Everything runs in the browser: format conversion in workers, topology baking in WASM, no servers, no API keys. This is the data layer under [ortho-earth](https://www.ortho-earth.com/) — 1,900+ Japanese municipal polygons identify in 0.5–4 ms on an ordinary laptop.

```js
import { createGeopbf } from "geopbf";
const geopbf = createGeopbf();

// From anything: GeoJSON object, File (drag & drop), or URL
const pbf = await geopbf(featureCollection, { gint: true });
const pbf2 = await geopbf(file);        // .geojson .zip(shp) .kml .kmz .gpx .gml .fgb .topojson (.gz OK)
const pbf3 = await geopbf("https://example.com/data.zip#layer.shp");

pbf.geojson         // → FeatureCollection (round-trip)
pbf.features        // → features array
pbf.arrayBuffer     // → the GeoPBF binary (store it, ship it, re-load it)
pbf.contain(lng, lat)   // → which feature contains this point (smallest-wins)
```

## What's inside

- **Converters** (worker-per-format, lazy): GeoJSON, Shapefile (zip), KML/KMZ, GPX, GML, FlatGeobuf, TopoJSON, MOJ 登記所備付地図 — in, and back out (`geojsonFile`, `kmzFile`, `gpxFile`, `gmlFile`, `fgbFile`, `shapeFile`, `topojsonFile`)
- **Gint** (`{ gint: true }`): a typed-array buffer of arcs, features and neighbor topology, baked in WASM, designed so a GPU vertex shader can read it directly — but equally useful in plain JS for identify/topology queries
- **Feature ops**: `centroid`, `area`, `lineLength`, `getBbox`, `classify`, `map`/`filter` clones, CSV/property tables
- **Attribution fields**: `description`, `license`, `attribution` travel inside the file — data provenance is part of the format

## Command line (`npx geopbf`)

The library is browser-first, but the core encoder/decoder runs on plain Node — so the package also ships a
small CLI for the things you would otherwise open a browser for. No build step, no GDAL, no extra dependencies.

```bash
npx geopbf enc ne_10m_admin_0_countries.geojson countries.geopbf   # 13.3 MB -> 2.7 MB, gzipped by default
npx geopbf enc in.geojson out.geopbf --precision 7 --no-gzip       # 1 cm grid, raw (un-gzipped) GeoPBF
npx geopbf info countries.geopbf                                   # features, vertices, precision, header fields
npx geopbf dec countries.geopbf back.geojson                       # round trip
npx geopbf lod countries.geopbf                                    # what Gint would actually draw, per zoom
npx geopbf pmtiles countries.geopbf countries.pmtiles --maxzoom 10 # → PMTiles (MVT), simplified per zoom from Gint
npx geopbf parquet countries.geopbf countries.parquet              # → GeoParquet (WKB + bbox)
```

`lod` assigns the Visvalingam-Whyatt ranks that Gint packs into the low 6 bits of each vertex and prints how many
vertices survive the `3 * (21 - z)` threshold at each zoom — the number that explains why no level of detail has to
be baked on a server:

```
  z  threshold      描画頂点   残存率
   0   63         9,742     1.8%  #
   4   51        38,330     7.0%  ###
   8   39       395,448    72.1%  #############################
  21    0       548,469   100.0%  ########################################
```

Output is gzipped by default (matching the GDAL driver's `COMPRESS=GZIP` and the usual distribution form) — pass
`--no-gzip` for a raw file. Gzip input is detected by signature, not by extension, for every command including `enc`. For formats other than GeoJSON — Shapefile, GPKG, PostGIS,
FlatGeobuf and everything else GDAL reads — use the [GDAL/OGR driver](https://github.com/kenjiyoshidahome2026-bit/gdal-geopbf)
(`ogr2ogr -f GeoPBF`, needs GDAL ≥ 3.12), or the browser workers in `src/index.js`.

## PMTiles / GeoParquet — GPU-accelerated export (`geopbf/pmtiles`, `geopbf/geoparquet`)

The other direction: a GeoPBF (plus its Gint) goes out as a **PMTiles** archive of Mapbox Vector Tiles, or as a
**GeoParquet** file — with the embarrassingly parallel parts of the job on the GPU (WebGPU compute), and a CPU
path with the *same* integer arithmetic when there is no GPU. Zero new dependencies; the CLI runs on plain Node.

```bash
npx geopbf pmtiles countries.geopbf countries.pmtiles --maxzoom 10   # bakes Gint with WASM, then tiles from it
npx geopbf pmtiles countries.geopbf countries.pmtiles --gint countries.gint --gpu   # reuse a baked Gint
npx geopbf parquet countries.geopbf countries.parquet                # WKB + bbox covering column, gzip
```

```js
import { toPMTiles } from "geopbf/pmtiles";
import { toGeoParquet } from "geopbf/geoparquet";

const pbf = await geopbf(file, { gint: true });          // browser: Gint is baked by the worker as usual
const { buffer, stats } = await toPMTiles(pbf, { maxZoom: 12 });   // stats.engine → "gpu" | "cpu"
const pq = await toGeoParquet(pbf);                      // pq.buffer → .parquet bytes, pq.geo → the "geo" metadata
```

**Tiles come from Gint, not from the raw features.** This is the same derived buffer ortho-earth draws on the GPU —
shared borders are single arcs, every vertex carries its Visvalingam-Whyatt rank — so per-zoom simplification is a
`rank >= threshold` filter (the `63 - 3·(z + log2(extent/256))` rule ortho-core uses at draw time), and two
neighbouring polygons are simplified to the *identical* vertex list. No slivers, no gaps, at any zoom. The pipeline:

1. `project` — Morton decode → fixed-point Web Mercator `X32/Y32` (32-bit, whole world). Once per vertex, not per zoom.
2. `lod` — one dispatch over `(arc × zoom)`: keep `rank >= threshold`, shift to tile space, drop consecutive
   duplicates, write compacted coordinates (count pass + write pass). All zooms in a single round trip.
3. Worker pool (browser `Worker` / Node `worker_threads`, one code path): each `(zoom × tile-column range)` job
   stitches rings/lines from the arcs (`polyStream`/`lineStream`), bisects them into tiles with buffer, encodes
   MVT, gzips and content-hashes its tiles. The main thread merges by content key and packs PMTiles v3 (Hilbert
   tile ids, run-length + content de-duplication for interior tiles, leaf directories when the root exceeds 16 KB).
   Sharding only prunes the bisection tree, so the output is byte-identical with any worker count (`workers: 0`
   runs inline).

GeoParquet takes the GeoPBF integers directly (no Gint round-trip, so coordinates are exactly the file's values):
the GPU converts `i / 10^precision` to IEEE-754 doubles by long division with round-to-nearest-even — bit-identical
to JavaScript's own division — and reduces per-feature bboxes; the CPU assembles WKB and writes Parquet (Thrift
compact footer, PLAIN or dictionary pages, RLE definition levels, GZIP, `geo` metadata 1.1 with a `bbox` covering
column and min/max/null-count statistics on every column). Low-cardinality columns are dictionary-encoded per row
group (`RLE_DICTIONARY`, chosen when distinct values are at most half the rows). Readable by pyarrow, DuckDB, GDAL, GeoPandas.

**Exactness is the design rule.** Every kernel is integer-only — the Mercator latitude uses a 2^13·10⁻⁷° table
with an exact slope column (error ≤ 3 units of 2⁻³²), longitude uses exact 64-bit division emulated in 32-bit —
so the GPU output is not "close to" the CPU output, it is byte-identical, and `scripts/verify-convert-gpu.mjs`
proves it on every kernel through headless Chromium (works on SwiftShader, so it runs in CI without a GPU).

Compression is one code path with no pako: Node uses `zlib` natively, browsers use `CompressionStream` driven
through its writer/reader directly (≈4× cheaper per tile than the `Blob`→`Response` idiom). The assembly stage is
typed-array based, stops bisecting as soon as a sub-range of tiles is provably interior to a polygon (one range event
instead of one clip per tile), encodes the attribute section once per feature, and hashes tile content before copying
it. Measured on Natural Earth 10m countries (258 polygons, 480k vertices), z0–10 = 573,898 tiles / 151.5 MB, 4-core
Node: 5.3–5.9 s with 4 workers (the default is one per core; 3 → 5.8 s, 5–7 → 5.5–6.8 s), 16–18 s single-threaded, of which zlib is ≈8 s (85k unique tiles, ~90 µs each regardless
of level); Chromium z0–8 takes ≈5.7 s with 3 workers. The GPU stage is ≈150 ms of that on a software adapter
(SwiftShader) — real-GPU numbers were not measurable in the CI container.

Where the GPU is not: Node has no `navigator.gpu`. `npm i webgpu` (Dawn) gives the CLI a real adapter; without it,
`--gpu` reports the fallback and runs the CPU path — same bytes out. Deno's built-in WebGPU works as is. In the
browser everything is automatic.

Options — `toPMTiles(pbf, { gint, minZoom=0, maxZoom=14, extent=4096, buffer=80, layer, lodBias=0, dropRate=2.5, tinyPolygon=2, tinyLine=0, include, exclude, excludeAll, tileCompression:"gzip", gpu, workers, onProgress })`,
`toGeoParquet(pbf, { codec:"gzip"|"none", rowGroupSize=65536, order="str", bboxColumn=true, geometryName="geometry", include, exclude, excludeAll, gpu })`.
Tile quality follows tippecanoe's defaults where they matter: polygon components smaller than `tinyPolygon` tile
units² at a zoom (measured on the full-resolution geometry, so components the simplification collapsed count too) are
replaced by one placeholder square per accumulated threshold of area — atolls and archipelagos stay visible as dots at
z2 instead of disappearing — and sub-threshold clip fragments and holes are dropped; the clipper removes the zero-width
spurs Sutherland–Hodgman leaves along tile edges; `include` / `exclude` / `excludeAll` select attributes (tiles and
Parquet columns alike). `tinyPolygon: 0` turns the reduction off.
Rows in the Parquet file are **spatially ordered** (`order`, default `"str"`): feature bbox centres are packed
Sort-Tile-Recursive style — sorted by x, cut into √P slices of `rowGroupSize` multiples, each slice sorted by y — so
every row group's `bbox` statistics cover a disjoint patch and a reader that pushes an area filter down (DuckDB,
pyarrow datasets, GeoPandas) fetches only the row groups that intersect it. This follows Kanahiro Iguchi's
*Spatial sort for well-packed GeoParquet* (CNG Japan 2026); replicated here on 1,000,000 points in 50 row groups:
row-group bbox overlap ratio `none` 24.5 → `morton` 0.87 → `hilbert` 0.28 → `str` 0.00, candidate row groups for a
city-sized area 50 → 3–4 → 2 → 1–2. `"morton"` is the Gint-native key (cheapest, still 10× better than unsorted),
`"hilbert"` the usual answer, `"none"` keeps input order so that row index = feature id. The `bbox` column is written
by default because it is what the pruning keys on; `bboxColumn: "auto"` drops it for point-only data (half the size,
no pruning).

Attributes travel to the workers as one typed-array table (key dictionary, UTF-8 string dictionary, per-feature entry
list) instead of a million small arrays: worker start-up for 1,000,000 features dropped from 16 s to 1.6 s and the
string bytes are written into the tiles as they are, without a second UTF-8 encoding.
Points skip the clipping tree entirely (tile index by shift, buffer copies to neighbours) and are thinned at lower zooms
like tippecanoe's `-r`: `dropRate` 2.5 keeps 1/2.5 of the points per zoom step below `maxZoom`, chosen by a hash of the
feature id so the kept sets nest; `dropRate: 1` keeps every point in every tile. Point-only datasets get no `bbox`
covering column in GeoParquet (it would repeat the coordinates) unless `bboxColumn: true`.
`gpu: false` forces CPU; a `GPU` object (e.g. from the `webgpu` package) can be passed as `gpu`.

**Against tippecanoe** (v2.82, same 4-core box, same Natural Earth input, z0–10): tippecanoe 58 s / 147 MB / 573,885 tiles;
geopbf ≈6.5 s from GeoJSON (encode 0.4 s + Gint 0.5 s + tiles 5.3–5.9 s) / 151.5 MB / 573,898 tiles — the same tiles within a handful (16 only in geopbf, 3 only in tippecanoe, all at z6–10), and
interior tiles are byte-for-byte the same size apart from the layer name and the feature `id` geopbf writes. The 3 % size
difference is vertex retention: the Gint rank threshold keeps somewhat more coastline vertices at mid zooms than
tippecanoe's Douglas-Peucker. `lodBias` moves that knob — `+3` raises the threshold by one rank step (≈2× coarser
linearly), `+6` lands on tippecanoe's size, negative values keep more. GDAL's PMTiles driver (3.12) took 780 s for the
same job. Points (1,000,000 synthetic, 4 attributes, z0–10): geopbf 14.6 s / 51 MB with the default `dropRate`
(tippecanoe defaults 31 s / 42 MB), 42 s / 270 MB keeping every point (tippecanoe `-r1` 65 s / 221 MB); GeoParquet
with STR ordering and the bbox column ≈12 s / 45.6 MB (the Parquet stage itself 7 s, down from 11 s before columns were
transposed once into contiguous arrays and dictionary-encoded), without the bbox column 21.4 MB (geopandas 4.9 s write /
20.2 MB, unsorted, no bbox column).

## COG — Cloud Optimized GeoTIFF (`geopbf/cog`)

Rasters, the same way: a COG is a static file read by HTTP Range requests — no tile server,
no preprocessing. The reader is hand-written pure JS (zero new dependencies): one 16 KB range
request fetches the whole header, tile requests are sorted and coalesced (adjacent ranges merge
into one request), decode + reprojection run in a worker pool, and decoded tiles sit in a
byte-budgeted LRU. JPEG/WebP tiles go through the browser's native (hardware) decoder.

```js
import { openCog } from "geopbf/cog";
const cog = await openCog("https://…/TCI.tif");     // 1 range request, header parsed
cog.bboxLL;                                          // [w,s,e,n] in WGS84
const bm = await cog.renderXYZ(14, x, y);            // ImageBitmap, warped to Web Mercator
cog.metrics();                                       // {ttfhMs, rangeRequests, coalescedFrom, …}
```

MapLibre / Leaflet, one line each (host libraries are not imported by geopbf):

```js
import { cogProtocol } from "geopbf/maplibre-cog";
maplibregl.addProtocol("cog", cogProtocol);
map.addSource("x", { type: "raster", tiles: ["cog://https://…/TCI.tif/{z}/{x}/{y}"], tileSize: 256 });

import { cogGridLayer } from "geopbf/leaflet-cog";
(await cogGridLayer(L, "https://…/TCI.tif")).addTo(map);
```

CLI (`npx geopbf cog info <url>` works on remote COGs via Node's fetch + Range):

```bash
npx geopbf cog info https://…/TCI.tif --bench   # structure + measured numbers
npx geopbf cog png  https://…/TCI.tif out.png   # quick-look render
```

Supported subset (public-COG mainstream; everything else fails with an explicit error):
tiled + stripped TIFF and BigTIFF · compression none / deflate / LZW / JPEG / WebP (JPEG/WebP
decode in browser only) · predictor 2 · uint8 RGB(A), palette, single-band uint8/16, int16,
float32 (auto percentile stretch, `GDAL_NODATA` → transparent) · CRS EPSG:4326 / 3857 /
UTM 326xx–327xx (Krüger n-series, nm-accurate). For anything beyond that, `gdal_translate -of COG`
first. Sources without CORS: inject a proxy via `openCog(url, { fetch })`. Node reads the same
core via `geopbf/cog/core` (DOM-free).

## Storage / caching (optional injection)

Out of the box, `createGeopbf()` fetches plainly and re-converts on every load — correct, dependency-free, cache-less. If you have your own storage layer (IndexedDB cache, remote bucket, proxied fetch), inject it:

```js
createGeopbf(apiBase, { bucket: myProvider });
// myProvider(apiBase, options) → { Bucket, Cache, Fetch }
```

Everything else (conversion, gint, identify) is identical either way.

## MapLibre GL JS integration

`geopbf/maplibre` supplies GeoPBF files to MapLibre as GeoJSON sources — no maplibre-gl import on our side, no extra dependency. (This is data supply only; it is not a MapLibre-compatible rendering layer for the gint engine.)

```js
import maplibregl from "maplibre-gl";
import { geopbfProtocol } from "geopbf/maplibre";

maplibregl.addProtocol("geopbf", geopbfProtocol);
map.addSource("rail", { type: "geojson",
  data: "geopbf://https://api.ortho-earth.com/bucket/GIS/pbf/N02-25_RailroadSection" });
```

- **URL contract**: pass the inner URL **absolute** (`geopbf://https://…`), as with pmtiles. MapLibre normalizes source URLs through `new URL()`, which corrupts relative forms like `geopbf://../x`; the handler repairs the one mangling absolute URLs suffer (`https//` losing its colon), but relative paths cannot be recovered — absolutize them first.
- **Whole-file gzip** is detected by magic bytes and decompressed transparently.
- **Properties are sanitized** to survive MapLibre's JSON round-trip to its worker: `Date` → ISO string, BBOX → plain array, FUNC → source string (decoded with `noeval`, so no `new Function` — CSP-safe), Blob/ImageData values are dropped. Pass `makeGeopbfProtocol({ sanitize: false })` to opt out.
- **Metadata** (name / description / license / attribution / minZoom / maxZoom travel inside the file, but a protocol handler cannot set source attribution or layer zoom range) — use `loadGeopbf(url)` to get `{ geojson, ...meta }` and wire them into `addSource`/`addLayer` yourself, or `makeGeopbfProtocol({ onMeta })`. For feature-state, set `promoteId` on the source (GeoPBF features carry no `id`).
- Since a GeoPBF file is one whole dataset (not z/x/y tiles), MapLibre's built-in geojson-vt does the tiling/simplification. Comfortable up to tens of MB of resulting GeoJSON; a true MVT transcoding path for very large datasets is a possible future addition.

See `examples/maplibre.html` for a full standalone demo (base map + protocol source + `loadGeopbf` metadata wiring).

## Leaflet integration

`geopbf/leaflet` provides an `L.GeoJSON` subclass — again without importing leaflet itself. Register it explicitly (works with ESM and the CDN global `L` alike):

```js
import L from "leaflet";                        // or the CDN global
import { extendLeaflet } from "geopbf/leaflet";

extendLeaflet(L);
L.geoPBF("geopbf://https://api.ortho-earth.com/bucket/GIS/pbf/N02-25_RailroadSection", {
  style: { color: "#3564c0" },                  // plus any L.GeoJSON option
})
  .on("load", e => console.log(e.meta))         // "error" on failure
  .addTo(map);
```

Unlike MapLibre's protocol handler, a Leaflet layer owns its attribution — the file header's `attribution` is wired into the layer automatically (an explicit `options.attribution` wins). `getMeta()` returns the header metadata after load, and `await layer.whenReady()` awaits it. Loading/sanitizing behavior (gzip, `noeval`, property mapping, `{ fetch, sanitize, signal }` options) is shared with the MapLibre path. See `examples/leaflet.html`.

## OpenLayers integration

`geopbf/openlayers` provides a `VectorSource` loader factory — no `ol` import on our side; pass your format instance:

```js
import VectorSource from "ol/source/Vector.js";
import GeoJSON from "ol/format/GeoJSON.js";
import { makeGeopbfLoader } from "geopbf/openlayers";

const source = new VectorSource({
  loader: makeGeopbfLoader("geopbf://https://…/N02-25_RailroadSection", new GeoJSON(), {
    onMeta: meta => console.log(meta),   // header metadata; onError for failures
  }),
});
```

Features are reprojected to the view projection automatically (`featureProjection`), and the file header's `attribution` is wired into the source (an explicit `attributions` option wins). Loader options `{ fetch, sanitize, signal }` as elsewhere. See `examples/openlayers.html`.

## deck.gl / loaders.gl integration

`geopbf/loaders` exports a loaders.gl `Loader` object, which plugs into deck.gl (and other loaders.gl consumers) directly:

```js
import { GeoJsonLayer } from "@deck.gl/layers";
import { GeoPBFLoader } from "geopbf/loaders";

new GeoJsonLayer({ data: "https://…/N02-25_RailroadSection", loaders: [GeoPBFLoader] });
```

`parse` returns a GeoJSON FeatureCollection with the header metadata attached as `geopbfMeta`; pass `loadOptions: { geopbf: { sanitize: false } }` to opt out of property sanitizing. See `examples/deckgl.html`.

## Cesium, D3, and everything else (`geopbf/load`)

Libraries that accept a GeoJSON object directly need no plugin at all — `geopbf/load` exposes the shared loader the four integrations above are built on:

```js
import { loadGeopbf } from "geopbf/load";

// Cesium
const r = await loadGeopbf("geopbf://https://…/N02-25_RailroadSection");
viewer.dataSources.add(await Cesium.GeoJsonDataSource.load(r.geojson));
if (r.attribution) viewer.creditDisplay.addStaticCredit(new Cesium.Credit(r.attribution));
```

Same deal for D3 (`d3.geoPath` over `r.geojson`), Observable notebooks, or anything else that eats GeoJSON. `loadGeopbf` returns `{ geojson, name, description, license, attribution, minZoom, maxZoom }` and handles gzip, `noeval`, and property sanitizing. See `examples/cesium.html`.

## Editing (`geopbf/edit`, v1.3)

The editing core battle-tested in [geoedit](https://www.ortho-earth.com/japan/geoedit) — pure data modules (no DOM, worker-safe, Node-testable):

```js
import { buildTopology, createModel } from "geopbf/edit";

const topo = buildTopology(featureCollection, 6);   // grid 10^-6 deg; shared borders become single arcs
const model = createModel(topo);
const addr = model.addrOf(eid, pathIdx, vertIdx);   // stable address {eid, path, vi}
const { arcId, idx } = model.resolveAddr(addr);
model.moveVertex(arcId, idx, lng, lat);             // one arc, N features: neighbors move together
model.toGeoJSON();                                  // → FeatureCollection (round-trip)
model.stats();                                      // → { features, arcs, vertices }
```

- **`buildTopology(fc, gridExp)`** — extract shared-edge topology; a border edit moves both features at once.
- **`createModel(topo)`** — vertex move/insert/delete, feature add/delete, holes, translate; command objects (`applyCmd`/`invertCmd`) with re-extraction-stable addresses make undo/redo survive topology rebuilds.
- **`createLargeModel(pbf)`** — edit tens of millions of vertices in place on the GeoPBF bytes + Gint buffer (no full extraction, no OOM).
- **`createSnapIndex(gridExp, deref)`** — grid-linked snapping. **`createHistory()`** — undo/redo stack.
- **`smoothRing / smoothGeom`** — Catmull-Rom subdivision used by both the editor and `@spline` playback (same curve everywhere).

Granular imports: `geopbf/edit/model`, `geopbf/edit/large-model`, `geopbf/edit/topo-extract`, `geopbf/edit/snap`, `geopbf/edit/history`, `geopbf/edit/spline`.

## Bundler notes

Workers are declared as `new Worker(new URL("./…", import.meta.url), { type: "module" })` and the WASM ships as a regular asset — Vite and other modern bundlers handle both natively, no plugins. One setting is required in the consumer's Vite config (the workers use dynamic imports internally, which Vite's default `iife` worker format rejects):

```js
// vite.config.js
export default { worker: { format: "es" } };
```

Runtime dependency: `pbf` (protobuf reader) only. Compression and decompression everywhere — gzip/deflate for GeoPBF, ZIP/Shapefile/MOJ decoders, COG tiles, PMTiles and Parquet — go through the platform's native codecs (`CompressionStream`/`DecompressionStream` in browsers and workers, `node:zlib` in Node); pako was removed in 1.5. Requires a browser with `CompressionStream` (all evergreen browsers).

## License

MIT. The format is meant to spread — build on it freely. Format spec and technical notes: [ortho-earth.com/docs/geopbf.html](https://www.ortho-earth.com/docs/geopbf.html)
