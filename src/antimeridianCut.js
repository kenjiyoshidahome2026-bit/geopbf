export function antimeridianCut(points, isLine = false) {
    const tub = [];
    const is_ring = _ => (_[0][0] == _[_.length - 1][0]) && (_[0][1] == _[_.length - 1][1]);
    const is_clockwise = _ => {
        let sum = 0;
        for (let i = 0; i < _.length - 1; i++) sum += (_[i + 1][0] - _[i][0]) * (_[i + 1][1] + _[i][1]);
        return sum > 0;
    };
    const sum = a => { let s = 0; a.forEach(t => s += t); return s; };
    const north = sum(points.map(t => t[1])) > 0; // 北半球か南半球か？
    const fix = x => x + (x < -180 ? 360 : x > 180 ? -360 : 0);
    points = points.map(t => [fix(t[0]), t[1]]);
    const straddles = p => {
        const a = [[], []];
        for (let i = 0; i < p.length - 1; i += 1) if (p[i][0] * p[i + 1][0] < 0) {
            var flag = ((p[i][0] > 0) ? (p[i + 1][0] < p[i][0] - 180) : (p[i][0] < p[i + 1][0] - 180)) ? 0 : 1;
            a[flag].push(i);
        }
        return a;
    };
    function intersect([x0, y0], [x1, y1], flag = 1) {
        const x = sin((y0 - y1) * d2r) * sin((x0 + x1) / 2 * d2r) * cos((x0 - x1) / 2 * d2r)
                - sin((y0 + y1) * d2r) * cos((x0 + x1) / 2 * d2r) * sin((x0 - x1) / 2 * d2r);
        const z = cos(y0 * d2r) * cos(y1 * d2r) * sin((x0 - x1) * d2r);
        return (flag * z < 0 ? -1 : 1) * atan2(x, sqrt(z * z)) / d2r;
    }
    const poleFilter = a => {
        const n = a.length, pole = north ? 90 : -90;
        return (abs(a[0][0] - a[1][0]) > 179) ?
            [].concat(a.slice(0, 1), [[a[0][0], pole], [(a[0][0] + a[1][0]) / 2, pole], [a[1][0], pole]], a.slice(1)) :
            (abs(a[n - 1][0] - a[n - 2][0]) > 179) ?
            [].concat(a.slice(0, n - 1), [[a[n - 2][0], pole], [(a[n - 1][0] + a[n - 2][0]) / 2, pole], [a[n - 1][0], pole]], a.slice(n - 1)) : a;
    };
    ((is_ring(points) && !isLine) ? splitPolygon : splitPloyLine)(points);
    return tub;
    function splitPolygon(p) {
        is_clockwise(p) || p.reverse();
        const crossings = straddles(p);
        if (crossings[0].length === 0) { tub.push([p]); return; }
        var [start, end] = crossings[0].map(i => [intersect(p[i], p[i + 1], 1), i]).sort(([p], [q]) => north ? p - q : q - p);
        var reverse = crossings[1].map(i => [intersect(p[i], p[i + 1], -1), i]).sort(([p], [q]) => north ? q - p : p - q)[0];
        cut(start, 1, end || reverse, end ? 1 : 0);
        cut(end || reverse, end ? 1 : 0, start, 1);
        function cut(start, s, end, e) {
            const a = [];
            let i = (start[1] < p.length - 2) ? start[1] + 1 : 0;
            const degree = 180 * (p[i][0] < 0 ? -1 : 1);
            a.push([s ? degree : 0, start[0]]); a.push(p[i]);
            while (i !== end[1]) a.push(p[i = (i < p.length - 2) ? i + 1 : 0]);
            a.push([e ? degree : 0, end[0]]); a.push(a[0]);
            splitPolygon(s & e ? a : poleFilter(a));
        }
    }
    function splitPloyLine(p) {
        let i = 0;
        for (; i < p.length - 1; i++) if (p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) break;
        if (i == p.length - 1) { tub.push(p); return; }
        var lat = intersect(p[i], p[i + 1], 1);
        tub.push(p.slice(0, i + 1).concat([[180 * (p[0][0] < 0 ? -1 : 1), lat]]));
        splitPloyLine([[180 * (p[0][0] < 0 ? 1 : -1), lat]].concat(p.slice(i + 1)));
    }
}
