// refilm — capture option parsing.
//
// The command surface is documented in src/commands/record.ts; this file turns parsed argv into the
// CaptureOptions contract from types.ts and rejects contradictory combinations before a browser launches.
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { abs, list, num, parseArgs, parseRect, parseSize, parseTime, str, usageError } from "../lib.js";
export const TRIGGERS = ["load", "scroll", "hover", "leave", "move", "drag", "click", "none"];
const CLOCKS = ["real", "virtual"];
const GPUS = ["software", "hardware"];
function oneOf(value, allowed, flag, fallback) {
    const s = str(value);
    if (s === undefined)
        return fallback;
    if (!allowed.includes(s)) {
        throw usageError(`${flag} must be one of ${allowed.join(", ")}, got "${s}"`);
    }
    return s;
}
function pair(value, flag, fallback) {
    const s = str(value);
    if (s === undefined)
        return fallback;
    const parts = s.split(",").map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
        throw usageError(`bad ${flag} "${s}", expected X,Y (for example 0.5,0.5)`);
    }
    return { x: parts[0], y: parts[1] };
}
/** "--path 0.5,0.5;0.1,0.9" -> points as fractions of the target box, visited in order. */
function points(value, flag) {
    const s = str(value);
    if (s === undefined)
        return [{ x: 0.5, y: 0.5 }];
    const out = s
        .split(";")
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
        const parts = chunk.split(",").map(Number);
        if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
            throw usageError(`bad ${flag} point "${chunk}", expected FX,FY inside the target box`);
        }
        return { x: parts[0], y: parts[1] };
    });
    if (!out.length)
        throw usageError(`bad ${flag}: no points`);
    return out;
}
/**
 * A duration flag in milliseconds. A bare number is milliseconds (the documented unit), "1.5s" and
 * "1500ms" are accepted so the flags read the same as everywhere else in the CLI.
 */
