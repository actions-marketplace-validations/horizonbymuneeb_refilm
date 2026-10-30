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

  const clockChannels: string[] = [];
  const derivedChannels: string[] = [];

  for (const ch of fits) {
    const best = ch.fit.bestFits[0];
    const rate = clockRate(ch);
    const rowNotes: string[] = [];

    if (rate !== null) {
      clockChannels.push(`${ch.name} (${rate >= 0 ? "+" : ""}${roundTo(rate, 6)}/ms)`);
      rowNotes.push(`linear in time at ${roundTo(rate, 6)} per ms: a clock, so the rate is the value to copy`);
    }
    if (/Matrix/i.test(ch.name)) {
      derivedChannels.push(ch.name);
      rowNotes.push("a matrix element: it moves because the object moves, not on its own");
    }
    if (ch.kind === "there-and-back" || ch.kind === "oscillation") {
      rowNotes.push(`the trace classifies this channel as ${ch.kind}: a cycle, not a one-shot tween`);
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
      confidence: rate !== null || /Matrix/i.test(ch.name) ? "low" : best && best.rmse < 0.05 ? "medium" : "low",
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
  if (derivedChannels.length) {
    facts["gl.derivedChannels"] = `${derivedChannels.length} matrix channel(s)`;
    notes.push(
      `${derivedChannels.length} row(s) come from matrix elements — copy the object's rotation/position, not the matrix numbers`,
    );
  }
  const moved = new Set(rows.map((r) => r.element));
  const still = names.filter((n) => !moved.has(n.split(".")[0] ?? n));
  if (still.length) notes.push(`${still.length} traced channel(s) never move: fixed uniforms are constants to copy as they are`);

  return { rows, notes, facts, channels: fits };
}
