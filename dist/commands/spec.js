// refilm spec — derive the motion spec from evidence, instead of hand-writing it.
//
// The output is a contract: one row per element per property, with a `source` saying which
// evidence produced the number and a `confidence` saying how much to trust it. Whatever the
// evidence could not answer is listed in `unresolved`; nothing is invented to fill a gap.
import { EXIT, abs, ensureDir, exists, ffmpeg, isDir, listFrames, num, parseArgs, probeMedia, reporter, str, usageError, writeJson, writeText, } from "../lib.js";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { deriveSpec, specToMarkdown, loadCapture, loadFrames, loadLottie } from "../spec/index.js";
export const help = `
refilm spec — derive the motion spec from a capture, a frame set, a Lottie file or a track.

  refilm spec --capture <captureDir>            read inspect.json + track.json + gl-track.json
  refilm spec --frames <framesDir|video|gif>    pixels only: a video or a numbered frame set
  refilm spec --lottie <file.json>              the file IS the spec; layers are read directly
  refilm spec --track <track.json>              add fitted rows from a track (alone, or with --capture)

  --name <name>            spec name (default: the capture directory's name)
  --out <spec.json>        where to write the spec (default: <capture>/spec.json)
  --md <spec.md>           also write the human template
  --destination <path>     where the clone will live (a component path, a stack)
  --fidelity <level>       motion (default) | pixel | mixed
  --additions "a,b"        what is being added on top, for --fidelity mixed
  --json                   machine-readable result

Evidence becomes a row's source: declared (inspect.json / Lottie keyframes), track (fitted
from track.json samples), gl-track (fitted from a GPU trace), frames (pixels only), unknown.
Anything the evidence cannot measure is listed under unresolved and its row is marked
confidence low. Nothing in this command guesses a number to fill a row.

Writes <out>/spec.json, and <md> when --md is given. Exit 0 on success, 2 on a usage error.
`;
const FIDELITIES = ["motion", "pixel", "mixed"];
export async function run(argv, ctx) {
    const rep = reporter("spec", { json: ctx.json });
    const args = parseArgs(argv);
    const captureArg = str(args.capture);
    const framesArg = str(args.frames);
    const lottieArg = str(args.lottie);
    const trackArg = str(args.track);
    if (!captureArg && !framesArg && !lottieArg && !trackArg) {
        throw usageError("spec needs evidence: --capture <dir>, --frames <dir|video|gif>, --lottie <file.json> or --track <file>", "example: refilm spec --capture .refilm/runs/hero/ref --name hero --md .refilm/runs/hero/spec.md");
    }
    const fidelityArg = str(args.fidelity);
    if (fidelityArg && !FIDELITIES.includes(fidelityArg)) {
        throw usageError(`bad --fidelity "${fidelityArg}"`, `expected one of: ${FIDELITIES.join(", ")}`);
    }
    const fidelity = fidelityArg ?? "motion";
    const additions = str(args.additions)
        ? String(str(args.additions))
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    // ---- gather evidence from every source given, in one place
    const inputs = {};
    const notes = [];
    let evidence = {};
    let captureDir = null;
    if (captureArg) {
        const dir = abs(captureArg);
        if (!isDir(dir))
            throw usageError(`--capture ${captureArg} is not a directory`, "point it at a directory written by refilm record");
        captureDir = dir;
        const loaded = loadCapture(dir, { fps: undefined });
        evidence = { ...evidence, ...loaded.evidence };
        Object.assign(inputs, loaded.inputs);
        notes.push(...loaded.notes);
        if (!Object.keys(loaded.inputs).length) {
            throw usageError(`nothing to read in ${dir}`, "a capture directory holds inspect.json, track.json, gl-track.json and/or frames/ — run refilm record first");
        }
    }
    if (framesArg) {
        const target = abs(framesArg);
        if (isDir(target)) {
            if (!listFrames(target).length) {
                throw usageError(`--frames ${framesArg} holds no PNG frames`, "pass the frames directory written by refilm record/frames");
            }
            const loaded = loadFrames(target);
            evidence = { ...evidence, ...loaded.evidence };
            Object.assign(inputs, loaded.inputs);
            notes.push(...loaded.notes);
            if (!captureDir)
                captureDir = target;
        }
        else if (exists(target)) {
            // A video or gif: the time base has to be decided before anything is measured, and a
            // gif's own frame rate is not the rate the motion was authored at, so it is extracted at
            // an explicit fps and that fps becomes the spec's.
            const fps = num(args.fps, 25);
            if (!(fps > 0))
                throw usageError(`bad --fps ${str(args.fps)}`);
            const media = probeMedia(target);
            if (!media.durationS) {
                throw usageError(`--frames ${framesArg} could not be read as a video or gif`, "check the file plays: ffmpeg -i <file>");
            }
            const tmpDir = join(tmpdir(), `refilm-spec-frames-${process.pid}`);
            ensureDir(tmpDir);
            rep.info(`cutting ${basename(target)} at ${fps} fps into ${tmpDir}`);
            ffmpeg(["-y", "-i", target, "-vf", `fps=${fps}`, join(tmpDir, "%04d.png")], { quiet: true });
            const cut = listFrames(tmpDir);
            if (!cut.length)
                throw usageError(`no frames could be extracted from ${framesArg}`);
            const loaded = loadFrames(tmpDir, { fps });
            evidence = { ...evidence, ...loaded.evidence };
            Object.assign(inputs, loaded.inputs);
            notes.push(`${cut.length} frames were extracted from ${basename(target)} at ${fps} fps: the original recording's own frame rate is not the authored rate, so timing here is accurate to one extracted frame`);
            if (!captureDir)
                captureDir = tmpDir;
        }
        else {
            throw usageError(`--frames ${framesArg} does not exist`);
        }
    }
    if (lottieArg) {
        const file = abs(lottieArg);
        if (!exists(file))
            throw usageError(`--lottie ${lottieArg} does not exist`);
        const loaded = loadLottie(file);
        evidence = { ...evidence, ...loaded.evidence };
        Object.assign(inputs, loaded.inputs);
        notes.push(...loaded.notes);
    }
    if (trackArg) {
        const file = abs(trackArg);
        if (!exists(file))
            throw usageError(`--track ${trackArg} does not exist`);
        // Extra track selectors add fitted rows for elements the capture's own track did not cover.
        const { readJson } = await import("../lib.js");
        const track = readJson(file);
        const { deriveFromTrack } = await import("../spec/track.js");
        const derivation = deriveFromTrack(track);
        const current = evidence;
        if (current.track) {
            const existing = current.track;
            const seen = new Set(existing.rows.map((r) => `${r.element}|${r.property}`));
            for (const row of derivation.rows) {
                if (seen.has(`${row.element}|${row.property}`))
                    continue;
                existing.rows.push(row);
                seen.add(`${row.element}|${row.property}`);
            }
            notes.push(`--track added ${derivation.rows.length} fitted row(s) from ${basename(file)}`);
        }
        else {
            evidence.track = derivation;
        }
        inputs["track"] = file;
    }
    const name = str(args.name) ?? (captureDir ? basename(captureDir) : lottieArg ? basename(abs(lottieArg)).replace(/\.json$/i, "") : "spec");
    const { spec, merged } = deriveSpec(evidence, {
        name,
        destination: str(args.destination),
        fidelity,
        additions,
    });
    if (!spec.rows.length) {
        rep.warn("no measurable motion found: every row needs evidence — see `unresolved` for what was missing");
    }
    for (const note of notes)
        rep.info(`note: ${note}`);
    // ---- write
    const written = [];
    const outArg = str(args.out);
    const outPath = outArg ? abs(outArg) : captureDir ? join(captureDir, "spec.json") : abs(`${name}.spec.json`);
    ensureDir(join(outPath, ".."));
    writeJson(outPath, spec);
    written.push(outPath);
    const mdArg = str(args.md);
    if (mdArg) {
        const mdPath = abs(mdArg);
        ensureDir(join(mdPath, ".."));
        writeText(mdPath, specToMarkdown(spec));
        written.push(mdPath);
    }
    // ---- human output
    rep.say(`spec ${spec.name} — ${spec.rows.length} row(s), ${spec.unresolved.length} unresolved, ${spec.totalMs} ms total`);
    if (spec.rows.length) {
        const header = ["#", "element", "property", "from → to", "start", "dur", "easing", "stagger", "source", "conf"];
        rep.say(header.join(" | "));
        spec.rows.forEach((row, i) => {
            rep.say([
                i + 1,
                row.element,
                row.property,
                `${row.from} → ${row.to}`,
                row.startMs === null ? "?" : `${row.startMs}`,
                row.durationMs === null ? "?" : `${row.durationMs}`,
                row.easing ? `${row.easing}${row.easingFamily !== "unknown" ? `/${row.easingFamily}` : ""}` : "?",
                row.staggerMs === null ? "–" : `${row.staggerMs}`,
                row.source,
                row.confidence,
            ].join(" | "));
        });
    }
    if (spec.unresolved.length) {
        rep.say("");
        rep.say(`unresolved (${spec.unresolved.length}):`);
        for (const item of spec.unresolved)
            rep.say(`  - ${item}`);
    }
    if (merged.length) {
        rep.say("");
        rep.say(`${merged.length} row(s) merged from a weaker source:`);
        for (const item of merged.slice(0, 8))
            rep.say(`  - ${item}`);
    }
    rep.say("");
    for (const path of written)
        rep.say(`wrote ${path}`);
    rep.emit("spec", {
        spec,
        written,
        inputs,
        merged,
        notes,
    });
    return EXIT.OK;
}
