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
import { EXIT, abs, bool, ensureDir, exists, ffmpeg, isDir, listFrames, num, pad, parseArgs, parseRect, readJson, reporter, str, usageError, writeJson, writeText, } from "../lib.js";
import { SCHEMA } from "../types.js";
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
/** Recursive directory walk of PNG frames, sorted so frame N is stable. */
function frameList(dir) {
    if (!isDir(dir)) {
        throw usageError(`not a directory: ${dir}`, "pass the folder that holds the numbered PNG frames");
    }
    const files = listFrames(dir);
    if (!files.length) {
        throw usageError(`no PNG frames in ${dir}`, "check --ref / --clone, or run refilm frames first");
    }
    return files;
}
function readPng(path) {
    return PNG.sync.read(readFileSync(path));
}
/** Crop into a fresh RGBA buffer (reference coordinates); a missing rect keeps the whole frame. */
function cropImage(img, rect) {
    if (!rect)
        return img;
    const w = Math.min(rect.width, img.width - rect.x);
    const h = Math.min(rect.height, img.height - rect.y);
    if (w <= 0 || h <= 0) {
        throw usageError(`--region ${rect.x},${rect.y},${rect.width},${rect.height} does not overlap the ${img.width}x${img.height} frames`);
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
function boxBlur(img, radius) {
    if (radius <= 0)
        return img;
    const w = img.width;
    const h = img.height;
    const work = new Float32Array(img.data);
    const scratch = new Float32Array(work.length);
    const r = Math.max(1, Math.round(radius));
    const axisPass = (src, dst, horizontal) => {
        const outer = horizontal ? h : w;
        const inner = horizontal ? w : h;
        const at = horizontal
            ? (o, i, c) => ((o * w + i) << 2) + c
            : (o, i, c) => ((i * w + o) << 2) + c;
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
    for (let i = 0; i < work.length; i++)
        out.data[i] = Math.max(0, Math.min(255, Math.round(work[i])));
    return out;
}
/** Fraction of pixels that differ (0..1). Writes the red diff into `diff` when supplied. */
function mismatch(a, b, pixelThreshold, diff) {
    const pixels = pixelmatch(a.data, b.data, diff?.data, a.width, a.height, {
        threshold: pixelThreshold,
        includeAA: false,
    });
    return pixels / (a.width * a.height);
}
const round = (n, digits = 4) => Number(n.toFixed(digits));
/**
 * Frames where something visibly changes. The floor is relative to the busiest transition on that
 * side (5%) with a small absolute minimum, so a slow fade is not cut off at the tail and a still
 * scene does not report phantom motion.
 */
function motionWindow(activity, fps) {
    const peak = activity.length ? activity.indexOf(Math.max(...activity)) : -1;
    const top = peak >= 0 ? activity[peak] : 0;
    const floor = Math.max(0.0005, top * 0.05);
    let first = -1;
    let last = -1;
    if (top > floor) {
        activity.forEach((v, i) => {
            if (v > floor) {
                if (first < 0)
                    first = i;
                last = i;
            }
        });
    }
    const durationS = first < 0 ? 0 : round((last - first + 1) / fps, 3);
    return {
        first,
        last,
        peak,
        startS: first < 0 ? 0 : round(first / fps, 3),
        endS: first < 0 ? 0 : round(last / fps, 3),
        durationS,
    };
}
function captureMetaOf(framesDir) {
    const p = join(framesDir, "..", "capture.json");
    return exists(p) ? readJson(p) : null;
}
/** Settings that must match, or the diff is measuring the capture, not the work. */
const SETUP_KEYS = ["viewport", "scale", "fps", "trigger", "duration", "preRoll", "clock", "seed", "gpu", "rafHz", "rate"];
export async function run(argv, ctx) {
    const rep = reporter("compare", { json: ctx.json });
    const args = parseArgs(argv);
    const refDir = str(args.ref) && abs(str(args.ref));
    const cloneDir = str(args.clone) && abs(str(args.clone));
    const outArg = str(args.out);
    if (!refDir || !cloneDir || !outArg) {
        throw usageError("compare needs --ref <framesDir> --clone <framesDir> --out <dir>", "example: refilm compare --ref .refilm/ref/frames --clone .refilm/clone/frames --out .refilm/diff");
    }
    const outDir = ensureDir(abs(outArg));
    const refFiles = frameList(refDir);
    let cloneFiles = frameList(cloneDir);
    // ---- frame rate: explicit flag, then the frame metadata, then the capture metadata
    const fpsFromJson = (dir) => {
        for (const p of [join(dir, "frames.json"), join(dir, "..", "capture.json")]) {
            if (!exists(p))
                continue;
            const meta = readJson(p);
            if (Number.isFinite(Number(meta?.fps)) && Number(meta.fps) > 0)
                return Number(meta.fps);
        }
        return undefined;
    };
    const fps = num(args.fps, fpsFromJson(refDir) ?? fpsFromJson(cloneDir) ?? 25);
    if (!(fps > 0))
        throw usageError(`bad --fps ${str(args.fps)}`);
    const pixelThreshold = num(args["pixel-threshold"], 0.1);
    const threshold = num(args.threshold, 0.05);
    const motionThreshold = num(args["motion-threshold"], 0.08);
    const region = parseRect(args.region);
    const blurR = Math.max(0, num(args.blur, 0));
    const writeDiffs = !bool(args["no-diffs"]);
    // ---- setup guard: compare the capture metadata before trusting a single pixel
    const setupWarnings = [];
    const capRef = captureMetaOf(refDir);
    const capClone = captureMetaOf(cloneDir);
    if (capRef && capClone) {
        for (const key of SETUP_KEYS) {
            const a = JSON.stringify(capRef[key] ?? null);
            const b = JSON.stringify(capClone[key] ?? null);
            if (a !== b) {
                const msg = `${key}: reference ${a}, clone ${b}`;
                setupWarnings.push(msg);
                rep.warn(msg);
            }
        }
    }
    // ---- decode, crop, optionally blur
    const refImgs = refFiles.map((p) => ({ path: p, img: cropImage(readPng(p), region) }));
    let cloneImgs = cloneFiles.map((p) => ({ path: p, img: cropImage(readPng(p), region) }));
    const size = [refImgs[0].img.width, refImgs[0].img.height];
    let tmpScaled = null;
    if (cloneImgs[0].img.width !== size[0] || cloneImgs[0].img.height !== size[1]) {
        // A clone captured at another size is still comparable, but only after scaling: never let a
        // dimension mismatch turn into a "100% different" number.
        rep.info(`clone frames are ${cloneImgs[0].img.width}x${cloneImgs[0].img.height}, reference ${size[0]}x${size[1]}: rescaling clone frames`);
        tmpScaled = mkdtempSync(join(tmpdir(), "refilm-compare-"));
        const scaledPaths = cloneFiles.map((p, i) => {
            const dest = join(tmpScaled, `${pad(i)}.png`);
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
        // ---- activity: how much changed since the previous frame, per side. Timing is read from the
        // sharp frames even with --blur, because blur hides the moment a change starts.
        const rawActivity = (imgs) => {
            const out = [0];
            for (let i = 1; i < imgs.length; i++)
                out.push(mismatch(imgs[i - 1], imgs[i], pixelThreshold));
            return out;
        };
        const refRaw = rawActivity(refSharp);
        const cloneRaw = rawActivity(cloneSharp);
        const normalise = (raw) => {
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
        }
        else if (autoAlign) {
            const maxShift = Math.max(0, num(args["max-shift"], 15));
            const probe = Math.min(12, refCmp.length);
            let best = Number.POSITIVE_INFINITY;
            for (let k = -maxShift; k <= maxShift; k++) {
                let sum = 0;
                let n = 0;
                for (let i = 0; i < probe; i++) {
                    const j = i + k;
                    if (j < 0 || j >= cloneCmp.length)
                        continue;
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
            for (const f of readdirSync(diffDir))
                if (/\.png$/i.test(f))
                    rmSync(join(diffDir, f));
        }
        const frameDetails = [];
        let blurredSum = 0;
        for (let i = 0; i < refCmp.length; i++) {
            const j = i + offset;
            if (j < 0 || j >= cloneCmp.length)
                continue;
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
            if (blurR)
                blurredSum += mismatch(refCmp[i], cloneCmp[j], pixelThreshold);
            if (diff && diffDir)
                writeFileSync(join(diffDir, `${pad(i)}.png`), PNG.sync.write(diff));
        }
        if (!frameDetails.length) {
            throw usageError(`no frame pairs at offset ${offset} (reference ${refCmp.length} frames, clone ${cloneCmp.length})`, "widen --max-shift, drop --offset, or re-capture the clone over the same time window");
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
        const toRef = (cloneFrame) => (cloneFrame < 0 ? -1 : cloneFrame - offset);
        const cloneWindowRef = {
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
        const failures = [];
        const pixelPass = judgedMismatch <= threshold;
        if (!pixelPass) {
            failures.push(`pixel mismatch ${(judgedMismatch * 100).toFixed(2)}%${blurredMeanMismatch !== undefined ? ` (blurred, sharp ${(meanMismatch * 100).toFixed(2)}%)` : ""} ` +
                `is above the ${(threshold * 100).toFixed(2)}% limit — worst frame #${worstFrames[0].index} at ${worstFrames[0].t}s (${(worstFrames[0].mismatch * 100).toFixed(1)}%)`);
        }
        const timingChecks = [
            ["start", "motion start"],
            ["end", "motion end"],
            ["duration", "visible duration"],
            ["peak", "peak speed"],
        ];
        for (const [key, label] of timingChecks) {
            const value = timingError[key];
            if (Math.abs(value) > motionThreshold) {
                failures.push(`${label} is off by ${value > 0 ? "+" : ""}${value.toFixed(3)}s (limit ±${motionThreshold}s) — ` +
                    `${value > 0 ? "the clone moves later/longer" : "the clone moves earlier/shorter"} than the reference`);
            }
        }
        const pass = pixelPass && failures.length === 0;
        const report = {
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
        const bars = (v) => {
            const n = Math.round(Math.max(0, Math.min(1, v)) * 34);
            return n > 0 ? "█".repeat(n) : "·";
        };
        const lines = [
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
            for (const w of setupWarnings)
                lines.push(`- ${w}`);
            lines.push(``, `Re-capture both sides with identical settings before trusting the numbers below.`, ``);
        }
        lines.push(`## activity per frame (change since the previous frame, each side normalised to its own peak)`, ``, "```", `frame    t(s)   reference                          clone`, ...activity.map((a) => `${String(a.ref === 0 && a.clone === 0 ? "-" : "")}${String(Math.round(a.t * fps)).padStart(4)} ${a.t.toFixed(2).padStart(7)}   ${bars(a.ref).padEnd(34)} ${bars(a.clone)}`), "```", ``, `## verdict: ${pass ? "PASS" : "FAIL"}`, ``, ...(failures.length ? failures.map((f) => `- ${f}`) : ["- every criterion passed"]), ``, `Diff images: ${diffDir ?? "(skipped with --no-diffs)"} — red pixels differ. ` +
            `Read them with refilm sheet compare --ref ${refDir} --clone ${cloneDir} --diff ${join(outDir, "diff")}.`);
        writeText(join(outDir, "report.md"), lines.join("\n") + "\n");
        rep.say(lines.join("\n"));
        rep.emit("compare", report);
        return pass ? EXIT.OK : EXIT.VERIFY_FAILED;
    }
    finally {
        if (tmpScaled)
            rmSync(tmpScaled, { recursive: true, force: true });
    }
}
