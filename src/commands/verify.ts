// refilm verify — the gate. Every spec row becomes a check; the exit code is the answer.
//
// The comparison itself is `compare`'s job (one diff implementation in this tool, not two), so
// this command runs it in-process and reads its report. What is added here is the part a diff
// cannot know: which rows the spec promised, and whether the clone met each one.
//
// A check that cannot be measured is `skip` with a reason, never `pass`. A green verify that
// quietly skipped half the spec would be the most expensive bug this tool could ship.

import { EXIT, abs, ensureDir, exists, isDir, num, parseArgs, parseRect, readJson, reporter, str, usageError, writeJson, writeText } from "../lib.js";
import { join } from "node:path";
import type { CaptureMeta, CompareReport, Fidelity, Spec, SpecRow, VerifyCheck, VerifyResult } from "../types.js";
import { SCHEMA } from "../types.js";
import { familyOf, curveDistanceToSeries, sampleCurve } from "../spec/easing.js";
import { channelSeries, deriveFromTrack, trackChannelFits, type ChannelFit } from "../spec/track.js";
import { fitSeries, type FitResult, type Series } from "../commands/fit.js";

export const help = `
refilm verify — the gate: evaluate every row of a spec against a clone.

  refilm verify --spec <spec.json> --ref <captureDir|framesDir> --clone <captureDir|framesDir>
                [--out <dir>] [--fidelity motion|pixel|mixed] [--region x,y,w,h] [--json]

  --spec <file>          the spec to hold the clone to (from refilm spec)
  --ref <dir>            the reference capture (frames/ + optional track.json)
  --clone <dir>          the clone capture, made the same way
  --out <dir>            write verify.json and verify.md here
  --fidelity <level>     motion | pixel | mixed (default: the spec's own fidelity)
  --region x,y,w,h       for mixed: the cloned region, in reference pixel coordinates
  --threshold T          mean-mismatch limit for the pixel gate (default 0.02)
  --json                 machine-readable result

Checks, per fidelity:
  motion  start/end/duration within 80 ms · easing family equal or curve within 5% of travel ·
          stagger gaps within 40 ms · travel within 10% · nothing moving that should be still
  pixel   mean mismatch ≤ 2%, no frame above 5%, rest frames ≤ 0.5%, fonts identical
  mixed   the cloned region passes one of the above; additions are not compared

Exit codes: 0 every check passed or skipped · 1 any check failed · 2 usage · 3 environment.
A skipped check is not a pass: it names what was missing.
`;

const TIMING_LIMIT_MS = 80;
const STAGGER_LIMIT_MS = 40;
const TRAVEL_LIMIT = 0.1;
const EASING_LIMIT = 0.05;
const PIXEL_MEAN_LIMIT = 0.02;
const PIXEL_FRAME_LIMIT = 0.05;
const PIXEL_REST_LIMIT = 0.005;

const FIDELITIES: Fidelity[] = ["motion", "pixel", "mixed"];

interface DirEvidence {
  dir: string;
  frames: string | null;
  track: { kind?: string; samples?: unknown[]; selectors?: string[] } | null;
  capture: Partial<CaptureMeta> | null;
}

/** A capture directory, a frames directory, or a directory holding frames/ — all three work. */
function readDir(dir: string, label: string): DirEvidence {
  if (!isDir(dir)) throw usageError(`--${label} ${dir} is not a directory`);
  const nested = join(dir, "frames");
  const frames = isDir(nested) ? nested : dir;
  const hasFrames = isDir(frames) && (require_fs_readdir(frames).some((f) => /\.png$/i.test(f)));
  const trackPath = join(dir, "track.json");
  const capPath = [join(dir, "capture.json"), join(dir, "frames.json")].find((p) => exists(p));
  return {
    dir,
    frames: hasFrames ? frames : null,
    track: exists(trackPath) ? readJson(trackPath) : null,
    capture: capPath ? readJson<Partial<CaptureMeta>>(capPath) : null,
  };
}

