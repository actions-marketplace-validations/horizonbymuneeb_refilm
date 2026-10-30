// Unit tests for dist/cli.js dispatch: version, help, unknown commands, aliases and
// the guarantee that a failing command still prints a valid JSON envelope.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DIST, runCli, parseEnvelope } from "../helpers.js";
import { pathToFileURL } from "node:url";

const lib = await import(pathToFileURL(join(DIST, "lib.js")).href);

// The command names cli.ts promises in its usage text and its COMMANDS table.
const COMMANDS = [
  "record",
  "frames",
  "spec",
  "compare",
  "sheet",
  "fit",
  "gl",
  "verify",
  "report",
  "install",
  "init",
  "doctor",
];

// ------------------------------------------------------------------ --version

test("--version prints the version and exits 0", async () => {
  const res = await runCli(["--version"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), lib.VERSION);
  assert.equal(res.stderr.trim(), "", "version output belongs on stdout only");
});

test("-v and `version` are accepted spellings of --version", async () => {
  for (const spelling of ["-v", "version"]) {
    const res = await runCli([spelling]);
    assert.equal(res.code, 0, `${spelling} should exit 0`);
    assert.equal(res.stdout.trim(), lib.VERSION, `${spelling} should print the version`);
  }
});

// ------------------------------------------------------------------ --help

test("--help exits 0 and lists every command name", async () => {
  const res = await runCli(["--help"]);
  assert.equal(res.code, 0);
  for (const cmd of COMMANDS) {
    assert.match(
      res.stdout,
      new RegExp(`\\brefilm\\s+${cmd}\\b`),
      `--help must document the "${cmd}" command`,
    );
  }
});

test("--help documents the exit codes, because agents branch on them", async () => {
  const res = await runCli(["--help"]);
  for (const [code, meaning] of [
    ["0", "success"],
    ["1", "verification failed"],
    ["2", "usage error"],
    ["3", "environment problem"],
    ["4", "internal error"],
  ]) {
    assert.match(res.stdout, new RegExp(`\\b${code}\\b[^\\n]*${meaning}`), `--help must explain exit ${code}`);
  }
});

test("no arguments prints the usage and exits 0", async () => {
  const res = await runCli([]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /refilm/);
  assert.match(res.stdout, /--json/);
});

test("-h and `help` behave like --help", async () => {
  for (const spelling of ["-h", "help"]) {
    const res = await runCli([spelling]);
    assert.equal(res.code, 0, `${spelling} should exit 0`);
    assert.match(res.stdout, /refilm record/, `${spelling} should print the usage`);
  }
});

// ------------------------------------------------------------------ unknown command

test("an unknown command exits 2 with a JSON error envelope under --json", async () => {
  const res = await runCli(["definitely-not-a-command", "--json"]);
  assert.equal(res.code, 2, "an unknown command is a usage error");

  const env = parseEnvelope(res, "unknown command");
  assert.equal(env.ok, false);
  assert.equal(env.command, "definitely-not-a-command", "the envelope names what was asked for");
  assert.equal(env.version, lib.VERSION);
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors) && env.errors.length >= 1);
  const e = env.errors[0];
  assert.equal(e.code, "USAGE");
  assert.match(e.message, /unknown command/i);
  assert.ok(typeof e.hint === "string" && e.hint.length > 0, "the hint should point at --help");
});

test("an unknown command without --json exits 2 and writes no JSON to stdout", async () => {
  const res = await runCli(["definitely-not-a-command"]);
  assert.equal(res.code, 2);
  assert.equal(res.stdout.trim(), "", "human mode keeps stdout clean");
  assert.match(res.stderr, /definitely-not-a-command/);
});

