// refilm fit — the analysis brain. Given a tracked curve, say what it is: where it starts and ends,
// how long it waits, how long the change is visible, how far it overshoots, and which named easing
// it matches when the duration is fitted too.
//
// Why duration is a free parameter: a curve that matches in shape but reports 1200ms for a 900ms
// animation is useless, because the clone will be rebuilt with the wrong timing. So every easing is
// fitted with a duration search, and the duration comes back with the match.

import { exists, readJson, reporter, parseArgs, num, str, usageError } from "../lib.js";
import { EXIT } from "../lib.js";
import type { EasingFamily } from "../types.js";

export const help = `
refilm fit — which easing is this curve, and how long does it run?

  refilm fit --track <track.json> --selector <css> --prop <x|y|w|h|opacity|scale|translateX|translateY|rotate>
  refilm fit --series '[[0,0],[100,12],[200,40],[300,80]]'
  refilm fit --track <gl-track.json> --channel <uHover|...>
  refilm fit --track <track.json> --selector .hero --prop y --compare-track <other.json> [--compare-channel k]

  --from-ms T / --to-ms T   clip the curve before analysis (ms of reference time)
  --compare-track <json>    diff this curve against another track's curve (same selector/prop unless
                            --compare-channel is given for a gl-track)
  --compare-channel <key>   channel of the comparison gl-track
  --top N                   how many easing candidates to report, default 5

Prints start/end values, delay (time of the first observed change), visible duration (first → last
change), overshoot %, settle time, whether it looks spring-like, and the best-fitting named easings
with RMSE and the fitted duration for each.

Reading it: take bestFits[0] as the easing to declare in the clone (bezier is ready to paste into CSS),
rebuild with that duration, then re-run fit on the clone's track — a curve that fits the same easing
with a low RMSE is a motion match even when the pixels are still off.
`;

// ------------------------------------------------------------------ easing library

export interface EasingSpec {
  /** Human name; also the CSS keyword when the easing has one. */
  name: string;
  /** Coarse bucket for SpecRow.easingFamily. */
  family: EasingFamily;
  /** cubic-bezier control points, or null for a non-bezier curve. */
  bezier: [number, number, number, number] | null;
  /** Normalised progress 0..1 → eased progress (may exceed 1 for back/overshoot curves). */
  fn: (t: number) => number;
  /** Other spellings that mean exactly this curve. */
  aliases?: string[];
}

/** CSS cubic-bezier(x1,y1,x2,y2) as a progress function, solved per call by bisection on x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bez = (u: number, a: number, b: number) => {
    const v = 1 - u;
    return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let u = t;
    for (let i = 0; i < 28; i++) {
      u = (lo + hi) / 2;
      if (bez(u, x1, x2) < t) lo = u;
      else hi = u;
    }
    return bez(u, y1, y2);
  };
}

function bez(
  name: string,
  family: EasingFamily,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  aliases?: string[],
): EasingSpec {
  return { name, family, bezier: [x1, y1, x2, y2], fn: cubicBezier(x1, y1, x2, y2), ...(aliases ? { aliases } : {}) };
}

/**
 * Every named curve a landing page, a design system or a tween library actually uses.
 * The bezier numbers are the CSS equivalents of the classic Penner-style power curves, so a match
 * can be declared directly in CSS or in a JS tween without translating anything.
 */
