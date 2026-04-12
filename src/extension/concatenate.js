import { PBF } from "../pbf-base.js";

export async function concatenate(pbfs, name) {
    pbfs = pbfs.filter(t => t instanceof PBF);
    if (pbfs.length == 0) return new PBF();
    if (pbfs.length == 1) return pbfs[0];

    const precisions = pbfs.map(t => t.precision());
    if (!precisions.slice(1).every(t => t == precisions[0])) {
        console.error("PBF concatenate: precision is not equal.");
        return null;
    }

    name = name || pbfs[0].name();
    const props = pbfs.map(pbf => pbf.properties);
    const [keys, bufs] = await PBF.makeKeys(props.flat());
    const pbf = new PBF({ name }).setHead(keys, bufs);

    pbf.setBody(() => pbfs.forEach((t, n) => {
        t.each(i => pbf.setMessage(PBF.TAGS.FEATURE, () => {
            pbf.copyGeometry(t, i);
            pbf.setProperties(props[n][i]);
        }));
    })).close();

    return pbf.getPosition();
}