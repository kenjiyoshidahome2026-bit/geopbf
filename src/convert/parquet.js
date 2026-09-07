// convert/parquet.js ── Apache Parquet の最小ライタ（依存ゼロ）。Thrift compact protocol の FileMetaData / PageHeader を
// 手書きし、DataPage v1・PLAIN 符号化・definition level は RLE（bit 幅 1）・圧縮は GZIP か無圧縮。
// 読み手は pyarrow / DuckDB / GDAL / GeoPandas を想定（tests/t-parquet.mjs が pyarrow で読み戻す）。
//
// 対応する列型: BOOLEAN / INT64 / DOUBLE / BYTE_ARRAY（UTF8・JSON・生バイト）。
// スキーマは depth-first の SchemaElement 列で受ける（GeoParquet の bbox = optional group { required double ×4 }）。
import { gzip } from "./gzip.js";

// ── Thrift compact protocol ──
const CT = { BOOL_TRUE: 1, BOOL_FALSE: 2, BYTE: 3, I16: 4, I32: 5, I64: 6, DOUBLE: 7, BINARY: 8, LIST: 9, SET: 10, MAP: 11, STRUCT: 12 };
export class TWriter {
	constructor(cap = 4096) { this.buf = new Uint8Array(cap); this.pos = 0; this.last = 0; this.stack = []; }
	need(n) { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf); this.buf = b; } }
	byte(v) { this.need(1); this.buf[this.pos++] = v & 255; }
	varint(v) { this.need(10); while (v >= 128) { this.buf[this.pos++] = (v % 128) | 128; v = Math.floor(v / 128); } this.buf[this.pos++] = v; }
	zig(v) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
	structBegin() { this.stack.push(this.last); this.last = 0; }
	structEnd() { this.byte(0); this.last = this.stack.pop(); }
	header(id, type) { const d = id - this.last; if (d > 0 && d <= 15) this.byte((d << 4) | type); else { this.byte(type); this.zig(id); } this.last = id; }
	bool(id, v) { this.header(id, v ? CT.BOOL_TRUE : CT.BOOL_FALSE); }
	i32(id, v) { this.header(id, CT.I32); this.zig(v); }
	i64(id, v) { this.header(id, CT.I64); this.zig(v); }
	double(id, v) { this.header(id, CT.DOUBLE); this.need(8); new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, v, true); this.pos += 8; }
	binary(id, u8) { this.header(id, CT.BINARY); this.varint(u8.length); this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
	string(id, s) { this.binary(id, new TextEncoder().encode(s)); }
	struct(id) { this.header(id, CT.STRUCT); this.structBegin(); }
	list(id, elemType, size) { this.header(id, CT.LIST); this.listHeader(elemType, size); }
	listHeader(elemType, size) { if (size < 15) this.byte((size << 4) | elemType); else { this.byte(0xF0 | elemType); this.varint(size); } }
	rawBinary(u8) { this.varint(u8.length); this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }   // list 要素の binary/string
	finish() { return this.buf.subarray(0, this.pos); }
}

export const PT = { BOOLEAN: 0, INT32: 1, INT64: 2, INT96: 3, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6, FIXED_LEN_BYTE_ARRAY: 7 };
export const REP = { REQUIRED: 0, OPTIONAL: 1, REPEATED: 2 };
const CONV = { UTF8: 0, TIMESTAMP_MILLIS: 9, JSON: 19 };
const CODEC = { none: 0, snappy: 1, gzip: 2 };

// SchemaElement: { name, type?, repetition?, numChildren?, logical?: "UTF8"|"JSON"|"TIMESTAMP_MILLIS" }
function writeSchemaElement(w, e) {
	w.structBegin();
	if (e.type !== undefined) w.i32(1, e.type);
	if (e.repetition !== undefined) w.i32(3, e.repetition);
	w.string(4, e.name);
	if (e.numChildren !== undefined) w.i32(5, e.numChildren);
	if (e.logical && CONV[e.logical] !== undefined) w.i32(6, CONV[e.logical]);
	if (e.logical === "UTF8") { w.struct(10); w.struct(1); w.structEnd(); w.structEnd(); }                       // LogicalType.STRING
	else if (e.logical === "JSON") { w.struct(10); w.struct(12); w.structEnd(); w.structEnd(); }                 // LogicalType.JSON
	else if (e.logical === "TIMESTAMP_MILLIS") { w.struct(10); w.struct(8); w.bool(1, true); w.struct(2); w.struct(1); w.structEnd(); w.structEnd(); w.structEnd(); w.structEnd(); }   // TIMESTAMP{utc, MILLIS}
	w.structEnd();
}

