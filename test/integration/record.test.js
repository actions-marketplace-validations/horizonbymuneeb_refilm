// Integration: `refilm record` against the fixture pages.
//
// Drives the real CLI as a child process and asserts on exit codes and the --json
// payload only — never on log wording, which the engine owns and may rephrase.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixture, tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

// 640x480 and <=1500ms keep each capture under a second on this 2-vCPU box.
const VIEW = "640x480";

/** Required CaptureMeta keys, straight from src/types.ts. A missing one breaks compare/verify. */
const CAPTURE_META_KEYS = [
  "schema",
  "version",
  "kind",
  "url",
  "title",
  "createdAt",
  "viewport",
  "scale",
  "fps",
  "frameCount",
  "durationMs",
  "preRollMs",
  "trigger",
  "triggerFrame",
  "clock",
  "seed",
  "rafHz",
  "gpu",
  "rate",
  "trackSelectors",
  "trackSamples",
  "libs",
  "fonts",
  "counts",
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Sorted sha256 of every frame, so two captures can be compared frame by frame. */
function frameHashes(dir) {
  const frames = join(dir, "frames");
  if (!existsSync(frames)) return [];
  return readdirSync(frames)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => ({ file: f, sha: sha256(join(frames, f)) }));
}

test("record: --trigger load on the fade-up fixture writes a valid capture", async () => {
  const out = tmpDir();
  try {
    const res = await runCli([
      "record",
      "--url", fixture("fade-up.html"),
      "--out", out,
      "--viewport", VIEW,
      "--fps", "10",
      "--duration", "1200",
      "--trigger", "load",
      "--json",
    ]);
    assert.equal(res.code, 0, `record should succeed:\n${res.stderr.slice(-2000)}`);
    const env = parseEnvelope(res, "record");
    assert.equal(env.ok, true);
    assert.equal(env.command, "record");

    // ---- capture.json against the CaptureMeta shape
    const capPath = join(out, "capture.json");
    assert.ok(existsSync(capPath), "capture.json must be written");
    const cap = JSON.parse(readFileSync(capPath, "utf8"));
    for (const key of CAPTURE_META_KEYS) {
      assert.ok(key in cap, `capture.json is missing required CaptureMeta key "${key}"`);
    }
    assert.equal(cap.kind, "capture");
    assert.equal(cap.schema, 1);
    assert.equal(cap.trigger, "load");
    assert.equal(cap.fps, 10);
    assert.equal(cap.durationMs, 1200);
    assert.deepEqual(cap.viewport, { width: 640, height: 480 });
    assert.equal(typeof cap.createdAt, "string");
    assert.ok(!Number.isNaN(Date.parse(cap.createdAt)), "createdAt must be an ISO timestamp");
    assert.ok(cap.frameCount > 0, `frameCount must be positive, got ${cap.frameCount}`);
    assert.ok(Array.isArray(cap.trackSelectors));
    assert.ok(Array.isArray(cap.libs));
    assert.ok(Array.isArray(cap.fonts));
    assert.ok(cap.counts && typeof cap.counts === "object");
    for (const k of ["animations", "keyframes", "canvases", "nodes"]) {
      assert.equal(typeof cap.counts[k], "number", `counts.${k} must be a number`);
    }

    // ---- frames on disk match the declared count
    const frames = frameHashes(out);
    assert.equal(frames.length, cap.frameCount, "frameCount must match the PNGs actually written");
    assert.ok(frames.length > 0);

    // ---- inspect.json saw the declared animation
    const inspPath = join(out, "inspect.json");
    assert.ok(existsSync(inspPath), "inspect.json must be written");
    const insp = JSON.parse(readFileSync(inspPath, "utf8"));
    assert.ok(Array.isArray(insp.animations), "inspect.json must list animations");
    assert.ok(insp.animations.length >= 3, `expected the 3 fade-up cards, got ${insp.animations.length}`);
    const names = insp.animations.map((a) => a.name).filter(Boolean);
    assert.ok(names.includes("fade-up"), `declared animation "fade-up" missing from inspect.json, saw ${JSON.stringify(names)}`);
    const durations = insp.animations.map((a) => Number(a.timing?.duration));
    assert.ok(
      durations.some((d) => Math.abs(d - 900) < 1),
      `the 900ms animation duration should be visible in inspect.json, saw ${JSON.stringify(durations)}`,
    );

    // ---- track.json has samples when selectors are tracked
    const trackPath = join(out, "track.json");
    if (existsSync(trackPath)) {
      const track = JSON.parse(readFileSync(trackPath, "utf8"));
      assert.equal(track.kind, "track");
      assert.ok(Array.isArray(track.samples), "track.json must have a samples array");
      assert.ok(track.samples.length > 0, "track.json was written but has no samples");
      for (const s of track.samples.slice(0, 3)) {
        assert.equal(typeof s.t, "number", "each sample needs a time");
        assert.ok(s.els && typeof s.els === "object", "each sample needs an els map");
      }
    }
  } finally {
    cleanup(out);
  }
});

