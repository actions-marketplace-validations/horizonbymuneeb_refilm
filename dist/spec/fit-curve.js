// refilm — curve fitting shared by `spec` (deriving rows from a track) and `verify`
// (deciding whether a clone's curve matches the reference's).
//
// Everything here is pure: series in, numbers out. No IO, no globals.
/** A cubic-bezier timing function evaluated as y for a given x (progress). */
export function bezierFn(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
        if (x <= 0)
            return 0;
        if (x >= 1)
            return 1;
        // Newton first, bisection as the safety net: the derivative can be 0 at the ends.
        let t = x;
        for (let i = 0; i < 8; i++) {
            const err = sampleX(t) - x;
            if (Math.abs(err) < 1e-6)
                return sampleY(t);
            const d = dX(t);
            if (Math.abs(d) < 1e-6)
                break;
            t -= err / d;
        }
        let lo = 0;
        let hi = 1;
        t = x;
        for (let i = 0; i < 40; i++) {
            const v = sampleX(t);
            if (Math.abs(v - x) < 1e-6)
                break;
            if (v < x)
                lo = t;
            else
                hi = t;
            t = (lo + hi) / 2;
        }
        return sampleY(t);
    };
}
const bez = (x1, y1, x2, y2) => bezierFn(x1, y1, x2, y2);
function make(name, family, b) {
    return { name, family, bezier: b, fn: bez(b[0], b[1], b[2], b[3]) };
}
/** The named curves worth fitting; families are what `verify` compares. */
export const EASINGS = [
    { name: "linear", family: "linear", bezier: [0, 0, 1, 1], fn: (t) => t },
    make("ease", "ease-in-out", [0.25, 0.1, 0.25, 1]),
    make("easeInQuad", "ease-in", [0.11, 0, 0.5, 0]),
    make("easeOutQuad", "ease-out", [0.5, 1, 0.89, 1]),
    make("easeInOutQuad", "ease-in-out", [0.45, 0, 0.55, 1]),
    make("easeInCubic", "ease-in", [0.32, 0, 0.67, 0]),
    make("easeOutCubic", "ease-out", [0.33, 1, 0.68, 1]),
    make("easeInOutCubic", "ease-in-out", [0.65, 0, 0.35, 1]),
    make("easeInQuart", "ease-in", [0.5, 0, 0.75, 0]),
    make("easeOutQuart", "ease-out", [0.25, 1, 0.5, 1]),
    make("easeInOutQuart", "ease-in-out", [0.76, 0, 0.24, 1]),
    make("easeInQuint", "ease-in", [0.64, 0, 0.78, 0]),
    make("easeOutQuint", "ease-out", [0.22, 1, 0.36, 1]),
    make("easeInOutQuint", "ease-in-out", [0.83, 0, 0.17, 1]),
    make("easeInSine", "ease-in", [0.12, 0, 0.39, 0]),
    make("easeOutSine", "ease-out", [0.61, 1, 0.88, 1]),
    make("easeInOutSine", "ease-in-out", [0.37, 0, 0.63, 1]),
    make("easeInExpo", "ease-in", [0.7, 0, 0.84, 0]),
    make("easeOutExpo", "ease-out", [0.16, 1, 0.3, 1]),
    make("easeInOutExpo", "ease-in-out", [0.87, 0, 0.13, 1]),
    make("easeInCirc", "ease-in", [0.55, 0, 1, 0.45]),
    make("easeOutCirc", "ease-out", [0, 0.55, 0.45, 1]),
    make("easeInOutCirc", "ease-in-out", [0.85, 0, 0.15, 1]),
    make("easeInBack", "ease-in", [0.36, 0, 0.66, -0.56]),
    make("easeOutBack", "spring", [0.34, 1.56, 0.64, 1]),
    make("easeInOutBack", "spring", [0.68, -0.6, 0.32, 1.6]),
];
const BY_NAME = new Map(EASINGS.map((e) => [e.name.toLowerCase(), e]));
/** Classify a declared timing function by shape: does it start fast, end fast, or run even? */
export function classifyCurve(fn) {
    const mid = fn(0.5);
    const quarter = fn(0.25);
    const threeQuarter = fn(0.75);
    // Overshoot past the end is the spring/back tell.
    let peak = 0;
    for (let i = 0; i <= 100; i++)
        peak = Math.max(peak, fn(i / 100));
    if (peak > 1.02)
        return "spring";
    if (Math.abs(mid - 0.5) <= 0.06)
        return "ease-in-out";
    if (mid > 0.5)
        return "ease-out";
    if (mid < 0.5)
        return "ease-in";
    return quarter + threeQuarter > 1 ? "ease-out" : "ease-in";
}
const STEPS_RE = /^steps?\(/i;
/** Family for a CSS/WAAPI easing string, without fitting anything. */
export function familyOf(easing) {
    if (!easing)
        return "unknown";
    const e = easing.trim().toLowerCase();
    if (STEPS_RE.test(e))
        return "steps";
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
    const springWord = /spring|elastic|bounce|back/.exec(e);
    if (springWord)
        return "spring";
    const cb = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(e);
    if (cb) {
        const [, a, b, c, d] = cb;
        const fn = bezierFn(Number(a), Number(b), Number(c), Number(d));
        return classifyCurve(fn);
    }
    const named = BY_NAME.get(e);
    if (named)
        return named.family;
    return "unknown";
}
/** The curve behind an easing string, when it can be reconstructed. */
export function curveOf(easing) {
    if (!easing)
        return null;
    const e = easing.trim().toLowerCase();
    const cb = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(e);
    if (cb)
        return bezierFn(Number(cb[1]), Number(cb[2]), Number(cb[3]), Number(cb[4]));
    if (e === "linear")
        return (t) => t;
    if (e === "ease")
        return bez([0.25, 0.1, 0.25, 1]);
    if (e === "ease-in")
        return bez([0.42, 0, 1, 1]);
    if (e === "ease-out")
        return bez([0, 0, 0.58, 1]);
    if (e === "ease-in-out")
        return bez([0.42, 0, 0.58, 1]);
    const named = BY_NAME.get(e);
    return named ? named.fn : null;
}
const IDENTITY = { tx: 0, ty: 0, sx: 1, sy: 1, rotate: 0 };
/** Reads matrix(), matrix3d(), the individual transform keywords and "none". */
export function matrixParts(transform) {
    if (!transform || transform === "none")
        return { ...IDENTITY };
    const t = transform.trim();
    const m2 = /^matrix\(\s*([^)]+)\)/.exec(t);
    if (m2) {
        const p = m2[1].split(",").map((s) => Number(s.trim()));
        if (p.length >= 6) {
            const [a, b, c, d, e, f] = p;
            return {
                tx: e,
                ty: f,
                sx: Math.hypot(a, b) || 1,
                sy: Math.hypot(c, d) || 1,
                rotate: (Math.atan2(b, a) * 180) / Math.PI,
            };
        }
    }
    const m3 = /^matrix3d\(\s*([^)]+)\)/.exec(t);
    if (m3) {
        const p = m3[1].split(",").map((s) => Number(s.trim()));
        if (p.length >= 16) {
            return {
                tx: p[12],
                ty: p[13],
                sx: Math.hypot(p[0], p[1]) || 1,
                sy: Math.hypot(p[4], p[5]) || 1,
                rotate: (Math.atan2(p[1], p[0]) * 180) / Math.PI,
            };
        }
    }
    // "translateY(40px) rotate(360deg) scale(1.2)" — order matters in CSS, but for tracking
    // we only need the magnitude of each channel, so accumulate independently.
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
// ---------------------------------------------------------------- fitting
const EPS = 1e-9;
/** First and last sample index where the series moves more than `frac` of its total travel. */
export function motionSpan(values, frac = 0.02) {
    if (values.length < 2)
        return null;
    const change = values[values.length - 1] - values[0];
    let lo = values[0];
    let hi = values[0];
    for (const v of values) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
    }
    const travel = hi - lo;
    if (travel <= EPS)
        return null;
    const eps = Math.max(travel * frac, EPS);
    let first = -1;
    let last = -1;
    for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - values[0]) > eps) {
            first = i;
            break;
        }
    }
    for (let i = values.length - 2; i >= 0; i--) {
        if (Math.abs(values[values.length - 1] - values[i]) > eps) {
            last = i;
            break;
        }
    }
    if (first < 0 || last < first)
        return null;
    return { first, last: last + 1, change };
}
/**
 * Fits a series against the named easings. The window is measured first (visible motion),
 * then each candidate curve is scored on the normalised progress inside that window.
 */
