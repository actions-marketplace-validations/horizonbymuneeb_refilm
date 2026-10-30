export declare const VERSION = "0.1.0";
/** Exit codes are part of the CLI contract: agents and CI branch on these. */
export declare const EXIT: {
    readonly OK: 0;
    readonly VERIFY_FAILED: 1;
    readonly USAGE: 2;
    readonly ENVIRONMENT: 3;
    readonly INTERNAL: 4;
};
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export declare class RefilmError extends Error {
    code: string;
    exit: ExitCode;
    hint?: string;
    constructor(code: string, message: string, exit?: ExitCode, hint?: string);
}
export declare const usageError: (message: string, hint?: string) => RefilmError;
export declare const envError: (message: string, hint?: string) => RefilmError;
/** Where the compiled code lives (dist/), used to find bundled assets. */
export declare const PKG_DIR: string;
export interface Args {
    _: string[];
    [key: string]: any;
}
/**
 * Parses `--key value`, `--key=value` and bare `--flag` (true).
 * A value that starts with `--` is treated as the next flag, so `--headed --url x` works.
 * Repeated keys collect into an array.
 */
export declare function parseArgs(argv: string[], defaults?: Record<string, any>): Args;
export declare function num(v: any, fallback: number): number;
export declare function str(v: any): string | undefined;
export declare function bool(v: any): boolean;
export declare function list(v: any): string[];
/** "1:23.5" | "83.5" | "83.5s" | "1500ms" -> seconds */
export declare function parseTime(v: any): number | undefined;
export declare function parseSize(v: any, fallback: {
    width: number;
    height: number;
}): {
    width: number;
    height: number;
};
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export declare function parseRect(v: any): Rect | undefined;
export interface Reporter {
    json: boolean;
    warnings: string[];
    info(msg: string): void;
    warn(msg: string): void;
    /** Human-readable line that is suppressed in --json mode. */
    say(msg: string): void;
    emit(command: string, data: any): void;
}
export declare function reporter(command: string, opts?: {
    json?: boolean;
}): Reporter;
export declare function emitError(command: string, err: unknown, json: boolean): number;
export declare function ensureDir(p: string): string;
export declare function abs(p: string): string;
export declare function readJson<T = any>(p: string): T;
export declare function writeJson(p: string, value: any): void;
export declare function writeText(p: string, text: string): void;
export declare function exists(p: string): boolean;
export declare function listFrames(dir: string): string[];
export declare function isDir(p: string): boolean;
export declare const pad: (n: number, width?: number) => string;
/**
 * ffmpeg resolution order: REFILM_FFMPEG, a bundled binary, then ffmpeg on PATH.
 * The tool never downloads anything at runtime; `refilm doctor` reports what is missing.
 */
export declare function ffmpegPath(): string;
export declare function ffmpeg(args: string[], opts?: {
    quiet?: boolean;
}): string;
/** ffmpeg -i output is the only probe we need; ffprobe is not assumed to exist. */
export declare function probeMedia(input: string): {
    input: string;
    durationS: number | undefined;
    width: number | undefined;
    height: number | undefined;
    sourceFps: number | undefined;
};
