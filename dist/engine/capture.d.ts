import type { CaptureMeta, CaptureOptions } from "../types.js";
export interface CaptureProgress {
    phase: "launch" | "load" | "prepare" | "frames" | "encode" | "inspect" | "gl" | "write";
    detail: string;
}
export interface CaptureResult {
    meta: CaptureMeta;
    out: string;
    frames: number;
    trackSamples: number;
    inspect: any;
    /** The on-disk artifacts, relative to --out, in the order they were written. */
    artifacts: string[];
    warnings: string[];
}
export interface CaptureHooks {
    onProgress?: (p: CaptureProgress) => void;
    warn?: (message: string) => void;
}
export declare function capturePage(opts: CaptureOptions, hooks?: CaptureHooks): Promise<CaptureResult>;
