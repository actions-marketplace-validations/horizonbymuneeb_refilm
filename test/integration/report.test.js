// Integration: `refilm report` — one self-contained HTML file.
//
// The report is the deliverable a human opens, so the properties that matter are:
//   - it is produced at all, from a real run directory
//   - it is self-contained: no external src/href, so it opens offline and leaks nothing
//   - --check agrees with that, and exits 1 when the file is not clean
//   - a run directory with missing artefacts still reports, listing what is missing

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

const VIEW = "640x480";

/** Build a run directory: capture, spec, a clone, compare and verify. */
async function buildRun(dir) {
  const ref = join(dir, "ref");
  const clone = join(dir, "clone");
  const spec = join(dir, "spec.json");

  let r = await runCli([
    "record", "--url", fixture("fade-up.html"), "--out", ref,
    "--viewport", VIEW, "--fps", "25", "--duration", "1200", "--json",
  ], { timeoutMs: 180_000 });
  assert.equal(r.code, 0, `ref capture failed:\n${r.stderr.slice(-1500)}`);

  r = await runCli([
    "record", "--url", fixture("fade-up.html"), "--out", clone,
    "--viewport", VIEW, "--fps", "25", "--duration", "1200", "--json",
  ], { timeoutMs: 180_000 });
  assert.equal(r.code, 0, `clone capture failed:\n${r.stderr.slice(-1500)}`);

  r = await runCli(["spec", "--capture", ref, "--out", spec, "--json"], { timeoutMs: 120_000 });
  assert.equal(r.code, 0, `spec failed:\n${r.stderr.slice(-1500)}`);

  r = await runCli([
    "compare", "--ref", join(ref, "frames"), "--clone", join(clone, "frames"),
    "--out", join(dir, "compare-1"), "--json",
  ], { timeoutMs: 120_000 });
  // compare exits 0 for a pass; either way the artifacts exist.
  assert.ok([0, 1].includes(r.code), `compare failed unexpectedly: ${r.code}\n${r.stderr.slice(-1500)}`);

  r = await runCli([
    "verify", "--spec", spec, "--ref", ref, "--clone", clone,
    "--out", join(dir, "verify-1"), "--json",
  ], { timeoutMs: 180_000 });
  assert.ok([0, 1].includes(r.code), `verify failed unexpectedly: ${r.code}`);

  return { dir, spec };
}

