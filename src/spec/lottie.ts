// refilm — read a Lottie export directly.
//
// A Lottie file *is* the spec: every layer carries its own keyframe times and bezier handles,
// so re-deriving it from pixels would only add error. This reader walks the layer properties
// and emits one row per animated property per keyframe segment, with the bezier the author
// actually wrote.

import { classifyCurve, curveOf, familyOf } from "./easing.js";
import { roundTo, type RawRow } from "./row.js";

export interface LottieKeyframe {
  t?: number;
  s?: number[] | number;
  e?: number[] | number;
  i?: { x?: number | number[]; y?: number | number[] };
  o?: { x?: number | number[]; y?: number | number[] };
  h?: number;
}

export interface LottieProp {
  a?: number;
  k?: number | number[] | LottieKeyframe[];
  x?: string;
}

export interface LottieLayer {
  ind?: number;
  nm?: string;
  ty?: number;
  ip?: number;
  op?: number;
  st?: number;
  sr?: number;
  ks?: Record<string, LottieProp>;
  shapes?: unknown[];
  tt?: number;
}

export interface LottieFile {
  v?: string;
  nm?: string;
  fr?: number;
  ip?: number;
  op?: number;
  w?: number;
  h?: number;
  layers?: LottieLayer[];
  markers?: Array<{ tm?: number; cm?: string; dr?: number }>;
  assets?: unknown[];
}

export interface LottieDerivation {
  rows: RawRow[];
  notes: string[];
  facts: Record<string, string | number>;
  fps: number;
  totalMs: number;
  name: string;
}

const num = (v: unknown, fallback = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === "number" && Number.isFinite(v[0])) return v[0];
  return fallback;
};

const vec = (v: unknown): number[] => {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return [];
};

function firstNumber(v: { x?: number | number[]; y?: number | number[] } | undefined, axis: "x" | "y"): number | null {
  if (!v) return null;
  const raw = v[axis];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw) && typeof raw[0] === "number" && Number.isFinite(raw[0])) return raw[0];
  return null;
}

/**
 * Lottie stores a segment's easing as two handles: `o` (out of this keyframe) and `i` (into the
 * next one), each normalised to the segment. That is exactly a cubic-bezier control pair.
 */
function segmentEasing(kf: LottieKeyframe, next: LottieKeyframe | undefined): { css: string | null; family: RawRow["easingFamily"] } {
  if (kf.h === 1) return { css: "steps(1, end)", family: "steps" };
  const ox = firstNumber(kf.o, "x");
  const oy = firstNumber(kf.o, "y");
  const ix = firstNumber(kf.i, "x");
  const iy = firstNumber(kf.i, "y");
  if (ox === null || oy === null || ix === null || iy === null) {
    // No handles: Lottie holds the value until the next keyframe.
    return { css: "steps(1, end)", family: "steps" };
  }
  if (Math.abs(ox - oy) < 1e-6 && Math.abs(ix - iy) < 1e-6 && Math.abs(ox - ix) < 1e-6) {
    return { css: "linear", family: "linear" };
  }
  const css = `cubic-bezier(${roundTo(ox, 3)}, ${roundTo(oy, 3)}, ${roundTo(ix, 3)}, ${roundTo(iy, 3)})`;
  const fn = curveOf(css);
  const family = familyOf(css) !== "unknown" ? familyOf(css) : fn ? classifyCurve(fn) : "unknown";
  return { css, family };
}

interface PropertySpec {
  key: string;
  label: string;
  /** Which component of the value to emit, and how to name it. */
  channels: Array<{ index: number; property: string; transform?: (v: number) => number }>;
}

const PROPERTY_SPECS: PropertySpec[] = [
  { key: "o", label: "opacity", channels: [{ index: 0, property: "opacity", transform: (v) => roundTo(v / 100, 3) }] },
  {
    key: "p",
    label: "position",
    channels: [
      { index: 0, property: "x", transform: (v) => roundTo(v, 2) },
      { index: 1, property: "y", transform: (v) => roundTo(v, 2) },
    ],
  },
  {
    key: "s",
    label: "scale",
    channels: [
      { index: 0, property: "scaleX", transform: (v) => roundTo(v / 100, 3) },
      { index: 1, property: "scaleY", transform: (v) => roundTo(v / 100, 3) },
    ],
  },
  { key: "r", label: "rotation", channels: [{ index: 0, property: "rotate", transform: (v) => roundTo(v, 2) }] },
];

function layerName(layer: LottieLayer, index: number): string {
  const nm = (layer.nm ?? "").trim();
  if (nm) return nm;
  const kind = layer.ty === 4 ? "shape" : layer.ty === 2 ? "image" : layer.ty === 5 ? "text" : layer.ty === 0 ? "precomp" : "layer";
  return `${kind}[${layer.ind ?? index}]`;
}

