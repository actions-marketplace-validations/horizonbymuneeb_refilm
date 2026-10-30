// refilm — shared primitives: argument parsing, structured output, errors, files, ffmpeg.
// Everything here is dependency-free so every command behaves the same way.
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export const VERSION = "0.1.0";
/** Exit codes are part of the CLI contract: agents and CI branch on these. */
export const EXIT = {
    OK: 0,
    VERIFY_FAILED: 1,
    USAGE: 2,
    ENVIRONMENT: 3,
    INTERNAL: 4,
};
export class RefilmError extends Error {
    code;
    exit;
    hint;
    constructor(code, message, exit = EXIT.INTERNAL, hint) {
        super(message);
        this.name = "RefilmError";
        this.code = code;
        this.exit = exit;
        this.hint = hint;
    }
}
export const usageError = (message, hint) => new RefilmError("USAGE", message, EXIT.USAGE, hint);
export const envError = (message, hint) => new RefilmError("ENVIRONMENT", message, EXIT.ENVIRONMENT, hint);
/** Where the compiled code lives (dist/), used to find bundled assets. */
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Parses `--key value`, `--key=value` and bare `--flag` (true).
 * A value that starts with `--` is treated as the next flag, so `--headed --url x` works.
 * Repeated keys collect into an array.
 */
export function parseArgs(argv, defaults = {}) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) {
            out._.push(token);
            continue;
        }
        const eq = token.indexOf("=");
        if (eq > 0) {
            assign(out, token.slice(2, eq), token.slice(eq + 1));
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--"))
            assign(out, key, true);
        else {
            assign(out, key, next);
            i++;
        }
    }
    // Defaults fill the gaps only: a flag the user passed always wins, and repeated
    // flags still collect into an array.
    for (const key of Object.keys(defaults)) {
        if (out[key] === undefined)
            out[key] = defaults[key];
    }
    return out;
}
function assign(out, key, value) {
    if (out[key] === undefined)
        out[key] = value;
    else if (Array.isArray(out[key]))
        out[key].push(value);
    else
        out[key] = [out[key], value];
}
export function num(v, fallback) {
    if (v === undefined || v === true)
        return fallback;
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) ? n : fallback;
}
export function str(v) {
    if (v === undefined || v === true)
        return undefined;
    return String(Array.isArray(v) ? v[0] : v);
}
export function bool(v) {
    if (v === undefined)
        return false;
    if (v === true)
        return true;
    const s = String(v).toLowerCase();
    return s !== "false" && s !== "0" && s !== "no";
}
export function list(v) {
    if (v === undefined || v === true)
        return [];
    const raw = Array.isArray(v) ? v : [v];
    return raw
        .flatMap((x) => String(x).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
}
/** "1:23.5" | "83.5" | "83.5s" | "1500ms" -> seconds */
export function parseTime(v) {
    const s = str(v);
    if (s === undefined)
        return undefined;
    if (s.endsWith("ms"))
        return Number(s.slice(0, -2)) / 1000;
    if (s.includes(":")) {
        const parts = s.split(":");
        const secs = Number(parts.pop());
        const mins = Number(parts.pop() ?? 0);
        const hours = Number(parts.pop() ?? 0);
        return hours * 3600 + mins * 60 + secs;
    }
    const n = Number(s.replace(/s$/, ""));
    return Number.isFinite(n) ? n : undefined;
}
export function parseSize(v, fallback) {
    const s = str(v);
    if (!s)
        return fallback;
    const m = s.match(/^(\d+)x(\d+)$/);
    if (!m)
        throw usageError(`bad --viewport "${s}", expected WxH (for example 1440x900)`);
    return { width: Number(m[1]), height: Number(m[2]) };
}
export function parseRect(v) {
    const s = str(v);
    if (!s)
        return undefined;
    const p = s.split(",").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
        throw usageError(`bad rect "${s}", expected x,y,w,h`);
    }
    return { x: p[0], y: p[1], width: p[2], height: p[3] };
}
export function reporter(command, opts = {}) {
    const json = !!opts.json;
    const warnings = [];
    const say = (msg) => {
        if (!json)
            console.log(msg);
    };
    return {
        json,
        warnings,
        info: (msg) => {
            if (!json)
                console.error(msg);
        },
        warn: (msg) => {
            warnings.push(msg);
            if (!json)
                console.error(`warning: ${msg}`);
        },
        say,
        emit: (cmd, data) => {
            if (json) {
                console.log(JSON.stringify({ ok: true, command: cmd, version: VERSION, warnings, data }, null, 2));
            }
        },
    };
}
export function emitError(command, err, json) {
    const e = err instanceof RefilmError
        ? err
        : new RefilmError("INTERNAL", err instanceof Error ? err.message : String(err), EXIT.INTERNAL);
    if (json) {
        console.log(JSON.stringify({
            ok: false,
            command,
            version: VERSION,
            warnings: [],
            errors: [{ code: e.code, message: e.message, hint: e.hint ?? null }],
        }, null, 2));
    }
    else {
        console.error(`refilm ${command}: ${e.message}`);
        if (e.hint)
            console.error(`hint: ${e.hint}`);
    }
    return e.exit;
}
// ---------------------------------------------------------------- files
export function ensureDir(p) {
    mkdirSync(p, { recursive: true });
    return p;
}
export function abs(p) {
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
}
export function readJson(p) {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    }
    catch (err) {
        throw new RefilmError("BAD_JSON", `cannot read JSON at ${p}: ${err instanceof Error ? err.message : err}`, EXIT.INTERNAL);
    }
}
export function writeJson(p, value) {
    ensureDir(dirname(p));
    writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}
