// Unit tests for the shared primitives in dist/lib.js.
//
// These assert the documented behaviour only: argument shapes, number coercion,
// the JSON envelope, exit codes and ffmpeg resolution order. Nothing here depends
// on how a command formats its human output.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir, cleanup, DIST, REPO } from "../helpers.js";

const LIB = pathToFileURL(join(DIST, "lib.js")).href;

/** A fresh lib.js instance, so module-level caches (ffmpegPath) do not leak between tests. */
let bust = 0;
const freshLib = () => import(`${LIB}?bust=${++bust}`);
const lib = await freshLib();

// ------------------------------------------------------------------ parseArgs

test("parseArgs: --key value pairs", () => {
  const a = lib.parseArgs(["--url", "page.html", "--out", "run"]);
  assert.equal(a.url, "page.html");
  assert.equal(a.out, "run");
  assert.deepEqual(a._, []);
});

test("parseArgs: --key=value form, including values containing '='", () => {
  const a = lib.parseArgs(["--fps=30", "--url=http://x.test/?a=1&b=2"]);
  assert.equal(a.fps, "30");
  assert.equal(a.url, "http://x.test/?a=1&b=2");
});

test("parseArgs: bare flag is true", () => {
  const a = lib.parseArgs(["--json", "--headed"]);
  assert.equal(a.json, true);
  assert.equal(a.headed, true);
});

test("parseArgs: a value starting with -- is the next flag, not a value", () => {
  const a = lib.parseArgs(["--headed", "--url", "x.html"]);
  assert.equal(a.headed, true, "--headed must not swallow --url");
  assert.equal(a.url, "x.html");
});

test("parseArgs: repeated keys collect into an array in order", () => {
  const a = lib.parseArgs(["--track", "#a", "--track", "#b", "--track", "#c"]);
  assert.deepEqual(a.track, ["#a", "#b", "#c"]);
});

test("parseArgs: repeated bare flags collect too", () => {
  const a = lib.parseArgs(["--x", "--x"]);
  assert.deepEqual(a.x, [true, true]);
});

test("parseArgs: positionals land in _ in order", () => {
  const a = lib.parseArgs(["alpha", "--k", "v", "beta"]);
  assert.deepEqual(a._, ["alpha", "beta"]);
  assert.equal(a.k, "v");
});

test("parseArgs: defaults are applied but overridden by argv", () => {
  const a = lib.parseArgs(["--fps", "60"], { fps: 25, clock: "real" });
  assert.equal(a.fps, "60");
  assert.equal(a.clock, "real");
});

test("parseArgs: empty argv keeps defaults and an empty positional list", () => {
  const a = lib.parseArgs([], { fps: 25 });
  assert.deepEqual(a._, []);
  assert.equal(a.fps, 25);
});

// ------------------------------------------------------------------ parseTime

test("parseTime: the four documented forms all resolve to seconds", () => {
  assert.equal(lib.parseTime("1:23.5"), 83.5, "m:ss.s");
  assert.equal(lib.parseTime("83.5"), 83.5, "bare seconds");
  assert.equal(lib.parseTime("83.5s"), 83.5, "seconds suffix");
  assert.equal(lib.parseTime("1500ms"), 1.5, "milliseconds");
});

test("parseTime: hours form", () => {
  assert.equal(lib.parseTime("1:00:00"), 3600);
  assert.equal(lib.parseTime("0:01:23.5"), 83.5);
});

test("parseTime: unparseable and absent values return undefined", () => {
  assert.equal(lib.parseTime(undefined), undefined);
  assert.equal(lib.parseTime(true), undefined, "a bare flag has no value");
  assert.equal(lib.parseTime("abc"), undefined);
});

test("parseTime: numeric input is accepted", () => {
  assert.equal(lib.parseTime(10), 10);
});

// ------------------------------------------------------------------ parseSize

test("parseSize: WxH parses to a viewport object", () => {
  assert.deepEqual(lib.parseSize("640x480", { width: 1, height: 1 }), { width: 640, height: 480 });
  assert.deepEqual(lib.parseSize("1440x900", { width: 1, height: 1 }), { width: 1440, height: 900 });
});

