// refilm — assemble a Spec from whatever evidence a capture actually provides.
//
// The rule this file enforces: a number appears in a row only when a source measured it.
// Everything else goes to `unresolved` with the reason, and the row that could not be
// measured is marked low-confidence. A spec that silently guesses is worse than no spec,
// because every downstream check trusts it.

import type { Fidelity, Spec, SpecRow, Trigger, Viewport } from "../types.js";
import { SCHEMA } from "../types.js";
import { roundTo, type RawRow } from "./row.js";
import type { InspectDerivation } from "./inspect.js";
import type { TrackDerivation } from "./track.js";
import type { GlDerivation } from "./gl-track.js";
import type { FramesDerivation } from "./frames.js";
import type { LottieDerivation } from "./lottie.js";

export interface Evidence {
  inspect?: InspectDerivation;
  track?: TrackDerivation;
  glTrack?: GlDerivation;
  frames?: FramesDerivation;
  lottie?: LottieDerivation;
  /** capture.json / frames.json / gl capture metadata, already flattened. */
  capture?: {
    url?: string;
    title?: string;
    viewport?: Viewport;
    fps?: number;
    trigger?: Trigger;
    durationMs?: number;
    clip?: { x: number; y: number; width: number; height: number };
    renderer?: string;
    libs?: string[];
    fonts?: Array<{ family?: string; status?: string }>;
    frameCount?: number;
  };
}

export interface DeriveOptions {
  name: string;
  destination?: string;
  fidelity: Fidelity;
  additions: string[];
  /** Extra selectors from --track, used to name elements when a track has no inspect. */
  trackSelectors?: string[];
}

export interface DerivedSpec {
  spec: Spec;
  /** Rows dropped as duplicates of a stronger source, for the human report. */
  merged: string[];
}

const SOURCE_RANK: Record<SpecRow["source"], number> = {
  declared: 4,
  track: 3,
  "gl-track": 2,
  frames: 1,
  unknown: 0,
};

const FIDELITY_DEFAULT: Fidelity = "motion";

/** Sibling rows: same element tag and same property, distinguished only by index. */
function siblingKey(row: RawRow): string {
  return `${row.group}`;
}

/**
 * Stagger is the gap between siblings of one effect. It is only real when at least two
 * siblings of the same group start at different times, and the gaps are consistent enough
 * to be a rule rather than noise.
 */
function applyStagger(rows: RawRow[]): { notes: string[] } {
  const notes: string[] = [];
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    if (row.index === undefined) continue;
    const key = siblingKey(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const starts = sorted.map((r) => r.startMs);
    if (starts.some((s) => s === null)) continue;
    const gaps: number[] = [];
    for (let i = 1; i < starts.length; i++) gaps.push(roundTo((starts[i] as number) - (starts[i - 1] as number), 1));
    if (!gaps.length) continue;
    const allEqual = gaps.every((g) => Math.abs(g - gaps[0]) <= 1);
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    // A constant gap is a stagger. A growing gap is an eased stagger, which is a different
    // instruction to the implementer, so it gets said in words rather than one number.
    if (allEqual && Math.abs(gaps[0]) > 0.5) {
      for (const row of sorted) row.staggerMs = Math.abs(gaps[0]);
    } else if (min > 0.5) {
      for (const row of sorted) row.staggerMs = roundTo(gaps[gaps.length - 1], 1);
      notes.push(
        `${key.split("|")[0]}: sibling gaps grow (${gaps.map((g) => `${g}ms`).join(", ")}) — an eased stagger, so a single staggerMs cannot express it`,
      );
    }
  }
  return { notes };
}

/**
 * Cross-check declared rows against the fitted track. A declaration is exact and a fit is not,
 * so a disagreement is a note for the reader — never a reason to distrust the declaration. What
 * the track *can* prove is the reverse: motion with no declared explanation.
 */
function corroborate(row: RawRow, track?: TrackDerivation): { note?: string } {
  if (!track) return {};
  const candidates = track.rows.filter((t) => t.property === row.property);
  if (!candidates.length) return {};
  const durations = candidates.map((c) => c.durationMs).filter((d): d is number => d !== null);
  if (!durations.length || row.durationMs === null) return {};
  if (durations.some((d) => Math.abs(d - row.durationMs!) <= 90)) return {};
  return {
    note: `the declared ${row.durationMs} ms is what the page asked for; the pixels fit ${durations.map((d) => Math.round(d)).join("/")} ms — a front-loaded curve hides its own tail, so the declaration wins`,
  };
}

