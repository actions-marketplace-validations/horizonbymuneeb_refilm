import type { CaptureMeta, Viewport } from "../types.js";
import type { Evidence } from "./derive.js";
export interface LoadedEvidence {
    evidence: Evidence;
    /** Absolute paths that contributed, for the JSON payload. */
    inputs: Record<string, string>;
    /** Problems that are not fatal: a missing optional file, an unreadable one. */
    notes: string[];
}
interface FrameMeta {
    fps?: number;
    count?: number;
    preRollMs?: number;
    triggerFrame?: number;
    viewport?: Viewport;
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    note?: string;
}
/** capture.json (record) or frames.json (frames command) — whichever the directory has. */
export declare function loadCaptureMeta(dir: string): {
    meta?: FrameMeta & Partial<CaptureMeta>;
    from?: string;
};
/** The frame directory of a capture: `frames/` inside it, or the directory itself. */
export declare function framesDirOf(dir: string): string | null;
export interface LoadOptions {
    /** Extra selectors supplied with --track, used only to label elements. */
    trackSelectors?: string[];
    /** Force the fps when neither metadata file has one. */
    fps?: number;
}
/**
 * Reads every evidence file a capture directory has. Missing optional files are notes, not
 * errors: the whole point of the spec is that it reports what the evidence could not say.
 */
export declare function loadCapture(dir: string, opts?: LoadOptions): LoadedEvidence;
/** A Lottie file is its own evidence: the file *is* the spec. */
export declare function loadLottie(path: string, opts?: {
    fps?: number;
}): LoadedEvidence;
/** Frames-only evidence from a directory of PNGs or a video/gif that was cut elsewhere. */
export declare function loadFrames(dir: string, opts?: {
    fps?: number;
}): LoadedEvidence;
export {};