test("parseSize: absent value returns the fallback unchanged", () => {
  const fallback = { width: 1280, height: 720 };
  assert.deepEqual(lib.parseSize(undefined, fallback), fallback);
});

test("parseSize: malformed value is a USAGE error with exit 2", () => {
  for (const bad of ["bogus", "640", "640*480", "x480", "640x"]) {
    assert.throws(
      () => lib.parseSize(bad, { width: 1, height: 1 }),
      (err) => {
        assert.ok(err instanceof lib.RefilmError, `${bad}: must be a RefilmError`);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exit, lib.EXIT.USAGE);
        assert.equal(err.exit, 2);
        return true;
      },
      `parseSize(${JSON.stringify(bad)}) should throw`,
    );
  }
});

// ------------------------------------------------------------------ parseRect

test("parseRect: x,y,w,h parses to a rect", () => {
  assert.deepEqual(lib.parseRect("10,20,300,200"), { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(lib.parseRect("0,0,1,1"), { x: 0, y: 0, width: 1, height: 1 });
});

test("parseRect: absent value returns undefined", () => {
  assert.equal(lib.parseRect(undefined), undefined);
  assert.equal(lib.parseRect(true), undefined);
});

test("parseRect: wrong component count or non-numbers is a USAGE error", () => {
  for (const bad of ["1,2,3", "1,2,3,4,5", "a,b,c,d", "1,2,3,x"]) {
    assert.throws(
      () => lib.parseRect(bad),
      (err) => err instanceof lib.RefilmError && err.code === "USAGE" && err.exit === 2,
      `parseRect(${JSON.stringify(bad)}) should throw USAGE`,
    );
  }
});

// ------------------------------------------------------------------ num/str/bool/list

test("num: numbers pass through, non-numbers and bare flags fall back", () => {
  assert.equal(lib.num("30", 25), 30);
  assert.equal(lib.num(30, 25), 30);
  assert.equal(lib.num(undefined, 25), 25);
  assert.equal(lib.num(true, 25), 25, "a bare flag is not the number 1");
  assert.equal(lib.num("nope", 25), 25);
  assert.equal(lib.num(Infinity, 25), 25);
});

test("num: repeated keys take the first value", () => {
  assert.equal(lib.num(["7", "9"], 25), 7);
});

test("str: returns strings, undefined for absent/bare flags, first of repeats", () => {
  assert.equal(lib.str("x"), "x");
  assert.equal(lib.str(42), "42");
  assert.equal(lib.str(undefined), undefined);
  assert.equal(lib.str(true), undefined);
  assert.equal(lib.str(["a", "b"]), "a");
});

test("bool: only false/0/no are false; a bare flag is true", () => {
  assert.equal(lib.bool(undefined), false);
  assert.equal(lib.bool(true), true);
  assert.equal(lib.bool("true"), true);
  assert.equal(lib.bool("yes"), true);
  assert.equal(lib.bool("1"), true);
  assert.equal(lib.bool("false"), false);
  assert.equal(lib.bool("FALSE"), false);
  assert.equal(lib.bool("0"), false);
  assert.equal(lib.bool("no"), false);
});

test("list: splits on commas, flattens repeats, trims, drops empties", () => {
  assert.deepEqual(lib.list("a,b"), ["a", "b"]);
  assert.deepEqual(lib.list(["a", "b"]), ["a", "b"]);
  assert.deepEqual(lib.list(["#a,#b", "#c"]), ["#a", "#b", "#c"]);
  assert.deepEqual(lib.list(" a , , b "), ["a", "b"]);
  assert.deepEqual(lib.list(undefined), []);
  assert.deepEqual(lib.list(true), [], "a bare flag carries no selectors");
});

// ------------------------------------------------------------------ pad

test("pad: zero-pads to width 4 by default", () => {
  assert.equal(lib.pad(0), "0000");
  assert.equal(lib.pad(7), "0007");
  assert.equal(lib.pad(42), "0042");
  assert.equal(lib.pad(9999), "9999");
});

test("pad: custom width, and numbers longer than the width are not truncated", () => {
  assert.equal(lib.pad(7, 2), "07");
  assert.equal(lib.pad(0, 3), "000");
  assert.equal(lib.pad(12345), "12345");
  assert.equal(lib.pad(12345, 3), "12345");
});

// ------------------------------------------------------------------ listFrames

test("listFrames: returns only .png files, sorted, as full paths", () => {
  const dir = tmpDir();
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of ["frame-10.png", "frame-2.png", "frame-1.png", "notes.txt", "frame-3.PNG"]) {
      writeFileSync(join(dir, f), "");
    }
    const got = lib.listFrames(dir).map((p) => p.split("/").pop());
    // Lexical sort: the zero-padded naming the CLI writes is what makes this correct.
    assert.deepEqual(got, ["frame-1.png", "frame-10.png", "frame-2.png", "frame-3.PNG"]);
    for (const p of lib.listFrames(dir)) assert.ok(p.startsWith(dir), "paths must be absolute to the dir");
  } finally {
    cleanup(dir);
  }
});