/** Find any external reference in an HTML document. */
function externalRefs(html) {
  const found = [];
  const re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (/^(?:data:|#|about:|javascript:)/i.test(url)) continue;
    found.push(url);
  }
  return found;
}

test("report: writes a self-contained HTML file for a real run directory", async () => {
  const dir = tmpDir();
  try {
    await buildRun(dir);
    const res = await runCli(["report", "--dir", dir, "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, `report should succeed:\n${res.stdout.slice(0, 1200)}`);

    const env = parseEnvelope(res, "report");
    assert.equal(env.ok, true);
    const d = env.data;

    const htmlPath = join(dir, "report.html");
    assert.ok(existsSync(htmlPath), "report must write report.html into the run directory");
    const html = readFileSync(htmlPath, "utf8");
    assert.ok(html.length > 1000, `report.html is suspiciously small (${html.length} bytes)`);
    assert.match(html, /<html/i, "output must be an HTML document");

    // ---- self-contained: no network on open
    const refs = externalRefs(html);
    assert.deepEqual(refs, [], `report.html references external resources: ${refs.slice(0, 5).join(", ")}`);
    if (Array.isArray(d.externalReferences)) {
      assert.deepEqual(d.externalReferences, [], "the payload must report zero external references");
    }
    if (d.offlineSafe !== undefined) {
      assert.equal(d.offlineSafe, true, "the payload must confirm the report is offline-safe");
    }
  } finally {
    cleanup(dir);
  }
});

test("report: --check gates the file on disk and exits 1 on an external reference", async () => {
  // --check must validate the report ALREADY WRITTEN, not regenerate its own subject:
  // a gate that rewrites what it checks can never fail. The write pass must come
  // first, then --check reads the file back.
  const dir = tmpDir();
  try {
    await buildRun(dir);

    const write = await runCli(["report", "--dir", dir, "--json"], { timeoutMs: 120_000 });
    assert.equal(write.code, 0, `the write pass must succeed:\n${write.stdout.slice(0, 800)}`);
    const htmlPath = join(dir, "report.html");
    assert.ok(existsSync(htmlPath), "the write pass must produce report.html");

    const clean = await runCli(["report", "--dir", dir, "--check", "--json"], { timeoutMs: 120_000 });
    assert.equal(clean.code, 0, `--check on a self-contained report must exit 0:\n${clean.stdout.slice(0, 1000)}`);
    const cleanData = parseEnvelope(clean, "report --check clean").data;
    assert.equal(cleanData.offlineSafe, true, "--check must report the file as offline-safe");
    assert.deepEqual(cleanData.externalReferences, [], "--check must find no external references");

    // Poison the written file, then re-check it. --check must now fail, and it must
    // not repair the file on the way: the appended tag has to survive.
    const poisoned = '<img src="https://example.com/pixel.png">';
    writeFileSync(htmlPath, readFileSync(htmlPath, "utf8").replace("</body>", `${poisoned}</body>`));

    const dirty = await runCli(["report", "--dir", dir, "--check", "--json"], { timeoutMs: 120_000 });
    assert.equal(
      dirty.code,
      1,
      `--check must exit 1 when the written report loads an external resource, got ${dirty.code}:\n${dirty.stdout.slice(0, 1200)}`,
    );
    const dirtyData = parseEnvelope(dirty, "report --check dirty").data;
    assert.equal(dirtyData.offlineSafe, false, "the payload must report the file as not offline-safe");
    assert.ok(
      Array.isArray(dirtyData.externalReferences) && dirtyData.externalReferences.length > 0,
      "the payload must name the external reference it found",
    );
    assert.ok(
      dirtyData.externalReferences.some((r) => String(r).includes("example.com")),
      `externalReferences should include the injected URL, got ${JSON.stringify(dirtyData.externalReferences)}`,
    );
    assert.ok(
      readFileSync(htmlPath, "utf8").includes(poisoned),
      "--check must not rewrite the file it is checking",
    );
  } finally {
    cleanup(dir);
  }
});

test("report: --check on a run directory with no report yet is a usage error", async () => {
  // There is nothing to gate, so this must be a clear usage error, not a silent pass.
  const dir = tmpDir();
  try {
    const ref = join(dir, "ref");
    const r = await runCli([
      "record", "--url", fixture("fade-up.html"), "--out", ref,
      "--viewport", VIEW, "--fps", "25", "--duration", "600", "--json",
    ], { timeoutMs: 180_000 });
    assert.equal(r.code, 0, r.stderr.slice(-1200));

    const res = await runCli(["report", "--dir", dir, "--check", "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 2, `--check with no report on disk should be exit 2, got ${res.code}`);
    const env = parseEnvelope(res, "report --check missing");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
    assert.ok(
      env.errors[0].hint && /report/i.test(env.errors[0].hint),
      "the hint should tell the user to run report first",
    );
  } finally {
    cleanup(dir);
  }
});

test("report: a plain write reports mode \"write\" and --check reports mode \"check\"", async () => {
  // The Lead's design: exit 1 is deliberately tied to --check, so the two modes must
  // stay distinguishable. A plain write is a write and exits 0; only --check gates.
  const dir = tmpDir();
  try {
    await buildRun(dir);
    const res = await runCli(["report", "--dir", dir, "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, "a plain report write must exit 0");
    const d = parseEnvelope(res, "report write mode").data;
    assert.equal(d.mode, "write", `a plain write should report mode "write", got ${JSON.stringify(d.mode)}`);

    const check = await runCli(["report", "--dir", dir, "--check", "--json"], { timeoutMs: 120_000 });
    const c = parseEnvelope(check, "report check mode").data;
    assert.equal(c.mode, "check", `--check should report mode "check", got ${JSON.stringify(c.mode)}`);
  } finally {
    cleanup(dir);
  }
});

test("report: --out writes to an explicit path", async () => {
  const dir = tmpDir();
  const out = tmpDir();
  try {
    await buildRun(dir);
    const target = join(out, "custom-report.html");
    const res = await runCli(["report", "--dir", dir, "--out", target, "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, res.stdout.slice(0, 1000));
    assert.ok(existsSync(target), "--out must be honoured");
    assert.match(readFileSync(target, "utf8"), /<html/i);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test("report: a run directory with missing artefacts still reports, and says what is missing", async () => {
  // The Lead's design decision: a partial run yields a report plus a "missing" list,
  // not a failure. This test pins that behaviour so a future change is deliberate.
  const dir = tmpDir();
  try {
    const ref = join(dir, "ref");
    let r = await runCli([
      "record", "--url", fixture("fade-up.html"), "--out", ref,
      "--viewport", VIEW, "--fps", "25", "--duration", "600", "--json",
    ], { timeoutMs: 180_000 });
    assert.equal(r.code, 0, r.stderr.slice(-1200));

    const res = await runCli(["report", "--dir", dir, "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, `a partial run should still produce a report:\n${res.stdout.slice(0, 1000)}`);
    const d = parseEnvelope(res, "report partial").data;
    assert.ok(Array.isArray(d.missing), "the payload must list missing artefacts");
    assert.ok(d.missing.length > 0, "a run with no spec/clone must report something as missing");
    assert.ok(existsSync(join(dir, "report.html")), "report.html must still be written");
  } finally {
    cleanup(dir);
  }
});

test("report: --title is used in the document", async () => {
  const dir = tmpDir();
  try {
    await buildRun(dir);
    const title = "Clone round 7 — hero fade";
    const res = await runCli(["report", "--dir", dir, "--title", title, "--json"], { timeoutMs: 120_000 });
    assert.equal(res.code, 0, res.stdout.slice(0, 800));
    const html = readFileSync(join(dir, "report.html"), "utf8");
    assert.ok(html.includes(title), "the --title text must appear in the report");
  } finally {
    cleanup(dir);
  }
});

test("report: a missing --dir is a usage error with exit 2", async () => {
  const res = await runCli(["report", "--json"], { timeoutMs: 60_000 });
  assert.equal(res.code, 2, `expected exit 2, got ${res.code}`);
  const env = parseEnvelope(res, "report no dir");
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "USAGE");
});

test("report: a directory that does not exist is a usage error, not a crash", async () => {
  const res = await runCli(["report", "--dir", "/nonexistent/run", "--json"], { timeoutMs: 60_000 });
  assert.notEqual(res.code, 4, "a missing directory is not an internal error");
  assert.equal(res.code, 2, `expected exit 2, got ${res.code}`);
  const env = parseEnvelope(res, "report missing dir");
  assert.equal(env.ok, false);
});
