// Integration: `refilm verify` — the pass/fail gate.
//
// verify is the command an agent loops on, so its exit code is the product:
//   0 = the clone meets the spec
//   1 = it does not
// Anything else means the run itself failed. Both directions are asserted here,
// because a gate that always passes is worse than no gate.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

const VIEW = "640x480";

async function capture(url, out, extra = []) {
  // `extra` is merged over the defaults, not appended: a repeated flag would arrive
  // as an array and the first value (the default) would win.
  const flags = new Map([
    ["--viewport", VIEW],
    ["--fps", "25"],
    ["--duration", "1200"],
  ]);
  for (let i = 0; i < extra.length; i += 2) flags.set(extra[i], extra[i + 1]);
  const argv = ["record", "--url", url, "--out", out];
  for (const [k, v] of flags) argv.push(k, v);
  argv.push("--json");

  const res = await runCli(argv, { timeoutMs: 180_000 });
  assert.equal(res.code, 0, `capture of ${url} failed:\n${res.stderr.slice(-2000)}`);
  return out;
}

/** Build a spec from a capture, writing it as a file (the portable form). */
async function specOf(capDir, specPath) {
  const res = await runCli(["spec", "--capture", capDir, "--out", specPath, "--json"], { timeoutMs: 120_000 });
  assert.equal(res.code, 0, `spec failed:\n${res.stderr.slice(-2000)}`);
  return specPath;
}

test("verify: ref vs an identical clone passes with exit 0", async () => {
  const ref = tmpDir();
  const clone = tmpDir();
  const out = tmpDir();
  try {
    await capture(fixture("fade-up.html"), ref);
    await capture(fixture("fade-up.html"), clone);
    const spec = await specOf(ref, join(ref, "spec.json"));

    const res = await runCli([
      "verify",
      "--spec", spec,
      "--ref", ref,
      "--clone", clone,
      "--out", out,
      "--json",
    ], { timeoutMs: 180_000 });

    assert.equal(res.code, 0, `an identical clone must pass, exit was ${res.code}:\n${res.stdout.slice(0, 1500)}`);
    const env = parseEnvelope(res, "verify pass");
    assert.equal(env.ok, true);
    const v = env.data;
    assert.equal(v.kind, "verify");
    assert.equal(v.schema, 1);
    assert.equal(v.pass, true);
    assert.equal(v.counts.fail, 0, `a passing verify must report zero failures, got ${JSON.stringify(v.counts)}`);
    assert.ok(Array.isArray(v.checks) && v.checks.length > 0, "verify must report its checks");

    // Every check must be pass or skip — never fail.
    for (const c of v.checks) {
      assert.ok(["pass", "fail", "skip"].includes(c.status), `bad status ${c.status}`);
      assert.notEqual(c.status, "fail", `check "${c.id}" failed on an identical clone: ${c.detail}`);
      assert.equal(typeof c.id, "string");
      assert.equal(typeof c.label, "string");
      assert.ok("measured" in c, "each check reports what it measured");
      assert.ok("limit" in c);
    }

    // counts must agree with the checks array
    const tally = { pass: 0, fail: 0, skip: 0 };
    for (const c of v.checks) tally[c.status]++;
    assert.deepEqual(v.counts, tally, "counts must match the checks array");

    // artifacts
    assert.ok(v.artifacts && typeof v.artifacts === "object", "verify must report artifact paths");
    const vj = join(out, "verify.json");
    assert.ok(existsSync(vj), "verify must write verify.json");
    const onDisk = JSON.parse(readFileSync(vj, "utf8"));
    assert.equal(onDisk.pass, true);
  } finally {
    cleanup(ref);
    cleanup(clone);
    cleanup(out);
  }
});

