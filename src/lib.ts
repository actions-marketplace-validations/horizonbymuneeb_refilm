// refilm — shared primitives: argument parsing, structured output, errors, files, ffmpeg.
// Everything here is dependency-free so every command behaves the same way.

import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.3";

/** Exit codes are part of the CLI contract: agents and CI branch on these. */
export const EXIT = {
  OK: 0,
  VERIFY_FAILED: 1,
  USAGE: 2,
  ENVIRONMENT: 3,
  INTERNAL: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class RefilmError extends Error {
  code: string;
  exit: ExitCode;
  hint?: string;
  constructor(code: string, message: string, exit: ExitCode = EXIT.INTERNAL, hint?: string) {
    super(message);
    this.name = "RefilmError";
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

export const usageError = (message: string, hint?: string) =>
  new RefilmError("USAGE", message, EXIT.USAGE, hint);
export const envError = (message: string, hint?: string) =>
  new RefilmError("ENVIRONMENT", message, EXIT.ENVIRONMENT, hint);

/** Where the compiled code lives (dist/), used to find bundled assets. */
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- arguments

export interface Args {
  _: string[];
  [key: string]: any;
}

/**
 * Parses `--key value`, `--key=value` and bare `--flag` (true).
 * A value that starts with `--` is treated as the next flag, so `--headed --url x` works.
 * Repeated keys collect into an array.
 */
export function parseArgs(argv: string[], defaults: Record<string, any> = {}): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      assign(out, token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) assign(out, key, true);
    else {
      assign(out, key, next);
      i++;
    }
  }
  // Defaults fill the gaps only: a flag the user passed always wins, and repeated
  // flags still collect into an array.
  for (const key of Object.keys(defaults)) {
    if (out[key] === undefined) out[key] = defaults[key];
  }
  return out;
}

function assign(out: Args, key: string, value: any) {
  if (out[key] === undefined) out[key] = value;
  else if (Array.isArray(out[key])) out[key].push(value);
  else out[key] = [out[key], value];
}

export function num(v: any, fallback: number): number {
  if (v === undefined || v === true) return fallback;
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : fallback;
}

export function str(v: any): string | undefined {
  if (v === undefined || v === true) return undefined;
  return String(Array.isArray(v) ? v[0] : v);
}

export function bool(v: any): boolean {
  if (v === undefined) return false;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  return s !== "false" && s !== "0" && s !== "no";
}

export function list(v: any): string[] {
  if (v === undefined || v === true) return [];
  const raw = Array.isArray(v) ? v : [v];
  return raw
    .flatMap((x) => String(x).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "1:23.5" | "83.5" | "83.5s" | "1500ms" -> seconds */
export function parseTime(v: any): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  if (s.endsWith("ms")) return Number(s.slice(0, -2)) / 1000;
  if (s.includes(":")) {
    const parts = s.split(":");
    const secs = Number(parts.pop());
    const mins = Number(parts.pop() ?? 0);
    const hours = Number(parts.pop() ?? 0);
    return hours * 3600 + mins * 60 + secs;
  }
  const n = Number(s.replace(/s$/, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function parseSize(v: any, fallback: { width: number; height: number }) {
  const s = str(v);
  if (!s) return fallback;
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) throw usageError(`bad --viewport "${s}", expected WxH (for example 1440x900)`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseRect(v: any): Rect | undefined {
  const s = str(v);
  if (!s) return undefined;
  const p = s.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw usageError(`bad rect "${s}", expected x,y,w,h`);
  }
  return { x: p[0], y: p[1], width: p[2], height: p[3] };
}

// ---------------------------------------------------------------- output

export interface Reporter {
  json: boolean;
  warnings: string[];
  info(msg: string): void;
  warn(msg: string): void;
  /** Human-readable line that is suppressed in --json mode. */
  say(msg: string): void;
  emit(command: string, data: any): void;
}

export function reporter(command: string, opts: { json?: boolean } = {}): Reporter {
  const json = !!opts.json;
  const warnings: string[] = [];
  const say = (msg: string) => {
    if (!json) console.log(msg);
  };
  return {
    json,
    warnings,
    info: (msg) => {
      if (!json) console.error(msg);
    },
    warn: (msg) => {
      warnings.push(msg);
      if (!json) console.error(`warning: ${msg}`);
    },
    say,
    emit: (cmd, data) => {
      if (json) {
        console.log(
          JSON.stringify(
            { ok: true, command: cmd, version: VERSION, warnings, data },
            null,
            2,
          ),
        );
      }
    },
  };
}

export function emitError(command: string, err: unknown, json: boolean): number {
  const e =
    err instanceof RefilmError
      ? err
      : new RefilmError("INTERNAL", err instanceof Error ? err.message : String(err), EXIT.INTERNAL);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          command,
          version: VERSION,
          warnings: [],
          errors: [{ code: e.code, message: e.message, hint: e.hint ?? null }],
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`refilm ${command}: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
  }
  return e.exit;
}

// ---------------------------------------------------------------- files

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function readJson<T = any>(p: string): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch (err) {
    throw new RefilmError(
      "BAD_JSON",
      `cannot read JSON at ${p}: ${err instanceof Error ? err.message : err}`,
      EXIT.INTERNAL,
    );
  }
}

export function writeJson(p: string, value: any) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(p: string, text: string) {
  ensureDir(dirname(p));
  writeFileSync(p, text);
}

export function exists(p: string): boolean {
  return existsSync(p);
}

export function listFrames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export const pad = (n: number, width = 4) => String(n).padStart(width, "0");

// ---------------------------------------------------------------- ffmpeg

let cachedFfmpeg: string | null = null;

/**
 * ffmpeg resolution order: REFILM_FFMPEG, a bundled binary, then ffmpeg on PATH.
 * The tool never downloads anything at runtime; `refilm doctor` reports what is missing.
 */
export function ffmpegPath(): string {
  if (cachedFfmpeg) return cachedFfmpeg;
  const fromEnv = process.env.REFILM_FFMPEG;
  if (fromEnv && existsSync(fromEnv)) return (cachedFfmpeg = fromEnv);
  const bundled = join(PKG_DIR, "vendor", "ffmpeg");
  if (existsSync(bundled)) return (cachedFfmpeg = bundled);
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  if (probe.status === 0) return (cachedFfmpeg = "ffmpeg");
  throw envError(
    "ffmpeg not found",
    "install ffmpeg (apt install ffmpeg / brew install ffmpeg) or set REFILM_FFMPEG=/path/to/ffmpeg",
  );
}

export function ffmpeg(args: string[], opts: { quiet?: boolean } = {}): string {
  const bin = ffmpegPath();
  const r = spawnSync(bin, ["-hide_banner", "-loglevel", opts.quiet ? "error" : "warning", ...args], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) {
    throw new RefilmError(
      "FFMPEG_FAILED",
      `ffmpeg failed (${r.status}): ${(r.stderr || "").slice(-800)}`,
      EXIT.ENVIRONMENT,
    );
  }
  return r.stderr || "";
}

/** ffmpeg -i output is the only probe we need; ffprobe is not assumed to exist. */
export function probeMedia(input: string) {
  const bin = ffmpegPath();
  const r = spawnSync(bin, ["-hide_banner", "-i", input], { encoding: "utf8" });
  const text = r.stderr || "";
  const dur = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const dims = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  const fps = text.match(/([\d.]+) fps/);
  return {
    input,
    durationS: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined,
    width: dims ? Number(dims[1]) : undefined,
    height: dims ? Number(dims[2]) : undefined,
    sourceFps: fps ? Number(fps[1]) : undefined,
  };
}