test("listFrames: zero-padded frame names sort numerically", () => {
  const dir = tmpDir();
  try {
    for (const i of [10, 2, 1, 0]) writeFileSync(join(dir, `${lib.pad(i)}.png`), "");
    const got = lib.listFrames(dir).map((p) => p.split("/").pop());
    assert.deepEqual(got, ["0000.png", "0001.png", "0002.png", "0010.png"]);
  } finally {
    cleanup(dir);
  }
});

test("listFrames: a missing directory is an empty list, not a throw", () => {
  assert.deepEqual(lib.listFrames(join(tmpDir(), "does-not-exist")), []);
});

// ------------------------------------------------------------------ readJson

test("readJson: valid JSON round-trips", () => {
  const dir = tmpDir();
  try {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ schema: 1, kind: "capture", n: [1, 2, 3] }));
    assert.deepEqual(lib.readJson(p), { schema: 1, kind: "capture", n: [1, 2, 3] });
  } finally {
    cleanup(dir);
  }
});

test("readJson: bad JSON throws a RefilmError, not a raw SyntaxError", () => {
  const dir = tmpDir();
  try {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ this is not json ");
    assert.throws(
      () => lib.readJson(p),
      (err) => {
        assert.ok(err instanceof lib.RefilmError, `expected RefilmError, got ${err.constructor.name}`);
        assert.equal(err.name, "RefilmError");
        assert.equal(err.code, "BAD_JSON");
        assert.equal(err.exit, lib.EXIT.INTERNAL);
        assert.ok(err.message.includes(p), "the message must name the file so the user can find it");
        return true;
      },
    );
  } finally {
    cleanup(dir);
  }
});

test("readJson: a missing file also throws a RefilmError", () => {
  assert.throws(
    () => lib.readJson("/nonexistent/definitely/not/here.json"),
    (err) => err instanceof lib.RefilmError && err.code === "BAD_JSON",
  );
});

// ------------------------------------------------------------------ emitError envelope

