export function cleanCoords(pts) {
    if (pts.length < 3) return pts;
    const eps = 1e-9, q = [];
    const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (c[0] - a[0]) * (b[1] - a[1]);
    for (let p of pts) {// 重複と折り返しの除去（ポリゴンとしての循環も考慮）
        while (q.length >= 2) {
            const [a, b] = [q[q.length-2], q[q.length-1]];
            const [v1, v2] = [[b[0]-a[0], b[1]-a[1]], [p[0]-b[0], p[1]-b[1]]];
            if (Math.abs(v1[0]*v2[1] - v1[1]*v2[0]) < eps && v1[0]*v2[0] + v1[1]*v2[1] <= 0) q.pop();
            else break;
        }
        if (!q.length || Math.hypot(q[q.length-1][0]-p[0], q[q.length-1][1]-p[1]) > eps) q.push(p);
    }
    for (let i = 0; i < q.length - 3; i++) { // 交差除去（i = -1 で変更時に最初から再走査）
        for (let j = 2; j <= 3 && i + j + 1 < q.length; j++) {
            const [p1, p2, p3, p4] = [q[i], q[i+1], q[i+j], q[i+j+1]];
            if (ccw(p1,p2,p3) * ccw(p1,p2,p4) < 0 && ccw(p3,p4,p1) * ccw(p3,p4,p2) < 0) {
                q.splice(i + 1, j); i = -1; break;
            }
        }
    }
    const [f, l] = [q[0], q[q.length-1]]; // 始点と終点のつなぎ目を正規化（ポリゴンの「口」を閉じる）
    if (f[0] === l[0] && f[1] === l[1]) q.pop(); // 一旦末尾を消して判定
    if (q.length > 2) { // つなぎ目（最後→最初→2番目）が一直線なら始点を消去
        const [a, b, c] = [q[q.length-1], q[0], q[1]];
        const [v1, v2] = [[b[0]-a[0], b[1]-a[1]], [c[0]-b[0], c[1]-b[1]]];
        if (Math.abs(v1[0]*v2[1] - v1[1]*v2[0]) < eps && v1[0]*v2[0] + v1[1]*v2[1] <= 0) q.shift();
    }
    q.push([...q[0]]); // 最後に綺麗に閉じる
    return q;
}