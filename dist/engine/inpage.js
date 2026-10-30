// refilm — loading the in-page scripts.
//
// clock.js and gl-hooks.js are plain browser scripts (no imports, no build step): they are read from disk
// and injected with addInitScript, which runs them before any page script. The build does not copy them
// into dist/, so both the source tree and a packaged dist/inpage directory are searched.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PKG_DIR, envError } from "../lib.js";
const CANDIDATE_DIRS = [
    process.env.REFILM_INPAGE_DIR,
    join(PKG_DIR, "dist", "inpage"),
    join(PKG_DIR, "src", "inpage"),
    join(PKG_DIR, "inpage"),
].filter(Boolean);
const cache = new Map();
/** Reads one of the browser scripts (clock.js, gl-hooks.js). */
export function inpageSource(name) {
    const hit = cache.get(name);
    if (hit !== undefined)
        return hit;
    for (const dir of CANDIDATE_DIRS) {
        const file = join(dir, name);
        if (existsSync(file)) {
            const src = readFileSync(file, "utf8");
            cache.set(name, src);
            return src;
        }
    }
    throw envError(`in-page script ${name} not found`, `looked in ${CANDIDATE_DIRS.join(", ")} — set REFILM_INPAGE_DIR to the directory that holds it`);
}
/**
 * Wraps a browser script as an immediately-invoked function call so a config object can be passed in
 * without leaking globals. The trailing `;` is stripped first so the expression stays an expression.
 */
export function initScript(name, config) {
    const body = inpageSource(name).trim().replace(/;+\s*$/, "");
    return `(${body})(${JSON.stringify(config)});`;
}