/** Capture everything emitError writes to stdout without touching the real stream. */
function captureStdout(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    return { value: fn(), text: out.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("emitError: the JSON envelope has the documented shape", () => {
  const err = new lib.RefilmError("USAGE", "boom", lib.EXIT.USAGE, "do the thing");
  const { value, text } = captureStdout(() => lib.emitError("record", err, true));
  assert.equal(value, 2, "emitError returns the error's exit code");

  const env = JSON.parse(text);
  assert.deepEqual(Object.keys(env).sort(), ["command", "errors", "ok", "version", "warnings"]);
  assert.equal(env.ok, false);
  assert.equal(env.command, "record");
  assert.equal(env.version, lib.VERSION);
  assert.deepEqual(env.warnings, []);
  assert.ok(Array.isArray(env.errors) && env.errors.length === 1);
  assert.deepEqual(Object.keys(env.errors[0]).sort(), ["code", "hint", "message"]);
  assert.equal(env.errors[0].code, "USAGE");
  assert.equal(env.errors[0].message, "boom");
  assert.equal(env.errors[0].hint, "do the thing");
});

test("emitError: a plain Error becomes an INTERNAL error with exit 4", () => {
  const { value, text } = captureStdout(() => lib.emitError("verify", new Error("kaboom"), true));
  assert.equal(value, lib.EXIT.INTERNAL);
  assert.equal(value, 4);
  const env = JSON.parse(text);
  assert.equal(env.ok, false);
  assert.equal(env.command, "verify");
  assert.equal(env.errors[0].code, "INTERNAL");
  assert.equal(env.errors[0].message, "kaboom");
  assert.equal(env.errors[0].hint, null, "a missing hint is null, never undefined/absent");
});

test("emitError: a non-Error throw is stringified, never crashes the envelope", () => {
  const { value, text } = captureStdout(() => lib.emitError("spec", "just a string", true));
  assert.equal(value, 4);
  const env = JSON.parse(text);
  assert.equal(env.errors[0].code, "INTERNAL");
  assert.equal(env.errors[0].message, "just a string");
});

test("emitError: environment errors carry exit 3", () => {
  const err = lib.envError("ffmpeg not found", "install ffmpeg");
  assert.equal(err.exit, 3);
  const { value } = captureStdout(() => lib.emitError("doctor", err, true));
  assert.equal(value, 3);
});

test("emitError: without --json it writes to stderr and prints no JSON", () => {
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let value;
  const out = [];
  const origLog = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    value = lib.emitError("record", err("REC", "nope", 2), false);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  assert.equal(value, 2);
  assert.equal(out.length, 0, "human mode must not write JSON to stdout");
  assert.ok(errs.join("\n").includes("nope"));
});

function err(code, message, exit) {
  return new lib.RefilmError(code, message, exit);
}

// ------------------------------------------------------------------ reporter

test("reporter: emit() is silent unless --json, and then it is one valid envelope", () => {
  const quiet = lib.reporter("record", { json: false });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    quiet.emit("record", { a: 1 });
    quiet.say("human line");
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1, "only say() prints in human mode");
  assert.equal(lines[0], "human line");

  const json = lib.reporter("record", { json: true });
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  try {
    json.emit("record", { a: 1 });
    json.say("suppressed");
  } finally {
    console.log = orig;
  }
  assert.equal(out.length, 1, "only emit() prints in json mode");
  const env = JSON.parse(out[0]);
  assert.equal(env.ok, true);
  assert.equal(env.command, "record");
  assert.deepEqual(env.data, { a: 1 });
});

test("reporter: warn() records warnings that reach the envelope", () => {
  const r = lib.reporter("compare", { json: true });
  const origErr = console.error;
  console.error = () => {};
  try {
    r.warn("capture.json disagrees");
  } finally {
    console.error = origErr;
  }
  const out = [];
  const origLog = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    r.emit("compare", { pass: true });
  } finally {
    console.log = origLog;
  }
  const env = JSON.parse(out[0]);
  assert.deepEqual(env.warnings, ["capture.json disagrees"]);
});

// ------------------------------------------------------------------ exit codes

test("EXIT: the documented codes are stable", () => {
  assert.deepEqual(lib.EXIT, { OK: 0, VERIFY_FAILED: 1, USAGE: 2, ENVIRONMENT: 3, INTERNAL: 4 });
});

test("VERSION is a semver string", () => {
  assert.match(lib.VERSION, /^\d+\.\d+\.\d+/);
});

// ------------------------------------------------------------------ ffmpegPath

