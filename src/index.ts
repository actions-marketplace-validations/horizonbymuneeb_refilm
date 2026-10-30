// refilm — programmatic entry point.
//
// The CLI is the product; this module exists so scripts and CI jobs can call the same
// commands without spawning a process:
//
//   import { record, compare, verify, run } from "refilm";
//   const capture = await record({ url: "https://example.com", out: ".refilm/ref" });
//
// Every helper resolves with the same object the CLI prints under `data` in --json mode,
// and rejects with a RefilmError (code, exit) on failure.

import { main } from "./cli.js";

export { main, EXIT, RefilmError } from "./cli.js";
export { VERSION } from "./lib.js";
export * from "./types.js";

type CommandName =
  | "record"
  | "frames"
  | "spec"
  | "compare"
  | "sheet"
  | "fit"
  | "gl"
  | "verify"
  | "report"
  | "install"
  | "init"
  | "doctor";

/** Turns a plain options object into the CLI's argv form. */
export function toArgv(options: Record<string, unknown> = {}): string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    const flag = key.length === 1 ? `-${key}` : `--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
    if (value === true) {
      argv.push(flag);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      argv.push(flag, String(item));
    }
  }
  return argv;
}

/**
 * Runs one command and returns its JSON payload.
 * Captures the command's own stdout so the caller's output stays clean.
 */
export async function run(command: CommandName, options: Record<string, unknown> = {}): Promise<any> {
  const argv = [command, ...toArgv(options), "--json"];
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(String(chunk));
    return true;
  };
  let code: number;
  try {
    code = await main(argv);
  } finally {
    (process.stdout as any).write = original;
  }
  const text = chunks.join("").trim();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`refilm ${command} did not return JSON: ${text.slice(0, 400)}`);
  }
  if (!payload?.ok) {
    const err = payload?.errors?.[0];
    throw new Error(`refilm ${command} failed (exit ${code}): ${err?.message ?? "unknown error"}`);
  }
  return payload.data;
}

export const record = (options: Record<string, unknown>) => run("record", options);
export const frames = (options: Record<string, unknown>) => run("frames", options);
export const spec = (options: Record<string, unknown>) => run("spec", options);
export const compare = (options: Record<string, unknown>) => run("compare", options);
export const sheet = (options: Record<string, unknown>) => run("sheet", options);
export const fit = (options: Record<string, unknown>) => run("fit", options);
export const gl = (options: Record<string, unknown>) => run("gl", options);
export const verify = (options: Record<string, unknown>) => run("verify", options);
export const report = (options: Record<string, unknown>) => run("report", options);
export const install = (options: Record<string, unknown>) => run("install", options);
export const init = (options: Record<string, unknown>) => run("init", options);
export const doctor = (options: Record<string, unknown>) => run("doctor", options);