// definition level（0/1）の RLE/bit-packed hybrid（RLE run のみ・bit 幅 1）＋4 バイト長前置
function encodeDefLevels(levels) {
	const w = new TWriter(64);
	let i = 0;
	while (i < levels.length) { let j = i + 1; while (j < levels.length && levels[j] === levels[i]) j++; w.varint((j - i) * 2); w.byte(levels[i]); i = j; }
	const body = w.finish(), out = new Uint8Array(4 + body.length);
	new DataView(out.buffer).setUint32(0, body.length, true); out.set(body, 4);
	return out;
}

// 値の PLAIN 符号化。vals: 非 null の値だけ（順序保持）
function encodeValues(type, vals) {
	if (type === PT.BOOLEAN) { const out = new Uint8Array((vals.length + 7) >> 3); for (let i = 0; i < vals.length; i++) if (vals[i]) out[i >> 3] |= 1 << (i & 7); return out; }
	if (type === PT.DOUBLE) { const out = new Uint8Array(vals.length * 8), dv = new DataView(out.buffer); for (let i = 0; i < vals.length; i++) dv.setFloat64(i * 8, vals[i], true); return out; }
	if (type === PT.INT64) { const out = new Uint8Array(vals.length * 8), dv = new DataView(out.buffer); for (let i = 0; i < vals.length; i++) { const v = vals[i], hi = Math.floor(v / 4294967296); dv.setUint32(i * 8, v - hi * 4294967296, true); dv.setInt32(i * 8 + 4, hi, true); } return out; }
	if (type === PT.BYTE_ARRAY) {
		const enc = new TextEncoder(), bs = vals.map(v => v instanceof Uint8Array ? v : enc.encode(String(v)));
		let n = 0; for (const b of bs) n += 4 + b.length;
		const out = new Uint8Array(n), dv = new DataView(out.buffer); let p = 0;
		for (const b of bs) { dv.setUint32(p, b.length, true); out.set(b, p + 4); p += 4 + b.length; }
		return out;
	}
	throw new Error("parquet: unsupported type " + type);
}
const le8 = (v) => { const u = new Uint8Array(8); new DataView(u.buffer).setFloat64(0, v, true); return u; };

