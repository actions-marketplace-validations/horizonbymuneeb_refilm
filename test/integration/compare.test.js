// Integration: `refilm compare` — the measurement core.
//
// The two things worth asserting are the two things compare exists to answer:
//   ref vs itself     -> exit 0, zero mismatch, zero offset  (no false alarms)
//   ref vs a shifted  -> exit 1, non-empty failures          (no false passes)
// A compare that fails both directions is useless, so both are covered.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

const VIEW = "640x480";

/** Capture a fixture once; the frames are reused by several assertions below. */
async function capture(out, extra = []) {
  const res = await runCli([
    "record",
    "--url", fixture("fade-up.html"),
    "--out", out,
    "--viewport", VIEW,
    "--fps", "10",
    "--duration", "1200",
    "--trigger", "load",
    ...extra,
    "--json",
  ], { timeoutMs: 120_000 });
  assert.equal(res.code, 0, `capture failed:\n${res.stderr.slice(-2000)}`);
  return out;
}

/** A clone directory whose frames are the reference frames shifted by N (a real misalignment). */
function shiftedCopy(refDir, cloneDir, shift) {
  const refFrames = join(refDir, "frames");
  const cloneFrames = join(cloneDir, "frames");
  mkdirSync(cloneFrames, { recursive: true });
  const files = readdirSync(refFrames).filter((f) => f.endsWith(".png")).sort();
  files.forEach((f, i) => {
    const src = join(refFrames, files[(i + shift) % files.length]);
    copyFileSync(src, join(cloneFrames, f));
  });
  // compare reads the frame rate from frames.json beside the frames, so carry it over.
  const meta = join(refDir, "frames.json");
  if (existsSync(meta)) copyFileSync(meta, join(cloneDir, "frames.json"));
  return cloneDir;
}

test("compare: ref vs itself passes with zero mismatch and zero offset", async () => {
  const ref = tmpDir();
  const out = tmpDir();
  try {
    await capture(ref);
    const res = await runCli([
      "compare",
      "--ref", join(ref, "frames"),
      "--clone", join(ref, "frames"),
      "--out", out,
      "--json",
    ], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, `comparing a capture with itself must pass:\n${res.stderr.slice(-2000)}`);

    const env = parseEnvelope(res, "compare self");
    assert.equal(env.ok, true);
    const r = env.data;
    assert.equal(r.kind, "compare");
    assert.equal(r.schema, 1);
    assert.equal(r.pass, true, "a self-comparison must pass");
    assert.equal(r.meanMismatch, 0, "identical frames must have zero mean mismatch");
    assert.equal(r.maxMismatch, 0);
    assert.equal(r.offset, 0, "no alignment shift should be needed");
    assert.deepEqual(r.failures, [], "a passing comparison has no failures");
    assert.ok(r.compared > 0, "some frames must actually be compared");
    assert.ok(r.frames > 0);
    assert.equal(typeof r.threshold, "number");
    assert.equal(typeof r.motionThreshold, "number");
    assert.ok(Array.isArray(r.frameDetails), "frameDetails must be an array");
    assert.equal(r.frameDetails.length, r.compared, "one detail per compared frame");
    assert.ok(r.motion && r.motion.ref && r.motion.clone, "motion windows must be present for both sides");
    assert.ok(r.timingError && typeof r.timingError === "object");

    // report.json is the machine-readable artifact verify/report consume
    const reportPath = join(out, "report.json");
    assert.ok(existsSync(reportPath), "compare must write report.json");
    const onDisk = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(onDisk.pass, true);
    assert.equal(onDisk.meanMismatch, 0);
  } finally {
    cleanup(ref);
    cleanup(out);
  }
});

test("compare: ref vs a shifted clone fails with a non-zero exit and non-empty failures", async () => {
  const ref = tmpDir();
  const clone = tmpDir();
  const out = tmpDir();
  try {
    await capture(ref);
    shiftedCopy(ref, clone, 3); // every frame is 3 frames out of place

    const res = await runCli([
      "compare",
      "--ref", join(ref, "frames"),
      "--clone", join(clone, "frames"),
      "--out", out,
      "--max-shift", "1", // forbid compare from silently re-aligning the shift away
      "--json",
    ], { timeoutMs: 120_000 });

    assert.equal(res.code, 1, `a visibly different clone must exit 1, got ${res.code}`);
    const env = parseEnvelope(res, "compare shifted");
    // A failing comparison still reports ok:true — the run succeeded, the clone did not pass.
    assert.equal(env.ok, true, "compare ran successfully; the verdict is in data.pass");
    const r = env.data;
    assert.equal(r.pass, false);
    assert.ok(r.failures.length > 0, "a failing comparison must explain itself in failures");
    assert.ok(
      r.meanMismatch > 0,
      `a shifted clone must have non-zero mismatch, got ${r.meanMismatch}`,
    );
    for (const f of r.failures) assert.equal(typeof f, "string", "failures are human-readable strings");
  } finally {
    cleanup(ref);
    cleanup(clone);
    cleanup(out);
  }
});

test("compare: writes report.md and diff images for a human to look at", async () => {
  const ref = tmpDir();
  const clone = tmpDir();
  const out = tmpDir();
  try {
    await capture(ref);
    shiftedCopy(ref, clone, 2);
    const res = await runCli([
      "compare",
      "--ref", join(ref, "frames"),
      "--clone", join(clone, "frames"),
      "--out", out,
      "--max-shift", "0",
      "--json",
    ], { timeoutMs: 120_000 });
    assert.equal(res.code, 1);
    assert.ok(existsSync(join(out, "report.md")), "compare must write a human-readable report.md");
    const md = readFileSync(join(out, "report.md"), "utf8");
    assert.ok(md.length > 0, "report.md must not be empty");
  } finally {
    cleanup(ref);
    cleanup(clone);
    cleanup(out);
  }
});

test("compare: missing --ref/--clone is a usage error with exit 2", async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["compare", "--out", out, "--json"]);
    assert.equal(res.code, 2);
    const env = parseEnvelope(res, "compare missing args");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(out);
  }
});

test("compare: an empty frames directory is a usage error, not a crash", async () => {
  const empty = tmpDir();
  const out = tmpDir();
  try {
    const res = await runCli([
      "compare",
      "--ref", empty,
      "--clone", empty,
      "--out", out,
      "--json",
    ], { timeoutMs: 60_000 });
    assert.equal(res.code, 2, `an empty directory is a usage problem, got exit ${res.code}`);
    const env = parseEnvelope(res, "compare empty");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(empty);
    cleanup(out);
  }
});
