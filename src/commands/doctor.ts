// refilm doctor — report what the environment is missing, with the exact command that fixes it.
//
// The tool never installs anything by itself: no browser download, no binary fetch, no network
// call. Doctor's job is to make the fix copy-pasteable and to exit 3 so a script can branch on
// "this box cannot film anything yet".

import { EXIT, VERSION, abs, exists, ffmpegPath, isDir, parseArgs, reporter, str } from "../lib.js";
import { accessSync, constants, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { arch, platform } from "node:os";
import type { DoctorCheck, DoctorReport } from "../types.js";
import { SCHEMA } from "../types.js";

export const help = `
refilm doctor — check that this machine can record and compare.

  refilm doctor [--json] [--dir <project>]

Checks, in order:
  node        version ≥ 20 (the ESM + fetch baseline refilm is built against)
  ffmpeg      resolvable through ffmpegPath(): REFILM_FFMPEG, a bundled binary, or PATH
  chromium    Playwright's Chromium actually launches and closes (30 s timeout)
  writable    the current directory (or --dir) can be written to
  run dir     whether a .refilm/ run directory exists here yet

Every failing check carries the exact command that fixes it. Nothing is installed or downloaded.
Exit 0 when everything required passes, 3 when something required is missing, 1 if only optional
checks warn.
`;

const NODE_MIN_MAJOR = 20;
const CHROMIUM_TIMEOUT_MS = 30_000;

function check(id: string, status: DoctorCheck["status"], detail: string, fix?: string): DoctorCheck {
  return { id, status, detail, ...(fix ? { fix } : {}) };
}

function nodeCheck(): DoctorCheck {
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (!Number.isFinite(major)) return check("node", "fail", `cannot parse the node version "${raw}"`, "install Node 20 or newer: https://nodejs.org/");
  if (major >= NODE_MIN_MAJOR) return check("node", "ok", `v${raw}`);
  return check(
    "node",
    "fail",
    `v${raw} is older than the required ${NODE_MIN_MAJOR}`,
    "install Node 20 or newer (nvm install 20 && nvm use 20, or https://nodejs.org/)",
  );
}

function ffmpegCheck(): DoctorCheck {
  const envPath = process.env.REFILM_FFMPEG;
  if (envPath && !exists(envPath)) {
    return check(
      "ffmpeg",
      "fail",
      `REFILM_FFMPEG points at ${envPath}, which does not exist`,
      `fix or unset it: export REFILM_FFMPEG=/usr/bin/ffmpeg`,
    );
  }
  // Ask lib.ts itself, so doctor reports exactly what the other commands will get.
  let resolved: string;
  try {
    resolved = ffmpegPath();
  } catch (err) {
    return check(
      "ffmpeg",
      "fail",
      err instanceof Error ? err.message : String(err),
      "install ffmpeg (apt install ffmpeg, brew install ffmpeg) or set REFILM_FFMPEG=/path/to/ffmpeg",
    );
  }
  const probe = spawnSync(resolved, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10_000 });
  if (probe.status !== 0) {
    return check(
      "ffmpeg",
      "fail",
      `${resolved} exists but does not run (exit ${probe.status})`,
      "reinstall ffmpeg: apt install --reinstall ffmpeg, or set REFILM_FFMPEG to a working binary",
    );
  }
  const version = /ffmpeg version (\S+)/.exec(probe.stdout ?? "")?.[1] ?? "unknown version";
  const how = resolved === "ffmpeg" ? "on PATH" : resolved;
  return check("ffmpeg", "ok", `${version} (${how})`);
}

