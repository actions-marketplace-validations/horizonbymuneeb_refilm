// refilm compare — the measurement core: frame-by-frame pixel diff, alignment, motion timing,
// and a per-frame activity curve, all in one report that an agent can branch on.
//
// Two numbers matter and they answer different questions:
//   * pixel mismatch  — "does the clone look the same?" (colours, layout, copy, assets)
//   * timing error    — "does the clone move at the same time and the same speed?" (start/end/peak/duration)
// A clone can pass one and fail the other; the report keeps them apart on purpose.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import {
  EXIT,
  abs,
  bool,
  ensureDir,
  exists,
  ffmpeg,
  isDir,
  listFrames,
  num,
  pad,
  parseArgs,
  parseRect,
  readJson,
  reporter,
  str,
  usageError,
  writeJson,
  writeText,
} from "../lib.js";
import { SCHEMA } from "../types.js";
import type { CompareReport, FrameDetail, MotionWindow } from "../types.js";

export const help = `
refilm compare — diff a clone's frames against the reference's, frame by frame.

  refilm compare --ref <framesDir> --clone <framesDir> --out <dir> [options]

  --auto-align           find the clone offset in ±--max-shift that best matches the reference (default on)
  --offset K             use a fixed offset instead: clone frame = reference frame + K
  --max-shift N          auto-align search range in frames, default 15
  --region x,y,w,h       compare only this rectangle, in reference pixel coordinates
  --pixel-threshold T    pixelmatch colour tolerance 0..1, default 0.1 (raise it to forgive anti-aliasing)
  --threshold T          pass if mean mismatch ≤ T, default 0.05 (fraction of pixels; 0.01 for pixel work)
  --motion-threshold T   pass if every |timing error| ≤ T seconds, default 0.08
  --fps N                frame rate (default: frames.json beside --ref, else capture.json, else 25)
  --blur R               box-blur both sets by R px before comparing (particles, grain, noise), and
                         report the blurred and the sharp mismatch
  --no-diffs             do not write diff PNGs

Writes <out>/report.json (CompareReport), <out>/report.md and <out>/diff/NNNN.png
(red = pixels that differ). Exit code 1 when the comparison fails, 0 when it passes.

The comparison is only meaningful when both captures used the same viewport, fps, trigger, duration and
clock; compare warns when the capture.json files disagree, because then it is measuring the setup.
`;

interface LoadedFrame {
  path: string;
  img: PNG;
}

/** Recursive directory walk of PNG frames, sorted so frame N is stable. */
function frameList(dir: string): string[] {
  if (!isDir(dir)) {
    throw usageError(`not a directory: ${dir}`, "pass the folder that holds the numbered PNG frames");
  }
  const files = listFrames(dir);
  if (!files.length) {
    throw usageError(`no PNG frames in ${dir}`, "check --ref / --clone, or run refilm frames first");
  }
  return files;
}

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

/** Crop into a fresh RGBA buffer (reference coordinates); a missing rect keeps the whole frame. */
function cropImage(img: PNG, rect?: { x: number; y: number; width: number; height: number }): PNG {
  if (!rect) return img;
  const w = Math.min(rect.width, img.width - rect.x);
  const h = Math.min(rect.height, img.height - rect.y);
  if (w <= 0 || h <= 0) {
    throw usageError(
      `--region ${rect.x},${rect.y},${rect.width},${rect.height} does not overlap the ${img.width}x${img.height} frames`,
    );
  }
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const from = ((rect.y + row) * img.width + rect.x) * 4;
    img.data.copy(out.data, row * w * 4, from, from + w * 4);
  }
  return out;
}

/**
 * Separable box blur (running sum), applied twice per axis so the kernel is close to gaussian.
 * Used to compare "same density and motion" instead of "same pixel": particles, grain, dither.
 */
function boxBlur(img: PNG, radius: number): PNG {
  if (radius <= 0) return img;
  const w = img.width;
  const h = img.height;
  const work = new Float32Array(img.data);
  const scratch = new Float32Array(work.length);
  const r = Math.max(1, Math.round(radius));

  const axisPass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const at = horizontal
      ? (o: number, i: number, c: number) => ((o * w + i) << 2) + c
      : (o: number, i: number, c: number) => ((i * w + o) << 2) + c;
    for (let o = 0; o < outer; o++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        let count = 0;
        for (let i = 0; i <= Math.min(r, inner - 1); i++) {
          sum += src[at(o, i, c)];
          count++;
        }
        for (let i = 0; i < inner; i++) {
          dst[at(o, i, c)] = sum / count;
          const add = i + r + 1;
          const drop = i - r;
          if (add < inner) {
            sum += src[at(o, add, c)];
            count++;
          }
          if (drop >= 0) {
            sum -= src[at(o, drop, c)];
            count--;
          }
        }
      }
    }
  };

  for (let pass = 0; pass < 2; pass++) {
    axisPass(work, scratch, true);
    axisPass(scratch, work, false);
  }
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < work.length; i++) out.data[i] = Math.max(0, Math.min(255, Math.round(work[i])));
  return out;
}

