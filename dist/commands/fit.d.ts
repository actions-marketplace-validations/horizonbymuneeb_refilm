import type { EasingFamily } from "../types.js";
export declare const help = "\nrefilm fit \u2014 which easing is this curve, and how long does it run?\n\n  refilm fit --track <track.json> --selector <css> --prop <x|y|w|h|opacity|scale|translateX|translateY|rotate>\n  refilm fit --series '[[0,0],[100,12],[200,40],[300,80]]'\n  refilm fit --track <gl-track.json> --channel <uHover|...>\n  refilm fit --track <track.json> --selector .hero --prop y --compare-track <other.json> [--compare-channel k]\n\n  --from-ms T / --to-ms T   clip the curve before analysis (ms of reference time)\n  --compare-track <json>    diff this curve against another track's curve (same selector/prop unless\n                            --compare-channel is given for a gl-track)\n  --compare-channel <key>   channel of the comparison gl-track\n  --top N                   how many easing candidates to report, default 5\n\nPrints start/end values, delay (time of the first observed change), visible duration (first \u2192 last\nchange), overshoot %, settle time, whether it looks spring-like, and the best-fitting named easings\nwith RMSE and the fitted duration for each.\n\nReading it: take bestFits[0] as the easing to declare in the clone (bezier is ready to paste into CSS),\nrebuild with that duration, then re-run fit on the clone's track \u2014 a curve that fits the same easing\nwith a low RMSE is a motion match even when the pixels are still off.\n";
export interface EasingSpec {
    /** Human name; also the CSS keyword when the easing has one. */
    name: string;
    /** Coarse bucket for SpecRow.easingFamily. */
    family: EasingFamily;
    /** cubic-bezier control points, or null for a non-bezier curve. */
    bezier: [number, number, number, number] | null;
    /** Normalised progress 0..1 → eased progress (may exceed 1 for back/overshoot curves). */
    fn: (t: number) => number;
    /** Other spellings that mean exactly this curve. */
    aliases?: string[];
}
/** CSS cubic-bezier(x1,y1,x2,y2) as a progress function, solved per call by bisection on x. */
export declare function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number;
/**
 * Every named curve a landing page, a design system or a tween library actually uses.
 * The bezier numbers are the CSS equivalents of the classic Penner-style power curves, so a match
 * can be declared directly in CSS or in a JS tween without translating anything.
 */
export declare const EASINGS: ReadonlyArray<EasingSpec>;
export interface MatrixParts {
    tx: number;
    ty: number;
    sx: number;
    sy: number;
    rotate: number;
}
/** Pull translate/scale/rotate out of a computed `transform: matrix(...)` / `matrix3d(...)`. */
export declare function matrixParts(transform: string | null | undefined): MatrixParts;
export type Series = Array<[number, number]>;
export declare const TRACK_PROPS: readonly ["x", "y", "w", "h", "opacity", "scale", "scaleX", "scaleY", "translateX", "translateY", "rotate"];
export type TrackProp = (typeof TRACK_PROPS)[number];
/** Series from a track.json: one value per sample, `prop` measured on `selector`. */
export declare function seriesFromTrack(track: any, selector: string, prop: string): Series;
/** Resolve a gl channel name: exact key, or a unique key ending in "." + name. */
export declare function resolveChannel(track: any, name: string): string;
export declare function seriesFromGlTrack(track: any, channel: string): Series;
/** Pick the right reader for a track file: gl-track.json needs --channel, track.json needs --selector. */
export declare function seriesFromFile(path: string, opts: {
    selector?: string;
    prop?: string;
    channel?: string;
}): Series;
export interface FitBest {
    name: string;
    family: EasingFamily;
    /** cubic-bezier control points, ready for CSS; null for linear. */
    bezier: [number, number, number, number] | null;
    rmse: number;
    durationMs: number;
    delayMs: number;
}
export interface FitResult {
    samples: number;
    start: number;
    end: number;
    change: number;
    delayMs: number;
    visibleDurationMs: number;
    overshootPct: number;
    springLike: boolean;
    settleMs: number | null;
    verdict: string;
    note: string;
    bestFits: FitBest[];
}
export interface FitOptions {
    fromMs?: number;
    toMs?: number;
    top?: number;
    /** How much longer than the visible duration the fitted duration may be (expo tails). */
    maxDurationFactor?: number;
}
/**
 * Fit a series to the easing library. The model is
 *   value(t) = start + range * easing((t - tStart) / duration)
 * with `tStart` anchored on the last sample that still held the start value and `duration`
 * searched (coarse grid, then bisection-style refinement), so the reported duration is measured
 * rather than assumed.
 */
export declare function fitSeries(input: Series, opts?: FitOptions): FitResult;
/** Compare two curves on a common time grid and report the worst and average distance. */
export declare function diffSeries(a: Series, b: Series): {
    maxAbsDiff: number;
    meanAbsDiff: number;
    samples: number;
    diffs: Array<{
        t: number;
        diff: number;
    }>;
};
export declare function run(argv: string[], ctx: {
    json: boolean;
}): Promise<number>;