export function fitSeries(series, opts = {}) {
    const pts = series
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .sort((a, b) => a[0] - b[0]);
    const empty = {
        samples: pts.length,
        start: 0,
        end: 0,
        change: 0,
        delayMs: 0,
        visibleDurationMs: 0,
        overshootPct: 0,
        springLike: false,
        settleMs: null,
        verdict: "no samples",
        bestFits: [],
    };
    if (pts.length < 3)
        return empty;
    const from = opts.fromMs ?? pts[0][0];
    const to = opts.toMs ?? pts[pts.length - 1][0];
    const win = pts.filter((p) => p[0] >= from && p[0] <= to);
    if (win.length < 3)
        return { ...empty, verdict: "too few samples in the window" };
    const values = win.map((p) => p[1]);
    const span = motionSpan(values);
    if (!span)
        return { ...empty, samples: win.length, verdict: "value does not move" };
    const startT = win[span.first][0];
    const endT = win[span.last][0];
    const dur = endT - startT;
    const v0 = win[span.first][1];
    const v1 = win[span.last][1];
    const change = v1 - v0;
    const travel = Math.abs(change) || EPS;
    // overshoot: how far past the final value the curve goes, relative to the travel
    let extreme = v1;
    for (let i = span.first; i <= span.last; i++) {
        const v = win[i][1];
        if (Math.abs(v - v0) > Math.abs(extreme - v0))
            extreme = v;
    }
    const overshootPct = Math.max(0, (Math.abs(extreme - v1) / travel) * 100);
    let settleMs = null;
    if (overshootPct > 0.5) {
        for (let i = win.length - 1; i >= span.first; i--) {
            if (Math.abs(win[i][1] - v1) > travel * 0.02) {
                settleMs = win[i][0] - startT;
                break;
            }
        }
    }
    const maxFactor = opts.maxDurationFactor ?? 1.5;
    const candidates = [];
    for (const easing of EASINGS) {
        let sum = 0;
        let n = 0;
        for (let i = span.first; i <= span.last; i++) {
            const t = dur <= EPS ? 1 : (win[i][0] - startT) / dur;
            const progress = (win[i][1] - v0) / (change || EPS);
            const predicted = easing.fn(Math.min(1, Math.max(0, t)));
            sum += (progress - predicted) ** 2;
            n++;
        }
        if (!n)
            continue;
        const rmse = Math.sqrt(sum / n);
        candidates.push({
            name: easing.name,
            family: easing.family,
            bezier: easing.bezier,
            rmse,
            durationMs: dur,
        });
    }
    candidates.sort((a, b) => a.rmse - b.rmse);
    const top = Math.max(1, opts.top ?? 3);
    const bestFits = candidates.slice(0, top).filter((c) => c.durationMs <= dur * maxFactor + 1);
    const best = bestFits[0];
    const verdict = best
        ? `${best.name} ${Math.round(dur)}ms (rmse ${best.rmse.toFixed(3)})`
        : "no easing fits";
    return {
        samples: win.length,
        start: startT,
        end: endT,
        change,
        delayMs: startT,
        visibleDurationMs: dur,
        overshootPct,
        springLike: overshootPct > 2,
        settleMs,
        verdict,
        bestFits,
    };
}
/** Mean absolute difference between two curves sampled on the same normalised time base. */
export function meanAbsDiffCurves(a, b, steps = 40) {
    let sum = 0;
    for (let i = 0; i <= steps; i++)
        sum += Math.abs(a(i / steps) - b(i / steps));
    return sum / (steps + 1);
}
/** Normalises a fitted series to a 0..1 progress curve sampled at `steps` points. */
export function progressCurve(series, fit, steps = 40) {
    const pts = series.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((x, y) => x[0] - y[0]);
    const dur = Math.max(1, fit.visibleDurationMs);
    const v0 = pts.length ? valueAt(pts, fit.start) : 0;
    const v1 = pts.length ? valueAt(pts, fit.end) : 1;
    const travel = v1 - v0 || EPS;
    return (t) => {
        const tm = fit.start + Math.min(1, Math.max(0, t)) * dur;
        return (valueAt(pts, tm) - v0) / travel;
    };
}
function valueAt(pts, t) {
    if (t <= pts[0][0])
        return pts[0][1];
    const last = pts[pts.length - 1];
    if (t >= last[0])
        return last[1];
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid][0] <= t)
            lo = mid;
        else
            hi = mid;
    }
    const [t0, v0] = pts[lo];
    const [t1, v1] = pts[hi];
    const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    return v0 + (v1 - v0) * k;
}
/** Samples an easing string at n points; null when the string cannot be reconstructed. */
export function sampleEasing(easing, steps = 40) {
    const fn = curveOf(easing);
    if (!fn)
        return null;
    return Array.from({ length: steps + 1 }, (_, i) => fn(i / steps));
}
