import { PBF } from "./pbf-extension.js";
class PBFIO {
    constructor(dire) { this.dire = dire||"GIS"; }
    async open() { 
        const {nativeBucket} = await import('native-bucket');
        const {Bucket, Cache, Fetch} = await nativeBucket();
        this.bucket = await Bucket(`${this.dire}/pbf`);
        this.cache = await Cache(`${this.dire}/pbf`);
        this.fetch = Fetch;
        this.fetchCache = await Cache(`${this.dire}/loaded`);
        if (!this.bucket || !this.cache) { console.error("PBFIO open error: unable to access bucket or cache."); return null; }
        return this;
    }
    async files() { return await this.bucket.list(); }
    async _sync(name, ETag) {
        const blob = await this.bucket.get(name);
        const Buff = await blob.arrayBuffer();
        await this.cache(name, {ETag, Buff});
        return Buff
    }
    async sync() {
        const localKeys = (await this.cache())||[];
        for (const name of localKeys) {
            const ETag = await this.bucket.etag(name);
            if (ETag === false) break
            (ETag === null)? await this.delete(name) : await _sync(name, ETag);
        }
    }
    async fetch(name, useCache = true) {
        if (useCache) { const v = await this.fetchCache(name); if (v) return v; }
        const [url, target] = name.split(/\#/);
        const file = target? await this.fetch(url, {target}): await Fetch(url);
        await this.fetchCache(name, file);
        return file;
    }
    async load(name) {
        const [val, ETag] = await Promise.all([this.cache(name), this.bucket.etag(name)]).catch(console.error);
        if (ETag === false) { // Etag === false はオフラインまたは通信異常
            console.warn(`PBF get warning: server is unreachable. Using local cache for ${name} if available.`);
            return (val && val.Buff)? new PBF().set(val.Buff) : null;
         }  else if (ETag === null) { // Etag === null はサーバー上にファイルが存在しないことを意味する。ローカルにあっても消去するべき。
            console.error(`PBF get error: file(${name}) is not exist.`); 
            if (val) await this.cache(name, null);
            return null;
        }
        return new PBF().set(await _sync(name, ETag));
    }
    async save(pbf) {
        const name = pbf.name(); if (!name) { console.error("can't save pbf widthout name."); return null; }
        await this.bucket.put(name, await pbf.pbfFile());
        await this.cache(name, {ETag: await this.bucket.etag(name), Buff: await pbf.pbfBuffer()});
        return name;
    }
    async delete(name) {
        await this.bucket.del(name);
        await this.cache(name, null);
        return name;
    }
}
export async function pbfio(dire) { return new PBFIO(dire).open(); } 