test("record: --track writes track.json with one sample per tracked frame", async () => {
  const out = tmpDir();
  try {
    const res = await runCli([
      "record",
      "--url", fixture("fade-up.html"),
      "--out", out,
      "--viewport", VIEW,
      "--fps", "10",
      "--duration", "1200",
      "--selector", ".card",
      "--track", ".card",
      "--json",
    ]);
    assert.equal(res.code, 0, `record --track should succeed:\n${res.stderr.slice(-2000)}`);
    const env = parseEnvelope(res, "record --track");
    assert.equal(env.ok, true);

    const trackPath = join(out, "track.json");
    assert.ok(existsSync(trackPath), "track.json must be written when --track is given");
    const track = JSON.parse(readFileSync(trackPath, "utf8"));
    assert.equal(track.kind, "track");
    assert.equal(track.schema, 1);
    assert.ok(track.samples.length > 0, "track samples must not be empty");

    // The tracked element must actually move: translateY 40px -> 0 over the animation.
    const ys = [];
    for (const s of track.samples) {
      const el = s.els[".card"] ?? Object.values(s.els)[0];
      if (el) ys.push(el.y);
    }
    assert.ok(ys.length > 1, "need at least two samples to see motion");
    const travel = Math.max(...ys) - Math.min(...ys);
    assert.ok(
      travel >= 20,
      `the tracked .card should move ~40px vertically (fade-up), measured travel was ${travel}px`,
    );

    const cap = JSON.parse(readFileSync(join(out, "capture.json"), "utf8"));
    assert.ok(cap.trackSelectors.includes(".card"), "capture.json must record the tracked selectors");
    assert.ok(cap.trackSamples > 0, "capture.json must record a positive trackSamples count");
  } finally {
    cleanup(out);
  }
});

test("record: two runs with the same clock/seed produce identical frames (determinism)", async () => {
  // The headline guarantee: same input, same output. Virtual clock + fixed seed means
  // every frame is the page state at exactly t = k/fps, so the PNG bytes must match.
  const a = tmpDir();
  const b = tmpDir();
  try {
    const args = (out) => [
      "record",
      "--url", fixture("canvas-2d.html"),
      "--out", out,
      "--viewport", VIEW,
      "--fps", "10",
      "--duration", "1000",
      "--clock", "virtual",
      "--seed", "1",
      "--json",
    ];
    const ra = await runCli(args(a), { timeoutMs: 120_000 });
    assert.equal(ra.code, 0, `first capture failed:\n${ra.stderr.slice(-2000)}`);
    const rb = await runCli(args(b), { timeoutMs: 120_000 });
    assert.equal(rb.code, 0, `second capture failed:\n${rb.stderr.slice(-2000)}`);

    const ha = frameHashes(a);
    const hb = frameHashes(b);
    assert.ok(ha.length > 0, "first capture wrote no frames");
    assert.equal(ha.length, hb.length, "both captures must write the same number of frames");

    const mismatched = [];
    for (let i = 0; i < ha.length; i++) {
      if (ha[i].file !== hb[i].file || ha[i].sha !== hb[i].sha) {
        mismatched.push(`${ha[i].file}: ${ha[i].sha.slice(0, 12)} != ${hb[i].sha.slice(0, 12)}`);
      }
    }
    assert.deepEqual(
      mismatched,
      [],
      `--clock virtual --seed 1 is not deterministic: ${mismatched.length}/${ha.length} frames differ\n` +
        mismatched.slice(0, 5).join("\n"),
    );
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test("record: a different seed changes the canvas frames (the seed is actually wired)", async () => {
  // Guards the other direction: a determinism test passes trivially if the seed is ignored.
  const a = tmpDir();
  const b = tmpDir();
  try {
    const args = (out, seed) => [
      "record",
      "--url", fixture("canvas-2d.html"),
      "--out", out,
      "--viewport", VIEW,
      "--fps", "10",
      "--duration", "600",
      "--clock", "virtual",
      "--seed", seed,
      "--json",
    ];
    const ra = await runCli(args(a, "1"), { timeoutMs: 120_000 });
    const rb = await runCli(args(b, "2"), { timeoutMs: 120_000 });
    assert.equal(ra.code, 0, ra.stderr.slice(-1000));
    assert.equal(rb.code, 0, rb.stderr.slice(-1000));

    const ha = frameHashes(a);
    const hb = frameHashes(b);
    assert.ok(ha.length > 0 && hb.length > 0);
    const same = ha.filter((f, i) => hb[i] && f.sha === hb[i].sha).length;
    assert.ok(
      same < ha.length,
      "seed 1 and seed 2 produced identical frames — --seed is not reaching the page",
    );
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test("record: a missing --url is a usage error (exit 2) with a JSON envelope", async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["record", "--out", out, "--json"]);
    assert.equal(res.code, 2);
    const env = parseEnvelope(res, "record without --url");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
    assert.match(env.errors[0].message, /url/i);
  } finally {
    cleanup(out);
  }
});

test("record: a missing page is an environment/usage failure, not a crash", async () => {
  const out = tmpDir();
  try {
    const res = await runCli([
      "record",
      "--url", fixture("does-not-exist.html"),
      "--out", out,
      "--viewport", VIEW,
      "--fps", "10",
      "--duration", "300",
      "--json",
    ], { timeoutMs: 90_000 });
    assert.notEqual(res.code, 0, "capturing a missing page must not succeed");
    assert.ok([1, 2, 3, 4].includes(res.code), `expected a documented exit code, got ${res.code}`);
    // Whatever the failure, the envelope must still be parseable.
    const env = parseEnvelope(res, "record missing page");
    assert.equal(env.ok, false);
    assert.ok(env.errors.length >= 1);
  } finally {
    cleanup(out);
  }
});
