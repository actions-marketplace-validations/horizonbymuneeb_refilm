import { type FitResult, type Series } from "../commands/fit.js";
import type { GlTrack } from "../types.js";
import { type RawRow } from "./row.js";
export interface GlChannelFit {
    name: string;
    series: Series;
    fit: FitResult;
    startMs: number;
    endMs: number;
    /** `clock`, `transition`, `oscillation`, `steps`, `there-and-back`, or "" when unknown. */
    kind: string;
}
export interface GlDerivation {
    rows: RawRow[];
    notes: string[];
    facts: Record<string, string | number>;
    channels: GlChannelFit[];
}
/** Every traced channel, fitted; channels that never move are dropped. */
export declare function glChannelFits(track: GlTrack): GlChannelFit[];
export declare function deriveFromGlTrack(track: GlTrack, opts?: {
    fps?: number;
}): GlDerivation;
