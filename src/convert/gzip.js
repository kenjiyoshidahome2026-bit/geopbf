// convert/gzip.js ── modules/inflate.js の gzip 専用の薄い皮（PMTiles/Parquet/tile-worker が使う）。
import { inflate, deflate, deflateMany } from "../modules/inflate.js";
export const gzip = (u8) => deflate(u8, "gzip");
export const gunzip = (u8) => inflate(u8, "gzip");
export const gzipMany = (list, concurrency = 64) => deflateMany(list, "gzip", concurrency);
