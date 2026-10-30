// refilm — easing-string parsing and curve comparison.
//
// `src/commands/fit.ts` owns the numerical fitting (it is the command's own engine, and its
// `fitSeries` searches the duration as well as the curve). What it does not do — because the
// `fit` command never needs it — is turn a *declared* easing string from a page into a curve
// and a family, which is what `spec` reads out of inspect.json keyframes and what `verify`
// compares against a clone's measured curve. That is all this module does.
import { cubicBezier, EASINGS, matrixParts } from "../commands/fit.js";
/** Transform channels for a computed or declared transform string. */
export { matrixParts };
const IDENTITY = { tx: 0, ty: 0, sx: 1, sy: 1, rotate: 0 };
/**
 * `fit.ts`'s matrixParts reads computed matrices. Keyframe values from `getKeyframes()` are
 * written in keyword form (`translateY(40px)`, `scale(0.9)`), so they need their own reader.
 */
export function keywordTransform(transform) {
    if (!transform || transform === "none")
        return { ...IDENTITY };
    const t = transform.trim();
    if (/^matrix(3d)?\(/.test(t)) {
        const p = matrixParts(t);
        return { tx: p.tx, ty: p.ty, sx: p.sx, sy: p.sy, rotate: p.rotate };
    }
    const out = { ...IDENTITY };
    for (const part of t.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
        const name = part[1].toLowerCase();
        const vals = part[2]
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((v) => Number.parseFloat(v));
        if (vals.some((v) => !Number.isFinite(v)))
            continue;
        switch (name) {
            case "translate":
                out.tx += vals[0] ?? 0;
                out.ty += vals[1] ?? 0;
                break;
            case "translatex":
                out.tx += vals[0] ?? 0;
                break;
            case "translatey":
                out.ty += vals[0] ?? 0;
                break;
            case "translate3d":
                out.tx += vals[0] ?? 0;
                out.ty += vals[1] ?? 0;
                break;
            case "scale":
                out.sx *= vals[0] ?? 1;
                out.sy *= vals[1] ?? vals[0] ?? 1;
                break;
            case "scalex":
                out.sx *= vals[0] ?? 1;
                break;
            case "scaley":
                out.sy *= vals[0] ?? 1;
                break;
            case "rotate":
            case "rotatez":
                out.rotate += vals[0] ?? 0;
                break;
            default:
                break;
        }
    }
    return out;
}
/** Classify an arbitrary progress function by shape: fast start, fast end, or even. */
export function classifyCurve(fn) {
    let peak = 0;
    for (let i = 0; i <= 100; i++)
        peak = Math.max(peak, fn(i / 100));
    if (peak > 1.02)
        return "spring";
    const mid = fn(0.5);
    if (Math.abs(mid - 0.5) <= 0.06)
        return "ease-in-out";
    return mid > 0.5 ? "ease-out" : "ease-in";
}
const STEPS_RE = /^steps?\(/i;
/** The family a declared easing string belongs to, without fitting anything. */
export function familyOf(easing) {
    if (!easing)
        return "unknown";
    const e = easing.trim().toLowerCase();
    if (STEPS_RE.test(e))
        return "steps";
    if (/spring|elastic|bounce/.test(e))
        return "spring";
    if (e === "linear")
        return "linear";
    if (e === "ease")
        return "ease-in-out";
    if (e === "ease-in")
        return "ease-in";
    if (e === "ease-out")
        return "ease-out";
    if (e === "ease-in-out")
        return "ease-in-out";
    const cb = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(e);
    if (cb)
        return classifyCurve(cubicBezier(Number(cb[1]), Number(cb[2]), Number(cb[3]), Number(cb[4])));
    if (/back/.test(e))
        return "spring";
    const named = EASINGS.find((x) => x.name.toLowerCase() === e || (x.aliases ?? []).some((a) => a.toLowerCase() === e));
    return named ? named.family : "unknown";
}
/** The curve behind a declared easing string, when it can be reconstructed. */
export function curveOf(easing) {
    if (!easing)
        return null;
    const e = easing.trim().toLowerCase();
    const cb = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(e);
    if (cb)
        return cubicBezier(Number(cb[1]), Number(cb[2]), Number(cb[3]), Number(cb[4]));
    if (e === "linear")
        return (t) => t;
    if (e === "ease")
        return cubicBezier(0.25, 0.1, 0.25, 1);
    if (e === "ease-in")
        return cubicBezier(0.42, 0, 1, 1);
    if (e === "ease-out")
        return cubicBezier(0, 0, 0.58, 1);
    if (e === "ease-in-out")
        return cubicBezier(0.42, 0, 0.58, 1);
    const named = EASINGS.find((x) => x.name.toLowerCase() === e || (x.aliases ?? []).some((a) => a.toLowerCase() === e));
    return named ? named.fn : null;
}
/** A curve sampled on a normalised 0..1 time base. */
export function sampleCurve(easing, steps = 40) {
    const fn = curveOf(easing);
    if (!fn)
        return null;
    return Array.from({ length: steps + 1 }, (_, i) => fn(i / steps));
}
/** Mean absolute distance between two normalised curves; 0..1 in progress units. */
export function curveDistance(a, b) {
    if (!a || !b || a.length !== b.length || !a.length)
        return null;
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}
/** Mean absolute distance between a declared curve and a measured normalised progress series. */
export function curveDistanceToSeries(curve, series, steps = 40) {
    if (!curve || series.length < 3)
        return null;
    const t0 = series[0][0];
    const t1 = series[series.length - 1][0];
    const dur = t1 - t0;
    if (!(dur > 0))
        return null;
    const v0 = series[0][1];
    const travel = series[series.length - 1][1] - v0;
    if (Math.abs(travel) < 1e-9)
        return null;
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
        const t = t0 + (dur * i) / steps;
        const measured = (valueAt(series, t) - v0) / travel;
        sum += Math.abs(measured - curve[i]);
    }
    return sum / (steps + 1);
}
function valueAt(series, t) {
    if (t <= series[0][0])
        return series[0][1];
    const last = series[series.length - 1];
    if (t >= last[0])
        return last[1];
    let lo = 0;
    let hi = series.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (series[mid][0] <= t)
            lo = mid;
        else
            hi = mid;
    }
    const [ta, va] = series[lo];
    const [tb, vb] = series[hi];
    const k = tb === ta ? 0 : (t - ta) / (tb - ta);
    return va + (vb - va) * k;
}
export { valueAt as seriesValueAt };
