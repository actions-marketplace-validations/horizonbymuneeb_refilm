#!/usr/bin/env node
// refilm — command dispatch. Every command supports --json and a documented exit code.

import { EXIT, RefilmError, VERSION, emitError, parseArgs, reporter, usageError } from "./lib.js";

const USAGE = `
refilm ${VERSION} — clone a reference animation, then prove the copy matches.

  refilm record   --url <url|file.html> --out <dir> [options]     film a page: video, frames, inspect, track
  refilm frames   --in <video|gif> --out <dir> [options]          cut a recording into numbered frames
  refilm spec     --capture <dir> | --frames <dir> | --lottie <f>  build the motion spec (the contract)
  refilm compare  --ref <dir> --clone <dir> --out <dir>           frame-by-frame diff, timing, activity
  refilm sheet    filmstrip|compare ...                           labelled contact sheets to look at
  refilm fit      --track <json> --selector <css> --prop <p>      fit a tracked curve to a named easing
  refilm gl       summary|channels|compare ...                    read or diff a GPU trace
  refilm verify   --spec <spec.json> --ref <dir> --clone <dir>    pass/fail gate over every spec row
  refilm report   --dir <run dir> [--out <file.html>]             one self-contained HTML report
  refilm install  --agent claude|codex|dsh|all                    install the agent skill
  refilm init     [--dir <project>]                               scaffold .refilm/ in a project
  refilm doctor                                                    check the environment

Common
  --json                 machine-readable result on stdout, logs on stderr
  --help                 command help
  --version              print the version

Exit codes
  0 success · 1 verification failed · 2 usage error · 3 environment problem · 4 internal error

Fidelity levels: motion (default) · pixel · mixed — see docs/fidelity.md
`;

const COMMANDS: Record<string, { module: string; summary: string }> = {
  record: { module: "./commands/record.js", summary: "film a page" },
  frames: { module: "./commands/frames.js", summary: "cut a recording into frames" },
  spec: { module: "./commands/spec.js", summary: "build the motion spec" },
  compare: { module: "./commands/compare.js", summary: "compare clone against reference" },
  sheet: { module: "./commands/sheet.js", summary: "contact sheets" },
  fit: { module: "./commands/fit.js", summary: "fit easings to a track" },
  gl: { module: "./commands/gl.js", summary: "GPU trace reader" },
  verify: { module: "./commands/verify.js", summary: "pass/fail gate" },
  report: { module: "./commands/report.js", summary: "HTML report" },
  install: { module: "./commands/install.js", summary: "install the agent skill" },
  init: { module: "./commands/init.js", summary: "scaffold a project" },
  doctor: { module: "./commands/doctor.js", summary: "check the environment" },
};

/** Aliases keep the muscle memory from other tools working. */
const ALIASES: Record<string, string> = {
  capture: "record",
  diff: "compare",
  sheets: "sheet",
  easing: "fit",
  check: "verify",
};

interface Ctx {
  json: boolean;
  argv: string[];
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE.trim());
    return EXIT.OK;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return EXIT.OK;
  }

  const resolved = ALIASES[command] ?? command;
  const entry = COMMANDS[resolved];
  if (!entry) {
    const err = usageError(
      `unknown command "${command}"`,
      `run "refilm --help" — commands: ${Object.keys(COMMANDS).join(", ")}`,
    );
    return emitError(command, err, rest.includes("--json"));
  }

  const json = rest.includes("--json");
  try {
    const mod = (await import(entry.module)) as {
      run: (argv: string[], ctx: Ctx) => Promise<number>;
      help?: string;
    };
    if (rest.includes("--help") && mod.help) {
      console.log(mod.help.trim());
      return EXIT.OK;
    }
    return await mod.run(rest, { json, argv: rest });
  } catch (err) {
    return emitError(resolved, err, json);
  }
}

// Keep the import graph honest: commands must not crash the process themselves.
process.on("unhandledRejection", (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT.INTERNAL);
});

const invokedDirectly =
  process.argv[1] && /(?:^|[/\\])(?:cli|refilm)(?:\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(EXIT.INTERNAL);
    },
  );
}

export { EXIT, RefilmError, reporter, parseArgs };