export const EASINGS: ReadonlyArray<EasingSpec> = [
  { name: "linear", family: "linear", bezier: null, fn: (t) => t },

  bez("ease", "ease-in-out", 0.25, 0.1, 0.25, 1, ["cubic-bezier(0.25,0.1,0.25,1)"]),
  bez("ease-in", "ease-in", 0.42, 0, 1, 1, ["cubic-bezier(0.42,0,1,1)"]),
  bez("ease-out", "ease-out", 0, 0, 0.58, 1, ["cubic-bezier(0,0,0.58,1)"]),
  bez("ease-in-out", "ease-in-out", 0.42, 0, 0.58, 1, ["cubic-bezier(0.42,0,0.58,1)"]),

  // quad
  bez("ease-in-quad", "ease-in", 0.11, 0, 0.5, 0, ["cubic-bezier(0.11,0,0.5,0)"]),
  bez("ease-out-quad", "ease-out", 0.5, 1, 0.89, 1, ["cubic-bezier(0.5,1,0.89,1)"]),
  bez("ease-in-out-quad", "ease-in-out", 0.45, 0, 0.55, 1, ["cubic-bezier(0.45,0,0.55,1)"]),

  // cubic
  bez("ease-in-cubic", "ease-in", 0.32, 0, 0.67, 0, ["cubic-bezier(0.32,0,0.67,0)"]),
  bez("ease-out-cubic", "ease-out", 0.33, 1, 0.68, 1, ["cubic-bezier(0.33,1,0.68,1)"]),
  bez("ease-in-out-cubic", "ease-in-out", 0.65, 0, 0.35, 1, ["cubic-bezier(0.65,0,0.35,1)"]),

  // quart
  bez("ease-in-quart", "ease-in", 0.5, 0, 0.75, 0, ["cubic-bezier(0.5,0,0.75,0)"]),
  bez("ease-out-quart", "ease-out", 0.25, 1, 0.5, 1, ["cubic-bezier(0.25,1,0.5,1)"]),
  bez("ease-in-out-quart", "ease-in-out", 0.76, 0, 0.24, 1, ["cubic-bezier(0.76,0,0.24,1)"]),

  // quint — 0.22,1,0.36,1 is the "hero reveal" curve most landing pages ship
  bez("ease-in-quint", "ease-in", 0.64, 0, 0.78, 0, ["cubic-bezier(0.64,0,0.78,0)"]),
  bez("ease-out-quint", "ease-out", 0.22, 1, 0.36, 1, ["cubic-bezier(0.22,1,0.36,1)"]),
  bez("ease-in-out-quint", "ease-in-out", 0.83, 0, 0.17, 1, ["cubic-bezier(0.83,0,0.17,1)"]),

  // expo — 0.16,1,0.3,1 is the other very common hero curve
  bez("ease-in-expo", "ease-in", 0.7, 0, 0.84, 0, ["cubic-bezier(0.7,0,0.84,0)"]),
  bez("ease-out-expo", "ease-out", 0.16, 1, 0.3, 1, ["cubic-bezier(0.16,1,0.3,1)"]),
  bez("ease-in-out-expo", "ease-in-out", 0.87, 0, 0.13, 1, ["cubic-bezier(0.87,0,0.13,1)"]),

  // circ
  bez("ease-in-circ", "ease-in", 0.55, 0, 1, 0.45, ["cubic-bezier(0.55,0,1,0.45)"]),
  bez("ease-out-circ", "ease-out", 0.075, 0.82, 0.165, 1, ["cubic-bezier(0.075,0.82,0.165,1)"]),
  bez("ease-in-out-circ", "ease-in-out", 0.85, 0, 0.15, 1, ["cubic-bezier(0.85,0,0.15,1)"]),

  // back — the ones that overshoot on purpose
  bez("ease-in-back", "ease-in", 0.36, 0, 0.66, -0.56, ["cubic-bezier(0.36,0,0.66,-0.56)"]),
  bez("ease-out-back", "ease-out", 0.34, 1.56, 0.64, 1, ["cubic-bezier(0.34,1.56,0.64,1)"]),
  bez("ease-in-out-back", "ease-in-out", 0.68, -0.6, 0.32, 1.6, ["cubic-bezier(0.68,-0.6,0.32,1.6)"]),

  // landing-page / design-system curves that do not map onto a power curve
  bez("ease-out-expo-alt", "ease-out", 0.19, 1, 0.22, 1, ["cubic-bezier(0.19,1,0.22,1)"]),
  bez("ease-out-quint-alt", "ease-out", 0.23, 1, 0.32, 1, ["cubic-bezier(0.23,1,0.32,1)"]),
  bez("material-standard", "ease-in-out", 0.4, 0, 0.2, 1, ["cubic-bezier(0.4,0,0.2,1)"]),
  bez("material-emphasized", "ease-in-out", 0.2, 0, 0, 1, ["cubic-bezier(0.2,0,0,1)"]),
  bez("gsap-power3-in-out", "ease-in-out", 0.77, 0, 0.175, 1, ["cubic-bezier(0.77,0,0.175,1)"]),
];

// ------------------------------------------------------------------ transforms

export interface MatrixParts {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  rotate: number;
}

