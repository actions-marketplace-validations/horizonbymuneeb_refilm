// Integration: `refilm spec` — the contract the implementer builds against.
//
// The fade-up fixture declares, in CSS, exactly what spec must report:
//   3 cards, opacity 0->1 and translateY 40px->0, 900ms,
//   cubic-bezier(0.22,1,0.36,1), stagger 120ms, all declared on load.
// Every assertion here traces back to that declaration, so a spec that invents
// or drops a value fails rather than passing by agreeing with itself.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

const VIEW = "640x480";

async function captureFadeUp(out) {
  const res = await runCli([
    "record",
    "--url", fixture("fade-up.html"),
    "--out", out,
    "--viewport", VIEW,
    "--fps", "25",
    "--duration", "1200",
    "--trigger", "load",
    "--json",
  ], { timeoutMs: 180_000 });
  assert.equal(res.code, 0, `capture failed:\n${res.stderr.slice(-2000)}`);
  return out;
}

test("spec: rows are present, declared, and carry the fixture's real numbers", async () => {
  const cap = tmpDir();
  const out = tmpDir();
  try {
    await captureFadeUp(cap);
    const specPath = join(out, "spec.json");
    const res = await runCli(["spec", "--capture", cap, "--out", specPath, "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, `spec should succeed:\n${res.stderr.slice(-2000)}`);

    const env = parseEnvelope(res, "spec");
    assert.equal(env.ok, true);
    const s = env.data.spec;
    assert.equal(s.kind, "spec");
    assert.equal(s.schema, 1);
    assert.equal(s.fidelity, "motion");
    assert.equal(s.trigger, "load");
    assert.deepEqual(s.viewport, { width: 640, height: 480 });
    assert.equal(s.fps, 25);

    // ---- rows exist and are well formed
    assert.ok(Array.isArray(s.rows) && s.rows.length > 0, "spec must produce rows");
    for (const r of s.rows) {
      assert.equal(typeof r.id, "string");
      assert.equal(typeof r.element, "string");
      assert.equal(typeof r.property, "string");
      assert.ok(["high", "medium", "low"].includes(r.confidence), `bad confidence ${r.confidence}`);
      assert.ok(
        ["declared", "track", "gl-track", "frames", "unknown"].includes(r.source),
        `bad source ${r.source}`,
      );
    }

    // ---- source is "declared" for a CSS fixture: nothing had to be measured
    const sources = new Set(s.rows.map((r) => r.source));
    assert.deepEqual([...sources], ["declared"], `a CSS fixture must be declared, saw ${[...sources]}`);

    // ---- the two properties that actually animate
    const props = new Set(s.rows.map((r) => r.property));
    assert.ok(props.has("opacity"), `opacity row missing, saw ${[...props]}`);
    assert.ok(props.has("translateY"), `translateY row missing, saw ${[...props]}`);

    // ---- 900ms duration, declared once per row
    for (const r of s.rows) {
      assert.ok(
        r.durationMs !== null && Math.abs(r.durationMs - 900) <= 1,
        `${r.element}.${r.property}: expected a 900ms duration, got ${r.durationMs}`,
      );
    }

    // ---- the declared cubic-bezier and its family
    for (const r of s.rows) {
      assert.ok(r.easing, `${r.element}.${r.property}: easing must be declared`);
      assert.match(r.easing, /cubic-bezier\(\s*0?\.22\s*,\s*1\s*,\s*0?\.36\s*,\s*1\s*\)/, `easing ${r.easing}`);
      assert.equal(r.easingFamily, "ease-out", `${r.element}: family should be ease-out, got ${r.easingFamily}`);
    }

    // ---- the travel distance: 40px -> 0
    const travel = s.rows.find((r) => r.property === "translateY");
    assert.ok(travel, "a translateY row must exist");
    assert.ok(Math.abs(Number(travel.from) - 40) <= 1, `translateY from should be 40, got ${travel.from}`);
    assert.ok(Math.abs(Number(travel.to) - 0) <= 1, `translateY to should be 0, got ${travel.to}`);

    const opacity = s.rows.find((r) => r.property === "opacity");
    assert.ok(opacity, "an opacity row must exist");
    assert.equal(Number(opacity.from), 0);
    assert.equal(Number(opacity.to), 1);

    // ---- stagger: 120ms between the three cards
    // Cards start at 0 / 120 / 240ms. A spec that reports no stagger tells the
    // implementer to animate them all at once, which is a wrong clone.
    const starts = [...new Set(s.rows.map((r) => r.startMs))].filter((v) => v !== null).sort((a, b) => a - b);
    assert.ok(starts.length >= 3, `expected three distinct start times, saw ${JSON.stringify(starts)}`);
    const gaps = starts.slice(1).map((v, i) => Math.round((v - starts[i]) * 10) / 10);
    for (const g of gaps) {
      assert.ok(Math.abs(g - 120) <= 2, `stagger gap should be ~120ms, got ${JSON.stringify(gaps)}`);
    }
    const staggers = s.rows.map((r) => r.staggerMs).filter((v) => v !== null);
    assert.ok(staggers.length > 0, "staggerMs must be populated for a staggered page");
    for (const st of staggers) {
      assert.ok(Math.abs(st - 120) <= 2, `staggerMs should be ~120, got ${st}`);
    }

    // ---- totalMs covers the last card finishing: 240 + 900
    assert.ok(Math.abs(s.totalMs - 1140) <= 30, `totalMs should be ~1140, got ${s.totalMs}`);

    // ---- artifacts
    assert.ok(existsSync(specPath), "spec must write spec.json");
    const onDisk = JSON.parse(readFileSync(specPath, "utf8"));
    assert.equal(onDisk.kind, "spec");
    assert.equal(onDisk.rows.length, s.rows.length);
  } finally {
    cleanup(cap);
    cleanup(out);
  }
});

test("spec: --frames builds rows from a video when there is no DOM", async () => {
  // A pixel-only path must still produce rows, flagged low-confidence because
  // element identity cannot be known from pixels.
  const out = tmpDir();
  try {
    const res = await runCli(
      ["spec", "--frames", fixture("clip.mp4"), "--out", join(out, "spec.json"), "--json"],
      { timeoutMs: 120_000 },
    );
    assert.equal(res.code, 0, `spec --frames should succeed:\n${res.stderr.slice(-2000)}`);
    const s = parseEnvelope(res, "spec --frames").data.spec;
    assert.equal(s.kind, "spec");
    assert.ok(Array.isArray(s.rows));
    for (const r of s.rows) {
      assert.equal(r.source, "frames", "a frames-only spec must mark its rows as coming from frames");
      assert.equal(r.confidence, "low", "a frames-only row is low confidence by definition");
    }
  } finally {
    cleanup(out);
  }
});

test("spec: no input is a usage error with exit 2", async () => {
  const out = tmpDir();
  try {
    const res = await runCli(["spec", "--out", join(out, "spec.json"), "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 2);
    const env = parseEnvelope(res, "spec no input");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(out);
  }
});

test("spec: a capture directory that does not exist is a usage error", async () => {
  const out = tmpDir();
  try {
    const res = await runCli(
      ["spec", "--capture", "/nonexistent/capture", "--out", join(out, "spec.json"), "--json"],
      { timeoutMs: 60_000 },
    );
    assert.equal(res.code, 2, `expected exit 2, got ${res.code}`);
    const env = parseEnvelope(res, "spec missing capture");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(out);
  }
});

// BUG #4 (reported to the Lead, authoring owns the fix): spec treats --out as a FILE
// path, while every other command treats --out as a directory. Writing to an existing
// directory therefore dies with EISDIR and, worse, reports it as INTERNAL (exit 4),
// which reads as "refilm is broken" rather than "wrong argument shape".
// This test encodes the intended contract so the fix is verified, not assumed.
test("spec: --out pointing at an existing directory writes <out>/spec.json", async () => {
  const cap = tmpDir();
  const out = tmpDir(); // already exists — this is the failing case
  try {
    await captureFadeUp(cap);
    const res = await runCli(["spec", "--capture", cap, "--out", out, "--json"], { timeoutMs: 120_000 });

    assert.notEqual(
      res.code,
      4,
      `spec --out <existing dir> returned INTERNAL (exit 4); that code means refilm itself is broken. ` +
        `stdout: ${res.stdout.slice(0, 400)}`,
    );
    assert.equal(res.code, 0, `spec --out <dir> should succeed:\n${res.stdout.slice(0, 800)}`);
    assert.ok(existsSync(join(out, "spec.json")), "--out <dir> must write <dir>/spec.json");

    const env = parseEnvelope(res, "spec --out dir");
    assert.equal(env.ok, true);
    const onDisk = JSON.parse(readFileSync(join(out, "spec.json"), "utf8"));
    assert.equal(onDisk.kind, "spec");
    assert.ok(onDisk.rows.length > 0);
  } finally {
    cleanup(cap);
    cleanup(out);
  }
});
