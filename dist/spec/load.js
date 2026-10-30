// refilm — load a capture directory's evidence and hand it to the deriver.
//
// A capture is a directory with some subset of inspect.json, track.json, gl-track.json,
// frames/, capture.json. This module is the only place that knows those file names, so the
// command stays about flags and output.
import { exists, isDir, listFrames, readJson } from "../lib.js";
import { join } from "node:path";
import { deriveFromInspect } from "./inspect.js";
import { deriveFromTrack } from "./track.js";
import { deriveFromGlTrack } from "./gl-track.js";
import { deriveFromFrames } from "./frames.js";
import { deriveFromLottie } from "./lottie.js";
function triggerOf(v) {
    const allowed = ["load", "scroll", "hover", "leave", "move", "drag", "click", "none"];
    return typeof v === "string" && allowed.includes(v) ? v : undefined;
}
function viewportOf(v) {
    if (Array.isArray(v) && v.length >= 2)
        return { width: Number(v[0]), height: Number(v[1]) };
    if (v && typeof v === "object") {
        const o = v;
        if (Number.isFinite(Number(o.width)) && Number.isFinite(Number(o.height))) {
            return { width: Number(o.width), height: Number(o.height) };
        }
    }
    return undefined;
}
/** capture.json (record) or frames.json (frames command) — whichever the directory has. */
export function loadCaptureMeta(dir) {
    for (const name of ["capture.json", "frames.json"]) {
        const p = join(dir, name);
        if (!exists(p))
            continue;
        try {
            return { meta: readJson(p), from: p };
        }
        catch {
            continue;
        }
    }
    return {};
}
/** The frame directory of a capture: `frames/` inside it, or the directory itself. */
export function framesDirOf(dir) {
    const nested = join(dir, "frames");
    if (isDir(nested) && listFrames(nested).length)
        return nested;
    if (isDir(dir) && listFrames(dir).length)
        return dir;
    return null;
}
/**
 * Reads every evidence file a capture directory has. Missing optional files are notes, not
 * errors: the whole point of the spec is that it reports what the evidence could not say.
 */
export function loadCapture(dir, opts = {}) {
    const inputs = {};
    const notes = [];
    const evidence = {};
    const { meta, from } = loadCaptureMeta(dir);
    if (from)
        inputs["capture"] = from;
    const viewport = viewportOf(meta?.viewport);
    const fps = Number(meta?.fps) > 0 ? Number(meta?.fps) : opts.fps;
    const trigger = triggerOf(meta?.trigger);
    evidence.capture = {
        url: typeof meta?.url === "string" ? meta.url : undefined,
        title: typeof meta?.title === "string" ? meta.title : undefined,
        viewport,
        fps: fps && fps > 0 ? fps : undefined,
        trigger,
        durationMs: Number(meta?.durationMs) > 0 ? Number(meta.durationMs) : undefined,
        clip: meta?.clip ?? undefined,
        renderer: typeof meta?.renderer === "string" ? String(meta.renderer) : undefined,
        libs: Array.isArray(meta?.libs) ? meta.libs : undefined,
        fonts: Array.isArray(meta?.fonts)
            ? meta.fonts
            : undefined,
        frameCount: Number(meta?.count) > 0 ? Number(meta.count) : undefined,
    };
    const inspectPath = join(dir, "inspect.json");
    if (exists(inspectPath)) {
        try {
            const inspect = readJson(inspectPath);
            evidence.inspect = deriveFromInspect(inspect, { fps: fps ?? 25 });
            inputs["inspect"] = inspectPath;
            // inspect.json carries the viewport too, and it is the one the page was actually laid out at
            if (!evidence.capture.viewport) {
                const vp = viewportOf(inspect.viewport);
                if (vp)
                    evidence.capture.viewport = vp;
            }
            if (!evidence.capture.fonts && Array.isArray(inspect.fonts)) {
                evidence.capture.fonts = inspect.fonts.map((f) => ({ family: f.family, status: f.status }));
            }
            if (!evidence.capture.libs && Array.isArray(inspect.libs))
                evidence.capture.libs = inspect.libs;
        }
        catch (err) {
            notes.push(`inspect.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const trackPath = join(dir, "track.json");
    if (exists(trackPath)) {
        try {
            const track = readJson(trackPath);
            evidence.track = deriveFromTrack(track, { fps });
            inputs["track"] = trackPath;
        }
        catch (err) {
            notes.push(`track.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const glTrackPath = join(dir, "gl-track.json");
    if (exists(glTrackPath)) {
        try {
            const glTrack = readJson(glTrackPath);
            evidence.glTrack = deriveFromGlTrack(glTrack, { fps });
            inputs["glTrack"] = glTrackPath;
        }
        catch (err) {
            notes.push(`gl-track.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const framesDir = framesDirOf(dir);
    if (framesDir) {
        inputs["frames"] = framesDir;
        try {
            const frames = listFrames(framesDir);
            const frameMetaPath = join(framesDir, "..", "frames.json");
            const frameMeta = exists(frameMetaPath) ? readJson(frameMetaPath) : meta ?? {};
            const frameFps = Number(frameMeta.fps) > 0 ? Number(frameMeta.fps) : fps ?? 25;
            evidence.frames = deriveFromFrames(frames, {
                fps: frameFps,
                triggerFrame: Number(frameMeta.triggerFrame) > 0 ? Number(frameMeta.triggerFrame) : 0,
                preRollMs: Number(frameMeta.preRollMs) > 0 ? Number(frameMeta.preRollMs) : 0,
            });
            if (!evidence.capture.fps)
                evidence.capture.fps = frameFps;
            if (!evidence.capture.frameCount)
                evidence.capture.frameCount = frames.length;
            if (!evidence.capture.viewport) {
                const vp = viewportOf(frameMeta.viewport);
                if (vp)
                    evidence.capture.viewport = vp;
            }
        }
        catch (err) {
            notes.push(`frames could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { evidence, inputs, notes };
}
/** A Lottie file is its own evidence: the file *is* the spec. */
export function loadLottie(path, opts = {}) {
    const lottie = readJson(path);
    const derivation = deriveFromLottie(lottie, { fps: opts.fps });
    const evidence = {
        lottie: derivation,
        capture: {
            url: path,
            title: derivation.name,
            fps: derivation.fps,
            viewport: lottie.w && lottie.h ? { width: Number(lottie.w), height: Number(lottie.h) } : undefined,
            trigger: "load",
            durationMs: derivation.totalMs,
        },
    };
    return { evidence, inputs: { lottie: path }, notes: [] };
}
/** Frames-only evidence from a directory of PNGs or a video/gif that was cut elsewhere. */
export function loadFrames(dir, opts = {}) {
    const frames = listFrames(dir);
    const metaPath = join(dir, "frames.json");
    const meta = exists(metaPath) ? readJson(metaPath) : {};
    const fps = Number(meta.fps) > 0 ? Number(meta.fps) : opts.fps ?? 25;
    const derivation = deriveFromFrames(frames, {
        fps,
        triggerFrame: Number(meta.triggerFrame) > 0 ? Number(meta.triggerFrame) : 0,
        preRollMs: Number(meta.preRollMs) > 0 ? Number(meta.preRollMs) : 0,
    });
    const viewport = viewportOf(meta.viewport);
    return {
        evidence: {
            frames: derivation,
            capture: {
                fps,
                frameCount: frames.length,
                viewport,
                trigger: "load",
                durationMs: roundMs((frames.length / fps) * 1000),
            },
        },
        inputs: { frames: dir },
        notes: [],
    };
}
function roundMs(n) {
    return Math.round(n * 10) / 10;
}
