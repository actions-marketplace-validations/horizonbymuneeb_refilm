// Shared helpers for the refilm test suite.
//
// Not a test file itself: it lives outside test/unit/ and test/integration/ so the
// `test/*/*.test.js` globs in package.json never pick it up as a suite.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(TEST_DIR, "..");
export const FIXTURES = join(REPO, "test", "fixtures");
export const CLI = join(REPO, "dist", "cli.js");
export const DIST = join(REPO, "dist");

/** Absolute path to a fixture, e.g. fixture("fade-up.html"). */
export const fixture = (name) => join(FIXTURES, name);

/** A temp directory removed when the test's cleanup runs. */
export function tmpDir(prefix = "refilm-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Best-effort recursive delete; never throws, so cleanup cannot fail a test. */
export function cleanup(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a leftover temp dir must never turn a passing test red */
  }
}

/**
 * Run the real CLI as a child process and collect everything about the run.
 * Never throws on a non-zero exit: the exit code is the assertion.
 */
export function runCli(args, opts = {}) {
  const {
    cwd = REPO,
    timeoutMs = 120_000,
    env = {},
    input = null,
  } = opts;

  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    if (input !== null) child.stdin.end(input);
    else child.stdin.end();

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Parse the `--json` envelope from stdout. Fails loudly with the raw output when
 * stdout is not JSON, because a broken envelope is exactly the defect worth
 * reporting rather than hiding behind a generic assertion.
 */
export function parseEnvelope(res, label = "cli") {
  const text = (res.stdout || "").trim();
  if (!text) {
    throw new Error(
      `${label}: expected a JSON envelope on stdout, got nothing (exit ${res.code})\n` +
        `stderr: ${(res.stderr || "").slice(-1200)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${label}: stdout is not valid JSON (exit ${res.code}): ${err.message}\n` +
        `stdout: ${text.slice(0, 1200)}\n` +
        `stderr: ${(res.stderr || "").slice(-1200)}`,
    );
  }
}

/** Skip a test with a reason that says exactly what is missing. */
export function missingCommand(name) {
  return `refilm ${name}: dist/commands/${name}.js not built yet (owned by another teammate)`;
}