export function deriveFromLottie(file: LottieFile, opts: { fps?: number } = {}): LottieDerivation {
  const rows: RawRow[] = [];
  const notes: string[] = [];
  const facts: Record<string, string | number> = {};
  const fr = Number.isFinite(Number(file.fr)) && Number(file.fr) > 0 ? Number(file.fr) : 30;
  const fps = opts.fps && opts.fps > 0 ? opts.fps : fr;
  const ip = Number.isFinite(Number(file.ip)) ? Number(file.ip) : 0;
  const op = Number.isFinite(Number(file.op)) ? Number(file.op) : 0;
  const totalFrames = Math.max(0, op - ip);
  const totalMs = roundTo((totalFrames / fr) * 1000, 1);
  const name = (file.nm ?? "").trim() || "lottie";
  const frameToMs = (frame: number) => roundTo(((frame - ip) / fr) * 1000, 1);

  facts["lottie.version"] = file.v ?? "(unknown)";
  facts["lottie.frameRate"] = fr;
  facts["lottie.frames"] = totalFrames;
  facts["lottie.size"] = `${file.w ?? "?"}x${file.h ?? "?"}`;
  facts["lottie.layers"] = (file.layers ?? []).length;
  if (file.markers?.length) {
    facts["lottie.markers"] = file.markers.map((m) => m.cm ?? `marker@${m.tm ?? 0}`).join(", ");
  }
  if (opts.fps && opts.fps !== fr) {
    notes.push(
      `the file plays at ${fr} fps but the spec was asked for ${opts.fps} fps — keyframe times are reported in ms, so they are unaffected; only the frame count differs`,
    );
  }

  const layers = Array.isArray(file.layers) ? file.layers : [];
  if (!layers.length) {
    notes.push("the Lottie file has no layers — nothing to read");
    return { rows, notes, facts, fps, totalMs, name };
  }

  // static layers are still part of the spec: they are the things that must not move
  const staticLayers: string[] = [];
  const layerStarts: Array<{ element: string; startMs: number }> = [];

  layers.forEach((layer, li) => {
    const element = layerName(layer, li);
    const ks = layer.ks ?? {};
    const layerIn = Number.isFinite(Number(layer.ip)) ? Number(layer.ip) : ip;
    let animatedProps = 0;

    for (const spec of PROPERTY_SPECS) {
      const prop = ks[spec.key];
      if (!prop) continue;
      const animated = Number(prop.a) === 1;
      const keyframes = Array.isArray(prop.k) ? (prop.k as LottieKeyframe[]) : [];
      if (!animated || !keyframes.length) continue;
      animatedProps++;

      const sorted = [...keyframes].sort((a, b) => num(a.t) - num(b.t));
      for (let i = 0; i < sorted.length; i++) {
        const kf = sorted[i];
        const next = sorted[i + 1];
        const startFrame = num(kf.t, layerIn);
        const endFrame = next ? num(next.t, startFrame) : num(kf.t, startFrame) + 1;
        const startMs = roundTo(frameToMs(startFrame), 1);
        const durationMs = roundTo(((endFrame - startFrame) / fr) * 1000, 1);
        if (durationMs <= 0) continue;

        const fromVec = vec(kf.s);
        const toVec = next ? vec(next.s) : vec(kf.e);
        const easing = segmentEasing(kf, next);

        for (const channel of spec.channels) {
          const fromRaw = fromVec[channel.index];
          const toRaw = toVec[channel.index] ?? fromRaw;
          if (fromRaw === undefined || toRaw === undefined) continue;
          const from = channel.transform ? channel.transform(fromRaw) : roundTo(fromRaw, 2);
          const to = channel.transform ? channel.transform(toRaw) : roundTo(toRaw, 2);
          if (from === to) continue;
          rows.push({
            element,
            property: channel.property,
            from,
            to,
            startMs,
            durationMs,
            easing: easing.css,
            easingFamily: easing.family,
            overshoot: easing.family === "spring" ? null : 0,
            source: "declared",
            confidence: "high",
            group: `${element}|${spec.key}`,
            note: easing.family === "steps" ? "held keyframe (no bezier handles): the value jumps at the next keyframe" : undefined,
          });
        }
        if (!next && kf.e === undefined) {
          notes.push(`${element}.${spec.label}: the last keyframe has no end value — it holds from ${startMs} ms`);
        }
      }
      layerStarts.push({ element, startMs: roundTo(frameToMs(layerIn), 1) });
    }

    // A property with a single static value is not motion, but it is a fact the clone needs.
    for (const spec of PROPERTY_SPECS) {
      const prop = ks[spec.key];
      if (!prop || Number(prop.a) === 1) continue;
      const value = vec(prop.k);
      if (!value.length) continue;
      const mapped = spec.channels
        .map((c) => {
          const raw = value[c.index];
          if (raw === undefined) return null;
          return `${c.property}=${c.transform ? c.transform(raw) : roundTo(raw, 2)}`;
        })
        .filter(Boolean);
      if (mapped.length) facts[`lottie.static.${element}.${spec.label}`] = mapped.join(", ");
    }
    if (animatedProps === 0) staticLayers.push(element);
  });

  if (staticLayers.length) {
    facts["lottie.staticLayers"] = staticLayers.join(", ");
    notes.push(`${staticLayers.length} layer(s) never animate (${staticLayers.slice(0, 6).join(", ")}${staticLayers.length > 6 ? ", …" : ""}): they must stay still in the clone`);
  }
  if (!rows.length) {
    notes.push("no animated layer property found: the file may animate shapes or effects inside layers (mask paths, shape modifiers) rather than layer transforms");
  }

  // ---- stagger across layers, when the layers start at different times
  if (layerStarts.length > 1) {
    const unique = [...new Set(layerStarts.map((l) => l.startMs))].sort((a, b) => a - b);
    if (unique.length > 1) {
      const gaps: number[] = [];
      for (let i = 1; i < unique.length; i++) gaps.push(roundTo(unique[i] - unique[i - 1], 1));
      facts["lottie.layerStartsMs"] = unique.join(", ");
      notes.push(`layers start at ${unique.join(", ")} ms (gaps ${gaps.join(", ")} ms)`);
    }
  }

  return { rows, notes, facts, fps, totalMs, name };
}
