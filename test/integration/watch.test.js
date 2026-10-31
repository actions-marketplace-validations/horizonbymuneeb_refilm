// Integration: `refilm watch` — the dev loop.
//
// Two behaviours matter and both are covered:
//   --once on a faithful clone  -> exit 0, "PASS" on the summary line
//   --once on a wrong clone     -> exit 1, "FAIL"  (a watch that never fails is useless)
//
// The file-change path is covered by the unit-level assertion on change detection:
// editing the page must trigger a second iteration without a restart.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tmpDir, cleanup, runCli } from "../helpers.js";

async function capture(url, out) {
  // Defaults on both sides: watch records with the record defaults, so the reference
  // must be captured with the same setup or compare measures the setup, not the motion.
  const res = await runCli(["record", "--url", url, "--out", out, "--json"], {
    timeoutMs: 120_000,
  });
  assert.equal(res.code, 0, `capture failed:\n${res.stderr.slice(-2000)}`);
  return out;
}

test("watch --once: a faithful clone passes and says so", { timeout: 240_000 }, async () => {
  const dir = tmpDir("watch-pass");
  try {
    const ref = await capture(fixture("fade-up.html"), join(dir, "ref"));
    const res = await runCli(
      [
        "watch",
        "--url",
        fixture("fade-up.html"),
        "--ref",
        ref,
        "--out",
        join(dir, "run"),
        "--once",
      ],
      { timeoutMs: 240_000 },
    );
    assert.equal(res.code, 0, `watch failed:\n${res.stderr.slice(-2000)}`);
    assert.match(res.stdout, /PASS/);
    assert.match(res.stdout, /mismatch/);
    assert.ok(existsSync(join(dir, "run", "clone", "frames")), "the clone frames are kept for inspection");
    assert.ok(existsSync(join(dir, "run", "compare", "report.json")), "the compare report is written");
  } finally {
    cleanup(dir);
  }
});

test("watch --once: a wrong clone fails with exit 1", { timeout: 300_000 }, async () => {
  const dir = tmpDir("watch-fail");
  try {
    const ref = await capture(fixture("fade-up.html"), join(dir, "ref"));
    const res = await runCli(
      [
        "watch",
        "--url",
        fixture("scale-in.html"),
        "--ref",
        ref,
        "--out",
        join(dir, "run"),
        "--once",
      ],
      { timeoutMs: 240_000 },
    );
    assert.equal(res.code, 1, `expected a failing gate, got ${res.code}\n${res.stdout}`);
    assert.match(res.stdout, /FAIL/);
  } finally {
    cleanup(dir);
  }
});

test("watch --once --json: one machine-readable line per run", { timeout: 240_000 }, async () => {
  const dir = tmpDir("watch-json");
  try {
    const ref = await capture(fixture("fade-up.html"), join(dir, "ref"));
    const res = await runCli(
      [
        "watch",
        "--url",
        fixture("fade-up.html"),
        "--ref",
        ref,
        "--out",
        join(dir, "run"),
        "--once",
        "--json",
      ],
      { timeoutMs: 240_000 },
    );
    const line = res.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry.startsWith("{"))
      .pop();
    assert.ok(line, `expected a JSON line on stdout, got: ${res.stdout.slice(0, 400)}`);
    const payload = JSON.parse(line);
    assert.equal(payload.command, "watch");
    assert.equal(payload.iteration, 1);
    assert.equal(payload.pass, true);
    assert.ok(Number(payload.meanMismatch) <= Number(payload.threshold));
  } finally {
    cleanup(dir);
  }
});

test("watch: usage error without --url or --ref", async () => {
  const res = await runCli(["watch", "--url", fixture("fade-up.html")], { timeoutMs: 30_000 });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--ref/);
});

test("action metadata: action.yml exposes the verify/compare surface", () => {
  const text = readFileSync(new URL("../../action.yml", import.meta.url), "utf8");
  assert.match(text, /using:\s*"composite"/);
  for (const input of ["spec", "ref", "clone", "out", "mode", "threshold", "report", "version"]) {
    assert.match(text, new RegExp(`\\n\\s{2}${input}:`), `action.yml is missing the ${input} input`);
  }
  assert.match(text, /refilm verify/);
  assert.match(text, /GITHUB_STEP_SUMMARY/);
});
