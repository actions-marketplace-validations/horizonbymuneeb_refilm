export { main, EXIT, RefilmError } from "./cli.js";
export { VERSION } from "./lib.js";
export * from "./types.js";
type CommandName = "record" | "frames" | "spec" | "compare" | "sheet" | "fit" | "gl" | "verify" | "report" | "install" | "init" | "doctor";
/** Turns a plain options object into the CLI's argv form. */
export declare function toArgv(options?: Record<string, unknown>): string[];
/**
 * Runs one command and returns its JSON payload.
 * Captures the command's own stdout so the caller's output stays clean.
 */
export declare function run(command: CommandName, options?: Record<string, unknown>): Promise<any>;
export declare const record: (options: Record<string, unknown>) => Promise<any>;
export declare const frames: (options: Record<string, unknown>) => Promise<any>;
export declare const spec: (options: Record<string, unknown>) => Promise<any>;
export declare const compare: (options: Record<string, unknown>) => Promise<any>;
export declare const sheet: (options: Record<string, unknown>) => Promise<any>;
export declare const fit: (options: Record<string, unknown>) => Promise<any>;
export declare const gl: (options: Record<string, unknown>) => Promise<any>;
export declare const verify: (options: Record<string, unknown>) => Promise<any>;
export declare const report: (options: Record<string, unknown>) => Promise<any>;
export declare const install: (options: Record<string, unknown>) => Promise<any>;
export declare const init: (options: Record<string, unknown>) => Promise<any>;
export declare const doctor: (options: Record<string, unknown>) => Promise<any>;
