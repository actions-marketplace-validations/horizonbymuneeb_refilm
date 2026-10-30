/** Reads one of the browser scripts (clock.js, gl-hooks.js). */
export declare function inpageSource(name: string): string;
/**
 * Wraps a browser script as an immediately-invoked function call so a config object can be passed in
 * without leaking globals. The trailing `;` is stripped first so the expression stays an expression.
 */
export declare function initScript(name: string, config: Record<string, unknown>): string;
/** The config the clock expects; `virtual: false` installs the seed only. */
export interface ClockConfig {
    virtual: boolean;
    seed: number | null;
    hz: number;
    holdAtStart: boolean;
}
export interface GlConfig {
    dumpBuffers: number;
    prefix?: string;
    maxFrames?: number;
    maxDraws?: number;
    maxObjects?: number;
}