test("ffmpegPath: REFILM_FFMPEG wins when it points at an existing file", async () => {
  const dir = tmpDir();
  const prev = process.env.REFILM_FFMPEG;
  try {
    const fake = join(dir, "my-ffmpeg");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    process.env.REFILM_FFMPEG = fake;
    const fresh = await freshLib();
    assert.equal(fresh.ffmpegPath(), fake, "the env override must be used verbatim");
  } finally {
    if (prev === undefined) delete process.env.REFILM_FFMPEG;
    else process.env.REFILM_FFMPEG = prev;
    cleanup(dir);
  }
});

test("ffmpegPath: a non-existent REFILM_FFMPEG is ignored, not trusted", async () => {
  const prev = process.env.REFILM_FFMPEG;
  try {
    process.env.REFILM_FFMPEG = "/nonexistent/ffmpeg";
    const fresh = await freshLib();
    const got = fresh.ffmpegPath();
    assert.notEqual(got, "/nonexistent/ffmpeg");
    assert.ok(got === "ffmpeg" || got.endsWith("ffmpeg"), `expected a real ffmpeg, got ${got}`);
  } finally {
    if (prev === undefined) delete process.env.REFILM_FFMPEG;
    else process.env.REFILM_FFMPEG = prev;
  }
});

test("ffmpegPath: falls back to ffmpeg on PATH when there is no override", async () => {
  const prev = process.env.REFILM_FFMPEG;
  try {
    delete process.env.REFILM_FFMPEG;
    const fresh = await freshLib();
    assert.equal(fresh.ffmpegPath(), "ffmpeg");
  } finally {
    if (prev !== undefined) process.env.REFILM_FFMPEG = prev;
  }
});

test("ffmpegPath: missing ffmpeg is an ENVIRONMENT error with exit 3 and a fix hint", async () => {
  const prev = process.env.REFILM_FFMPEG;
  const prevPath = process.env.PATH;
  try {
    delete process.env.REFILM_FFMPEG;
    // An empty PATH cannot find ffmpeg, and no bundled binary exists in a dev checkout.
    process.env.PATH = "/nonexistent-bin-dir";
    const fresh = await freshLib();
    assert.throws(
      () => fresh.ffmpegPath(),
      (e) => {
        assert.ok(e instanceof fresh.RefilmError, "must be a RefilmError");
        assert.equal(e.exit, 3, "a missing tool is an environment problem");
        assert.equal(e.code, "ENVIRONMENT");
        assert.ok(e.hint && e.hint.length > 0, "must tell the user how to fix it");
        assert.match(e.hint, /ffmpeg/, "the hint should mention ffmpeg");
        return true;
      },
    );
  } finally {
    process.env.PATH = prevPath;
    if (prev !== undefined) process.env.REFILM_FFMPEG = prev;
  }
});

test("ffmpegPath: the resolved binary actually runs", () => {
  const bin = lib.ffmpegPath();
  assert.ok(bin === "ffmpeg" || readFileSync(bin, { encoding: null }).length > 0);
});

// ------------------------------------------------------------------ files

test("ensureDir / writeJson / writeText / exists / isDir / abs", () => {
  const dir = tmpDir();
  try {
    const nested = join(dir, "a", "b", "c");
    assert.equal(lib.ensureDir(nested), nested);
    assert.ok(lib.isDir(nested));

    const j = join(nested, "x.json");
    lib.writeJson(j, { hello: "world" });
    assert.ok(lib.exists(j));
    assert.deepEqual(lib.readJson(j), { hello: "world" });
    assert.ok(readFileSync(j, "utf8").endsWith("\n"), "written JSON ends with a newline");

    const t = join(nested, "x.txt");
    lib.writeText(t, "plain");
    assert.equal(readFileSync(t, "utf8"), "plain");

    assert.equal(lib.isDir(j), false, "a file is not a directory");
    assert.equal(lib.isDir("/nope/nope"), false, "a missing path is not a directory");
    assert.equal(lib.exists("/nope/nope"), false);

    assert.equal(lib.abs("rel/x"), join(REPO === "/" ? "/" : process.cwd(), "rel", "x"));
    assert.equal(lib.abs("/already/absolute"), "/already/absolute");
  } finally {
    cleanup(dir);
  }
});
