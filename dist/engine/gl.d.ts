import type { GlSummary, GlTrack } from "../types.js";
export type ChannelKind = "constant" | "clock" | "transition" | "there-and-back" | "oscillation" | "steps";
export interface Channel {
    source: "uniform" | "scene" | "webgpu";
    program?: string;
    uniform?: string;
    min: number;
    max: number;
    firstChangeMs: number | null;
    lastChangeMs: number | null;
    kind: ChannelKind;
    perSecond?: number;
    periodMs?: number;
}
/**
 * What does this series do over the capture? The answer decides how a clone drives it: by time (clock),
 * by an easing (transition), by a loop (oscillation), or by a keyframed step function (steps).
 */
export declare function classifySeries(times: number[], values: number[]): Pick<Channel, "min" | "max" | "firstChangeMs" | "lastChangeMs" | "kind" | "perSecond" | "periodMs">;
export interface RawTrace {
    revision?: string | number | null;
    notes?: string[];
    contexts: any[];
    programs: any[];
    textures: any[];
    buffers: any[];
    framebuffers: any[];
    frameData: any[];
    three: any;
    webgpu: any;
    engines?: Record<string, any[]>;
    dumps?: Record<string, {
        type: string;
        base64: string;
    }>;
    timeOrigin?: number;
    workers?: any[];
}
/** Writes gl/, three/ and gl-track.json for a capture and returns the summary capture.json carries. */
export declare function writeGlArtifacts(out: string, trace: RawTrace, triggerAt: number, rate: number): GlSummary;
export declare function summarizeTrace(dirIn: string): string;
export interface CompareOptions {
    map?: Record<string, string>;
    timing?: number;
    grep?: RegExp | null;
}
export interface CompareResult {
    markdown: string;
    failures: number;
    rows: number;
}
/** Every channel of the reference against its counterpart in the clone. */
export declare function compareTraces(refDir: string, cloneDir: string, opts?: CompareOptions): CompareResult;
export declare function readGlTrack(dir: string): GlTrack;
export declare function seriesFor(track: GlTrack, key: string): [number, number][];
/** Stable hash of a frame directory, used to prove two captures are byte-identical. */
export declare function hashTree(files: string[], read: (file: string) => Buffer): string;
