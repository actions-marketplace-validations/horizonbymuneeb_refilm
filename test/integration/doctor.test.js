// Integration: `refilm doctor` — the environment check.
//
// doctor is what a user runs when something is wrong, so it must always answer
// with a parseable report and a documented exit code, never a stack trace.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, cleanup, runCli, parseEnvelope, DIST } from "../helpers.js";

test("doctor: exits 0 or 3 and its JSON parses", async () => {
  const res = await runCli(["doctor", "--json"], { timeoutMs: 120_000 });
  assert.ok(
    res.code === 0 || res.code === 3,
    `doctor must exit 0 (healthy) or 3 (environment problem), got ${res.code}\nstdout: ${res.stdout.slice(0, 800)}`,
  );

  const env = parseEnvelope(res, "doctor");
  const d = env.data;

  // A failing doctor still reports a full structure: ok:false with the failing checks.
  if (res.code === 0) {
    assert.equal(env.ok, true, "exit 0 means the run succeeded");
  }
  assert.equal(d.kind, "doctor");
  assert.equal(d.schema, 1);
  assert.equal(typeof d.ok, "boolean");
  assert.ok(Array.isArray(d.checks) && d.checks.length > 0, "doctor must report its checks");

  for (const c of d.checks) {
    assert.equal(typeof c.id, "string", "every check has an id");
    assert.ok(["ok", "warn", "fail"].includes(c.status), `bad check status "${c.status}" for ${c.id}`);
    assert.equal(typeof c.detail, "string", `check ${c.id} needs a detail string`);
    if (c.fix !== undefined) assert.equal(typeof c.fix, "string", `check ${c.id}: fix must be a string`);
  }

  // The environment block is what users paste into a bug report.
  const e = d.environment;
  assert.ok(e && typeof e === "object", "doctor must report the environment");
  assert.equal(typeof e.node, "string");
  assert.equal(typeof e.platform, "string");
  assert.equal(typeof e.arch, "string");
  assert.equal(typeof e.version, "string");
  assert.ok("ffmpeg" in e, "the environment must say where ffmpeg was found (or null)");
  assert.ok("chromium" in e);
});

test("doctor: the exit code agrees with the report's ok flag", async () => {
  const res = await runCli(["doctor", "--json"], { timeoutMs: 120_000 });
  const d = parseEnvelope(res, "doctor consistency").data;
  const failed = d.checks.filter((c) => c.status === "fail");
  if (d.ok) {
    assert.equal(res.code, 0, "a healthy environment must exit 0");
    assert.equal(failed.length, 0, "ok:true with a failing check is contradictory");
  } else {
    assert.equal(res.code, 3, "an unhealthy environment must exit 3");
    assert.ok(failed.length > 0, "ok:false must name at least one failing check");
  }
});

test("doctor: reports the tooling this suite depends on", async () => {
  // node, ffmpeg and chromium are the three the test suite itself needs; if doctor
  // cannot see them it cannot help anyone debug a failing capture.
  const res = await runCli(["doctor", "--json"], { timeoutMs: 120_000 });
  const d = parseEnvelope(res, "doctor tools").data;
  const ids = d.checks.map((c) => c.id);
  for (const needed of ["node", "ffmpeg", "chromium"]) {
    assert.ok(ids.includes(needed), `doctor must check "${needed}", it checks ${JSON.stringify(ids)}`);
  }
});

test("doctor: human mode prints something readable and no JSON", async () => {
  const res = await runCli(["doctor"], { timeoutMs: 120_000 });
  assert.ok([0, 3].includes(res.code));
  assert.ok(res.stdout.trim().length > 0, "human mode must print a report");
  assert.throws(
    () => JSON.parse(res.stdout),
    "human mode should print prose, not a JSON document",
  );
});
