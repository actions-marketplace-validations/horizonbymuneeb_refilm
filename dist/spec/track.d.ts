import { type FitResult, type Series } from "../commands/fit.js";
import type { Track } from "../types.js";
import { type RawRow } from "./row.js";
export interface TrackDerivation {
    rows: RawRow[];
    notes: string[];
    facts: Record<string, string | number>;
    /** Element selectors present in the track, in first-seen order. */
    elements: string[];
}
export interface ChannelFit {
    element: string;
    property: string;
    series: Series;
    fit: FitResult;
    /** Absolute time of the first and last observed change (ms, track time base). */
    startMs: number;
    endMs: number;
}
/** Every tracked element, in first-seen order. */
export declare function trackElements(track: Track): string[];
export declare function channelSeries(track: Track, element: string, prop: string): Series;
/** Fits every tracked channel of every element. Channels with no motion are dropped. */
export declare function trackChannelFits(track: Track): ChannelFit[];
/** Median gap between samples: the timing resolution of anything fitted from this track. */
export declare function sampleIntervalMs(series: Series): number;
export declare function deriveFromTrack(track: Track, opts?: {
    fps?: number;
}): TrackDerivation;
