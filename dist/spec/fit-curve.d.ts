import type { EasingFamily } from "../types.js";
/** A property over time: [timeMs, value] pairs, sorted by time. */
export type Series = Array<[number, number]>;
export interface FitBest {
    name: string;
    family: EasingFamily;
    bezier: [number, number, number, number] | null;
    rmse: number;
    durationMs: number;
}
export interface FitResult {
    samples: number;
    /** First and last sample time where the value actually moves (ms, same space as the series). */
    start: number;
    end: number;
    /** Signed change over the fitted window (last − first). */
    change: number;
    delayMs: number;
    visibleDurationMs: number;
    /** Percent of the travel the curve goes past its final value, 0 when it does not. */
    overshootPct: number;
    springLike: boolean;
    settleMs: number | null;
    verdict: string;
    bestFits: FitBest[];
}
export interface FitOptions {
    fromMs?: number;
    toMs?: number;
    top?: number;
    /** Reject fits whose duration is more than this multiple of the visible window. */
    maxDurationFactor?: number;
}
export interface EasingSpec {
    name: string;
    family: EasingFamily;
    bezier: [number, number, number, number] | null;
    fn: (t: number) => number;
}
/** A cubic-bezier timing function evaluated as y for a given x (progress). */
export declare function bezierFn(x1: number, y1: number, x2: number, y2: number): (t: number) => number;
/** The named curves worth fitting; families are what `verify` compares. */
export declare const EASINGS: ReadonlyArray<EasingSpec>;
/** Classify a declared timing function by shape: does it start fast, end fast, or run even? */
export declare function classifyCurve(fn: (t: number) => number): EasingFamily;
/** Family for a CSS/WAAPI easing string, without fitting anything. */
export declare function familyOf(easing: string | null | undefined): EasingFamily;
/** The curve behind an easing string, when it can be reconstructed. */
export declare function curveOf(easing: string | null | undefined): ((t: number) => number) | null;
export interface TransformParts {
    tx: number;
    ty: number;
    sx: number;
    sy: number;
    rotate: number;
}
/** Reads matrix(), matrix3d(), the individual transform keywords and "none". */
export declare function matrixParts(transform: string | null | undefined): TransformParts;
/** First and last sample index where the series moves more than `frac` of its total travel. */
export declare function motionSpan(values: number[], frac?: number): {
    first: number;
    last: number;
    change: number;
} | null;
/**
 * Fits a series against the named easings. The window is measured first (visible motion),
 * then each candidate curve is scored on the normalised progress inside that window.
 */
export declare function fitSeries(series: Series, opts?: FitOptions): FitResult;
/** Mean absolute difference between two curves sampled on the same normalised time base. */
export declare function meanAbsDiffCurves(a: (t: number) => number, b: (t: number) => number, steps?: number): number;
/** Normalises a fitted series to a 0..1 progress curve sampled at `steps` points. */
export declare function progressCurve(series: Series, fit: FitResult, steps?: number): (t: number) => number;
/** Samples an easing string at n points; null when the string cannot be reconstructed. */
export declare function sampleEasing(easing: string | null | undefined, steps?: number): number[] | null;
