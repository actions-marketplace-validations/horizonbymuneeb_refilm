// refilm watch — the dev loop, closed.
//
// You edit the clone (or its dev server restarts). This re-records it, re-compares it
// against the reference and prints one measured line per iteration. It never stops on
// a failing comparison: the point is to watch the number come down.
//
//   refilm watch --url <url|file.html> --ref <dir> [--out <dir>] [--spec <spec.json>]
//                  [--interval 3] [--once] [-- record flags...]
//
// Change detection:
//   * file:// or a local path  — the file's mtime
//   * http(s)://               — ETag / Last-Modified / Content-Length on a HEAD request
//   * --interval is the floor, so a busy file cannot spin the recorder.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  EXIT,
  abs,
  bool,
  ensureDir,
  num,
  parseArgs,
  reporter,
  str,
  usageError,
} from "../lib.js";

export const help = `
refilm watch — re-record and re-compare whenever the clone changes.

  refilm watch --url <url|file.html> --ref <framesDir> [options] [-- record flags...]

  --out <dir>        run directory for the clone and compare output (default .refilm/watch)
  --spec <spec.json>  gate with \`refilm verify\` instead of \`refilm compare\`
  --interval <sec>   minimum seconds between runs, default 3
  --threshold T      pass if mean mismatch ≤ T (forwarded to compare), default 0.05
  --motion-threshold T   pass if every |timing error| ≤ T (forwarded to compare), default 0.08
  --once             run a single iteration and exit
  --json             one JSON line per iteration on stdout

Everything after \`--\` is forwarded to \`refilm record\`, e.g.:

  refilm watch --url http://localhost:3000 --ref .refilm/hero/ref -- --selector ".hero" --duration 1800

Prints one line per run:

  [12:03:04] recorded 45 frames · 1.24% mismatch (budget 5.00%) · start +0.02s · PASS

Exit code 0 when interrupted, 4 on an internal error. A failing comparison does not
stop the watch — that is the loop working.
`;

interface Snapshot {
  token: string;
  frames: number;
}

