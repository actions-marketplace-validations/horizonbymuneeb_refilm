import { matrixParts } from "../commands/fit.js";
import type { EasingFamily } from "../types.js";
/** Transform channels for a computed or declared transform string. */
export { matrixParts };
export interface TransformParts {
    tx: number;
    ty: number;
    sx: number;
    sy: number;
    rotate: number;
}
/**
 * `fit.ts`'s matrixParts reads computed matrices. Keyframe values from `getKeyframes()` are
 * written in keyword form (`translateY(40px)`, `scale(0.9)`), so they need their own reader.
 */
export declare function keywordTransform(transform: string | null | undefined): TransformParts;
/** Classify an arbitrary progress function by shape: fast start, fast end, or even. */
export declare function classifyCurve(fn: (t: number) => number): EasingFamily;
/** The family a declared easing string belongs to, without fitting anything. */
export declare function familyOf(easing: string | null | undefined): EasingFamily;
/** The curve behind a declared easing string, when it can be reconstructed. */
export declare function curveOf(easing: string | null | undefined): ((t: number) => number) | null;
/** A curve sampled on a normalised 0..1 time base. */
export declare function sampleCurve(easing: string | null | undefined, steps?: number): number[] | null;
/** Mean absolute distance between two normalised curves; 0..1 in progress units. */
export declare function curveDistance(a: number[] | null, b: number[] | null): number | null;
/** Mean absolute distance between a declared curve and a measured normalised progress series. */
export declare function curveDistanceToSeries(curve: number[] | null, series: Array<[number, number]>, steps?: number): number | null;
declare function valueAt(series: Array<[number, number]>, t: number): number;
export { valueAt as seriesValueAt };