function unresolvedForRow(row: RawRow): string | null {
  const bits: string[] = [];
  if (row.startMs === null) bits.push("start time");
  if (row.durationMs === null) bits.push("duration");
  if (row.easing === null) bits.push("easing curve");
  if (row.easingFamily === "unknown") bits.push("easing family");
  if (bits.length === 0) return null;
  return `${row.element}.${row.property}: ${bits.join(", ")} not measurable from the available evidence${row.note ? ` (${row.note})` : ""}`;
}

export function deriveSpec(evidence: Evidence, opts: DeriveOptions): DerivedSpec {
  const merged: string[] = [];
  const unresolved: string[] = [];
  const notes: string[] = [];

  // ---- collect every row, strongest source first
  const collected: Array<{ row: RawRow; rank: number }> = [];
  const push = (rows: RawRow[] | undefined, source: SpecRow["source"]) => {
    for (const row of rows ?? []) collected.push({ row, rank: SOURCE_RANK[row.source] ?? SOURCE_RANK[source] });
  };
  push(evidence.inspect?.rows, "declared");
  push(evidence.lottie?.rows, "declared");
  push(evidence.track?.rows, "track");
  push(evidence.glTrack?.rows, "gl-track");
  push(evidence.frames?.rows, "frames");

  // The strongest source present decides which rows survive: a declared capture does not need
  // a fitted duplicate of every property, and mixing sources inside one row would be a lie
  // about where the number came from.
  const bestRank = collected.reduce((m, c) => Math.max(m, c.rank), 0);
  const chosen: RawRow[] = [];
  for (const c of collected) {
    if (c.rank === bestRank) chosen.push(c.row);
    else merged.push(`${c.row.element}.${c.row.property} (${c.row.source}) — superseded by a ${bestRank >= 3 ? "declared/fitted" : "stronger"} source`);
  }

  // ---- corroboration: the track can only add notes here, never move a declared number
  if (bestRank === SOURCE_RANK.declared && evidence.track?.rows.length) {
    const seen = new Set<string>();
    for (const row of chosen) {
      const check = corroborate(row, evidence.track);
      if (check.note && !seen.has(check.note)) {
        seen.add(check.note);
        notes.push(check.note);
      }
    }
    // motion the declaration does not explain is a real gap in the spec
    const declaredProps = new Set(chosen.map((r) => r.property));
    const unexplained = evidence.track.rows.filter((t) => !declaredProps.has(t.property));
    for (const t of unexplained) {
      unresolved.push(
        `${t.element}.${t.property} moves in the track (${Math.round(t.startMs ?? 0)} ms, ${Math.round(t.durationMs ?? 0)} ms) but no declared animation explains it — likely a transition or a JS tween`,
      );
    }
  }

  // ---- stagger inside sibling groups
  const staggerNotes = applyStagger(chosen);
  notes.push(...staggerNotes.notes);

  // ---- order the rows the way the timeline reads: by start, then by element
  chosen.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || a.element.localeCompare(b.element) || a.property.localeCompare(b.property));

  // ---- ids: stable, readable, and unique even when an element repeats
  const idCount = new Map<string, number>();
  const rows: SpecRow[] = chosen.map((raw) => {
    const base = `${raw.element}-${raw.property}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const n = (idCount.get(base) ?? 0) + 1;
    idCount.set(base, n);
    const id = n === 1 ? base : `${base}#${n}`;

    if (raw.confidence === "low") {
      const reason = unresolvedForRow(raw) ?? `${raw.element}.${raw.property}: ${raw.note ?? "evidence is weak"}`;
      unresolved.push(reason);
    }
    if (raw.note && raw.confidence !== "low") notes.push(`${raw.element}.${raw.property}: ${raw.note}`);

    return {
      id,
      element: raw.element,
      property: raw.property,
      from: raw.from,
      to: raw.to,
      startMs: raw.startMs,
      durationMs: raw.durationMs,
      easing: raw.easing,
      easingFamily: raw.easingFamily,
      staggerMs: raw.staggerMs ?? null,
      overshoot: raw.overshoot,
      source: raw.source,
      confidence: raw.confidence,
    };
  });

  // ---- evidence-level gaps, the ones no single row owns
  const hasInspect = !!evidence.inspect && evidence.inspect.animationCount > 0;
  const hasTrack = !!evidence.track && evidence.track.rows.length > 0;
  const hasGl = !!evidence.glTrack && evidence.glTrack.rows.length > 0;
  const hasFrames = !!evidence.frames && evidence.frames.rows.length > 0;

  if (!hasInspect && !evidence.lottie && !hasGl) {
    unresolved.push(
      "no declared animation timing in this capture (inspect.json lists none): every start and duration below is fitted from samples, so it is accurate to about one frame, not to the millisecond",
    );
  }
  if (!hasTrack && !hasGl && !evidence.lottie) {
    unresolved.push(
      "no track.json: travel distance, overshoot and the easing shape were not measured — only the declared keyframe values are known",
    );
  }
  if (hasFrames && !hasInspect && !hasTrack) {
    unresolved.push(
      "pixel-only evidence: which element owns each region, the CSS property, the travel distance and the direction are all unknown — this spec cannot be implemented without a capture that has a DOM",
    );
  }
  const fonts = evidence.capture?.fonts ?? [];
  if (!fonts.length) {
    unresolved.push("no fonts recorded in the capture: font family, weight and rendering are unverified, which pixel fidelity cannot survive");
  }
  const viewport = evidence.capture?.viewport;
  if (!viewport) unresolved.push("no viewport recorded: the clone must be captured at the same size or the comparison is meaningless");
  if (!evidence.capture?.trigger) unresolved.push("no trigger recorded: the spec's t=0 is assumed to be page load");

  for (const note of evidence.inspect?.notes ?? []) unresolved.push(note);
  for (const note of evidence.track?.notes ?? []) notes.push(note);
  for (const note of evidence.glTrack?.notes ?? []) notes.push(note);
  // Frames notes are pixel-only caveats ("no DOM", "a region is not an element"). They belong
  // in `unresolved` only when pixels are the whole evidence; next to inspect.json they would
  // claim a gap the capture does not have.
  if (!hasInspect && !evidence.lottie && !hasGl && !hasTrack) {
    for (const note of evidence.frames?.notes ?? []) unresolved.push(note);
  } else if (hasFrames && !hasInspect && !evidence.lottie && !hasGl && hasTrack) {
    unresolved.push(
      "frames were also read, but a track gave the timing: the pixel activity curve was only used to cross-check the window",
    );
  }
  for (const note of evidence.lottie?.notes ?? []) notes.push(note);

  // ---- static facts: everything a clone needs that is not on the timeline
  const staticFacts: Record<string, string | number> = {};
  const capture = evidence.capture;
  if (capture?.url) staticFacts["target.url"] = capture.url;
  if (capture?.title) staticFacts["target.title"] = capture.title;
  if (viewport) staticFacts["viewport"] = `${viewport.width}x${viewport.height}`;
  if (capture?.fps) staticFacts["fps"] = capture.fps;
  if (capture?.trigger) staticFacts["trigger"] = capture.trigger;
  if (capture?.durationMs) staticFacts["capture.durationMs"] = capture.durationMs;
  if (capture?.frameCount) staticFacts["capture.frames"] = capture.frameCount;
  if (capture?.clip) staticFacts["capture.clip"] = `${capture.clip.x},${capture.clip.y},${capture.clip.width},${capture.clip.height}`;
  if (capture?.renderer) staticFacts["capture.renderer"] = capture.renderer;
  if (capture?.libs?.length) staticFacts["capture.libs"] = capture.libs.join(", ");
  if (fonts.length) staticFacts["fonts"] = fonts.map((f) => `${f.family ?? "?"}${f.status && f.status !== "loaded" ? ` (${f.status})` : ""}`).join(", ");
  for (const [k, v] of Object.entries(evidence.inspect?.facts ?? {})) staticFacts[k] = v;
  for (const [k, v] of Object.entries(evidence.track?.facts ?? {})) staticFacts[k] = v;
  for (const [k, v] of Object.entries(evidence.glTrack?.facts ?? {})) staticFacts[k] = v;
  for (const [k, v] of Object.entries(evidence.frames?.facts ?? {})) staticFacts[k] = v;
  for (const [k, v] of Object.entries(evidence.lottie?.facts ?? {})) staticFacts[k] = v;

  // ---- total length: the last moment anything is still moving
  let totalMs = 0;
  for (const row of rows) {
    if (row.startMs === null) continue;
    totalMs = Math.max(totalMs, row.startMs + (row.durationMs ?? 0));
  }
  if (evidence.lottie?.totalMs) totalMs = Math.max(totalMs, evidence.lottie.totalMs);
  if (!totalMs && capture?.durationMs) totalMs = capture.durationMs;

  // ---- identity of the target
  const target =
    evidence.lottie?.name
      ? `lottie ${evidence.lottie.name}`
      : [capture?.url, evidence.inspect?.facts["target.selector"]].filter(Boolean).join(" ") ||
        (capture?.title ? `capture "${capture.title}"` : opts.name);

  const spec: Spec = {
    schema: SCHEMA,
    kind: "spec",
    name: opts.name,
    target,
    ...(opts.destination ? { destination: opts.destination } : {}),
    fidelity: opts.fidelity ?? FIDELITY_DEFAULT,
    viewport: viewport ?? { width: 0, height: 0 },
    fps: capture?.fps ?? evidence.lottie?.fps ?? evidence.frames?.fps ?? 25,
    trigger: capture?.trigger ?? "load",
    totalMs: roundTo(totalMs, 1),
    rows,
    staticFacts,
    additions: opts.additions,
    unresolved,
  };

  return { spec, merged };
}

