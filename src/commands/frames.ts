// refilm frames — turn a recording (mp4/webm/mov/gif) into numbered PNG frames plus frames.json.
// This is the entry point for "I have a video of the animation, measure it": everything downstream
// (compare, sheet, spec) reads the numbered PNGs, and frames.json carries the frame rate that turns
// a frame index back into a time in seconds.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT,
  abs,
  bool,
  ensureDir,
  exists,
  ffmpeg,
  num,
  parseArgs,
  parseRect,
  parseTime,
  probeMedia,
  reporter,
  str,
  usageError,
  writeJson,
} from "../lib.js";
import { SCHEMA } from "../types.js";

export const help = `
refilm frames — cut a video or gif into numbered PNG frames.

  refilm frames --in <file.mp4|.webm|.mov|.gif> --out <dir> [options]

  --fps N          frames per second to keep, default 10 (25-30 for fast motion, 5 for long sequences)
  --start T        first moment to keep: "0:03", "3.5", "1500ms". default 0
  --end T          last moment to keep, same formats. default: end of the file
  --crop x,y,w,h   crop in source pixels
  --width W        downscale the output to this width (aspect preserved). default: source width
  --probe          print the source's duration, size and frame rate, extract nothing

Writes <out>/NNNN.png (0001.png is the first kept frame) and <out>/frames.json with
fps, count, start, sourceWidth, sourceHeight and sourceFps.

Frame i (0-based) sits at t = start + i / fps seconds of the source, so a frame index from
compare or sheet maps straight back onto the recording. Requires ffmpeg; refilm doctor checks it.
`;

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("frames", { json: ctx.json });
  const args = parseArgs(argv);
  const inputArg = str(args.in);
  if (!inputArg) {
    throw usageError("frames needs --in <video|gif>", "example: refilm frames --in reference.mp4 --out .refilm/ref/frames");
  }
  const input = abs(inputArg);
  if (!exists(input)) {
    throw usageError(`no such file: ${input}`, "check the --in path");
  }

  // ffmpeg -i is the only probe: ffprobe is not assumed to be installed anywhere.
  const src = probeMedia(input);
  const source = {
    input,
    durationS: src.durationS,
    width: src.width,
    height: src.height,
    sourceFps: src.sourceFps,
  };

  if (bool(args.probe)) {
    const info = {
      input,
      durationS: src.durationS ?? null,
      sourceWidth: src.width ?? null,
      sourceHeight: src.height ?? null,
      sourceFps: src.sourceFps ?? null,
    };
    rep.say(
      [
        `source: ${input}`,
        `duration: ${src.durationS !== undefined ? `${src.durationS.toFixed(3)}s` : "unknown"}`,
        `size: ${src.width ?? "?"}x${src.height ?? "?"}`,
        `frame rate: ${src.sourceFps !== undefined ? `${src.sourceFps} fps` : "unknown"}`,
      ].join("\n"),
    );
    rep.emit("frames", { probe: true, ...info });
    return EXIT.OK;
  }

  const outArg = str(args.out);
  if (!outArg) {
    throw usageError("frames needs --out <dir>", "the numbered frames and frames.json are written there");
  }
  const outDir = ensureDir(abs(outArg));

  const fps = num(args.fps, 10);
  if (!(fps > 0)) throw usageError(`bad --fps ${str(args.fps)}`, "use a positive number such as 10 or 25");

  const start = parseTime(args.start) ?? 0;
  if (start < 0) throw usageError(`bad --start ${str(args.start)}`, "times look like 0:03, 3.5 or 1500ms");
  const end = parseTime(args.end);
  if (end !== undefined && end <= start) {
    throw usageError(`--end (${end}s) must be after --start (${start}s)`);
  }
  if (src.durationS !== undefined && start >= src.durationS) {
    throw usageError(
      `--start ${start}s is past the end of the ${src.durationS.toFixed(2)}s source`,
      "drop --start, or probe first with --probe",
    );
  }

  const crop = parseRect(args.crop);
  const width = args.width !== undefined && !bool(args.width) ? Math.max(1, Math.round(num(args.width, 0))) : 0;

  // A stale frame from an earlier run would silently extend the set and skew every later
  // comparison, so the output folder is cleared of PNGs first.
  for (const f of readdirSync(outDir)) if (/\.png$/i.test(f)) rmSync(join(outDir, f));

  const filters = [`fps=${fps}`];
  if (crop) {
    const w = Math.round(crop.width);
    const h = Math.round(crop.height);
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    filters.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (width) filters.push(`scale=${width}:-2`);

  const ffArgs = ["-y"];
  if (start > 0) ffArgs.push("-ss", String(start));
  ffArgs.push("-i", input);
  if (end !== undefined) ffArgs.push("-t", String(end - start));
  ffArgs.push("-vf", filters.join(","), "-start_number", "1", join(outDir, "%04d.png"));

  ffmpeg(ffArgs, { quiet: true });

  const files = readdirSync(outDir)
    .filter((f) => /\.png$/i.test(f))
    .sort();
  const count = files.length;
  if (!count) {
    throw usageError(
      "ffmpeg produced no frames",
      `check --start/--end against the source duration (${src.durationS ?? "unknown"}s) and the --crop rectangle`,
    );
  }

  const meta = {
    schema: SCHEMA,
    kind: "frames" as const,
    fps,
    count,
    start,
    sourceWidth: src.width ?? null,
    sourceHeight: src.height ?? null,
    sourceFps: src.sourceFps ?? null,
    source: input,
    durationS: src.durationS ?? null,
    end: end ?? (src.durationS !== undefined ? Math.round(src.durationS * 1000) / 1000 : null),
    crop: crop ?? null,
    width: width || null,
  };
  writeJson(join(outDir, "frames.json"), meta);

  const firstOut = files[0];
  const lastOut = files[count - 1];
  rep.say(
    [
      `wrote ${count} frames at ${fps} fps to ${outDir}`,
      `source ${src.width ?? "?"}x${src.height ?? "?"}${src.sourceFps ? ` @ ${src.sourceFps} fps` : ""}` +
        `${src.durationS !== undefined ? `, ${src.durationS.toFixed(2)}s` : ""}`,
      `time range ${start.toFixed(3)}s – ${(start + count / fps).toFixed(3)}s${crop ? `, crop ${crop.width}x${crop.height} at ${crop.x},${crop.y}` : ""}`,
      `files ${firstOut} … ${lastOut}`,
    ].join("\n"),
  );
  rep.emit("frames", meta);
  return EXIT.OK;
}