/** Fraction of pixels that differ (0..1). Writes the red diff into `diff` when supplied. */
function mismatch(a: PNG, b: PNG, pixelThreshold: number, diff?: PNG): number {
  const pixels = pixelmatch(a.data, b.data, diff?.data, a.width, a.height, {
    threshold: pixelThreshold,
    includeAA: false,
  });
  return pixels / (a.width * a.height);
}

const round = (n: number, digits = 4) => Number(n.toFixed(digits));

/**
 * Frames where the animation is actually moving.
 *
 * The window is the span of frames whose own change clears a floor above the capture's background
 * noise. The floor matters more than it looks: too high and the long tail of a slow ease-out is cut
 * off (which hides a clone that is 300ms too slow), too low and grain keeps the window open to the
 * last frame. So the floor is derived from the data: the median per-frame change is the background,
 * and a frame counts as moving at four times that. A small relative term keeps the rule meaningful
 * for very large or very small captures.
 */
function motionWindow(activity: number[], fps: number): MotionWindow {
  const n = activity.length;
  const peak = n ? activity.indexOf(Math.max(...activity)) : -1;
  const total = activity.reduce((sum, v) => sum + v, 0);
  if (!n || total <= 1e-9 || peak < 0) {
    return { first: -1, last: -1, peak: -1, startS: 0, endS: 0, durationS: 0 };
  }
  // Constant background change (grain, resampling shimmer, a blinking cursor) is present in every
  // frame, so it is estimated as the median change and the floor sits above it. The floor also
  // carries a small relative term, so the same rule reads a 4K capture and a 320px capture alike.
  const sorted = [...activity].sort((a, b) => a - b);
  const background = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const peakValue = activity[peak] ?? 0;
  const floor = Math.max(0.0005, background * 4, peakValue * 0.01);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (activity[i] >= floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) first = peak;
  if (last < first) last = first;
  return {
    first,
    last,
    peak,
    startS: round(first / fps, 3),
    endS: round(last / fps, 3),
    durationS: round((last - first + 1) / fps, 3),
  };
}

function captureMetaOf(framesDir: string): Record<string, any> | null {
  const p = join(framesDir, "..", "capture.json");
  return exists(p) ? readJson(p) : null;
}

/**
 * Settings that must match, or the diff is measuring the capture, not the work.
 * Label → CaptureMeta field; the labels are the short names a person reads in the warning.
 */