// ---------------------------------------------------------------- markdown

function fmtValue(v: number | string): string {
  if (typeof v === "string") return v;
  if (Number.isInteger(v)) return String(v);
  return String(roundTo(v, 3));
}

function fmtMs(v: number | null): string {
  return v === null ? "?" : `${roundTo(v, 1)}`;
}

/** The human template: one table an implementer can work straight down. */
export function specToMarkdown(spec: Spec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.name} motion spec`);
  lines.push("");
  const vp = spec.viewport.width ? `${spec.viewport.width}x${spec.viewport.height}` : "?x?";
  lines.push(
    `Target: ${spec.target}   Viewport: ${vp}   Fps: ${spec.fps}   Trigger: ${spec.trigger}`,
  );
  lines.push(
    `Destination: ${spec.destination ?? "(not set)"}   Fidelity: ${spec.fidelity}`,
  );
  lines.push("");
  lines.push("## Timeline (t=0 is the trigger)");
  lines.push("| # | element | property | from → to | start ms | duration ms | easing | stagger | source | confidence |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  spec.rows.forEach((row, i) => {
    const stagger = row.staggerMs === null ? "–" : `${fmtMs(row.staggerMs)}`;
    const easing = row.easing ? `${row.easing}${row.easingFamily !== "unknown" ? ` (${row.easingFamily})` : ""}` : "?";
    lines.push(
      `| ${i + 1} | ${row.element} | ${row.property} | ${fmtValue(row.from)} → ${fmtValue(row.to)} | ${fmtMs(row.startMs)} | ${fmtMs(row.durationMs)} | ${easing} | ${stagger} | ${row.source} | ${row.confidence} |`,
    );
  });
  if (!spec.rows.length) lines.push("| – | (no measurable rows) | – | – | – | – | – | – | – | – |");
  lines.push("");
  lines.push("## Unresolved");
  if (spec.unresolved.length) for (const item of spec.unresolved) lines.push(`- ${item}`);
  else lines.push("- (none: every row has a measured value)");
  lines.push("");
  if (spec.fidelity === "mixed" || spec.additions.length) {
    lines.push("## Additions (mixed only)");
    if (spec.additions.length) for (const a of spec.additions) lines.push(`- ${a}`);
    else lines.push("- (none listed)");
    lines.push("");
  }
  const facts = Object.entries(spec.staticFacts);
  if (facts.length) {
    lines.push("## Static facts");
    lines.push("| fact | value |");
    lines.push("|---|---|");
    for (const [k, v] of facts) lines.push(`| ${k} | ${String(v).replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  lines.push(`Total: ${fmtMs(spec.totalMs)} ms across ${spec.rows.length} row(s).`);
  return lines.join("\n") + "\n";
}
