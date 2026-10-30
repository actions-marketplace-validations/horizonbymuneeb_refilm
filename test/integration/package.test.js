// Integration: the package is installable as published, not just runnable from a checkout.
//
// This exists because 0.1.0 and 0.1.1 shipped without dist/inpage/*.js — plain browser scripts
// that `tsc` does not copy. A source checkout hides the bug completely, because the engine also
// looks in src/inpage/. Every `refilm record` from npm failed with "clock.js not found", and no
// test caught it because every test ran from the checkout.
//
// The lesson generalises: a packaging bug needs a test that looks at the packaged shape.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMMANDS = [
  "record", "frames", "spec", "compare", "sheet", "fit",
  "gl", "verify", "report", "install", "init", "doctor",
];

test("package: every in-page script is in dist/ (not only in src/)", () => {
  // The exact files the engine injects with addInitScript.
  for (const name of ["clock.js", "gl-hooks.js"]) {
    const inDist = join(ROOT, "dist", "inpage", name);
    assert.ok(
      existsSync(inDist),
      `dist/inpage/${name} is missing — a packaged install cannot inject it. ` +
        `The build must copy src/inpage/*.js into dist/inpage/ (scripts/copy-assets.mjs).`,
    );
    assert.ok(readFileSync(inDist, "utf8").trim().length > 0, `dist/inpage/${name} is empty`);
  }
});

test("package: dist/inpage is resolved before src/inpage, so a published install never needs src", () => {
  const src = readFileSync(join(ROOT, "src", "engine", "inpage.ts"), "utf8");
  const distIdx = src.indexOf('join(PKG_DIR, "dist", "inpage")');
  const srcIdx = src.indexOf('join(PKG_DIR, "src", "inpage")');
  assert.ok(distIdx > -1, "the resolver must look in dist/inpage");
  assert.ok(srcIdx > -1, "the resolver must still fall back to src/inpage for a checkout");
  assert.ok(distIdx < srcIdx, "dist/inpage must be searched before src/inpage");
});

test("package: every command has a built module", () => {
  for (const name of COMMANDS) {
    const rel = join("dist", "commands", `${name}.js`);
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is missing — "refilm ${name}" would fail to load`);
  }
});

test("package: the skill ships with its reference files", () => {
  assert.ok(existsSync(join(ROOT, "skill", "SKILL.md")), "skill/SKILL.md is missing");
  const refs = join(ROOT, "skill", "references");
  assert.ok(existsSync(refs), "skill/references/ is missing — the installed skill would have no detail");
  const md = readdirSync(refs).filter((f) => f.endsWith(".md"));
  assert.ok(md.length >= 4, `skill/references should hold the per-topic notes, found ${md.length}`);
});

test("package: every file the README points at is shipped", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  // Images use ABSOLUTE raw.githubusercontent URLs, because npm renders the README at
  // npmjs.com/package/refilm where a relative "docs/media/x.png" resolves to a 403. An absolute
  // URL can still rot (a renamed file, a moved folder), so each one is mapped back to a repo
  // path and checked on disk.
  const RAW = "https://raw.githubusercontent.com/horizonbymuneeb/refilm/main/";
  const rawRefs = [...readme.matchAll(new RegExp(`src="${RAW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^"]+)"`, "g"))].map(
    (m) => m[1],
  );
  assert.ok(rawRefs.length > 0, "the README should show real media; none was referenced");
  for (const rel of rawRefs) {
    assert.ok(existsSync(join(ROOT, rel)), `README references ${rel} on GitHub, which is not in the repository`);
  }

  // A relative image path would silently break on npm, so none may exist.
  const relativeImages = [...readme.matchAll(/src="((?!#|https?:|data:)[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    relativeImages,
    [],
    `README images must use absolute raw URLs (npm renders the README on npmjs.com): ${relativeImages.join(", ")}`,
  );

  // Repo-relative links (docs, demo, LICENSE, ...) must resolve too.
  for (const m of readme.matchAll(/\]\(((?!https?:|#|mailto:)[^)]+)\)/g)) {
    const rel = m[1].split("#")[0];
    if (!rel) continue;
    assert.ok(existsSync(join(ROOT, rel)), `README links to ${rel}, which is not in the repository`);
  }
});

test("package: npm pack includes dist/inpage (the check that would have caught 0.1.1)", () => {
  // `npm pack --dry-run --json` lists exactly what a consumer would receive.
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_offline: "true" },
    timeout: 120_000,
  });
  const info = JSON.parse(raw)[0];
  const files = info.files.map((f) => f.path);

  assert.ok(files.includes("dist/cli.js"), "the tarball must contain the CLI");
  for (const name of ["clock.js", "gl-hooks.js"]) {
    assert.ok(
      files.includes(`dist/inpage/${name}`),
      `the tarball is missing dist/inpage/${name}; an npm install would fail at record time. ` +
        `Files in the tarball: ${files.slice(0, 12).join(", ")}…`,
    );
  }
  assert.ok(files.some((f) => f.startsWith("skill/")), "the tarball must contain the agent skill");
});