export function ms(value, fallback) {
    const s = str(value);
    if (s === undefined)
        return fallback;
    if (s.endsWith("ms")) {
        const n = Number(s.slice(0, -2));
        return Number.isFinite(n) ? n : fallback;
    }
    if (s.includes(":")) {
        const seconds = parseTime(s);
        return seconds === undefined ? fallback : seconds * 1000;
    }
    if (/^[\d.]+s$/.test(s)) {
        const n = Number(s.slice(0, -1));
        return Number.isFinite(n) ? n * 1000 : fallback;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
}
/** A --pre-js value is a file when it names one, otherwise inline code. */
function readPreJs(value) {
    const s = str(value);
    if (s === undefined)
        return undefined;
    const candidate = abs(s);
    return existsSync(candidate) ? readFileSync(candidate, "utf8") : s;
}
/** Bare paths become file:// URLs so `--url page.html` works from the shell. */
export function normalizeUrl(value) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value))
        return value;
    return "file://" + resolve(process.cwd(), value);
}
export function parseCaptureOptions(argv, defaults = {}) {
    const a = parseArgs(argv, defaults);
    const url = str(a.url);
    if (!url)
        throw usageError("--url is required", "refilm record --url <url|file.html> --out <dir>");
    const outArg = str(a.out);
    if (!outArg)
        throw usageError("--out is required", "refilm record --url <url> --out <dir>");
    const viewport = parseSize(a.viewport, { width: 1440, height: 900 });
    const trigger = oneOf(a.trigger, TRIGGERS, "--trigger", "load");
    const clock = oneOf(a.clock, CLOCKS, "--clock", "real");
    const gpu = oneOf(a.gpu, GPUS, "--gpu", "software");
    const reducedMotion = oneOf(a["reduced-motion"], ["no-preference", "reduce"], "--reduced-motion", "no-preference");
    const colorSchemeRaw = str(a["color-scheme"]);
    if (colorSchemeRaw !== undefined && colorSchemeRaw !== "light" && colorSchemeRaw !== "dark") {
        throw usageError(`--color-scheme must be light or dark, got "${colorSchemeRaw}"`);
    }
    const selector = str(a.selector);
    const target = str(a.target) ?? selector;
    const clip = parseRect(a.clip);
    const trackFlags = list(a.track);
    const track = trackFlags.length ? trackFlags : selector ? [selector] : [];
    const fps = num(a.fps, 25);
    if (!(fps > 0))
        throw usageError(`--fps must be positive, got ${fps}`);
    const duration = Math.max(0, ms(a.duration, 3000));
    const preRoll = Math.max(0, ms(a["pre-roll"], 200));
    const waitBefore = Math.max(0, ms(a["wait-before"], 800));
    const rafHz = num(a["raf-hz"], 60);
    if (!(rafHz > 0))
        throw usageError(`--raf-hz must be positive, got ${rafHz}`);
    const scale = num(a.scale, 1);
    if (!(scale > 0))
        throw usageError(`--scale must be positive, got ${scale}`);
    const playbackRate = num(a["playback-rate"], 1);
    if (!(playbackRate > 0))
        throw usageError(`--playback-rate must be positive, got ${playbackRate}`);
    const seed = a.seed !== undefined && a.seed !== true ? num(a.seed, 1) : clock === "virtual" ? 1 : null;
    const options = {
        url: normalizeUrl(url),
        out: abs(outArg),
        viewport,
        scale,
        fps,
        duration,
        preRoll,
        waitBefore,
        trigger,
        selector,
        target,
        clip: clip ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height } : undefined,
        pad: num(a.pad, 0),
        track,
        clock,
        seed,
        rafHz,
        networkWait: num(a["network-wait"], 3000),
        gl: !!a.gl,
        glBuffersMb: a["gl-buffers"] === undefined || a["gl-buffers"] === true ? 0 : num(a["gl-buffers"], 16),
        gpu,
        assets: !!a.assets,
        video: !a["no-video"],
        playbackRate,
        colorScheme: colorSchemeRaw,
        reducedMotion,
        headed: !!a.headed,
        preJs: readPreJs(a["pre-js"]),
        scrollTo: str(a["scroll-to"]),
        scrollMs: num(a["scroll-ms"], 600),
        scrollSteps: Math.max(1, Math.round(num(a["scroll-steps"], 12))),
        hoverAt: pair(a["hover-at"], "--hover-at", { x: 0.5, y: 0.5 }),
        preHover: str(a["pre-hover"]),
        preHoverMs: num(a["pre-hover-ms"], 1500),
        leaveTo: a["leave-to"] === undefined
            ? { x: Math.round(viewport.width / 2), y: 8 }
            : pair(a["leave-to"], "--leave-to", { x: viewport.width / 2, y: 8 }),
        path: points(a.path, "--path"),
        pathMs: num(a["path-ms"], 400),
    };
    if (options.trigger === "scroll" && !options.scrollTo && !options.selector) {
        throw usageError("a scroll trigger needs --scroll-to or --selector", "for example --trigger scroll --selector .hero --scroll-steps 12");
    }
    if ((options.trigger === "hover" || options.trigger === "move" || options.trigger === "drag" || options.trigger === "click") &&
        !options.target) {
        throw usageError(`--trigger ${options.trigger} needs --target (or --selector)`, "point it at the element that reacts");
    }
    return { options, raw: a };
}
/** Every path a capture writes, resolved once so nothing builds joins by hand. */
export const outPaths = (out) => ({
    out,
    frames: join(out, "frames"),
    raw: join(out, ".raw"),
    video: join(out, ".video"),
    inspect: join(out, "inspect.json"),
    track: join(out, "track.json"),
    framesJson: join(out, "frames.json"),
    meta: join(out, "capture.json"),
    videoWebm: join(out, "video.webm"),
    videoMp4: join(out, "video.mp4"),
    glDir: join(out, "gl"),
    glTrack: join(out, "gl-track.json"),
    assetsJson: join(out, "assets.json"),
    finalPng: join(out, "final.png"),
    threeDir: join(out, "three"),
});
