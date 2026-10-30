// Integration: `refilm init` — scaffolding .refilm/ in a project.
//
// init writes into the user's repository, so the properties that matter are:
//   - it creates what it says it creates
//   - running it twice is safe and does not duplicate the .gitignore line
//   - it never clobbers a config the user has edited (unless --force)
//   - afterwards `doctor` recognises the project as set up

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, cleanup, runCli, parseEnvelope } from "../helpers.js";

test("init: scaffolds .refilm/ with a config and a runs directory", async () => {
  const dir = tmpDir();
  try {
    const res = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 0, `init should succeed:\n${res.stdout.slice(0, 800)}`);
    const env = parseEnvelope(res, "init");
    assert.equal(env.ok, true);

    const base = join(dir, ".refilm");
    assert.ok(existsSync(base), ".refilm/ must be created");
    assert.ok(existsSync(join(base, "runs")), ".refilm/runs/ must be created");

    const configPath = join(base, "config.json");
    assert.ok(existsSync(configPath), ".refilm/config.json must be created");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(typeof config, "object");
    assert.ok(Object.keys(config).length > 0, "config.json must not be empty");
  } finally {
    cleanup(dir);
  }
});

test("init: adds .refilm/ to .gitignore exactly once, even when run twice", async () => {
  // The Lead asked for this specifically: a duplicated ignore line is the classic
  // idempotency bug, and it is visible in the user's git diff.
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

    const first = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(first.code, 0, `first init failed:\n${first.stdout.slice(0, 800)}`);

    const second = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(second.code, 0, `second init must exit 0 (idempotent), got ${second.code}`);

    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    const hits = ignore.split("\n").filter((l) => l.trim() === ".refilm/" || l.trim() === ".refilm");
    assert.equal(hits.length, 1, `.gitignore must contain exactly one .refilm/ line, found ${hits.length}:\n${ignore}`);

    // The user's own lines must survive.
    assert.match(ignore, /node_modules\//, "existing .gitignore entries must be preserved");
  } finally {
    cleanup(dir);
  }
});

test("init: creates a .gitignore containing .refilm/ when none exists", async () => {
  const dir = tmpDir();
  try {
    assert.equal(existsSync(join(dir, ".gitignore")), false, "precondition: no .gitignore");
    const res = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 0, res.stdout.slice(0, 800));

    const gi = join(dir, ".gitignore");
    assert.ok(existsSync(gi), "init must create .gitignore when there is none");
    assert.match(readFileSync(gi, "utf8"), /\.refilm\/?/, "the created .gitignore must ignore .refilm/");
  } finally {
    cleanup(dir);
  }
});

test("init: a hand-edited config.json survives a second run", async () => {
  // init is run repeatedly in real projects; silently resetting a tuned config
  // would lose the user's viewport/fps decisions.
  const dir = tmpDir();
  try {
    const first = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(first.code, 0, first.stdout.slice(0, 800));

    const configPath = join(dir, ".refilm", "config.json");
    const edited = JSON.parse(readFileSync(configPath, "utf8"));
    edited.sentinel = "user-edit-do-not-clobber";
    edited.viewport = { width: 1440, height: 900 };
    edited.fps = 25;
    writeFileSync(configPath, JSON.stringify(edited, null, 2) + "\n");

    const second = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(second.code, 0, `second init must exit 0, got ${second.code}`);

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(after.sentinel, "user-edit-do-not-clobber", "init must not overwrite a user-edited config");
    assert.deepEqual(after.viewport, { width: 1440, height: 900 }, "the user's viewport must survive");
    assert.equal(after.fps, 25, "the user's fps must survive");
  } finally {
    cleanup(dir);
  }
});

test("init: --force rewrites config.json", async () => {
  const dir = tmpDir();
  try {
    let res = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 0, res.stdout.slice(0, 600));

    const configPath = join(dir, ".refilm", "config.json");
    const original = readFileSync(configPath, "utf8");
    const edited = JSON.parse(original);
    edited.sentinel = "should-be-removed-by-force";
    writeFileSync(configPath, JSON.stringify(edited, null, 2) + "\n");

    res = await runCli(["init", "--dir", dir, "--force", "--json"], { timeoutMs: 60_000 });
    assert.equal(res.code, 0, `init --force should succeed:\n${res.stdout.slice(0, 800)}`);

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(after.sentinel, undefined, "--force must rewrite the config, dropping the sentinel");
    assert.ok(Object.keys(after).length > 0, "the rewritten config must not be empty");
  } finally {
    cleanup(dir);
  }
});

test("init then doctor: doctor stops warning about a missing run directory", async () => {
  // The interop the Lead verified by hand; worth pinning so the two commands
  // cannot drift apart.
  const dir = tmpDir();
  try {
    const before = await runCli(["doctor", "--json"], { timeoutMs: 120_000 });
    const beforeData = parseEnvelope(before, "doctor before init").data;
    const runDirCheck = (checks) => checks.find((c) => c.id === "runDir");
    assert.ok(runDirCheck(beforeData.checks), "doctor must have a runDir check");

    const init = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(init.code, 0, init.stdout.slice(0, 600));

    // doctor checks the working directory, so run it inside the scaffolded project.
    const after = await runCli(["doctor", "--json"], { timeoutMs: 120_000, cwd: dir });
    const afterData = parseEnvelope(after, "doctor after init").data;
    const check = runDirCheck(afterData.checks);
    assert.ok(check, "doctor must still report the runDir check");
    assert.equal(
      check.status,
      "ok",
      `after init, doctor's runDir check should be ok, got "${check.status}" (${check.detail})`,
    );
  } finally {
    cleanup(dir);
  }
});

test("init: an explicit --dir is respected and the cwd is untouched", async () => {
  const dir = tmpDir();
  const elsewhere = tmpDir();
  try {
    const res = await runCli(["init", "--dir", dir, "--json"], { timeoutMs: 60_000, cwd: elsewhere });
    assert.equal(res.code, 0, res.stdout.slice(0, 600));
    assert.ok(existsSync(join(dir, ".refilm")), "--dir must be scaffolded");
    assert.equal(existsSync(join(elsewhere, ".refilm")), false, "the cwd must not be scaffolded when --dir is given");
  } finally {
    cleanup(dir);
    cleanup(elsewhere);
  }
});