async function httpToken(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    return [
      response.status,
      response.headers.get("etag") ?? "",
      response.headers.get("last-modified") ?? "",
      response.headers.get("content-length") ?? "",
    ].join("|");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fileToken(target: string): string | null {
  const path = target.startsWith("file:") ? fileURLToPath(target) : target;
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

async function snapshotOf(url: string): Promise<string | null> {
  return /^https?:/i.test(url) ? httpToken(url) : fileToken(url);
}

/** `refilm <args> --json` → parsed stdout. */
function runCli(cliPath: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: run.status ?? 1,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
}

function parseEnvelope(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const first = trimmed.indexOf("{");
  if (first === -1) return null;
  try {
    return JSON.parse(trimmed.slice(first));
  } catch {
    return null;
  }
}

const stamp = (): string => new Date().toISOString().slice(11, 19);

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const recordArgs = separator === -1 ? [] : argv.slice(separator + 1);

  const args = parseArgs(own);
  const url = str(args.url);
  const refArg = str(args.ref);
  if (!url || !refArg) {
    throw usageError(
      "watch needs --url <url|file.html> --ref <framesDir>",
      "example: refilm watch --url http://localhost:3000 --ref .refilm/hero/ref",
    );
  }
  const ref = abs(refArg);
  const outDir = ensureDir(abs(str(args.out) ?? join(".refilm", "watch")));
  const spec = str(args.spec) ? abs(str(args.spec)!) : null;
  const intervalMs = Math.max(1, num(args.interval, 3)) * 1000;
  const once = bool(args.once);
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

  const rep = reporter("watch", { json: ctx.json });
  const cloneDir = join(outDir, "clone");
  const compareDir = join(outDir, "compare");

  let iteration = 0;
  let lastPass: boolean | null = null;
  let stopping = false;

  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const iterate = async (): Promise<number> => {
    iteration += 1;
    const started = Date.now();

    const record = runCli(cliPath, ["record", "--url", url, "--out", cloneDir, "--json", ...recordArgs]);
    if (record.code !== EXIT.OK) {
      const envelope = parseEnvelope(record.stdout);
      const message =
        envelope?.errors?.[0]?.message?.split("\n")[0] ??
        envelope?.error?.message ??
        (record.stderr.trim() || "record failed");
      rep.info(`[${stamp()}] record failed (exit ${record.code}): ${message}`);
      lastPass = false;
      if (ctx.json) {
        console.log(JSON.stringify({ ok: false, command: "watch", iteration, stage: "record", exit: record.code, message }));
      }
      return record.code;
    }
    const recorded = parseEnvelope(record.stdout)?.data ?? {};
    const frames = Number(recorded.frames ?? recorded.frameCount ?? 0);

    const gate = spec
      ? ["verify", "--spec", spec, "--ref", ref, "--clone", cloneDir, "--json"]
      : ["compare", "--ref", ref, "--clone", cloneDir, "--out", compareDir, "--json"];
    for (const flag of ["threshold", "pixel-threshold", "motion-threshold", "max-shift", "blur", "region"]) {
    const value = args[flag];
    if (value !== undefined && value !== true) gate.push(`--${flag}`, String(value));
  }
  if (bool(args["no-diffs"])) gate.push("--no-diffs");
  const check = runCli(cliPath, gate);
    const envelope = parseEnvelope(check.stdout);
    const data = envelope?.data ?? {};
    const pass = Boolean(data.pass);
    lastPass = pass;

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (spec) {
      const checks: Array<{ status: string }> = Array.isArray(data.checks) ? data.checks : [];
      const failed = checks.filter((entry) => entry.status === "fail").length;
      const skipped = checks.filter((entry) => entry.status === "skip").length;
      rep.say(
        `[${stamp()}] ${frames || "?"} frames · ${checks.length - failed - skipped}/${checks.length} checks · ${pass ? "PASS" : `FAIL (${failed})`} · ${elapsed}s`,
      );
    } else {
      const mean = Number(data.meanMismatch ?? 0);
      const budget = Number(data.threshold ?? 0);
      const start = Number(data.timingError?.start ?? 0);
      rep.say(
        `[${stamp()}] ${frames || data.compared || "?"} frames · ${(mean * 100).toFixed(2)}% mismatch (budget ${(budget * 100).toFixed(2)}%) · start ${start >= 0 ? "+" : ""}${start.toFixed(3)}s · ${pass ? "PASS" : "FAIL"} · ${elapsed}s`,
      );
    }

    if (ctx.json) {
      console.log(
        JSON.stringify({
          ok: true,
          command: "watch",
          iteration,
          frames,
          pass,
          exit: check.code,
          meanMismatch: data.meanMismatch ?? null,
          threshold: data.threshold ?? null,
          timingError: data.timingError ?? null,
          checks: Array.isArray(data.checks) ? data.checks.length : null,
          failures: Array.isArray(data.failures) ? data.failures : [],
          elapsedMs: Date.now() - started,
        }),
      );
    }
    return check.code;
  };

  rep.info(`watching ${url}`);
  rep.info(`reference ${ref}${spec ? ` · gate verify(${spec})` : " · gate compare"}`);
  rep.info(`run directory ${outDir}${once ? " · one iteration" : ""}`);

  let token = await snapshotOf(url);
  let lastRun = 0;
  await iterate();
  lastRun = Date.now();

  if (once) {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    return lastPass ? EXIT.OK : EXIT.VERIFY_FAILED;
  }

  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (Date.now() - lastRun < intervalMs) continue;
    const next = await snapshotOf(url);
    if (next === null || next === token) continue;
    token = next;
    await iterate();
    lastRun = Date.now();
  }

  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  rep.info(
    `stopped after ${iteration} run(s) · last result ${lastPass === null ? "n/a" : lastPass ? "PASS" : "FAIL"}`,
  );
  return EXIT.OK;
}
