// refilm accept — promote a measured clone to be the new reference.
//
// Every visual-regression tool needs this and every team eventually types it by hand:
// the design changed on purpose, the clone is right, and the baseline has to move.
// Doing it with `cp` loses the provenance — what was replaced, when, and why.
//
//   refilm accept --ref <refDir> --from <cloneDir> [--reason "…"] [--dry-run]
//
// Writes:
//   <refDir>.bak-<timestamp>/     the previous reference (frames + metadata)
//   <refDir>/                     the promoted frames + capture.json/frames.json/track.json
//   <refDir>/ACCEPTED.md          an appended audit trail (time, reason, counts)

import { copyFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import {
  EXIT,
  abs,
  ensureDir,
  exists,
  listFrames,
  parseArgs,
  readJson,
  reporter,
  str,
  usageError,
  writeText,
} from "../lib.js";

export const help = `
refilm accept — make a clone the new reference, with a backup and an audit trail.

  refilm accept --ref <framesDir> --from <cloneDir> [options]

  --reason <text>   why the baseline moved (written to ACCEPTED.md)
  --dry-run         print the plan, write nothing
  --json            machine-readable result

What it does:
  1. copies the current reference to <refDir>.bak-<timestamp>/ (never overwrites it)
  2. copies the clone's frames + capture.json / frames.json / track.json over the reference
  3. appends a dated entry to <refDir>/ACCEPTED.md with the reason and the frame counts

Refuses to run when the clone has no frames, and never touches the clone.

Example:

  refilm compare --ref .refilm/hero/ref --clone .refilm/hero/clone-1 --out .refilm/hero/diff
  # the diff is what you want, the change was intentional:
  refilm accept --ref .refilm/hero/ref --from .refilm/hero/clone-1 --reason "new hero easing, approved in DS-214"
`;

const METADATA = ["capture.json", "frames.json", "track.json", "inspect.json"];

/** `record` writes <out>/frames/*.png; older captures keep PNGs in the directory itself. */
function resolveLayout(dir: string): { root: string; frames: string } {
  const nested = join(dir, "frames");
  if (exists(nested) && statSync(nested).isDirectory() && listFrames(nested).length > 0) {
    return { root: dir, frames: nested };
  }
  return { root: dir, frames: dir };
}

function copyFrames(fromFrames: string, toFrames: string): number {
  const frames = listFrames(fromFrames);
  ensureDir(toFrames);
  for (const file of frames) copyFileSync(file, join(toFrames, basename(file)));
  return frames.length;
}

/** Drop the old frames so a shorter clone cannot leave a stale tail behind. */
function clearFrames(dir: string): number {
  if (!exists(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!/\.png$/i.test(entry)) continue;
    unlinkSync(join(dir, entry));
    removed += 1;
  }
  return removed;
}

function copyMetadata(fromRoot: string, toRoot: string): string[] {
  const copied: string[] = [];
  for (const name of METADATA) {
    // record writes capture.json one level above the frames directory; clone dirs may
    // be passed either way, so look in both places.
    for (const candidate of [join(fromRoot, name), join(dirname(fromRoot), name)]) {
      if (!exists(candidate)) continue;
      const target = join(toRoot, name);
      if (exists(target) && target === candidate) break;
      copyFileSync(candidate, target);
      copied.push(name);
      break;
    }
  }
  return copied;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("accept", { json: ctx.json });
  const args = parseArgs(argv);
  const refArg = str(args.ref);
  const fromArg = str(args.from);
  const dryRun = Boolean(args["dry-run"]);

  if (!refArg || !fromArg) {
    throw usageError(
      "accept needs --ref <framesDir> --from <cloneDir>",
      "example: refilm accept --ref .refilm/hero/ref --from .refilm/hero/clone-1 --reason \"new easing, approved\"",
    );
  }

  const refDir = abs(refArg);
  const fromDir = abs(fromArg);
  if (!exists(refDir) || !statSync(refDir).isDirectory()) {
    throw usageError(`reference directory not found: ${refArg}`, "record a reference first: refilm record --url <page> --out <dir>");
  }
  if (!exists(fromDir) || !statSync(fromDir).isDirectory()) {
    throw usageError(`clone directory not found: ${fromArg}`, "clone the page first: refilm record --url <clone> --out <dir>");
  }

  const refLayout = resolveLayout(refDir);
  const fromLayout = resolveLayout(fromDir);
  const incoming = listFrames(fromLayout.frames);
  if (incoming.length === 0) {
    throw usageError(
      `no frames in ${fromArg}`,
      "pass the directory that contains the clone's PNG frames (record writes them to <out>/frames)",
    );
  }
  const outgoing = listFrames(refLayout.frames);

  const backupDir = `${refDir}.bak-${stamp()}`;
  const reason = str(args.reason) ?? "";

  const plan = {
    ref: refDir,
    from: fromDir,
    backup: backupDir,
    previousFrames: outgoing.length,
    incomingFrames: incoming.length,
    reason,
    dryRun,
  };

  if (dryRun) {
    if (ctx.json) rep.emit("accept", { ...plan, written: false });
    else {
      rep.say(`would back up ${outgoing.length} frame(s) to ${backupDir}`);
      rep.say(`would copy ${incoming.length} frame(s) from ${fromDir}`);
      rep.say("dry run — nothing written");
    }
    return EXIT.OK;
  }

  if (outgoing.length > 0) {
    // Back up the whole capture root: frames plus the metadata that describes them.
    ensureDir(join(backupDir, "frames"));
    copyFrames(refLayout.frames, join(backupDir, "frames"));
    for (const name of METADATA) {
      const source = join(refLayout.root, name);
      if (exists(source)) copyFileSync(source, join(backupDir, name));
    }
  }

  // The previous frames are safe in the backup; clear them so the new set is exactly
  // the clone's, never an old tail plus a new head.
  clearFrames(refLayout.frames);
  const copied = copyFrames(fromLayout.frames, refLayout.frames);
  const metadata = copyMetadata(fromLayout.root, refLayout.root);

  const capture = (() => {
    for (const candidate of [join(refLayout.root, "capture.json"), join(dirname(refLayout.root), "capture.json")]) {
      if (exists(candidate)) {
        try {
          return readJson(candidate);
        } catch {
          return null;
        }
      }
    }
    return null;
  })();

  const entry = [
    `## ${new Date().toISOString()}`,
    "",
    `- accepted: ${copied} frame(s) from \`${fromDir}\``,
    `- previous reference: ${outgoing.length} frame(s)` + (outgoing.length > 0 ? ` — backed up to \`${backupDir}\`` : ""),
    `- metadata carried over: ${metadata.length > 0 ? metadata.join(", ") : "none"}`,
    capture?.url ? `- page: ${capture.url}` : null,
    capture?.frameCount ? `- recorded frame count: ${capture.frameCount}` : null,
    reason ? `- reason: ${reason}` : "- reason: (none given)",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const historyPath = join(refLayout.root, "ACCEPTED.md");
  const header = exists(historyPath) ? "" : "# Accepted baselines\n\nEvery entry is one `refilm accept` run.\n\n";
  const previous = exists(historyPath) ? readFileSync(historyPath, "utf8") : "";
  writeText(historyPath, `${previous}${header}${entry}`);

  const result = { ...plan, written: true, copied, metadata, history: historyPath, frames: refLayout.frames };
  if (ctx.json) rep.emit("accept", result);
  else {
    if (outgoing.length > 0) rep.say(`backed up ${outgoing.length} frame(s) -> ${backupDir}`);
    rep.say(`accepted ${copied} frame(s) -> ${refDir}`);
    if (metadata.length > 0) rep.say(`metadata: ${metadata.join(", ")}`);
    rep.say(`audit trail: ${historyPath}`);
  }
  return EXIT.OK;
}