// A tiny local readdir so this module does not pull a second filesystem abstraction in.
import { readdirSync } from "node:fs";
function require_fs_readdir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function captureFps(ev: DirEvidence, fallback: number): number {
  const n = Number(ev.capture?.fps);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Runs `compare` in-process and returns its report, captured from its own JSON output. */
async function runCompare(opts: {
  ref: string;
  clone: string;
  out: string;
  fps: number;
  region?: { x: number; y: number; width: number; height: number };
  threshold: number;
}): Promise<CompareReport> {
  const compareModule = (await import("./compare.js")) as {
    run: (argv: string[], ctx: { json: boolean }) => Promise<number>;
  };
  const argv = [
    "--ref",
    opts.ref,
    "--clone",
    opts.clone,
    "--out",
    opts.out,
    "--fps",
    String(opts.fps),
    "--threshold",
    String(opts.threshold),
  ];
  if (opts.region) argv.push("--region", `${opts.region.x},${opts.region.y},${opts.region.width},${opts.region.height}`);

  // compare prints its result through the reporter; take that output instead of scraping disk
  // so verify works even when --out is a temporary directory.
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    captured.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  };
  try {
    await compareModule.run(argv, { json: true });
  } finally {
    console.log = originalLog;
  }

  const text = captured.join("\n");
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const envelope = JSON.parse(text.slice(start)) as { data?: CompareReport };
      if (envelope?.data?.kind === "compare") return envelope.data;
    } catch {
      // fall through to the file
    }
  }
  const fromDisk = join(opts.out, "report.json");
  if (exists(fromDisk)) {
    const report = readJson<CompareReport>(fromDisk);
    if (report?.kind === "compare") return report;
  }
  throw usageError(
    "the comparison produced no report",
    "run `refilm compare --ref <dir> --clone <dir> --out <dir>` directly to see why",
  );
}

/** The channel a spec row names, as a track property. */
function trackPropFor(row: SpecRow): string | null {
  const p = row.property;
  const known = ["opacity", "translateX", "translateY", "scale", "scaleX", "scaleY", "rotate", "x", "y", "w", "h"];
  return known.includes(p) ? p : null;
}

/** Layout channels are consequences of a transform or of layout, not authored properties. */
const DERIVED_CHANNELS = new Set(["x", "y", "w", "h"]);

