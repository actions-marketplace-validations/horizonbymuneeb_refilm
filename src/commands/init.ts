// refilm init — scaffold a project so captures, specs and reports have a home.
//
// Idempotent by design: running it twice must not duplicate a .gitignore line, rewrite a config
// the user edited, or fail. An init that has to be undone is worse than no init.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT,
  abs,
  bool,
  ensureDir,
  isDir,
  parseArgs,
  reporter,
  str,
  writeJson,
} from "../lib.js";

export const help = `
refilm init — scaffold .refilm/ in a project.

  refilm init [--dir <project>] [--force] [--json]

  --dir DIR    project directory to scaffold, default the current directory
  --force      rewrite config.json even if it already exists
  --json       machine-readable result

Creates
  .refilm/config.json   default viewport, fps, fidelity and run directory
  .refilm/runs/         one directory per clone attempt
and adds .refilm/ to .gitignore when a .gitignore exists and does not list it yet.

Safe to run more than once: existing files are left alone unless --force is given.
`;

const DEFAULT_CONFIG = {
  schema: 1,
  viewport: { width: 1440, height: 900 },
  fps: 25,
  fidelity: "motion",
  clock: "real",
  durationMs: 2000,
  runsDir: ".refilm/runs",
  note: "Edited by hand. refilm reads it as defaults; flags on the command line always win.",
};

const GITIGNORE_ENTRY = ".refilm/";

/** True when a .gitignore already ignores the run directory in any of its spellings. */
function ignoresRefilm(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => {
      const bare = line.replace(/^\/+/, "").replace(/\/+$/, "");
      return bare === ".refilm" || line === GITIGNORE_ENTRY;
    });
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const a = parseArgs(argv);
  const out = reporter("init", { json: ctx.json });
  const dir = abs(str(a.dir) ?? ".");
  const force = bool(a.force);

  if (!isDir(dir)) {
    out.say(`refilm init: ${dir} is not a directory`);
    return EXIT.USAGE;
  }

  const created: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];

  const root = join(dir, ".refilm");
  const runs = join(root, "runs");
  const configPath = join(root, "config.json");

  if (!existsSync(root)) {
    ensureDir(root);
    created.push(".refilm/");
  }
  if (!existsSync(runs)) {
    ensureDir(runs);
    created.push(".refilm/runs/");
  }

  if (!existsSync(configPath) || force) {
    writeJson(configPath, DEFAULT_CONFIG);
    created.push(".refilm/config.json");
  } else {
    kept.push(".refilm/config.json");
  }

  // .gitignore: append only when a .gitignore exists and does not already cover .refilm/.
  const gitignorePath = join(dir, ".gitignore");
  let gitignore: "added" | "present" | "absent" | "created" = "absent";
  if (existsSync(gitignorePath)) {
    const text = readFileSync(gitignorePath, "utf8");
    if (ignoresRefilm(text)) {
      gitignore = "present";
    } else {
      const suffix = text.endsWith("\n") || text.length === 0 ? "" : "\n";
      writeFileSync(gitignorePath, `${text}${suffix}${GITIGNORE_ENTRY}\n`);
      gitignore = "added";
      created.push(".gitignore (+.refilm/)");
    }
  } else {
    // No .gitignore at all: create one, so a first capture never lands in a commit by accident.
    writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`);
    gitignore = "created";
    created.push(".gitignore");
  }

  for (const line of created) out.say(`  created  ${line}`);
  for (const line of kept) out.say(`  kept     ${line}`);
  if (gitignore === "present") out.say(`  kept     .gitignore already ignores ${GITIGNORE_ENTRY}`);

  if (created.length === 0) out.say("nothing to do — .refilm/ is already set up");

  out.say("");
  out.say("next:");
  out.say("  refilm record --url <url> --out .refilm/runs/<name>/ref --selector \"<section>\" --trigger load");
  out.say("  refilm spec   --capture .refilm/runs/<name>/ref --out .refilm/runs/<name>");

  out.emit("init", {
    dir,
    root,
    runsDir: runs,
    configPath,
    configWritten: created.includes(".refilm/config.json"),
    gitignore,
    created,
    kept,
    warnings,
  });
  return EXIT.OK;
}
