// Integration: `refilm accept` — moving the baseline without losing the history.
//
// The command is small but it is the one place a tool can silently destroy evidence,
// so every behaviour below is asserted: the backup exists, the frames really moved,
// the audit trail records why, and --dry-run writes nothing at all.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

function png(name) {
  // listFrames only looks at the extension; the bytes are irrelevant to the copy.
  return name;
}

function makeCapture(root, frameCount, url) {
  const frames = join(root, "frames");
  mkdirSync(frames, { recursive: true });
  for (let index = 0; index < frameCount; index += 1) {
    writeFileSync(join(frames, png(`${String(index).padStart(4, "0")}.png`)), "png");
  }
  writeFileSync(
    join(root, "capture.json"),
    JSON.stringify({ schema: 1, kind: "capture", url, fps: 25, frameCount }),
  );
  writeFileSync(join(root, "frames.json"), JSON.stringify({ fps: 25, count: frameCount }));
  return root;
}

test("accept: promotes the clone, backs up the old reference and writes the audit trail", async () => {
  const dir = tmpDir("accept");
  try {
    const ref = makeCapture(join(dir, "ref"), 3, "file:///ref.html");
    const clone = makeCapture(join(dir, "clone"), 5, "file:///clone.html");

    const res = await runCli(["accept", "--ref", ref, "--from", clone, "--reason", "new easing, DS-214", "--json"]);
    assert.equal(res.code, 0, res.stderr);

    const payload = parseEnvelope(res);
    assert.equal(payload.data.written, true);
    assert.equal(payload.data.copied, 5);
    assert.equal(payload.data.previousFrames, 3);

    assert.equal(readdirSync(join(ref, "frames")).length, 5, "the reference now holds the clone's frames");
    assert.ok(existsSync(payload.data.backup), "a backup directory is created");
    assert.equal(readdirSync(join(payload.data.backup, "frames")).length, 3, "the backup holds the old frames");
    assert.equal(
      JSON.parse(readFileSync(join(ref, "capture.json"), "utf8")).url,
      "file:///clone.html",
      "the capture metadata follows the frames",
    );

    const history = readFileSync(join(ref, "ACCEPTED.md"), "utf8");
    assert.match(history, /# Accepted baselines/);
    assert.match(history, /accepted: 5 frame/);
    assert.match(history, /previous reference: 3 frame/);
    assert.match(history, /new easing, DS-214/);
  } finally {
    cleanup(dir);
  }
});

test("accept: a second accept appends instead of replacing the trail", async () => {
  const dir = tmpDir("accept-twice");
  try {
    const ref = makeCapture(join(dir, "ref"), 2, "file:///ref.html");
    const first = makeCapture(join(dir, "clone-a"), 3, "file:///a.html");
    const second = makeCapture(join(dir, "clone-b"), 4, "file:///b.html");

    assert.equal((await runCli(["accept", "--ref", ref, "--from", first, "--reason", "first move"])).code, 0);
    assert.equal((await runCli(["accept", "--ref", ref, "--from", second, "--reason", "second move"])).code, 0);

    const history = readFileSync(join(ref, "ACCEPTED.md"), "utf8");
    assert.match(history, /first move/);
    assert.match(history, /second move/);
    assert.equal(readdirSync(join(ref, "frames")).length, 4);
  } finally {
    cleanup(dir);
  }
});

test("accept --dry-run: prints the plan and writes nothing", async () => {
  const dir = tmpDir("accept-dry");
  try {
    const ref = makeCapture(join(dir, "ref"), 2, "file:///ref.html");
    const clone = makeCapture(join(dir, "clone"), 3, "file:///clone.html");
    const before = readdirSync(dir).sort();

    const res = await runCli(["accept", "--ref", ref, "--from", clone, "--dry-run"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /dry run — nothing written/);
    assert.equal(readdirSync(join(ref, "frames")).length, 2, "the reference is untouched");
    assert.deepEqual(readdirSync(dir).sort(), before, "no backup directory is created");
    assert.equal(existsSync(join(ref, "ACCEPTED.md")), false, "no audit trail is written");
  } finally {
    cleanup(dir);
  }
});

test("accept: missing flags and an empty clone are usage errors with a hint", async () => {
  const dir = tmpDir("accept-usage");
  try {
    const ref = makeCapture(join(dir, "ref"), 1, "file:///ref.html");
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });

    const noRef = await runCli(["accept", "--from", ref]);
    assert.equal(noRef.code, 2);
    assert.match(noRef.stderr, /--ref/);

    const noFrames = await runCli(["accept", "--ref", ref, "--from", empty]);
    assert.equal(noFrames.code, 2);
    assert.match(noFrames.stderr, /no frames/i);
  } finally {
    cleanup(dir);
  }
});

test("accept: a frames directory without the capture wrapper still works", async () => {
  const dir = tmpDir("accept-flat");
  try {
    const ref = makeCapture(join(dir, "ref"), 2, "file:///ref.html");
    const flat = join(dir, "flat");
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "0000.png"), "png");

    const res = await runCli(["accept", "--ref", ref, "--from", flat, "--json"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(parseEnvelope(res).data.copied, 1);
    assert.equal(readdirSync(join(ref, "frames")).length, 1);
  } finally {
    cleanup(dir);
  }
});