function classesOf(selectorish: string): Set<string> {
  const out = new Set<string>();
  for (const m of selectorish.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

/**
 * Does a track selector describe the element a spec row names?
 *
 * The spec says `div#card-1.card` (from inspect.json) and the track says `.card` (from
 * `--track`). They are the same element when every class in the selector is on the row's
 * element; an id or a different class set means a different element.
 */
function sameElement(specElement: string, trackSelector: string): boolean {
  if (specElement === trackSelector) return true;
  const specClasses = classesOf(specElement);
  const trackClasses = classesOf(trackSelector);
  if (!trackClasses.size) return false;
  for (const c of trackClasses) if (!specClasses.has(c)) return false;
  // an id in the selector must appear in the spec element
  const id = /#([A-Za-z0-9_-]+)/.exec(trackSelector)?.[1];
  if (id && !specElement.includes(`#${id}`)) return false;
  return true;
}

interface RowMeasurement {
  ref: { series: Series; fit: FitResult; fitStartMs: number; fitDurationMs: number } | null;
  clone: { series: Series; fit: FitResult; fitStartMs: number; fitDurationMs: number } | null;
  element: string | null;
  prop: string | null;
  /** Set when the row cannot be measured, with the reason and the fix. */
  why?: string;
}

/**
 * Pairs a spec row with the same element in both tracks.
 *
 * The in-page tracker samples the FIRST element matching each selector, so a track with one
 * selector (`.card`) holds one element, not all three siblings. Rows for the other siblings are
 * unmeasurable from that track: reporting them as passing would be the exact bug this gate
 * exists to prevent, so they are skipped with the selector that would measure them.
 */
function measureRow(row: SpecRow, refFits: ChannelFit[], cloneFits: ChannelFit[]): RowMeasurement {
  const prop = trackPropFor(row);
  if (!prop) {
    return { ref: null, clone: null, element: null, prop: null, why: `${row.property} is not a channel the tracker samples (it reads opacity, transform and the box)` };
  }

  const indexMatch = /\[(\d+)\]$/.exec(row.element);
  const index = indexMatch ? Number(indexMatch[1]) : 0;

  const candidatesFor = (fits: ChannelFit[]) =>
    fits.filter((f) => f.property === prop && sameElement(row.element, f.element));

  const refCandidates = candidatesFor(refFits);
  const cloneCandidates = candidatesFor(cloneFits);

  if (!refCandidates.length) {
    const tracked = [...new Set(refFits.map((f) => f.element))].join(", ") || "(none)";
    return {
      ref: null,
      clone: null,
      element: null,
      prop,
      why: `the reference track has no ${prop} series for ${row.element} (tracked: ${tracked})`,
    };
  }

  // One tracked element standing in for N siblings: only the first sibling is measurable.
  const siblingCount = Math.max(refCandidates.length, cloneCandidates.length, 1);
  if (refCandidates.length < index + 1) {
    const selector = refCandidates[0]?.element ?? ".unknown";
    const nth = `:nth-child(${index + 1})`;
    return {
      ref: null,
      clone: null,
      element: null,
      prop,
      why: `the track holds ${refCandidates.length} element(s) for ${selector}, so sibling ${index} was never sampled — track it explicitly with --track "${selector}${nth}"`,
    };
  }

  const wrap = (f: ChannelFit) => ({
    series: f.series,
    fit: f.fit,
    fitStartMs: f.startMs,
    fitDurationMs: f.fit.bestFits[0]?.durationMs ?? f.fit.visibleDurationMs,
  });

  const ref = refCandidates[index];
  const clone = cloneCandidates[index] ?? cloneCandidates[0];
  if (!clone) {
    return { ref: wrap(ref), clone: null, element: ref.element, prop, why: `the clone's track has no ${prop} series for ${ref.element}` };
  }
  void siblingCount;
  return { ref: wrap(ref), clone: wrap(clone), element: ref.element, prop };
}

function check(
  id: string,
  label: string,
  status: VerifyCheck["status"],
  measured: number | string | null,
  limit: number | string | null,
  detail?: string,
): VerifyCheck {
  return { id, label, status, measured, limit, ...(detail ? { detail } : {}) };
}

function skip(id: string, label: string, why: string): VerifyCheck {
  return { id, label, status: "skip", measured: null, limit: null, detail: why };
}

/** The per-row motion checks: timing, easing, travel. */
function rowChecks(row: SpecRow, m: RowMeasurement, fps: number): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const label = `${row.element} ${row.property}`;

  if (!m.ref || !m.clone) {
    const why =
      m.why ??
      `no ${!m.ref ? "reference" : "clone"} data for this row: capture with --track "<selector>" to measure it`;
    return [skip(`${row.id}.timing`, `${label} timing`, why)];
  }

  // ---- timing
  const refStart = m.ref.fitStartMs;
  const cloneStart = m.clone.fitStartMs;
  const startErr = Math.round(cloneStart - refStart);
  checks.push(
    check(
      `${row.id}.start`,
      `${label} start`,
      Math.abs(startErr) <= TIMING_LIMIT_MS ? "pass" : "fail",
      `${startErr >= 0 ? "+" : ""}${startErr} ms`,
      `±${TIMING_LIMIT_MS} ms`,
      `reference ${Math.round(refStart)} ms, clone ${Math.round(cloneStart)} ms`,
    ),
  );

  const refEnd = m.ref.fitStartMs + m.ref.fitDurationMs;
  const cloneEnd = m.clone.fitStartMs + m.clone.fitDurationMs;
  const endErr = Math.round(cloneEnd - refEnd);
  checks.push(
    check(
      `${row.id}.end`,
      `${label} end`,
      Math.abs(endErr) <= TIMING_LIMIT_MS ? "pass" : "fail",
      `${endErr >= 0 ? "+" : ""}${endErr} ms`,
      `±${TIMING_LIMIT_MS} ms`,
      `reference ${Math.round(refEnd)} ms, clone ${Math.round(cloneEnd)} ms`,
    ),
  );

  const durErr = Math.round(m.clone.fitDurationMs - m.ref.fitDurationMs);
  checks.push(
    check(
      `${row.id}.duration`,
      `${label} duration`,
      Math.abs(durErr) <= TIMING_LIMIT_MS ? "pass" : "fail",
      `${durErr >= 0 ? "+" : ""}${durErr} ms`,
      `±${TIMING_LIMIT_MS} ms`,
      `reference ${Math.round(m.ref.fitDurationMs)} ms, clone ${Math.round(m.clone.fitDurationMs)} ms`,
    ),
  );

  // ---- easing: same family, or a curve that stays within 5% of the travel
  const refBest = m.ref.fit.bestFits[0];
  const cloneBest = m.clone.fit.bestFits[0];
  if (!refBest || !cloneBest) {
    checks.push(skip(`${row.id}.easing`, `${label} easing`, "no easing curve could be fitted on one side"));
  } else {
    const sameFamily = refBest.family === cloneBest.family;
    const refCurve = sampleCurve(refBest.name === "linear" ? "linear" : refBest.name, 40) ?? sampleCurve(cssFromBezier(refBest.bezier), 40);
    const distance = refCurve ? curveDistanceToSeries(refCurve, m.clone.series, 40) : null;
    if (sameFamily) {
      checks.push(
        check(`${row.id}.easing`, `${label} easing`, "pass", `${refBest.name} → ${cloneBest.name}`, `family ${refBest.family}`, "same easing family"),
      );
    } else if (distance !== null && distance <= EASING_LIMIT && !FAMILY_CONFLICT(refBest.family, cloneBest.family)) {
      checks.push(
        check(
          `${row.id}.easing`,
          `${label} easing`,
          "pass",
          `${(distance * 100).toFixed(1)}% of travel`,
          `≤${EASING_LIMIT * 100}% of travel`,
          `families differ (${refBest.family} vs ${cloneBest.family}) but the curves agree`,
        ),
      );
    } else {
      const conflict = FAMILY_CONFLICT(refBest.family, cloneBest.family);
      checks.push(
        check(
          `${row.id}.easing`,
          `${label} easing`,
          "fail",
          conflict
            ? `${refBest.family} → ${cloneBest.family}`
            : distance === null
              ? `${refBest.family} → ${cloneBest.family}`
              : `${(distance * 100).toFixed(1)}% of travel`,
          `family ${refBest.family}, or ≤${EASING_LIMIT * 100}% of travel`,
          FAMILY_CONFLICT(refBest.family, cloneBest.family)
            ? `the clone is ${cloneBest.family} where the reference is ${refBest.family}: that is a different kind of motion, not a near miss (curve distance ${distance === null ? "unmeasurable" : `${(distance * 100).toFixed(1)}%`})`
            : `the clone's curve is ${cloneBest.name} where the reference is ${refBest.name}`,
        ),
      );
    }
  }

  // ---- travel distance and direction
  const refTravel = m.ref.fit.change;
  const cloneTravel = m.clone.fit.change;
  const travelErr = Math.abs(refTravel) > 1e-9 ? Math.abs(cloneTravel - refTravel) / Math.abs(refTravel) : 0;
  const sameDirection = Math.sign(refTravel) === Math.sign(cloneTravel) || Math.abs(refTravel) < 1e-9;
  checks.push(
    check(
      `${row.id}.travel`,
      `${label} travel`,
      sameDirection && travelErr <= TRAVEL_LIMIT ? "pass" : "fail",
      `${(travelErr * 100).toFixed(1)}%${sameDirection ? "" : " (opposite direction)"}`,
      `≤${TRAVEL_LIMIT * 100}% of ${round(refTravel)}`,
      `reference ${round(refTravel)}, clone ${round(cloneTravel)}`,
    ),
  );

  // ---- fps resolution note: two frames at 25 fps is the limit, and it is worth naming
  if (fps < 20) {
    checks.push(skip(`${row.id}.resolution`, `${label} timing resolution`, `${fps} fps resolves timing to ${Math.round(1000 / fps)} ms, coarser than the ±${TIMING_LIMIT_MS} ms limit`));
  }

  return checks;
}

/**
 * A linear curve against an ease-out is a different *kind* of motion, not a near miss: the
 * measured distance can land inside 5% purely because a 900 ms ease-out is nearly straight in
 * its first half. Family conflicts that are this structural must not be forgiven by the
 * numeric escape hatch.
 */
function FAMILY_CONFLICT(a: string, b: string): boolean {
  if (a === b) return false;
  const straight = (f: string) => f === "linear";
  const curved = (f: string) => f === "ease-in" || f === "ease-out" || f === "ease-in-out" || f === "spring";
  // linear vs any curved family is a structural difference
  return (straight(a) && curved(b)) || (curved(a) && straight(b));
}

function cssFromBezier(bezier: [number, number, number, number] | null): string | null {
  if (!bezier) return null;
  return `cubic-bezier(${bezier.join(", ")})`;
}

function round(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/** Stagger: within a group of siblings, the gaps must match within 40 ms. */
function staggerChecks(spec: Spec, refFits: ChannelFit[], cloneFits: ChannelFit[]): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const groups = new Map<string, SpecRow[]>();
  for (const row of spec.rows) {
    const tag = row.element.replace(/\[\d+\]$/, "");
    const key = `${tag}|${row.property}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    const expected: number[] = [];
    for (let i = 1; i < sorted.length; i++) expected.push((sorted[i].startMs ?? 0) - (sorted[i - 1].startMs ?? 0));

    // measure the clone's own gaps from its track, on the same property
    const prop = trackPropFor(sorted[0]);
    const prop2 = prop ? cloneFits.filter((f) => f.property === prop) : [];
    const cloneStarts = prop2.map((f) => f.startMs).sort((a, b) => a - b);
    if (cloneStarts.length < sorted.length) {
      checks.push(
        skip(
          `${sorted[0].id}.stagger`,
          `${key.split("|")[0]} stagger`,
          `the clone's track has ${cloneStarts.length} start time(s) for ${sorted.length} siblings: track every sibling to measure the stagger`,
        ),
      );
      continue;
    }
    const measured: number[] = [];
    for (let i = 1; i < sorted.length; i++) measured.push(cloneStarts[i] - cloneStarts[i - 1]);
    const errors = expected.map((e, i) => Math.round(measured[i] - e));
    const worst = errors.reduce((m, e) => (Math.abs(e) > Math.abs(m) ? e : m), 0);
    checks.push(
      check(
        `${sorted[0].id}.stagger`,
        `${key.split("|")[0]} stagger`,
        Math.abs(worst) <= STAGGER_LIMIT_MS ? "pass" : "fail",
        `${errors.map((e) => `${e >= 0 ? "+" : ""}${e}`).join(", ")} ms`,
        `±${STAGGER_LIMIT_MS} ms`,
        `spec gaps ${expected.map((e) => Math.round(e)).join(", ")} ms; clone gaps ${measured.map((m) => Math.round(m)).join(", ")} ms`,
      ),
    );
  }
  return checks;
}

