import type { CaptureOptions, Trigger } from "../types.js";
export declare const TRIGGERS: readonly Trigger[];
/** Everything a capture needs beyond the on-disk contract: the on-disk options plus the raw argv. */
export interface CaptureConfig {
    options: CaptureOptions;
    raw: Record<string, any>;
}
/**
 * A duration flag in milliseconds. A bare number is milliseconds (the documented unit), "1.5s" and
 * "1500ms" are accepted so the flags read the same as everywhere else in the CLI.
 */
export declare function ms(value: any, fallback: number): number;
/** Bare paths become file:// URLs so `--url page.html` works from the shell. */
export declare function normalizeUrl(value: string): string;
export declare function parseCaptureOptions(argv: string[], defaults?: Record<string, any>): CaptureConfig;
/** Every path a capture writes, resolved once so nothing builds joins by hand. */
export declare const outPaths: (out: string) => {
    out: string;
    frames: string;
    raw: string;
    video: string;
    inspect: string;
    track: string;
    framesJson: string;
    meta: string;
    videoWebm: string;
    videoMp4: string;
    glDir: string;
    glTrack: string;
    assetsJson: string;
    finalPng: string;
    threeDir: string;
};
