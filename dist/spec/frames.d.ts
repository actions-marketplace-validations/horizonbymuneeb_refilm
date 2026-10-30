import { type RawRow } from "./row.js";
export interface FramesDerivation {
    rows: RawRow[];
    notes: string[];
    facts: Record<string, string | number>;
    activity: number[];
    fps: number;
}
export interface FrameGrid {
    cols: number;
    rows: number;
    /** Per block, the activity per frame (fraction of pixels changed since the previous frame). */
    blocks: Array<{
        row: number;
        col: number;
        x: number;
        y: number;
        w: number;
        h: number;
        activity: number[];
    }>;
    width: number;
    height: number;
}
/**
 * Activity of a frame sequence: per frame, how much changed since the previous one, overall
 * and per block of a grid. Blocks are how a pixel-only spec finds two things moving apart.
 */
export declare function frameGrid(frames: string[], cols?: number, rows?: number): FrameGrid;
export interface FramesOptions {
    fps: number;
    triggerFrame?: number;
    preRollMs?: number;
}
export declare function deriveFromFrames(frames: string[], opts: FramesOptions): FramesDerivation;
