// refilm — load a capture directory's evidence and hand it to the deriver.
//
// A capture is a directory with some subset of inspect.json, track.json, gl-track.json,
// frames/, capture.json. This module is the only place that knows those file names, so the
// command stays about flags and output.

import { exists, isDir, listFrames, readJson } from "../lib.js";
import { join } from "node:path";
import type { CaptureMeta, GlTrack, Track, Trigger, Viewport } from "../types.js";
import { deriveFromInspect, type InspectFile } from "./inspect.js";
import { deriveFromTrack } from "./track.js";
import { deriveFromGlTrack } from "./gl-track.js";
import { deriveFromFrames } from "./frames.js";
import { deriveFromLottie, type LottieFile } from "./lottie.js";
import type { Evidence } from "./derive.js";

export interface LoadedEvidence {
  evidence: Evidence;
  /** Absolute paths that contributed, for the JSON payload. */
  inputs: Record<string, string>;
  /** Problems that are not fatal: a missing optional file, an unreadable one. */
  notes: string[];
}

interface FrameMeta {
  fps?: number;
  count?: number;
  preRollMs?: number;
  triggerFrame?: number;
  viewport?: Viewport;
  clip?: { x: number; y: number; width: number; height: number };
  note?: string;
}

function triggerOf(v: unknown): Trigger | undefined {
  const allowed: Trigger[] = ["load", "scroll", "hover", "leave", "move", "drag", "click", "none"];
  return typeof v === "string" && (allowed as string[]).includes(v) ? (v as Trigger) : undefined;
}

function viewportOf(v: unknown): Viewport | undefined {
  if (Array.isArray(v) && v.length >= 2) return { width: Number(v[0]), height: Number(v[1]) };
  if (v && typeof v === "object") {
    const o = v as { width?: unknown; height?: unknown };
    if (Number.isFinite(Number(o.width)) && Number.isFinite(Number(o.height))) {
      return { width: Number(o.width), height: Number(o.height) };
    }
  }
  return undefined;
}

/** capture.json (record) or frames.json (frames command) — whichever the directory has. */
export function loadCaptureMeta(dir: string): { meta?: FrameMeta & Partial<CaptureMeta>; from?: string } {
  for (const name of ["capture.json", "frames.json"]) {
    const p = join(dir, name);
    if (!exists(p)) continue;
    try {
      return { meta: readJson<FrameMeta & Partial<CaptureMeta>>(p), from: p };
    } catch {
      continue;
    }
  }
  return {};
}

/** The frame directory of a capture: `frames/` inside it, or the directory itself. */
export function framesDirOf(dir: string): string | null {
  const nested = join(dir, "frames");
  if (isDir(nested) && listFrames(nested).length) return nested;
  if (isDir(dir) && listFrames(dir).length) return dir;
  return null;
}

export interface LoadOptions {
  /** Extra selectors supplied with --track, used only to label elements. */
  trackSelectors?: string[];
  /** Force the fps when neither metadata file has one. */
  fps?: number;
}

/**
 * Reads every evidence file a capture directory has. Missing optional files are notes, not
 * errors: the whole point of the spec is that it reports what the evidence could not say.
 */