test("verify: a deliberately wrong clone fails with exit 1 and names the failing check", async () => {
  const ref = tmpDir();
  const clone = tmpDir();
  const out = tmpDir();
  try {
    // The reference animates over 900ms; a 400ms clone cannot match it.
    await capture(fixture("fade-up.html"), ref);
    await capture(fixture("fade-up.html"), clone, ["--duration", "400"]);
    const spec = await specOf(ref, join(ref, "spec.json"));

    const res = await runCli([
      "verify",
      "--spec", spec,
      "--ref", ref,
      "--clone", clone,
      "--out", out,
      "--json",
    ], { timeoutMs: 180_000 });

    assert.equal(res.code, 1, `a wrong clone must exit 1, got ${res.code}:\n${res.stdout.slice(0, 1500)}`);
    const env = parseEnvelope(res, "verify fail");
    // The run succeeded; the verdict is in data.pass.
    assert.equal(env.ok, true, "verify ran; the failure is a verdict, not an error");
    const v = env.data;
    assert.equal(v.pass, false, "a wrong clone must not pass");
    assert.ok(v.counts.fail > 0, `expected at least one failed check, got ${JSON.stringify(v.counts)}`);

    const failed = v.checks.filter((c) => c.status === "fail");
    assert.ok(failed.length > 0, "a failed verify must have at least one check with status fail");
    for (const c of failed) {
      assert.equal(typeof c.id, "string");
      assert.ok(c.detail === undefined || typeof c.detail === "string");
    }
  } finally {
    cleanup(ref);
    cleanup(clone);
    cleanup(out);
  }
});

test("verify: a clone of a completely different page fails", async () => {
  // Structural mismatch, not a timing nudge: the strongest negative case.
  const ref = tmpDir();
  const clone = tmpDir();
  const out = tmpDir();
  try {
    await capture(fixture("fade-up.html"), ref);
    await capture(fixture("marquee.html"), clone);
    const spec = await specOf(ref, join(ref, "spec.json"));

    const res = await runCli([
      "verify",
      "--spec", spec,
      "--ref", ref,
      "--clone", clone,
      "--out", out,
      "--json",
    ], { timeoutMs: 180_000 });
    assert.equal(res.code, 1, `a clone of the wrong page must exit 1, got ${res.code}`);
    const v = parseEnvelope(res, "verify wrong page").data;
    assert.equal(v.pass, false);
    assert.ok(v.counts.fail > 0);
  } finally {
    cleanup(ref);
    cleanup(clone);
    cleanup(out);
  }
});

test("verify: --fidelity pixel on identical captures passes", async () => {
  const ref = tmpDir();
  const clone = tmpDir();
  const out = tmpDir();
  try {
    await capture(fixture("fade-up.html"), ref);
    await capture(fixture("fade-up.html"), clone);
    const spec = await specOf(ref, join(ref, "spec.json"));

    const res = await runCli([
      "verify",
      "--spec", spec,
      "--ref", ref,
      "--clone", clone,
      "--fidelity", "pixel",
      "--out", out,
      "--json",
    ], { timeoutMs: 180_000 });
    assert.equal(res.code, 0, `pixel fidelity on identical captures must pass:\n${res.stdout.slice(0, 1200)}`);
    const v = parseEnvelope(res, "verify pixel").data;
    assert.equal(v.fidelity, "pixel");
    assert.equal(v.pass, true);
    assert.equal(v.counts.fail, 0);
  } finally {
    cleanup(ref);
    cleanup(clone);
    cleanup(out);
  }
});

test("verify: a missing --spec is a usage error with exit 2", async () => {
  const ref = tmpDir();
  try {
    const res = await runCli(["verify", "--ref", ref, "--clone", ref, "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 2, `missing --spec should be a usage error, got ${res.code}`);
    const env = parseEnvelope(res, "verify no spec");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(ref);
  }
});

test("verify: a spec file that does not exist is a usage error, not a crash", async () => {
  const ref = tmpDir();
  const out = tmpDir();
  try {
    const res = await runCli([
      "verify",
      "--spec", "/nonexistent/spec.json",
      "--ref", ref,
      "--clone", ref,
      "--out", out,
      "--json",
    ], { timeoutMs: 60_000 });
    assert.equal(res.code, 2, `a missing spec file should be exit 2, got ${res.code}`);
    const env = parseEnvelope(res, "verify missing spec");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
  } finally {
    cleanup(ref);
    cleanup(out);
  }
});

test("verify: a malformed spec file reports a parseable error envelope", async () => {
  const ref = tmpDir();
  const out = tmpDir();
  try {
    const bad = join(ref, "spec.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bad, "{ not a spec ");
    const res = await runCli([
      "verify",
      "--spec", bad,
      "--ref", ref,
      "--clone", ref,
      "--out", out,
      "--json",
    ], { timeoutMs: 60_000 });
    assert.notEqual(res.code, 0, "a malformed spec must not pass");
    // Whatever the code, the envelope has to parse — that is the agent contract.
    const env = parseEnvelope(res, "verify bad spec");
    assert.equal(env.ok, false);
    assert.ok(env.errors.length >= 1);
  } finally {
    cleanup(ref);
    cleanup(out);
  }
});