/** Chromium is the expensive check: it actually launches a browser and closes it. */
async function chromiumCheck(): Promise<DoctorCheck> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return check(
      "chromium",
      "fail",
      `playwright is not installed: ${err instanceof Error ? err.message : String(err)}`,
      "npm install playwright",
    );
  }

  const attempt = async (): Promise<string> => {
    const browser = await chromium.launch({ timeout: CHROMIUM_TIMEOUT_MS });
    try {
      return browser.version();
    } finally {
      await browser.close();
    }
  };

  try {
    const version = await Promise.race([
      attempt(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`launch timed out after ${CHROMIUM_TIMEOUT_MS / 1000}s`)), CHROMIUM_TIMEOUT_MS),
      ),
    ]);
    return check("chromium", "ok", `Playwright Chromium ${version} launches and closes`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = /Executable doesn't exist|browserType\.launch: .*not found|please run the following command/i.test(message);
    return check(
      "chromium",
      "fail",
      missing ? `Playwright's Chromium is not installed (${firstLine(message)})` : `Chromium did not launch: ${firstLine(message)}`,
      "npx playwright install chromium",
    );
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? text;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function writableCheck(dir: string): DoctorCheck {
  if (!isDir(dir)) return check("writable", "fail", `${dir} is not a directory`, `create it or pass --dir <an existing project>`);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return check("writable", "fail", `${dir} is not writable`, `chmod u+w ${dir}, or run refilm from a directory you own`);
  }
  // access() lies on read-only mounts and on some ACL setups: prove it with a real write.
  const probePath = join(dir, `.refilm-write-probe-${process.pid}`);
  try {
    writeFileSync(probePath, "refilm");
    rmSync(probePath, { force: true });
  } catch (err) {
    return check("writable", "fail", `${dir} rejected a test write: ${err instanceof Error ? err.message : String(err)}`, `run refilm from a writable directory (--dir <path>)`);
  }
  return check("writable", "ok", `${dir} is writable`);
}

function runDirCheck(dir: string): DoctorCheck {
  const runDir = join(dir, ".refilm");
  if (!isDir(runDir)) {
    return check(
      "runDir",
      "warn",
      `no .refilm/ in ${dir} yet`,
      "refilm init            # scaffolds .refilm/ with runs/ and config.json",
    );
  }
  const runsDir = join(runDir, "runs");
  if (!isDir(runsDir)) {
    return check("runDir", "warn", `${runDir} exists but has no runs/ directory`, "refilm init            # adds the missing runs/ directory");
  }
  const config = join(runDir, "config.json");
  return check("runDir", "ok", `${runDir} with runs/${exists(config) ? " and config.json" : ""}`);
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("doctor", { json: ctx.json });
  const args = parse_dir(argv);
  const dir = abs(args.dir ?? process.cwd());

  const checks: DoctorCheck[] = [];
  checks.push(nodeCheck());
  checks.push(ffmpegCheck());
  checks.push(await chromiumCheck());
  checks.push(writableCheck(dir));
  checks.push(runDirCheck(dir));

  // Only a failing *required* check is fatal. A missing .refilm/ is a warn: you can record
  // before scaffolding, the scaffold only gives you somewhere conventional to put the runs.
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const ok = failed.length === 0;

  const chromiumVersion = checks.find((c) => c.id === "chromium");
  const ffmpegDetail = checks.find((c) => c.id === "ffmpeg");

  const report: DoctorReport = {
    schema: SCHEMA,
    kind: "doctor",
    ok,
    checks,
    environment: {
      node: process.versions.node,
      platform: platform(),
      arch: arch(),
      ffmpeg: ffmpegDetail?.status === "ok" ? ffmpegDetail.detail : null,
      chromium: chromiumVersion?.status === "ok" ? chromiumVersion.detail : null,
      version: VERSION,
    },
  };

  // ---- human output
  rep.say(`refilm doctor — ${ok ? "ready" : "not ready"} (${checks.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail)`);
  rep.say("");
  for (const c of checks) {
    const mark = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    rep.say(`  ${mark}  ${c.id.padEnd(9)} ${c.detail}`);
    if (c.fix) rep.say(`        fix: ${c.fix}`);
  }
  rep.say("");
  if (ok) {
    rep.say(warned.length ? "ready to film (warnings do not block)" : "ready to film");
  } else {
    rep.say(`${failed.length} required check(s) failed — fix the commands above, then run refilm doctor again`);
  }

  rep.emit("doctor", report);
  return ok ? EXIT.OK : EXIT.ENVIRONMENT;
}

/** --dir is the only flag doctor takes. */
function parse_dir(argv: string[]): { dir?: string } {
  const args = parseArgs(argv);
  return { dir: str(args.dir) };
}
