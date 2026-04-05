////---------------------------------------------------------------------------------------------------------
//// ArrayBufferの圧縮・伸長
////---------------------------------------------------------------------------------------------------------
const pipe = async(q, filter) => new Response(new Blob([q]).stream().pipeThrough(filter)).arrayBuffer();
const enc = q => pipe(q, new CompressionStream("deflate-raw"));
const dec = q => pipe(q, new DecompressionStream("deflate-raw"));
const thenMap = async(a, func) => { const n = a.length, q = [];
    for (let i = 0; i < n; i++) q.push(await func(a[i],i).catch(console.error)); return q;
};
////---------------------------------------------------------------------------------------------------------
//// bufferTub (ArrayBufferを効率的に、アレイ化)
////---------------------------------------------------------------------------------------------------------
export class bufferTub {
    constructor() { this.tub = []; }
    set(q) { if (q instanceof ArrayBuffer) return abset(this.tub, q); }
    async close() { const a = this.tub.sort((p,q)=>p[1]>q[1]?1:-1).map(t=>t[0]); this.tub = [];
        return thenMap(a, enc);
    }
  }
 export class readBufs { 
    constructor() { this.tub = []; }
    set(q) { this.tub.push(q); }
    async close() { const tobuf = v => v.buffer.slice(v.byteOffset, v.byteLength + v.byteOffset);
        return thenMap(this.tub.map(tobuf), dec);
    }
}
function abcomp(buf1, buf2) {
    if (buf1 === buf2) return 0;
    let d = (buf2.byteLength - buf1.byteLength); if (d) return d;
    var view1 = new DataView(buf1), view2 = new DataView(buf2);
    var n = buf1.byteLength;
    for (let i = 0; i < n; i++) { d = view2.getUint8(i) - view1.getUint8(i); if (d) return d; }
    return 0;
};
function abset(a, buf) { //buf = buf.buffer || buf;
    var len = a.length; if (len == 0) { a[0] = [buf, len]; return len; }
    return (function cmp(m0, m1) {
        const v0 = abcomp(a[m0][0], buf); if (!v0) return a[m0][1];
        const v1 = abcomp(buf, a[m1][0]); if (!v1) return a[m1][1];
        if (v0 < 0) { a.unshift([buf, len]); return len; }
        if (v1 < 0) { a.push([buf, len]); return len; }
        if (m1 - m0 == 1) { a.splice(m0+1, 0, [buf,len]); return len }
        var mm = ~~((m0+m1)/2);
        var v = abcomp(a[mm][0], buf); if (!v) return a[mm][1];
        if (v > 0) return cmp(mm, m1);
        if (v < 0) return cmp(m0, mm);
    })(0, len - 1);
}