/** Pull translate/scale/rotate out of a computed `transform: matrix(...)` / `matrix3d(...)`. */
export function matrixParts(transform: string | null | undefined): MatrixParts {
  const identity: MatrixParts = { tx: 0, ty: 0, sx: 1, sy: 1, rotate: 0 };
  if (!transform || transform === "none") return identity;
  const m = transform.match(/matrix(3d)?\(([^)]*)\)/);
  if (!m) return identity;
  const v = m[2].split(",").map((n) => Number(n.trim()));
  if (v.some((n) => !Number.isFinite(n))) return identity;
  const rotate = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  if (m[1]) {
    // matrix3d is column-major: m11 m12 m13 m14, m21 ... so translation sits at 12/13
    return {
      tx: v[12],
      ty: v[13],
      sx: Math.hypot(v[0], v[1]),
      sy: Math.hypot(v[4], v[5]),
      rotate,
    };
  }
  return {
    tx: v[4],
    ty: v[5],
    sx: Math.hypot(v[0], v[1]),
    sy: Math.hypot(v[2], v[3]),
    rotate,
  };
}

// ------------------------------------------------------------------ series input

export type Series = Array<[number, number]>;

export const TRACK_PROPS = [
  "x",
  "y",
  "w",
  "h",
  "opacity",
  "scale",
  "scaleX",
  "scaleY",
  "translateX",
  "translateY",
  "rotate",
] as const;

export type TrackProp = (typeof TRACK_PROPS)[number];

/** Series from a track.json: one value per sample, `prop` measured on `selector`. */
export function seriesFromTrack(track: any, selector: string, prop: string): Series {
  const out: Series = [];
  const samples = Array.isArray(track?.samples) ? track.samples : [];
  for (const sample of samples) {
    const el = sample?.els?.[selector];
    if (!el) continue;
    const m = matrixParts(el.transform);
    const values: Record<string, number> = {
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      opacity: el.opacity,
      scale: m.sx,
      scaleX: m.sx,
      scaleY: m.sy,
      translateX: m.tx,
      translateY: m.ty,
      rotate: m.rotate,
    };
    const v = values[prop];
    if (v === undefined || !Number.isFinite(v)) continue;
    out.push([Number(sample.t), v]);
  }
  if (!out.length) {
    throw usageError(
      `no samples for selector ${JSON.stringify(selector)} in this track`,
      `tracked selectors: ${(track?.selectors ?? []).join(", ") || "(none)"}`,
    );
  }
  return out;
}

/** Resolve a gl channel name: exact key, or a unique key ending in "." + name. */
export function resolveChannel(track: any, name: string): string {
  const channels = track?.channels ?? {};
  if (channels[name]) return name;
  const matches = Object.keys(channels).filter((k) => k === name || k.endsWith(`.${name}`) || k.endsWith(name));
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    const sample = Object.keys(channels).slice(0, 12).join(", ");
    throw usageError(`no animated channel ${JSON.stringify(name)}`, sample ? `channels include: ${sample}` : "run refilm gl channels <dir>");
  }
  throw usageError(
    `channel ${JSON.stringify(name)} is ambiguous`,
    `matches: ${matches.slice(0, 12).join(", ")} — pass a longer key`,
  );
}

export function seriesFromGlTrack(track: any, channel: string): Series {
  const key = resolveChannel(track, channel);
  const out: Series = [];
  for (const s of Array.isArray(track?.samples) ? track.samples : []) {
    const v = s?.v?.[key];
    if (v === undefined || !Number.isFinite(v)) continue;
    out.push([Number(s.t), v]);
  }
  if (out.length < 2) throw usageError(`channel ${JSON.stringify(key)} has fewer than 2 samples`);
  return out;
}

/** Pick the right reader for a track file: gl-track.json needs --channel, track.json needs --selector. */
export function seriesFromFile(path: string, opts: { selector?: string; prop?: string; channel?: string }): Series {
  const track = readJson<any>(path);
  if (track?.kind === "gl-track" || (track?.channels && !track?.selectors)) {
    if (!opts.channel) throw usageError(`${path} is a gl-track.json: pass --channel <key>`);
    return seriesFromGlTrack(track, opts.channel);
  }
  if (!opts.selector) {
    throw usageError(
      `${path} is a track.json: pass --selector <css>`,
      `tracked selectors: ${(track?.selectors ?? []).join(", ") || "(none)"}`,
    );
  }
  return seriesFromTrack(track, opts.selector, opts.prop ?? "y");
}

// ------------------------------------------------------------------ the fit

export interface FitBest {
  name: string;
  family: EasingFamily;
  /** cubic-bezier control points, ready for CSS; null for linear. */
  bezier: [number, number, number, number] | null;
  rmse: number;
  durationMs: number;
  delayMs: number;
}

