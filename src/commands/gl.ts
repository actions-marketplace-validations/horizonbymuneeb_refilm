// refilm gl — read a GPU trace written by `refilm record --gl`.
//
//   summary   what the scene is made of: canvases and their settings, shaders, programs, draw order,
//             textures, and every value that changes during the capture
//   channels  the animated values, or one of them as a series to fit an easing to
//   compare   reference vs clone: canvas settings, draw structure, and every animated channel

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, RefilmError, abs, exists, num, parseArgs, reporter, str, usageError, readJson } from "../lib.js";
import {
  compareTraces,
  readGlTrack,
  seriesFor,
  summarizeTrace,
  type Channel,
  type ChannelKind,
} from "../engine/gl.js";

export const help = `
refilm gl — read a GPU trace written by "refilm record --gl".

  refilm gl summary  <captureDir>
      canvases and their renderer settings, three.js scene graph and mixers, shader programs with their
      attribute layouts, draw order per frame, textures, and every animated channel.

  refilm gl channels <captureDir> [--grep RE] [--series KEY]
      list channels (kind, range, when they change), or print one channel as [[t, value], …] for fitting.

  refilm gl compare  --ref <dir> --clone <dir> [--grep RE] [--map "a=b,c=d"] [--timing 80] [--out report.md]
      canvas attributes, renderer settings and draw structure side by side, then every animated channel:
      same kind, start and end within --timing ms, mean value error ≤ 5 % of the reference range.
      Exit code is 1 when any channel fails.

  --json   machine-readable result on stdout
`;

const KINDS: ChannelKind[] = ["clock", "transition", "there-and-back", "oscillation", "steps", "constant"];

function requireTrace(dir: string): string {
  if (!exists(join(dir, "gl", "gl.json"))) {
    throw usageError(
      `no GPU trace in ${dir}`,
      "capture with --gl first: refilm record --url <page> --out <dir> --gl",
    );
  }
  return dir;
}

function channelsTable(track: ReturnType<typeof readGlTrack>, grep: RegExp | null): string[] {
  const channels = track.channels as Record<string, Channel>;
  const rows: string[] = [];
  for (const [key, channel] of Object.entries(channels)) {
    if (grep && !grep.test(key)) continue;
    const kind = KINDS.includes(channel.kind) ? channel.kind : channel.kind;
    const rate = channel.kind === "clock" && channel.perSecond !== undefined ? `  +${channel.perSecond}/s` : "";
    const period = channel.periodMs !== undefined ? `  period ${channel.periodMs} ms` : "";
    rows.push(`${key}\t${kind}\t${channel.min} → ${channel.max}\t${channel.firstChangeMs}–${channel.lastChangeMs} ms${rate}${period}`);
  }
  return rows.sort((a, b) => {
    const order = ["transition", "there-and-back", "oscillation", "steps", "clock"];
    const kindOf = (line: string) => order.indexOf(line.split("\t")[1]);
    return kindOf(a) - kindOf(b) || a.localeCompare(b);
  });
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const out = reporter("gl", { json: ctx.json });
  const a = parseArgs(argv);
  const sub = a._[0];

  if (a.help || !sub) {
    console.log(help.trim());
    return a.help ? EXIT.OK : EXIT.USAGE;
  }

  if (sub === "summary") {
    const dir = requireTrace(abs(str(a._[1]) ?? str(a.in) ?? ""));
    const markdown = summarizeTrace(dir);
    const track = readGlTrack(dir);
    const channels = track.channels as Record<string, Channel>;
    const animated = Object.entries(channels);
    const byKind: Record<string, number> = {};
    for (const [, channel] of animated) byKind[channel.kind] = (byKind[channel.kind] ?? 0) + 1;

    out.say(markdown);
    out.emit("gl", {
      dir,
      markdown,
      channels: animated.length,
      byKind,
      samples: track.samples.length,
      programs: (readJson<any>(join(dir, "gl", "gl.json")).programs ?? []).length,
    });
    return EXIT.OK;
  }

  if (sub === "channels") {
    const dir = requireTrace(abs(str(a._[1]) ?? str(a.in) ?? ""));
    const track = readGlTrack(dir);
    const series = str(a.series);
    if (series !== undefined) {
      const points = seriesFor(track, series);
      out.say(JSON.stringify(points));
      out.emit("gl", { dir, series, points, samples: points.length });
      return EXIT.OK;
    }
    const grep = str(a.grep);
    const rows = channelsTable(track, grep ? new RegExp(grep, "i") : null);
    out.say(rows.join("\n"));
    out.emit("gl", {
      dir,
      channels: rows.length,
      rows: rows.map((line) => {
        const [key, kind, range, window] = line.split("\t");
        return { key, kind, range, window };
      }),
    });
    return EXIT.OK;
  }

  if (sub === "compare") {
    const ref = str(a.ref);
    const clone = str(a.clone);
    if (!ref || !clone) {
      throw usageError("gl compare needs --ref <dir> and --clone <dir>", "both directories must come from --gl captures");
    }
    const refDir = requireTrace(abs(ref));
    const cloneDir = requireTrace(abs(clone));
    const map: Record<string, string> = {};
    for (const pair of String(str(a.map) ?? "").split(",").filter(Boolean)) {
      const [from, to] = pair.split("=");
      if (from && to) map[from.trim()] = to.trim();
    }
    const timing = num(a.timing, 80);
    const grepRaw = str(a.grep);
    const result = compareTraces(refDir, cloneDir, {
      map,
      timing,
      grep: grepRaw ? new RegExp(grepRaw) : null,
    });
    const reportPath = str(a.out);
    if (reportPath) writeFileSync(abs(reportPath), result.markdown + "\n");

    out.say(result.markdown);
    out.emit("gl", {
      ref: refDir,
      clone: cloneDir,
      rows: result.rows,
      failures: result.failures,
      pass: result.failures === 0,
      timing,
      report: reportPath ? abs(reportPath) : null,
    });
    return result.failures === 0 ? EXIT.OK : EXIT.VERIFY_FAILED;
  }

  throw usageError(`unknown gl subcommand "${sub}"`, "summary | channels | compare");
}

export { RefilmError };