// columns: [{ path: ["a"] | ["bbox","xmin"], type: PT.*, get(row) → 値 | null, stats?: true（DOUBLE の min/max）}]
// opts: { rowGroupSize=65536, codec:"gzip"|"none", keyValue: {k: v}, createdBy, compress?: async (u8)=>u8 }
export async function writeParquet({ schema, columns, numRows }, opts = {}) {
	const rowGroupSize = opts.rowGroupSize ?? 65536, codecName = opts.codec ?? "gzip", codec = CODEC[codecName];
	if (codec === undefined || codec === 1) throw new Error("parquet: codec は gzip か none");
	const gz = opts.compress ?? gzip;
	const compress = async (u8) => codec === 2 ? gz(u8) : u8;
	const parts = [new Uint8Array([0x50, 0x41, 0x52, 0x31])];   // "PAR1"
	let fileOff = 4;
	const rowGroups = [];
	for (let r0 = 0; r0 < numRows; r0 += rowGroupSize) {
		const n = Math.min(rowGroupSize, numRows - r0), chunks = [];
		let totalBytes = 0, totalComp = 0;
		for (const col of columns) {
			const levels = new Uint8Array(n), vals = [];
			let min = Infinity, max = -Infinity, nulls = 0;
			for (let i = 0; i < n; i++) {
				const v = col.get(r0 + i);
				if (v === null || v === undefined) { nulls++; continue; }
				levels[i] = 1; vals.push(v);
				if (col.stats) { if (v < min) min = v; if (v > max) max = v; }
			}
			const lv = encodeDefLevels(levels), vb = encodeValues(col.type, vals);
			const raw = new Uint8Array(lv.length + vb.length); raw.set(lv, 0); raw.set(vb, lv.length);
			const comp = await compress(raw);
			// PageHeader
			const ph = new TWriter(64);
			ph.structBegin();
			ph.i32(1, 0);                      // DATA_PAGE
			ph.i32(2, raw.length); ph.i32(3, comp.length);
			ph.struct(5); ph.i32(1, n); ph.i32(2, 0); ph.i32(3, 3); ph.i32(4, 3); ph.structEnd();   // DataPageHeader: num_values, PLAIN, RLE, RLE
			ph.structEnd();
			const phb = ph.finish().slice();
			const pageOff = fileOff;
			parts.push(phb, comp); fileOff += phb.length + comp.length;
			const unc = phb.length + raw.length, cmp = phb.length + comp.length;
			totalBytes += unc; totalComp += cmp;
			chunks.push({ col, pageOff, unc, cmp, n, nulls, min, max, hasStats: col.stats && vals.length > 0 });
		}
		rowGroups.push({ chunks, n, totalBytes, totalComp });
	}
	// FileMetaData
	const w = new TWriter(1 << 16);
	w.structBegin();
	w.i32(1, 2);                                              // version
	w.list(2, CT.STRUCT, schema.length); for (const e of schema) writeSchemaElement(w, e);
	w.i64(3, numRows);
	w.list(4, CT.STRUCT, rowGroups.length);
	for (const rg of rowGroups) {
		w.structBegin();
		w.list(1, CT.STRUCT, rg.chunks.length);
		for (const c of rg.chunks) {
			w.structBegin();
			w.i64(2, c.pageOff);                                  // file_offset
			w.struct(3);                                          // ColumnMetaData
			w.i32(1, c.col.type);
			w.list(2, CT.I32, 2); w.zig(0); w.zig(3);             // encodings: PLAIN, RLE
			w.list(3, CT.BINARY, c.col.path.length); for (const s of c.col.path) w.rawBinary(new TextEncoder().encode(s));
			w.i32(4, codec);
			w.i64(5, c.n);
			w.i64(6, c.unc); w.i64(7, c.cmp);
			w.i64(9, c.pageOff);                                  // data_page_offset
			if (c.hasStats || c.nulls) {                          // Statistics
				w.struct(12);
				w.i64(3, c.nulls);
				if (c.hasStats) { w.binary(5, le8(c.max)); w.binary(6, le8(c.min)); }
				w.structEnd();
			}
			w.structEnd();
			w.structEnd();
		}
		w.i64(2, rg.totalBytes); w.i64(3, rg.n);
		w.i64(6, rg.totalComp);
		w.structEnd();
	}
	const kv = Object.entries(opts.keyValue || {});
	if (kv.length) { w.list(5, CT.STRUCT, kv.length); for (const [k, v] of kv) { w.structBegin(); w.string(1, k); if (v != null) w.string(2, v); w.structEnd(); } }
	w.string(6, opts.createdBy ?? "geopbf");
	// column_orders: 葉列ごとに TypeDefinedOrder{}。これが無いと parquet-cpp（pyarrow）は min_value/max_value を読まない
	w.list(7, CT.STRUCT, columns.length); for (let i = 0; i < columns.length; i++) { w.structBegin(); w.struct(1); w.structEnd(); w.structEnd(); }
	w.structEnd();
	const meta = w.finish();
	const tail = new Uint8Array(8); new DataView(tail.buffer).setUint32(0, meta.length, true); tail.set([0x50, 0x41, 0x52, 0x31], 4);
	parts.push(meta, tail);
	let total = 0; for (const p of parts) total += p.length;
	const out = new Uint8Array(total); let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
	return out;
}