export interface FitResult {
  samples: number;
  start: number;
  end: number;
  change: number;
  delayMs: number;
  visibleDurationMs: number;
  overshootPct: number;
  springLike: boolean;
  settleMs: number | null;
  verdict: string;
  note: string;
  bestFits: FitBest[];
}

export interface FitOptions {
  fromMs?: number;
  toMs?: number;
  top?: number;
  /** How much longer than the visible duration the fitted duration may be (expo tails). */
  maxDurationFactor?: number;
}

const round3 = (n: number, digits = 3) => Number(n.toFixed(digits));

/**
 * Fit a series to the easing library. The model is
 *   value(t) = start + range * easing((t - tStart) / duration)
 * with `tStart` anchored on the last sample that still held the start value and `duration`
 * searched (coarse grid, then bisection-style refinement), so the reported duration is measured
 * rather than assumed.
 */
export function fitSeries(input: Series, opts: FitOptions = {}): FitResult {
  const fromMs = opts.fromMs ?? Number.NEGATIVE_INFINITY;
  const toMs = opts.toMs ?? Number.POSITIVE_INFINITY;
  const top = Math.max(1, Math.round(opts.top ?? 5));
  const maxFactor = Math.max(1, opts.maxDurationFactor ?? 2.2);

  const series = input.filter(([t]) => t >= fromMs && t <= toMs).sort((a, b) => a[0] - b[0]);
  if (series.length < 4) {
    throw usageError(
      `need at least 4 samples to fit a curve, got ${series.length}`,
      "widen --from-ms/--to-ms or track the element for longer",
    );
  }

  const t0 = series[0][0];
  const start = series[0][1];
  const end = series[series.length - 1][1];
  const range = end - start;
  const magnitude = Math.abs(range);
  // "changed" means moved by more than 1% of the total travel (2px floor for pixel-space props)
  const eps = Math.max(magnitude * 0.01, 0.002);

  // The curve is "moving" while consecutive samples differ by more than the noise floor. Comparing
  // against the start value instead would run the window to the end of the recording, because a
  // finished animation never returns to where it began.
  let firstChange = -1;
  for (let i = 0; i < series.length; i++) {
    if (Math.abs(series[i][1] - start) > eps) {
      firstChange = i;
      break;
    }
  }
  if (firstChange < 0) {
    return {
      samples: series.length,
      start: round3(start),
      end: round3(end),
      change: round3(range),
      delayMs: 0,
      visibleDurationMs: 0,
      overshootPct: 0,
      springLike: false,
      settleMs: null,
      verdict: "no motion: the value never leaves its start value inside the window",
      note: "an all-constant curve usually means the wrong selector/prop, or the element is static",
      bestFits: [],
    };
  }

  let lastMoving = firstChange;
  for (let i = firstChange + 1; i < series.length; i++) {
    if (Math.abs(series[i][1] - series[i - 1][1]) > eps) lastMoving = i;
  }
  const delayMs = series[firstChange][0] - t0;
  const visibleDurationMs = Math.max(1, series[lastMoving][0] - series[firstChange][0]);

  // overshoot: how far past the end value the curve travels, relative to the total travel
  const signed = series.map(([, v]) => (v - start) * Math.sign(range || 1));
  const overshoot = magnitude === 0 ? 0 : Math.max(0, (Math.max(...signed) - magnitude) / magnitude);

  // settle: from the first change until the value is last seen outside 1% of the end value. For an
  // overshooting curve this lands after the overshoot, which is exactly the number a spring needs.
  let settleMs: number | null = null;
  for (let i = series.length - 1; i >= firstChange; i--) {
    if (Math.abs(series[i][1] - end) > eps) {
      settleMs = Math.round(series[Math.min(series.length - 1, i + 1)][0] - series[firstChange][0]);
      break;
    }
  }

  const bestFits: FitBest[] = [];
  if (magnitude > 0) {
    // normalise: y in 0..1 across the travel, t relative to the last still sample
    const anchorIndex = Math.max(0, firstChange - 1);
    const anchorT = series[anchorIndex][0];
    const normalised = series
      .slice(anchorIndex)
      .map(([t, v]) => [t - anchorT, (v - start) / range] as [number, number]);

    const rmseAt = (fn: (t: number) => number, duration: number, startOffset: number) => {
      let sum = 0;
      let n = 0;
      for (const [t, y] of normalised) {
        const local = t - startOffset;
        if (local < -duration * 0.1) continue;
        const predicted = local <= 0 ? 0 : local >= duration ? 1 : fn(local / duration);
        sum += (predicted - y) ** 2;
        n++;
      }
      return n ? Math.sqrt(sum / n) : Number.POSITIVE_INFINITY;
    };

    for (const easing of EASINGS) {
      let best = { rmse: Number.POSITIVE_INFINITY, duration: visibleDurationMs, delay: 0 };
      // delay search: the first changed sample sits between anchorT and the next sample, so allow
      // a fraction of a frame of slack either way
      const frameMs = Math.max(1, (series[Math.min(series.length - 1, firstChange + 1)][0] - series[anchorIndex][0]) || visibleDurationMs / 10);
      const delays = [0, frameMs * 0.25, frameMs * 0.5, frameMs * 0.75];
      for (const delay of delays) {
        // The bracket has to be wide: a tail-heavy curve (expo, quint) looks finished long before
        // its declared duration ends, so the visible window can be a third of the real duration.
        // A correct model still wins at its own duration because its residual goes to zero there.
        const lo = Math.max(16, visibleDurationMs * 0.2);
        const hi = Math.max(visibleDurationMs * 4, visibleDurationMs * maxFactor);
        // coarse grid
        let bestD = lo;
        let bestR = Number.POSITIVE_INFINITY;
        const steps = 64;
        for (let i = 0; i <= steps; i++) {
          const d = lo + ((hi - lo) * i) / steps;
          const r = rmseAt(easing.fn, d, delay);
          if (r < bestR) {
            bestR = r;
            bestD = d;
          }
        }
        // refine around the winner (three rounds of a shrinking bracket)
        let span = (hi - lo) / steps;
        for (let round = 0; round < 24; round++) {
          const candidates = [bestD - span / 2, bestD, bestD + span / 2];
          let improved = false;
          for (const d of candidates) {
            if (d <= 0) continue;
            const r = rmseAt(easing.fn, d, delay);
            if (r < bestR - 1e-9) {
              bestR = r;
              bestD = d;
              improved = true;
            }
          }
          span = improved ? span / 2 : span / 2;
          if (span < 0.05) break;
        }
        if (bestR < best.rmse) best = { rmse: bestR, duration: bestD, delay };
      }
      bestFits.push({
        name: easing.name,
        family: easing.family,
        bezier: easing.bezier,
        rmse: round3(best.rmse, 4),
        durationMs: Math.round(best.duration),
        delayMs: Math.round(best.delay),
      });
    }
    bestFits.sort((a, b) => a.rmse - b.rmse);
    // identical curves under different names would fill the list with one answer repeated
    const seen = new Set<string>();
    for (let i = bestFits.length - 1; i >= 0; i--) {
      const key = bestFits[i].bezier ? bestFits[i].bezier!.join(",") : "linear";
      if (seen.has(key)) bestFits.splice(i, 1);
      else seen.add(key);
    }
  }

  const best = bestFits[0];
  const springLike = overshoot > 0.02 && settleMs !== null;
  const quality =
    !best || !Number.isFinite(best.rmse)
      ? "no fit"
      : best.rmse < 0.02
        ? "good fit"
        : best.rmse < 0.06
          ? "approximate"
          : "poor fit";
  const verdict = springLike
    ? `spring-like: overshoots by ${(overshoot * 100).toFixed(1)}% and settles after ~${settleMs}ms — use a spring or a back easing, not a monotone one`
    : best
      ? `${best.name} over ~${best.durationMs}ms (${quality})`
      : "no motion to fit";

  return {
    samples: series.length,
    start: round3(start),
    end: round3(end),
    change: round3(range),
    delayMs: Math.round(delayMs),
    visibleDurationMs: Math.round(visibleDurationMs),
    overshootPct: round3(overshoot * 100, 1),
    springLike,
    settleMs,
    verdict,
    note:
      "visibleDurationMs = first→last observed change; bestFits[].durationMs is the fitted declared " +
      "duration (a long tail can make it longer than the visible change)",
    bestFits: bestFits.slice(0, top),
  };
}