/**
 * Anything moving in the clone that the spec does not describe.
 *
 * Two things are deliberately not "extra motion": layout channels (x/y/w/h), which move because
 * a transform moved them, and a selector that stands in for a sibling row — the tracker samples
 * one element per selector, so the same channel can be legitimately shared by three rows.
 */
function stillnessChecks(spec: Spec, cloneFits: ChannelFit[]): VerifyCheck[] {
  const specProps = new Set(spec.rows.map((r) => `${r.property}`));
  const unexpected = cloneFits.filter((f) => {
    if (DERIVED_CHANNELS.has(f.property)) return false;
    if (specProps.has(f.property)) return false;
    return true;
  });
  if (!unexpected.length) {
    return [
      check(
        "stillness",
        "nothing extra is moving",
        "pass",
        0,
        0,
        "every moving property in the clone is one the spec describes",
      ),
    ];
  }
  const described = unexpected.slice(0, 6).map((f) => `${f.element}.${f.property}`);
  return [
    check(
      "stillness",
      "nothing extra is moving",
      "fail",
      unexpected.length,
      0,
      `the clone animates ${described.join(", ")}${unexpected.length > 6 ? `, and ${unexpected.length - 6} more` : ""}, which the spec does not describe`,
    ),
  ];
}

/** Pixel checks from the compare report, plus the font comparison the spec recorded. */
function pixelChecks(report: CompareReport, ref: DirEvidence, clone: DirEvidence, fidelity: Fidelity): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const mean = report.meanMismatch;
  checks.push(
    check(
      "pixel.mean",
      "mean mismatch",
      mean <= PIXEL_MEAN_LIMIT ? "pass" : "fail",
      `${(mean * 100).toFixed(2)}%`,
      `≤${(PIXEL_MEAN_LIMIT * 100).toFixed(0)}%`,
      `${report.compared}/${report.frames} frames compared at ${report.fps} fps`,
    ),
  );

  // Seed from the first compared frame, not a sentinel: with a perfect clone every mismatch is
  // 0 and a strict ">" comparison would never replace a placeholder, reporting "frame -1".
  const maxFrame =
    report.frameDetails.length > 0
      ? report.frameDetails.reduce((worst, f) => (f.mismatch > worst.mismatch ? f : worst), report.frameDetails[0])
      : null;
  if (!maxFrame) {
    checks.push(skip("pixel.maxFrame", "worst frame", "no frames were compared (the two frame sets do not overlap)"));
  } else {
    checks.push(
      check(
        "pixel.maxFrame",
        "worst frame",
        maxFrame.mismatch <= PIXEL_FRAME_LIMIT ? "pass" : "fail",
        `${(maxFrame.mismatch * 100).toFixed(2)}% @ frame ${maxFrame.index} (${maxFrame.t}s)`,
        `≤${(PIXEL_FRAME_LIMIT * 100).toFixed(0)}%`,
        "no single frame may exceed the limit, however good the average is",
      ),
    );
  }

  // at rest: after the reference has finished moving, nothing should still differ
  const restFrom = report.motion.ref.endS;
  const restFrames = report.frameDetails.filter((f) => f.t >= restFrom);
  if (!restFrames.length) {
    checks.push(skip("pixel.rest", "rest frames", `no frames after the reference's last motion (${restFrom}s)`));
  } else {
    const worstRest = restFrames.reduce((worst, f) => (f.mismatch > worst.mismatch ? f : worst), restFrames[0]);
    checks.push(
      check(
        "pixel.rest",
        "rest frames",
        worstRest.mismatch <= PIXEL_REST_LIMIT ? "pass" : "fail",
        `${(worstRest.mismatch * 100).toFixed(2)}% @ frame ${worstRest.index}`,
        `≤${(PIXEL_REST_LIMIT * 100).toFixed(1)}%`,
        `${restFrames.length} frame(s) after the reference settles`,
      ),
    );
  }

  // fonts: the spec records the reference's fonts; a clone on a different stack is a pixel fail
  const refFonts = (ref.capture?.fonts ?? []) as Array<{ family?: string; weight?: string; style?: string }>;
  const cloneFonts = (clone.capture?.fonts ?? []) as Array<{ family?: string; weight?: string; style?: string }>;
  const key = (f: { family?: string; weight?: string; style?: string }) => `${f.family ?? "?"}/${f.weight ?? "?"}/${f.style ?? "?"}`;
  if (!refFonts.length) {
    checks.push(skip("pixel.fonts", "fonts identical", "the reference capture recorded no fonts, so font identity cannot be checked"));
  } else if (!cloneFonts.length) {
    checks.push(skip("pixel.fonts", "fonts identical", "the clone capture recorded no fonts (inspect.json missing) — re-capture it with refilm record"));
  } else {
    const refSet = new Set(refFonts.map(key));
    const cloneSet = new Set(cloneFonts.map(key));
    const missing = [...refSet].filter((f) => !cloneSet.has(f));
    const extra = [...cloneSet].filter((f) => !refSet.has(f));
    checks.push(
      check(
        "pixel.fonts",
        "fonts identical",
        missing.length === 0 && extra.length === 0 ? "pass" : "fail",
        missing.length + extra.length,
        0,
        missing.length || extra.length ? `missing in clone: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}` : `${refSet.size} font(s) match`,
      ),
    );
  }

  if (fidelity === "mixed") {
    checks.push(
      skip(
        "pixel.additions",
        "additions excluded",
        "mixed fidelity compares only --region; additions outside it are not part of the pixel gate",
      ),
    );
  }

  return checks;
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("verify", { json: ctx.json });
  const args = parseArgs(argv);

  const specArg = str(args.spec);
  const refArg = str(args.ref);
  const cloneArg = str(args.clone);
  if (!specArg || !refArg || !cloneArg) {
    throw usageError(
      "verify needs --spec <spec.json> --ref <dir> --clone <dir>",
      "example: refilm verify --spec .refilm/runs/hero/spec.json --ref .refilm/runs/hero/ref --clone .refilm/runs/hero/clone-1",
    );
  }
  const specPath = abs(specArg);
  if (!exists(specPath)) throw usageError(`--spec ${specArg} does not exist`, "run refilm spec first");
  const spec = readJson<Spec>(specPath);
  if (spec.kind !== "spec") throw usageError(`${specArg} is not a spec (kind: ${String(spec.kind)})`, "pass the file written by refilm spec");

  const fidelityArg = str(args.fidelity);
  if (fidelityArg && !(FIDELITIES as string[]).includes(fidelityArg)) {
    throw usageError(`bad --fidelity "${fidelityArg}"`, `expected one of: ${FIDELITIES.join(", ")}`);
  }
  const fidelity: Fidelity = (fidelityArg as Fidelity) ?? spec.fidelity ?? "motion";
  const region = parseRect(args.region);
  const threshold = num(args.threshold, PIXEL_MEAN_LIMIT);

  const ref = readDir(abs(refArg), "ref");
  const clone = readDir(abs(cloneArg), "clone");
  if (!ref.frames) throw usageError(`--ref ${refArg} holds no PNG frames`, "pass the capture directory or its frames/ directory");
  if (!clone.frames) throw usageError(`--clone ${cloneArg} holds no PNG frames`, "pass the clone capture directory or its frames/ directory");

  const fps = captureFps(ref, spec.fps || 25);

  // ---- the diff itself
  const outDir = str(args.out) ? ensureDir(abs(str(args.out)!)) : null;
  const compareOut = outDir ? join(outDir, "compare") : join(abs(".refilm-tmp"), "verify-compare");
  ensureDir(compareOut);
  const report = await runCompare({
    ref: ref.frames,
    clone: clone.frames,
    out: compareOut,
    fps,
    region,
    threshold: fidelity === "pixel" ? Math.min(threshold, PIXEL_MEAN_LIMIT) : threshold,
  });

  for (const warning of report.setupWarnings) rep.warn(`setup: ${warning}`);

  // ---- evidence for the per-row checks
  const refFits = ref.track && (ref.track.kind === "track" || Array.isArray(ref.track.samples)) ? trackChannelFits(ref.track as never) : [];
  const cloneFits = clone.track && (clone.track.kind === "track" || Array.isArray(clone.track.samples)) ? trackChannelFits(clone.track as never) : [];

  const checks: VerifyCheck[] = [];

  // ---- motion checks
  if (fidelity === "motion" || fidelity === "mixed") {
    if (!refFits.length || !cloneFits.length) {
      const missing = !refFits.length && !cloneFits.length ? "neither capture has a track.json" : !refFits.length ? "the reference has no track.json" : "the clone has no track.json";
      checks.push(
        skip(
          "motion.rows",
          "per-row motion checks",
          `${missing}: start, duration, easing and travel cannot be measured per element, so only the pixel and motion-window checks apply`,
        ),
      );
    } else {
      for (const row of spec.rows) {
        const measurement = measureRow(row, refFits, cloneFits);
        checks.push(...rowChecks(row, measurement, fps));
      }
      checks.push(...staggerChecks(spec, refFits, cloneFits));
      checks.push(...stillnessChecks(spec, cloneFits));
    }

    // the global motion window from compare: the independent cross-check on the timing
    const timing = report.timingError;
    const worstTiming = Math.max(Math.abs(timing.start), Math.abs(timing.end), Math.abs(timing.duration));
    checks.push(
      check(
        "motion.window",
        "motion window (whole frame)",
        worstTiming <= TIMING_LIMIT_MS / 1000 ? "pass" : "fail",
        `start ${timing.start >= 0 ? "+" : ""}${timing.start.toFixed(3)}s, end ${timing.end >= 0 ? "+" : ""}${timing.end.toFixed(3)}s, duration ${timing.duration >= 0 ? "+" : ""}${timing.duration.toFixed(3)}s`,
        `±${TIMING_LIMIT_MS / 1000}s`,
        "measured from the pixel activity curve, independent of any track",
      ),
    );
  }

  // ---- pixel checks
  if (fidelity === "pixel" || fidelity === "mixed") {
    checks.push(...pixelChecks(report, ref, clone, fidelity));
  }

  // ---- fidelity narrower than the spec is a skip with a reason, never a silent pass
  if (fidelity !== spec.fidelity) {
    checks.push(
      skip(
        "fidelity.narrowed",
        "fidelity narrower than the spec",
        `the spec asks for ${spec.fidelity} but this run checked ${fidelity}: the checks for ${spec.fidelity} were not evaluated`,
      ),
    );
  }

  const counts = {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    skip: checks.filter((c) => c.status === "skip").length,
  };
  const pass = counts.fail === 0;

  const artifacts: Record<string, string> = {
    compareReport: join(compareOut, "report.json"),
    compareMarkdown: join(compareOut, "report.md"),
  };
  if (exists(join(compareOut, "diff"))) artifacts.diffs = join(compareOut, "diff");

  const result: VerifyResult = {
    schema: SCHEMA,
    kind: "verify",
    fidelity,
    pass,
    checks,
    counts,
    artifacts,
  };

  // ---- output
  rep.say(`verify ${spec.name} — ${fidelity} fidelity: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`);
  for (const c of checks) {
    const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP";
    const measured = c.measured === null ? "" : ` — ${c.measured}`;
    const limit = c.limit === null ? "" : ` (limit ${c.limit})`;
    rep.say(`  ${mark} ${c.label}${measured}${limit}`);
    if (c.detail && c.status !== "pass") rep.say(`       ${c.detail}`);
  }
  rep.say("");
  rep.say(pass ? `result: PASS (exit 0)` : `result: FAIL — ${counts.fail} check(s) failed (exit 1)`);
  if (counts.skip) rep.say(`note: ${counts.skip} check(s) skipped; a skip is not a pass — see the reasons above`);

  if (outDir) {
    writeJson(join(outDir, "verify.json"), result);
    writeText(join(outDir, "verify.md"), verifyMarkdown(spec, result));
    rep.say(`wrote ${join(outDir, "verify.json")} and ${join(outDir, "verify.md")}`);
    result.artifacts.verifyJson = join(outDir, "verify.json");
    result.artifacts.verifyMarkdown = join(outDir, "verify.md");
  }

  rep.emit("verify", result);
  return pass ? EXIT.OK : EXIT.VERIFY_FAILED;
}

function verifyMarkdown(spec: Spec, result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`# verify: ${spec.name}`);
  lines.push("");
  lines.push(`Fidelity: ${result.fidelity}   Result: **${result.pass ? "PASS" : "FAIL"}**   Checks: ${result.counts.pass} pass, ${result.counts.fail} fail, ${result.counts.skip} skip`);
  lines.push("");
  lines.push("| check | status | measured | limit | detail |");
  lines.push("|---|---|---|---|---|");
  for (const c of result.checks) {
    lines.push(
      `| ${c.label} | ${c.status} | ${c.measured === null ? "–" : String(c.measured)} | ${c.limit === null ? "–" : String(c.limit)} | ${(c.detail ?? "").replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  const skipped = result.checks.filter((c) => c.status === "skip");
  if (skipped.length) {
    lines.push("## Skipped");
    for (const c of skipped) lines.push(`- ${c.label}: ${c.detail ?? "no reason recorded"}`);
    lines.push("");
  }
  if (result.artifacts.compareReport) lines.push(`Compare report: ${result.artifacts.compareReport}`);
  return lines.join("\n") + "\n";
}
