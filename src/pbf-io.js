import { Bucket, Cache } from 'native-bucket';
import { PBF } from "./pbf-extension.js";
class PBFIO {
    constructor(dire) { this.dire = dire; }
    async open() { 
        this.bucket = await Bucket(this.dire);
        this.cache = await Cache(this.dire);
        return this;
    }
    async isServerAlive() {
        if (!navigator.onLine) return false;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const result = await this.bucket.etag('.healthcheck', { signal: controller.signal });
            clearTimeout(timeout);
            return result; // 応答があればオンライン確定
        } catch (e) { return false; }
    }
    async files() {
        const files = {}, res = await this.bucket.list();
        res.forEach(({Key, Size, LastModified, ETag})=>files[Key] = {Size, LastModified, ETag});
        return files;
    }
    async sync() {
        const localKeys = await this.cache();
        if (!Array.isArray(localKeys)) return;

        // 同期処理を走らせるが、途中で「完全にオフライン」だと判明したら即中断する
        for (const name of localKeys) {
            try {
                const remoteETag = await this.bucket.etag(name);

                if (remoteETag === null) {
                    // サーバーから「404 (Not Found)」が返ってきた時だけ消去
                    await this.delete(name);
                } else {
                    // サーバーに存在するなら load に任せる（ETag比較含む）
                    await this.load(name);
                }
            } catch (e) {
                // ネットワークエラー（オフライン、タイムアウト）の場合
                // ループを抜けて同期を中断する。中途半端な削除を防ぐため。
                console.error("[Sync] サーバーに到達できません。同期を中断し、ローカルデータを保護します。");
                break; 
            }
        }
    }
    async load(name) {
        const pbf = new PBF();
        const [val, ETag] = await Promise.all([this.cache(name), this.bucket.etag(name)]).catch(console.error);
        if (!ETag) { console.error(`PBF get error: file(${name}) is not exist.`);  return pbf; }
        if (val && (val.ETag == ETag||!ETag)) return pbf.set(val.Buff);
        const file = new File([await this.bucket.get(name)], name ,{type:"application/gzip"});
        const Buff = await file.arrayBuffer();
        await this.cache(name, {ETag, Buff});
        return pbf.set(Buff);
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