/** Compare two curves on a common time grid and report the worst and average distance. */
export function diffSeries(a: Series, b: Series): { maxAbsDiff: number; meanAbsDiff: number; samples: number; diffs: Array<{ t: number; diff: number }> } {
  if (!a.length || !b.length) return { maxAbsDiff: 0, meanAbsDiff: 0, samples: 0, diffs: [] };
  // Linear interpolation on the other curve: tracks are sampled per animation frame, and a
  // nearest-sample lookup would turn sub-frame timing differences into a visible stair step.
  const at = (s: Series, t: number): number => {
    if (t <= s[0][0]) return s[0][1];
    const last = s[s.length - 1];
    if (t >= last[0]) return last[1];
    for (let i = 1; i < s.length; i++) {
      const [t1, v1] = s[i];
      if (t1 < t) continue;
      const [t0, v0] = s[i - 1];
      if (t1 === t0) return v1;
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
    return last[1];
  };
  const diffs = a.map(([t, v]) => ({ t, diff: round3(at(b, t) - v, 3) }));
  const abs = diffs.map((d) => Math.abs(d.diff));
  return {
    maxAbsDiff: round3(Math.max(...abs), 3),
    meanAbsDiff: round3(abs.reduce((s, d) => s + d, 0) / abs.length, 3),
    samples: diffs.length,
    diffs,
  };
}

// ------------------------------------------------------------------ command

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("fit", { json: ctx.json });
  const args = parseArgs(argv);

  let series: Series;
  if (str(args.series)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(str(args.series)!);
    } catch (err) {
      throw usageError(`--series is not valid JSON: ${err instanceof Error ? err.message : err}`, "expected [[t_ms, value], ...]");
    }
    if (!Array.isArray(parsed) || parsed.some((p) => !Array.isArray(p) || p.length !== 2)) {
      throw usageError("--series must be an array of [t_ms, value] pairs");
    }
    series = (parsed as unknown[][]).map(([t, v]) => [Number(t), Number(v)]);
  } else if (str(args.track)) {
    const trackPath = str(args.track)!;
    if (!exists(trackPath)) throw usageError(`no such track file: ${trackPath}`);
    series = seriesFromFile(trackPath, {
      selector: str(args.selector),
      prop: str(args.prop) ?? "y",
      channel: str(args.channel),
    });
  } else {
    throw usageError(
      "fit needs a curve: --track <track.json> --selector <css> --prop <prop>, or --series '[[t,v],...]'",
      "example: refilm fit --track .refilm/ref/track.json --selector '.hero h1' --prop translateY",
    );
  }

  const result = fitSeries(series, {
    fromMs: args["from-ms"] !== undefined ? num(args["from-ms"], Number.NEGATIVE_INFINITY) : undefined,
    toMs: args["to-ms"] !== undefined ? num(args["to-ms"], Number.POSITIVE_INFINITY) : undefined,
    top: num(args.top, 5),
  });

  const comparePath = str(args["compare-track"]);
  let comparison: ReturnType<typeof diffSeries> | null = null;
  if (comparePath) {
    if (!exists(comparePath)) throw usageError(`no such --compare-track file: ${comparePath}`);
    const other = seriesFromFile(comparePath, {
      selector: str(args.selector),
      prop: str(args.prop) ?? "y",
      channel: str(args["compare-channel"]) ?? str(args.channel),
    });
    comparison = diffSeries(series, other);
  }

  const payload = comparison ? { ...result, compare: comparison } : result;

  const lines = [
    `start ${result.start} → end ${result.end} (change ${result.change})`,
    `delay ${result.delayMs}ms · visible duration ${result.visibleDurationMs}ms · overshoot ${result.overshootPct}%` +
      `${result.settleMs !== null ? ` · settles ${result.settleMs}ms after it starts` : ""}`,
    `verdict: ${result.verdict}`,
    ``,
    `best fits (rmse over the normalised curve, duration fitted):`,
    ...result.bestFits.map(
      (f, i) =>
        `  ${String(i + 1).padStart(2)}. ${f.name.padEnd(22)} rmse ${f.rmse.toFixed(4)}  ~${f.durationMs}ms` +
        `${f.bezier ? `  cubic-bezier(${f.bezier.join(",")})` : ""}  [${f.family}]`,
    ),
  ];
  if (comparison) {
    lines.push(
      ``,
      `compare: maxAbsDiff ${comparison.maxAbsDiff}, meanAbsDiff ${comparison.meanAbsDiff} over ${comparison.samples} samples`,
    );
  }
  rep.say(lines.join("\n"));
  rep.emit("fit", payload);
  return EXIT.OK;
}