export function writeText(p, text) {
    ensureDir(dirname(p));
    writeFileSync(p, text);
}
export function exists(p) {
    return existsSync(p);
}
export function listFrames(dir) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => /\.png$/i.test(f))
        .sort()
        .map((f) => join(dir, f));
}
export function isDir(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
export const pad = (n, width = 4) => String(n).padStart(width, "0");
// ---------------------------------------------------------------- ffmpeg
let cachedFfmpeg = null;
/**
 * ffmpeg resolution order: REFILM_FFMPEG, a bundled binary, then ffmpeg on PATH.
 * The tool never downloads anything at runtime; `refilm doctor` reports what is missing.
 */
export function ffmpegPath() {
    if (cachedFfmpeg)
        return cachedFfmpeg;
    const fromEnv = process.env.REFILM_FFMPEG;
    if (fromEnv && existsSync(fromEnv))
        return (cachedFfmpeg = fromEnv);
    const bundled = join(PKG_DIR, "vendor", "ffmpeg");
    if (existsSync(bundled))
        return (cachedFfmpeg = bundled);
    const probe = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
    if (probe.status === 0)
        return (cachedFfmpeg = "ffmpeg");
    throw envError("ffmpeg not found", "install ffmpeg (apt install ffmpeg / brew install ffmpeg) or set REFILM_FFMPEG=/path/to/ffmpeg");
}
export function ffmpeg(args, opts = {}) {
    const bin = ffmpegPath();
    const r = spawnSync(bin, ["-hide_banner", "-loglevel", opts.quiet ? "error" : "warning", ...args], {
        encoding: "utf8",
        maxBuffer: 64 << 20,
    });
    if (r.status !== 0) {
        throw new RefilmError("FFMPEG_FAILED", `ffmpeg failed (${r.status}): ${(r.stderr || "").slice(-800)}`, EXIT.ENVIRONMENT);
    }
    return r.stderr || "";
}
/** ffmpeg -i output is the only probe we need; ffprobe is not assumed to exist. */
export function probeMedia(input) {
    const bin = ffmpegPath();
    const r = spawnSync(bin, ["-hide_banner", "-i", input], { encoding: "utf8" });
    const text = r.stderr || "";
    const dur = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    const dims = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    const fps = text.match(/([\d.]+) fps/);
    return {
        input,
        durationS: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined,
        width: dims ? Number(dims[1]) : undefined,
        height: dims ? Number(dims[2]) : undefined,
        sourceFps: fps ? Number(fps[1]) : undefined,
    };
}