const SETUP_KEYS: Array<[string, string]> = [
  ["viewport", "viewport"],
  ["scale", "scale"],
  ["fps", "fps"],
  ["trigger", "trigger"],
  ["duration", "durationMs"],
  ["preRoll", "preRollMs"],
  ["clock", "clock"],
  ["seed", "seed"],
  ["gpu", "gpu"],
  ["rafHz", "rafHz"],
  ["rate", "rate"],
];

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("compare", { json: ctx.json });
  const args = parseArgs(argv);
  const refDir = str(args.ref) && abs(str(args.ref)!);
  const cloneDir = str(args.clone) && abs(str(args.clone)!);
  const outArg = str(args.out);
  if (!refDir || !cloneDir || !outArg) {
    throw usageError(
      "compare needs --ref <framesDir> --clone <framesDir> --out <dir>",
      "example: refilm compare --ref .refilm/ref/frames --clone .refilm/clone/frames --out .refilm/diff",
    );
  }
  const outDir = ensureDir(abs(outArg));

  const refFiles = frameList(refDir);
  let cloneFiles = frameList(cloneDir);

  // ---- frame rate: explicit flag, then the frame metadata, then the capture metadata
  const fpsFromJson = (dir: string): number | undefined => {
    for (const p of [join(dir, "frames.json"), join(dir, "..", "capture.json")]) {
      if (!exists(p)) continue;
      const meta = readJson(p);
      if (Number.isFinite(Number(meta?.fps)) && Number(meta.fps) > 0) return Number(meta.fps);
    }
    return undefined;
  };
  const fps = num(args.fps, fpsFromJson(refDir) ?? fpsFromJson(cloneDir) ?? 25);
  if (!(fps > 0)) throw usageError(`bad --fps ${str(args.fps)}`);

  const pixelThreshold = num(args["pixel-threshold"], 0.1);
  const threshold = num(args.threshold, 0.05);
  const motionThreshold = num(args["motion-threshold"], 0.08);
  const region = parseRect(args.region);
  const blurR = Math.max(0, num(args.blur, 0));
  const writeDiffs = !bool(args["no-diffs"]);

  // ---- setup guard: compare the capture metadata before trusting a single pixel
  const setupWarnings: string[] = [];
  const capRef = captureMetaOf(refDir);
  const capClone = captureMetaOf(cloneDir);
  if (capRef && capClone) {
    for (const [label, field] of SETUP_KEYS) {
      const a = JSON.stringify(capRef[field] ?? null);
      const b = JSON.stringify(capClone[field] ?? null);
      if (a !== b) {
        const msg = `${label}: reference ${a}, clone ${b}`;
        setupWarnings.push(msg);
        rep.warn(msg);
      }
    }
  }

  // ---- decode, crop, optionally blur
  const refImgs: LoadedFrame[] = refFiles.map((p) => ({ path: p, img: cropImage(readPng(p), region) }));
  let cloneImgs: LoadedFrame[] = cloneFiles.map((p) => ({ path: p, img: cropImage(readPng(p), region) }));

  const size: [number, number] = [refImgs[0].img.width, refImgs[0].img.height];
  let tmpScaled: string | null = null;
  if (cloneImgs[0].img.width !== size[0] || cloneImgs[0].img.height !== size[1]) {
    // A clone captured at another size is still comparable, but only after scaling: never let a
    // dimension mismatch turn into a "100% different" number.
    const note =
      `clone frames were ${cloneImgs[0].img.width}x${cloneImgs[0].img.height} but the reference is ${size[0]}x${size[1]}; ` +
      `the clone was rescaled to compare, so edge pixels are resampled`;
    rep.info(note);
    setupWarnings.push(note);
    tmpScaled = mkdtempSync(join(tmpdir(), "refilm-compare-"));
    const scaledPaths = cloneFiles.map((p, i) => {
      const dest = join(tmpScaled!, `${pad(i)}.png`);
      ffmpeg(["-y", "-i", p, "-vf", `scale=${size[0]}:${size[1]}:flags=lanczos`, dest], { quiet: true });
      return dest;
    });
    cloneImgs = scaledPaths.map((p) => ({ path: p, img: cropImage(readPng(p), region) }));
  }

  try {
    const refSharp = refImgs.map((f) => f.img);
    const cloneSharp = cloneImgs.map((f) => f.img);
    const refCmp = blurR ? refSharp.map((img) => boxBlur(img, blurR)) : refSharp;
    const cloneCmp = blurR ? cloneSharp.map((img) => boxBlur(img, blurR)) : cloneSharp;

    // ---- activity: how much changed since the previous frame, per side. Both sides use the same
    // images that were compared, so --blur removes grain from the timing curve too; otherwise a
    // noisy clone would look like it "changes" on every frame and its motion window would never end.
    const rawActivity = (imgs: PNG[]): number[] => {
      const out: number[] = [0];
      for (let i = 1; i < imgs.length; i++) out.push(mismatch(imgs[i - 1], imgs[i], pixelThreshold));
      return out;
    };
    const refRaw = rawActivity(refCmp);
    const cloneRaw = rawActivity(cloneCmp);
    const normalise = (raw: number[]): number[] => {
      const top = Math.max(...raw, 0);
      return top > 0 ? raw.map((v) => v / top) : raw.map(() => 0);
    };
    const refActivity = normalise(refRaw);
    const cloneActivity = normalise(cloneRaw);

    // ---- alignment: which clone frame lines up with reference frame 0?
    let offset = 0;
    const autoAlign = args["auto-align"] === undefined ? true : bool(args["auto-align"]);
    if (args.offset !== undefined) {
      offset = num(args.offset, 0);
    } else if (autoAlign) {
      const maxShift = Math.max(0, num(args["max-shift"], 15));
      const probe = Math.min(12, refCmp.length);
      let best = Number.POSITIVE_INFINITY;
      for (let k = -maxShift; k <= maxShift; k++) {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < probe; i++) {
          const j = i + k;
          if (j < 0 || j >= cloneCmp.length) continue;
          sum += mismatch(refCmp[i], cloneCmp[j], pixelThreshold);
          n++;
        }
        if (n >= Math.min(4, probe) && sum / n < best) {
          best = sum / n;
          offset = k;
        }
      }
    }

    // ---- per-frame diff
    const diffDir = writeDiffs ? ensureDir(join(outDir, "diff")) : null;
    if (diffDir) {
      for (const f of readdirSync(diffDir)) if (/\.png$/i.test(f)) rmSync(join(diffDir, f));
    }
    const frameDetails: FrameDetail[] = [];
    let blurredSum = 0;
    for (let i = 0; i < refCmp.length; i++) {
      const j = i + offset;
      if (j < 0 || j >= cloneCmp.length) continue;
      // frameDetails always carries the sharp number: that is the honest per-frame truth, and
      // --blur only changes which average decides the verdict.
      const diff = diffDir ? new PNG({ width: size[0], height: size[1] }) : undefined;
      const sharp = mismatch(refSharp[i], cloneSharp[j], pixelThreshold, diff);
      frameDetails.push({
        index: i,
        t: round(i / fps, 3),
        mismatch: round(sharp),
        diffPixels: Math.round(sharp * size[0] * size[1]),
      });
      if (blurR) blurredSum += mismatch(refCmp[i], cloneCmp[j], pixelThreshold);
      if (diff && diffDir) writeFileSync(join(diffDir, `${pad(i)}.png`), PNG.sync.write(diff));
    }

    if (!frameDetails.length) {
      throw usageError(
        `no frame pairs at offset ${offset} (reference ${refCmp.length} frames, clone ${cloneCmp.length})`,
        "widen --max-shift, drop --offset, or re-capture the clone over the same time window",
      );
    }

    const meanMismatch = frameDetails.reduce((s, f) => s + f.mismatch, 0) / frameDetails.length;
    const worstFrames = [...frameDetails].sort((a, b) => b.mismatch - a.mismatch).slice(0, 5);
    // The blurred average is what a particle/noise-heavy capture should be judged on; the sharp
    // number stays in the report so nothing is hidden behind a blur radius.
    const blurredMeanMismatch = blurR ? round(blurredSum / frameDetails.length) : undefined;
    const judgedMismatch = blurredMeanMismatch ?? round(meanMismatch);

    // ---- motion timing, both sides expressed in reference frame indices
    const refWindow = motionWindow(refRaw, fps);
    const cloneWindow = motionWindow(cloneRaw, fps);
    const toRef = (cloneFrame: number) => (cloneFrame < 0 ? -1 : cloneFrame - offset);
    const cloneWindowRef: MotionWindow = {
      ...cloneWindow,
      first: toRef(cloneWindow.first),
      last: toRef(cloneWindow.last),
      peak: toRef(cloneWindow.peak),
      startS: cloneWindow.first < 0 ? 0 : round((cloneWindow.first - offset) / fps, 3),
      endS: cloneWindow.last < 0 ? 0 : round((cloneWindow.last - offset) / fps, 3),
    };
    const timingError = {
      start: round(cloneWindowRef.startS - refWindow.startS, 3),
      end: round(cloneWindowRef.endS - refWindow.endS, 3),
      duration: round(cloneWindow.durationS - refWindow.durationS, 3),
      peak: round((cloneWindowRef.peak - refWindow.peak) / fps, 3),
    };

    const activity = refActivity.map((ref, i) => {
      const j = i + offset;
      return { t: round(i / fps, 3), ref: round(ref, 3), clone: j >= 0 && j < cloneActivity.length ? round(cloneActivity[j], 3) : 0 };
    });

    // ---- verdict
    const failures: string[] = [];
    const pixelPass = judgedMismatch <= threshold;
    if (!pixelPass) {
      failures.push(
        `pixel mismatch ${(judgedMismatch * 100).toFixed(2)}%${blurredMeanMismatch !== undefined ? ` (blurred, sharp ${(meanMismatch * 100).toFixed(2)}%)` : ""} ` +
          `is above the ${(threshold * 100).toFixed(2)}% limit — worst frame #${worstFrames[0].index} at ${worstFrames[0].t}s (${(worstFrames[0].mismatch * 100).toFixed(1)}%)`,
      );
    }
    const timingChecks: Array<[keyof typeof timingError, string]> = [
      ["start", "motion start"],
      ["end", "motion end"],
      ["duration", "visible duration"],
      ["peak", "peak speed"],
    ];
    for (const [key, label] of timingChecks) {
      const value = timingError[key];
      if (Math.abs(value) > motionThreshold) {
        failures.push(
          `${label} is off by ${value > 0 ? "+" : ""}${value.toFixed(3)}s (limit ±${motionThreshold}s) — ` +
            `${value > 0 ? "the clone moves later/longer" : "the clone moves earlier/shorter"} than the reference`,
        );
      }
    }
    const pass = pixelPass && failures.length === 0;

    const report: CompareReport = {
      schema: SCHEMA,
      kind: "compare",
      fps,
      size,
      offset,
      threshold,
      motionThreshold,
      pixelThreshold,
      setupWarnings,
      frames: refCmp.length,
      compared: frameDetails.length,
      meanMismatch: round(meanMismatch),
      maxMismatch: worstFrames[0].mismatch,
      ...(blurredMeanMismatch !== undefined ? { blurredMeanMismatch } : {}),
      worstFrames,
      motion: { ref: refWindow, clone: cloneWindowRef },
      timingError,
      activity,
      pass,
      failures,
      frameDetails,
    };

    writeJson(join(outDir, "report.json"), report);

    // ---- human report: the activity chart is the part a person reads first, because the shape of
    // the curve tells you whether the easing is wrong before any number does.
    const bars = (v: number) => {
      const n = Math.round(Math.max(0, Math.min(1, v)) * 34);
      return n > 0 ? "█".repeat(n) : "·";
    };
    const lines: string[] = [
      `# compare — reference vs clone`,
      ``,
      `- frames: ${frameDetails.length} compared of ${refCmp.length} reference frames at ${fps} fps, ${size[0]}x${size[1]}` +
        `${region ? `, region ${region.x},${region.y},${region.width},${region.height}` : ""}, clone offset ${offset}${autoAlign && args.offset === undefined ? " (auto-aligned)" : ""}`,
      `- mean mismatch${blurR ? ` (blurred ${blurR}px)` : ""}: **${(judgedMismatch * 100).toFixed(2)}%** (limit ${(threshold * 100).toFixed(2)}%) → ${pixelPass ? "PASS" : "FAIL"}` +
        `${blurredMeanMismatch !== undefined ? `; sharp ${(meanMismatch * 100).toFixed(2)}%` : ""}`,
      `- worst frames: ${worstFrames.map((f) => `#${f.index} ${(f.mismatch * 100).toFixed(1)}% @${f.t}s`).join(", ")}`,
      `- motion window — reference ${refWindow.first}–${refWindow.last} (${refWindow.durationS.toFixed(2)}s, peak #${refWindow.peak}); ` +
        `clone ${cloneWindowRef.first}–${cloneWindowRef.last} (${cloneWindow.durationS.toFixed(2)}s, peak #${cloneWindowRef.peak})`,
      `- timing error (clone − reference): start ${timingError.start.toFixed(3)}s, end ${timingError.end.toFixed(3)}s, ` +
        `duration ${timingError.duration.toFixed(3)}s, peak ${timingError.peak.toFixed(3)}s (limit ±${motionThreshold}s)`,
      ``,
    ];
    if (setupWarnings.length) {
      lines.push(`## setup warnings — these two captures are not comparable`, ``);
      for (const w of setupWarnings) lines.push(`- ${w}`);
      lines.push(``, `Re-capture both sides with identical settings before trusting the numbers below.`, ``);
    }
    lines.push(
      `## activity per frame (change since the previous frame, each side normalised to its own peak)`,
      ``,
      "```",
      `frame    t(s)   reference                          clone`,
      ...activity.map(
        (a) =>
          `${String(a.ref === 0 && a.clone === 0 ? "-" : "")}${String(Math.round(a.t * fps)).padStart(4)} ${a.t.toFixed(2).padStart(7)}   ${bars(a.ref).padEnd(34)} ${bars(a.clone)}`,
      ),
      "```",
      ``,
      `## verdict: ${pass ? "PASS" : "FAIL"}`,
      ``,
      ...(failures.length ? failures.map((f) => `- ${f}`) : ["- every criterion passed"]),
      ``,
      `Diff images: ${diffDir ?? "(skipped with --no-diffs)"} — red pixels differ. ` +
        `Read them with refilm sheet compare --ref ${refDir} --clone ${cloneDir} --diff ${join(outDir, "diff")}.`,
      ``,
      offset !== 0
        ? `Note: auto-align chose offset ${offset} by best pixel agreement, so a constant lead/lag of up to ` +
          `${Math.abs(offset)}/${fps}s between the two recordings is absorbed into the alignment and does not ` +
          `show up as a timing error. Pass --offset 0 to measure absolute timing.`
        : `Note: auto-align found no capture shift (offset 0), so the timing numbers are absolute.`,
    );
    writeText(join(outDir, "report.md"), lines.join("\n") + "\n");

    rep.say(lines.join("\n"));
    rep.emit("compare", report);
    return pass ? EXIT.OK : EXIT.VERIFY_FAILED;
  } finally {
    if (tmpScaled) rmSync(tmpScaled, { recursive: true, force: true });
  }
}
