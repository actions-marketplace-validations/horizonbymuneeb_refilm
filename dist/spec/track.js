// refilm — fit spec rows out of a capture's track.json.
//
// A track is the honest middle ground: no declared timings, but the element's position, size
// and opacity on every animation frame, so start, duration, travel, overshoot and the easing
// shape are all measurable. What it cannot answer is *why* (which selector the author meant,
// what happens outside the recorded window), and that goes to notes.
import { fitSeries, TRACK_PROPS } from "../commands/fit.js";
import { keywordTransform } from "./easing.js";
import { roundTo } from "./row.js";
/** Every tracked element, in first-seen order. */
export function trackElements(track) {
    const out = [];
    for (const s of track.samples ?? []) {
        for (const el of Object.keys(s.els ?? {}))
            if (!out.includes(el))
                out.push(el);
    }
    return out;
}
export function channelSeries(track, element, prop) {
    const out = [];
    for (const sample of track.samples ?? []) {
        const el = sample.els?.[element];
        if (!el || !Number.isFinite(sample.t))
            continue;
        const m = keywordTransform(el.transform);
        const values = {
            x: el.x,
            y: el.y,
            w: el.w,
            h: el.h,
            opacity: el.opacity,
            scale: m.sx,
            scaleX: m.sx,
            scaleY: m.sy,
            translateX: m.tx,
            translateY: m.ty,
            rotate: m.rotate,
        };
        const v = values[prop];
        if (typeof v === "number" && Number.isFinite(v))
            out.push([sample.t, v]);
    }
    return out;
}
/** Fits every tracked channel of every element. Channels with no motion are dropped. */
export function trackChannelFits(track) {
    const out = [];
    for (const element of trackElements(track)) {
        for (const property of TRACK_PROPS) {
            const series = channelSeries(track, element, property);
            if (series.length < 4)
                continue;
            const fit = fitSeries(series);
            if (!fit.bestFits.length || Math.abs(fit.change) < 1e-9)
                continue;
            const t0 = series[0][0];
            out.push({
                element,
                property,
                series,
                fit,
                startMs: roundTo(t0 + fit.delayMs, 1),
                endMs: roundTo(t0 + fit.delayMs + fit.visibleDurationMs, 1),
            });
        }
    }
    return out;
}
/** Median gap between samples: the timing resolution of anything fitted from this track. */
export function sampleIntervalMs(series) {
    if (series.length < 3)
        return 0;
    const gaps = [];
    for (let i = 1; i < series.length; i++)
        gaps.push(series[i][0] - series[i - 1][0]);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] ?? 0;
}
/** True when the value comes back to where it started and keeps moving: a loop, not a tween. */
function looksCyclic(series) {
    if (series.length < 6)
        return false;
    const first = series[0][1];
    const last = series[series.length - 1][1];
    let lo = first;
    let hi = first;
    for (const [, v] of series) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
    }
    const range = hi - lo;
    if (range < 1e-6)
        return false;
    // back at its start within 5% of the range, having travelled at least five times that gap
    return Math.abs(last - first) < range * 0.05 && range > Math.abs(last - first) * 5;
}
export function deriveFromTrack(track, opts = {}) {
    const rows = [];
    const notes = [];
    const facts = {};
    const samples = Array.isArray(track.samples) ? track.samples : [];
    if (!samples.length) {
        notes.push("track.json has no samples — nothing was tracked, so no row can be measured from it");
        return { rows, notes, facts, elements: [] };
    }
    facts["track.samples"] = samples.length;
    facts["track.selectors"] = (track.selectors ?? []).join(", ") || "(none)";
    facts["track.spanMs"] = roundTo(samples[samples.length - 1].t - samples[0].t, 1);
    if (opts.fps)
        facts["track.fps"] = opts.fps;
    const scrollValues = samples.map((s) => s.scrollY).filter((v) => Number.isFinite(v));
    if (scrollValues.length) {
        const scrollRange = Math.max(...scrollValues) - Math.min(...scrollValues);
        facts["track.scrollRange"] = roundTo(scrollRange, 1);
        if (scrollRange > 1) {
            notes.push(`the page scrolled ${Math.round(scrollRange)} px during the capture — position changes below may be scroll, not animation`);
        }
    }
    const fits = trackChannelFits(track);
    if (!fits.length) {
        notes.push("no tracked channel moves inside the recorded window: the track shows a static capture");
        return { rows, notes, facts, elements: trackElements(track) };
    }
    // translateY and y move together; reporting both would double every row. The transform wins
    // because it is what the author wrote.
    const transformProps = new Map();
    for (const f of fits) {
        if (!["translateX", "translateY", "scale", "rotate"].includes(f.property))
            continue;
        const set = transformProps.get(f.element) ?? new Set();
        set.add(f.property);
        transformProps.set(f.element, set);
    }
    const suppressed = (f) => {
        const t = transformProps.get(f.element);
        if (!t)
            return false;
        if (f.property === "y" && t.has("translateY"))
            return true;
        if (f.property === "x" && t.has("translateX"))
            return true;
        if ((f.property === "w" || f.property === "h") && (t.has("scale") || t.has("scaleX")))
            return true;
        return false;
    };
    const kept = fits
        .filter((f) => !suppressed(f))
        .sort((a, b) => a.startMs - b.startMs || a.element.localeCompare(b.element) || a.property.localeCompare(b.property));
    const interval = sampleIntervalMs(kept[0]?.series ?? []);
    if (interval > 0) {
        facts["track.sampleIntervalMs"] = roundTo(interval, 1);
        notes.push(`timing from this track is resolved to one sample interval (${roundTo(interval, 1)} ms): a start time is known to about ±${roundTo(interval / 2, 1)} ms, not to the millisecond`);
    }
    for (const f of kept) {
        const best = f.fit.bestFits[0];
        const cyclic = looksCyclic(f.series);
        // The first sample that shows a change proves the motion began somewhere in the preceding
        // interval, so the honest start is that previous sample, not the first changed one.
        const rawStart = f.startMs;
        const startMs = interval > 0 ? roundTo(Math.max(f.series[0][0], rawStart - interval), 1) : rawStart;
        const rowNotes = [];
        if (cyclic) {
            rowNotes.push("the value returns to where it started: a repeating cycle, so this window is one cycle, not a one-shot tween");
        }
        if (f.fit.springLike) {
            rowNotes.push(`overshoots by ${f.fit.overshootPct.toFixed(1)}% and settles after ~${f.fit.settleMs ?? "?"} ms — a spring or back curve, not a monotone one`);
        }
        if (f.startMs < 0)
            rowNotes.push("motion had already started before t=0: the capture began after the animation did");
        if (f.fit.samples < 6)
            rowNotes.push(`only ${f.fit.samples} samples cover this motion, so the timing is coarse`);
        // A front-loaded curve reaches its last visible change well before its declared duration, so
        // the observed window under-reports it. The fitted duration is the declared one; say both.
        if (best && Math.abs(best.durationMs - f.fit.visibleDurationMs) > 80) {
            rowNotes.push(`change is visible for ${Math.round(f.fit.visibleDurationMs)} ms but the curve fits a ${best.durationMs} ms tween: use the fitted duration, the tail is under 1% of the travel`);
        }
        rows.push({
            element: f.element,
            property: f.property,
            from: roundTo(f.fit.start, 4),
            to: roundTo(f.fit.end, 4),
            startMs,
            durationMs: roundTo(best ? best.durationMs : f.fit.visibleDurationMs, 1),
            easing: best ? best.name : null,
            easingFamily: best ? best.family : "unknown",
            overshoot: f.fit.overshootPct > 0.5 ? roundTo(f.fit.overshootPct, 2) : 0,
            source: "track",
            confidence: cyclic ? "low" : best && best.rmse < 0.05 ? "medium" : "low",
            group: `${f.element}|${f.property}`,
            note: rowNotes.length ? rowNotes.join("; ") : undefined,
        });
        // A near-tie between families is a real ambiguity and must not hide behind a confident row.
        const second = f.fit.bestFits[1];
        if (!cyclic && best && second && second.family !== best.family && second.rmse - best.rmse < 0.02) {
            notes.push(`${f.element}.${f.property}: ${best.name} (rmse ${best.rmse}) and ${second.name} (rmse ${second.rmse}) fit almost equally well — the easing family is not decided by ${f.fit.samples} samples`);
        }
        if (cyclic) {
            notes.push(`${f.element}.${f.property}: the tracked value cycles — record the period and the repeat count from the capture instead of a single tween`);
        }
    }
    const movingElements = new Set(kept.map((f) => f.element));
    const allElements = trackElements(track);
    const still = allElements.filter((el) => !movingElements.has(el));
    if (still.length) {
        facts["track.stillElements"] = still.join(", ");
        notes.push(`${still.join(", ")}: tracked and never moved — the clone must keep ${still.length > 1 ? "them" : "it"} still`);
    }
    facts["track.animatedElements"] = [...movingElements].join(", ") || "(none)";
    return { rows, notes, facts, elements: allElements };
}