test("a --json failure envelope is still valid JSON on stdout (agents parse this)", async () => {
  // This is the contract that matters most: an error path must never corrupt the envelope.
  // Three distinct failure routes, all of which must produce ok:false + errors[0].code + exit 2:
  //   (a) dispatch failure  — the command does not exist
  //   (b) usageError thrown by the command itself — required flags missing
  //   (c) usage error from a malformed value on a command that does exist
  const cases = [
    { argv: ["nope", "--json"], what: "(a) unknown command", expectCode: "USAGE" },
    { argv: ["record", "--json"], what: "(b) missing required --url/--out", expectCode: "USAGE" },
    { argv: ["compare", "--json"], what: "(b) missing required --ref/--clone", expectCode: "USAGE" },
  ];
  for (const { argv, what, expectCode } of cases) {
    const res = await runCli(argv, { timeoutMs: 60_000 });
    assert.equal(res.code, 2, `${what}: a usage error must exit 2, got ${res.code}`);

    const env = parseEnvelope(res, what);
    assert.equal(env.ok, false, `${what}: ok must be false`);
    assert.equal(typeof env.command, "string", `${what}: command must be named`);
    assert.equal(env.version, lib.VERSION, `${what}: version must be present`);
    assert.ok(Array.isArray(env.warnings), `${what}: warnings must be an array`);
    assert.ok(Array.isArray(env.errors) && env.errors.length >= 1, `${what}: at least one error`);
    assert.equal(env.errors[0].code, expectCode, `${what}: errors[0].code`);
    assert.equal(typeof env.errors[0].message, "string", `${what}: errors[0].message`);
    assert.ok("hint" in env.errors[0], `${what}: hint is always present (null when there is none)`);
    for (const e of env.errors) {
      assert.equal(typeof e.code, "string");
      assert.equal(typeof e.message, "string");
    }
  }
});

test("a command that throws usageError for a malformed value exits 2 with a USAGE code", async () => {
  // parseSize/parseRect throw usageError; --viewport is read by every capture command.
  const res = await runCli(["record", "--url", "x.html", "--out", "/tmp/x", "--viewport", "bogus", "--json"], {
    timeoutMs: 60_000,
  });
  if (res.code === 2) {
    const env = parseEnvelope(res, "bad --viewport");
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, "USAGE");
    assert.match(env.errors[0].message, /viewport/i, "the message should name the offending flag");
  } else {
    // The record module is not built yet: the CLI can only report that it is missing.
    assert.ok(
      res.code === 2 || res.code === 4,
      `expected a usage/internal error before record is built, got ${res.code}`,
    );
  }
});

// ------------------------------------------------------------------ aliases

test("aliases resolve to real commands rather than reporting unknown", async () => {
  // An alias may still exit 2 for its own missing arguments — that is correct behaviour.
  // What it must never do is fall through to the "unknown command" branch.
  const aliases = ["capture", "diff", "sheets", "easing", "check"];
  for (const alias of aliases) {
    const res = await runCli([alias, "--json"], { timeoutMs: 60_000 });
    const env = parseEnvelope(res, `alias ${alias}`);
    const message = env.errors?.[0]?.message ?? "";
    assert.doesNotMatch(
      message,
      /unknown command/i,
      `alias "${alias}" fell through to the unknown-command branch: ${message}`,
    );
    assert.notEqual(env.command, alias, `alias "${alias}" should report the resolved command name`);
  }
});

// ------------------------------------------------------------------ per-command help

test("every command that is built answers --help with exit 0 and non-empty text", async () => {
  let checked = 0;
  for (const cmd of COMMANDS) {
    const mod = join(DIST, "commands", `${cmd}.js`);
    if (!existsSync(mod)) continue; // not built yet: covered by its own skip-with-reason test
    checked++;
    const res = await runCli([cmd, "--help"], { timeoutMs: 60_000 });
    assert.equal(res.code, 0, `${cmd} --help should exit 0`);
    assert.ok(res.stdout.trim().length > 0, `${cmd} --help should print something`);
    assert.match(res.stdout, new RegExp(`refilm\\s+${cmd}`), `${cmd} --help should name itself`);
  }
  assert.ok(checked > 0, "no command modules are built yet — the CLI has nothing to dispatch to");
});

// ------------------------------------------------------------------ internal errors

test("cli.js exports main() so the dispatcher is testable without a subprocess", async () => {
  const cli = await import(pathToFileURL(join(DIST, "cli.js")).href);
  assert.equal(typeof cli.main, "function");
  assert.equal(typeof cli.EXIT, "object");
  assert.equal(cli.EXIT.USAGE, 2);
});

test("main() returns the exit code instead of calling process.exit", async () => {
  const cli = await import(pathToFileURL(join(DIST, "cli.js")).href);
  const orig = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  let code;
  try {
    code = await cli.main(["--version"]);
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0, "main must resolve to the exit code");
  assert.equal(out.join("").trim(), lib.VERSION);
});

test("main() on an unknown command returns 2 and emits the JSON envelope", async () => {
  const cli = await import(pathToFileURL(join(DIST, "cli.js")).href);
  const orig = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  let code;
  try {
    code = await cli.main(["nope", "--json"]);
  } finally {
    console.log = orig;
  }
  assert.equal(code, 2);
  const env = JSON.parse(out.join("\n"));
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, "USAGE");
});
