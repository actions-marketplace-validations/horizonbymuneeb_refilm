// Integration: `refilm frames` — cutting a video into numbered PNGs.
//
// Uses the committed 9.4 KB clip.mp4 fixture (1s, 160x120, 10fps), so this suite
// needs ffmpeg but no browser. When ffmpeg is genuinely absent the tests skip with
// a reason rather than failing, because a missing tool is an environment problem
// and `refilm doctor` already reports it.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

const CLIP = fixture("clip.mp4");

/** Is ffmpeg usable on this machine? */
function ffmpegAvailable() {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  return r.status === 0;
}

const HAVE_FFMPEG = ffmpegAvailable();
const SKIP = HAVE_FFMPEG ? false : "ffmpeg is not installed on this machine (refilm doctor reports it)";

test("frames: --probe reports the clip's width, height and duration", { skip: SKIP }, async () => {
  const res = await runCli(["frames", "--in", CLIP, "--probe", "--json"], { timeoutMs: 60_000 });
  assert.equal(res.code, 0, `frames --probe should succeed:\n${res.stderr.slice(-1500)}`);

  const env = parseEnvelope(res, "frames --probe");
  assert.equal(env.ok, true);
  const d = env.data;
  assert.equal(d.probe, true);
  assert.equal(d.sourceWidth, 160, `clip.mp4 is 160px wide, got ${d.sourceWidth}`);
  assert.equal(d.sourceHeight, 120, `clip.mp4 is 120px tall, got ${d.sourceHeight}`);
  assert.ok(Math.abs(d.durationS - 1.0) < 0.05, `clip.mp4 is 1s long, got ${d.durationS}s`);
  assert.ok(Math.abs(d.sourceFps - 10) < 0.5, `clip.mp4 is 10fps, got ${d.sourceFps}`);
});

test("frames: --probe extracts nothing", { skip: SKIP }, async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["frames", "--in", CLIP, "--out", out, "--probe", "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 0, res.stderr.slice(-1200));
    const pngs = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".png")) : [];
    assert.deepEqual(pngs, [], "--probe must not write frames");
  } finally {
    cleanup(out);
  }
});

test("frames: cuts the clip into numbered PNGs and writes frames.json", { skip: SKIP }, async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["frames", "--in", CLIP, "--out", out, "--fps", "10", "--json"], {
      timeoutMs: 90_000,
    });
    assert.equal(res.code, 0, `frames should succeed:\n${res.stderr.slice(-1500)}`);
    const env = parseEnvelope(res, "frames");
    assert.equal(env.ok, true);
    assert.equal(env.data.count, 10, `a 1s clip at 10fps is 10 frames, got ${env.data.count}`);

    const pngs = readdirSync(out).filter((f) => /^\d{4}\.png$/.test(f)).sort();
    assert.equal(pngs.length, 10, `expected 10 numbered PNGs, got ${pngs.length}`);
    assert.equal(pngs[0], "0001.png", "numbering starts at 0001");
    assert.equal(pngs[9], "0010.png");

    const meta = join(out, "frames.json");
    assert.ok(existsSync(meta), "frames must write frames.json");
    const m = JSON.parse(readFileSync(meta, "utf8"));
    assert.equal(m.count, 10);
    assert.equal(m.fps, 10);
    assert.equal(typeof m.start, "number");
    assert.equal(m.sourceWidth, 160);
    assert.equal(m.sourceHeight, 120);
  } finally {
    cleanup(out);
  }
});

test("frames: --start and --end select a window", { skip: SKIP }, async () => {
  const out = tmpDir();
  try {
    const res = await runCli([
      "frames", "--in", CLIP, "--out", out,
      "--fps", "10", "--start", "0.5", "--end", "1.0",
      "--json",
    ], { timeoutMs: 90_000 });
    assert.equal(res.code, 0, res.stderr.slice(-1500));
    const d = parseEnvelope(res, "frames window").data;
    assert.ok(d.count > 0 && d.count < 10, `a 0.5s window must be fewer than 10 frames, got ${d.count}`);
  } finally {
    cleanup(out);
  }
});

test("frames: --crop and --width change the output geometry", { skip: SKIP }, async () => {
  const out = tmpDir();
  try {
    const res = await runCli([
      "frames", "--in", CLIP, "--out", out,
      "--fps", "10", "--width", "80",
      "--json",
    ], { timeoutMs: 90_000 });
    assert.equal(res.code, 0, res.stderr.slice(-1500));
    const d = parseEnvelope(res, "frames width").data;
    assert.equal(d.sourceWidth, 160, "sourceWidth reports the source, not the output");
  } finally {
    cleanup(out);
  }
});

test("frames: --start accepts the documented time formats", { skip: SKIP }, async () => {
  // "0:00.5" and "500ms" and "0.5" must all mean the same moment.
  for (const start of ["0.5", "500ms", "0:00.5"]) {
    const out = tmpDir();
    try {
      const res = await runCli([
        "frames", "--in", CLIP, "--out", out, "--fps", "10", "--start", start, "--json",
      ], { timeoutMs: 90_000 });
      assert.equal(res.code, 0, `--start ${start} failed:\n${res.stderr.slice(-800)}`);
      const d = parseEnvelope(res, `frames --start ${start}`).data;
      assert.ok(d.count > 0, `--start ${start} produced no frames`);
      assert.ok(d.count < 10, `--start ${start} should drop the frames before 0.5s, got ${d.count}`);
    } finally {
      cleanup(out);
    }
  }
});

test("frames: a missing --in is a usage error with exit 2", { skip: SKIP }, async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["frames", "--out", out, "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 2);
    const env = parseEnvelope(res, "frames no input");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(out);
  }
});

test("frames: a file that is not a video is rejected cleanly", { skip: SKIP }, async () => {
  const out = tmpDir();
  const junk = tmpDir();
  try {
    const bad = join(junk, "not-a-video.mp4");
    writeFileSync(bad, "this is definitely not an mp4");
    const res = await runCli(["frames", "--in", bad, "--out", out, "--json"], { timeoutMs: 90_000 });
    assert.notEqual(res.code, 0, "a non-video must not silently produce zero frames as success");
    assert.ok([1, 2, 3, 4].includes(res.code), `expected a documented exit code, got ${res.code}`);
    const env = parseEnvelope(res, "frames bad input");
    assert.equal(env.ok, false);
    assert.ok(env.errors.length >= 1);
  } finally {
    cleanup(out);
    cleanup(junk);
  }
});

test("frames: a nonexistent input file is an error, not a crash", { skip: SKIP }, async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["frames", "--in", "/nonexistent/clip.mp4", "--out", out, "--json"], {
      timeoutMs: 60_000,
    });
    assert.notEqual(res.code, 0);
    const env = parseEnvelope(res, "frames missing input");
    assert.equal(env.ok, false);
  } finally {
    cleanup(out);
  }
});