export function loadCapture(dir: string, opts: LoadOptions = {}): LoadedEvidence {
  const inputs: Record<string, string> = {};
  const notes: string[] = [];
  const evidence: Evidence = {};

  const { meta, from } = loadCaptureMeta(dir);
  if (from) inputs["capture"] = from;

  const viewport = viewportOf(meta?.viewport);
  const fps = Number(meta?.fps) > 0 ? Number(meta?.fps) : opts.fps;
  const trigger = triggerOf((meta as Partial<CaptureMeta> | undefined)?.trigger);

  evidence.capture = {
    url: typeof meta?.url === "string" ? meta.url : undefined,
    title: typeof meta?.title === "string" ? meta.title : undefined,
    viewport,
    fps: fps && fps > 0 ? fps : undefined,
    trigger,
    durationMs: Number((meta as Partial<CaptureMeta> | undefined)?.durationMs) > 0 ? Number((meta as Partial<CaptureMeta>).durationMs) : undefined,
    clip: (meta?.clip as { x: number; y: number; width: number; height: number } | undefined) ?? undefined,
    renderer: typeof (meta as Partial<CaptureMeta> | undefined)?.renderer === "string" ? String((meta as Partial<CaptureMeta>).renderer) : undefined,
    libs: Array.isArray((meta as Partial<CaptureMeta> | undefined)?.libs) ? ((meta as Partial<CaptureMeta>).libs as string[]) : undefined,
    fonts: Array.isArray((meta as Partial<CaptureMeta> | undefined)?.fonts)
      ? ((meta as Partial<CaptureMeta>).fonts as Array<{ family?: string; status?: string }>)
      : undefined,
    frameCount: Number((meta as FrameMeta | undefined)?.count) > 0 ? Number((meta as FrameMeta).count) : undefined,
  };

  const inspectPath = join(dir, "inspect.json");
  if (exists(inspectPath)) {
    try {
      const inspect = readJson<InspectFile>(inspectPath);
      evidence.inspect = deriveFromInspect(inspect, { fps: fps ?? 25 });
      inputs["inspect"] = inspectPath;
      // inspect.json carries the viewport too, and it is the one the page was actually laid out at
      if (!evidence.capture.viewport) {
        const vp = viewportOf(inspect.viewport);
        if (vp) evidence.capture.viewport = vp;
      }
      if (!evidence.capture.fonts && Array.isArray(inspect.fonts)) {
        evidence.capture.fonts = inspect.fonts.map((f) => ({ family: f.family, status: f.status }));
      }
      if (!evidence.capture.libs && Array.isArray(inspect.libs)) evidence.capture.libs = inspect.libs;
    } catch (err) {
      notes.push(`inspect.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const trackPath = join(dir, "track.json");
  if (exists(trackPath)) {
    try {
      const track = readJson<Track>(trackPath);
      evidence.track = deriveFromTrack(track, { fps });
      inputs["track"] = trackPath;
    } catch (err) {
      notes.push(`track.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const glTrackPath = join(dir, "gl-track.json");
  if (exists(glTrackPath)) {
    try {
      const glTrack = readJson<GlTrack>(glTrackPath);
      evidence.glTrack = deriveFromGlTrack(glTrack, { fps });
      inputs["glTrack"] = glTrackPath;
    } catch (err) {
      notes.push(`gl-track.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const framesDir = framesDirOf(dir);
  if (framesDir) {
    inputs["frames"] = framesDir;
    try {
      const frames = listFrames(framesDir);
      const frameMetaPath = join(framesDir, "..", "frames.json");
      const frameMeta: FrameMeta = exists(frameMetaPath) ? readJson<FrameMeta>(frameMetaPath) : (meta as FrameMeta) ?? {};
      const frameFps = Number(frameMeta.fps) > 0 ? Number(frameMeta.fps) : fps ?? 25;
      evidence.frames = deriveFromFrames(frames, {
        fps: frameFps,
        triggerFrame: Number(frameMeta.triggerFrame) > 0 ? Number(frameMeta.triggerFrame) : 0,
        preRollMs: Number(frameMeta.preRollMs) > 0 ? Number(frameMeta.preRollMs) : 0,
      });
      if (!evidence.capture.fps) evidence.capture.fps = frameFps;
      if (!evidence.capture.frameCount) evidence.capture.frameCount = frames.length;
      if (!evidence.capture.viewport) {
        const vp = viewportOf(frameMeta.viewport);
        if (vp) evidence.capture.viewport = vp;
      }
    } catch (err) {
      notes.push(`frames could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { evidence, inputs, notes };
}

/** A Lottie file is its own evidence: the file *is* the spec. */
export function loadLottie(path: string, opts: { fps?: number } = {}): LoadedEvidence {
  const lottie = readJson<LottieFile>(path);
  const derivation = deriveFromLottie(lottie, { fps: opts.fps });
  const evidence: Evidence = {
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
export function loadFrames(dir: string, opts: { fps?: number } = {}): LoadedEvidence {
  const frames = listFrames(dir);
  const metaPath = join(dir, "frames.json");
  const meta: FrameMeta = exists(metaPath) ? readJson<FrameMeta>(metaPath) : {};
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

function roundMs(n: number): number {
  return Math.round(n * 10) / 10;
}
