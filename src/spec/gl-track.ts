// refilm — read a GPU trace (gl-track.json) into spec rows.
//
// A canvas has no CSS: the motion lives in uniforms and scene-graph values. The trace gives
// one value per rendered frame per channel, so the fit is the same fit a DOM track gets, and
// the rows name the channel instead of a CSS property.

import { fitSeries, type FitResult, type Series } from "../commands/fit.js";
import type { GlTrack } from "../types.js";
import { roundTo, type RawRow } from "./row.js";

export interface GlChannelFit {
  name: string;
  series: Series;
  fit: FitResult;
  startMs: number;
  endMs: number;
  /** `clock`, `transition`, `oscillation`, `steps`, `there-and-back`, or "" when unknown. */
  kind: string;
}

export interface GlDerivation {
  rows: RawRow[];
  notes: string[];
  facts: Record<string, string | number>;
  channels: GlChannelFit[];
}

/** Every traced channel, fitted; channels that never move are dropped. */
export function glChannelFits(track: GlTrack): GlChannelFit[] {
  const channels = (track.channels ?? {}) as Record<string, { kind?: string }>;
  const out: GlChannelFit[] = [];
  for (const name of Object.keys(channels)) {
    const series: Series = [];
    for (const s of track.samples ?? []) {
      const v = s.v?.[name];
      if (typeof v === "number" && Number.isFinite(v) && Number.isFinite(s.t)) series.push([s.t, v]);
    }
    if (series.length < 4) continue;
    const fit = fitSeries(series);
    if (!fit.bestFits.length || Math.abs(fit.change) < 1e-9) continue;
    const t0 = series[0][0];
    out.push({
      name,
      series,
      fit,
      startMs: roundTo(t0 + fit.delayMs, 1),
      endMs: roundTo(t0 + fit.delayMs + fit.visibleDurationMs, 1),
      kind: typeof channels[name]?.kind === "string" ? String(channels[name].kind) : "",
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));
}

/** A channel that keeps rising with time is a clock: it is the rate that must be copied. */
function clockRate(ch: GlChannelFit): number | null {
  const s = ch.series;
  if (s.length < 3) return null;
  const dt = s[s.length - 1][0] - s[0][0];
  if (dt <= 0) return null;
  const first = s[0][1];
  const slope = (s[s.length - 1][1] - first) / dt;
  const mean = s.reduce((sum, [, v]) => sum + v, 0) / s.length;
  let ssTot = 0;
  let ssRes = 0;
  for (const [t, v] of s) {
    const predicted = first + slope * (t - s[0][0]);
    ssTot += (v - mean) ** 2;
    ssRes += (v - predicted) ** 2;
  }
  // R² of a straight line through the samples: a clock is monotone and even
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return r2 > 0.995 ? slope : null;
}

export function deriveFromGlTrack(track: GlTrack, opts: { fps?: number } = {}): GlDerivation {
  const rows: RawRow[] = [];
  const notes: string[] = [];
  const facts: Record<string, string | number> = {};
  const samples = Array.isArray(track.samples) ? track.samples : [];
  const names = Object.keys(track.channels ?? {});

  facts["gl.channels"] = names.length;
  facts["gl.samples"] = samples.length;
  if (opts.fps) facts["gl.fps"] = opts.fps;
  if (!samples.length) {
    notes.push("gl-track.json has no samples — the GPU trace is empty");
    return { rows, notes, facts, channels: [] };
  }

  const kindCounts = new Map<string, number>();
  for (const name of names) {
    const kind = (track.channels as Record<string, { kind?: string }>)[name]?.kind;
    if (typeof kind === "string" && kind) kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  if (kindCounts.size) facts["gl.kinds"] = [...kindCounts.entries()].map(([k, n]) => `${k}×${n}`).join(", ");

  const fits = glChannelFits(track);
  if (!fits.length) {
    notes.push(
      "every traced channel holds a constant value: the canvas does not animate in the recorded window, or only fixed uniforms were captured",
    );
    return { rows, notes, facts, channels: [] };
  }

  // A model-view or normal matrix element is a *consequence* of the object's transform: emitting
  // one row per matrix element buries the three rows that matter (rotation, position, colour) in
  // a dozen that only say "the same object moved". When the trace also carries scene-graph
  // channels for that object, the matrix rows are dropped and reported as derived.
  const hasSceneGraph = (prefix: string) =>
    fits.some((f) => f.name.startsWith(prefix) && !/Matrix/.test(f.name) && !/\.emissive|\.color/.test(f.name));
  const derivedChannels: string[] = [];
  const matrixOnly: string[] = [];
  const kept: GlChannelFit[] = [];
  for (const ch of fits) {
    if (/Matrix/.test(ch.name)) {
      const prefix = ch.name.split(".")[0] ?? "";
      if (hasSceneGraph(prefix) || hasSceneGraph("three:")) {
        matrixOnly.push(ch.name);
        continue;
      }
    }
    kept.push(ch);
  }
  if (matrixOnly.length) {
    notes.push(
      `${matrixOnly.length} matrix channel(s) were not emitted as rows: they are the same object transform seen through a matrix, and the object's own rotation/position rows describe it directly`,
    );
    facts["gl.derivedMatrixChannels"] = matrixOnly.length;
  }

  const clockChannels: string[] = [];

  for (const ch of kept) {
    const best = ch.fit.bestFits[0];
    const rate = clockRate(ch);
    const rowNotes: string[] = [];

    if (rate !== null) {
      clockChannels.push(`${ch.name} (${rate >= 0 ? "+" : ""}${roundTo(rate, 6)}/ms)`);
      rowNotes.push(`linear in time at ${roundTo(rate, 6)} per ms: a clock, so the rate is the value to copy`);
    }
    if (ch.kind === "there-and-back" || ch.kind === "oscillation") {
      rowNotes.push(`the trace classifies this channel as ${ch.kind}: a cycle, not a one-shot tween`);
    }
    if (ch.fit.visibleDurationMs < 20) {
      rowNotes.push(
        `the fitted window is only ${Math.round(ch.fit.visibleDurationMs)} ms, shorter than one rendered frame at 60 fps: this channel oscillates and the window is noise, not a tween`,
      );
    }

    rows.push({
      element: ch.name.split(".")[0] ?? ch.name,
      property: ch.name,
      from: roundTo(ch.fit.start, 6),
      to: roundTo(ch.fit.end, 6),
      startMs: ch.startMs,
      durationMs: roundTo(ch.fit.visibleDurationMs, 1),
      easing: rate !== null ? "linear" : best ? best.name : null,
      easingFamily: rate !== null ? "linear" : best ? best.family : "unknown",
      overshoot: ch.fit.overshootPct > 0.5 ? roundTo(ch.fit.overshootPct, 2) : 0,
      source: "gl-track",
      // A clock rate is measured to a few parts per thousand, so it is resolved even though it
      // is not a tween; the row still says "clock" so nobody keyframes it.
      confidence: rate !== null ? "medium" : best && best.rmse < 0.05 ? "medium" : "low",
      group: `gl|${ch.name}`,
      note: rowNotes.length ? rowNotes.join("; ") : undefined,
    });
  }

  if (clockChannels.length) {
    facts["gl.clockChannels"] = clockChannels.join(", ");
    notes.push(
      `${clockChannels.length} clock channel(s): ${clockChannels.join(", ")} — copy the rate into the clone's clock, do not keyframe the values`,
    );
  }
  const moved = new Set(rows.map((r) => r.element));
  const still = names.filter((n) => !moved.has(n.split(".")[0] ?? n));
  if (still.length) notes.push(`${still.length} traced channel(s) never move: fixed uniforms are constants to copy as they are`);

  return { rows, notes, facts, channels: fits };
}
