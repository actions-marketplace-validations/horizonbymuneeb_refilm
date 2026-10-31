// Asserts that the built package can actually run when installed from the registry.
//
// A source checkout hides packaging bugs: `src/inpage/*.js` sits next to the code, so the
// engine finds it even if the build forgot to copy it into dist/. 0.1.0 shipped that way and
// every `record` from npm failed with "clock.js not found". This checks the packaged shape
// instead of the checkout's shape, so the failure mode cannot return quietly.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const mustExist = [
  ["dist/cli.js", "the CLI entry point"],
  ["dist/index.js", "the programmatic entry point"],
  ["dist/inpage/clock.js", "the virtual clock injected into the page"],
  ["dist/inpage/gl-hooks.js", "the GPU tracer injected into the page"],
  ["skill/SKILL.md", "the agent skill"],
  ["README.md", "the readme"],
  ["LICENSE", "the license"],
  ["CHANGELOG.md", "the changelog"],
];
for (const [rel, what] of mustExist) {
  if (!existsSync(join(root, rel))) problems.push(`${rel} is missing (${what})`);
}

// Every command the dispatcher can import must exist as a built module.
const commands = ["record", "frames", "spec", "compare", "sheet", "fit", "gl", "verify", "report", "watch", "accept", "install", "init", "doctor"];
for (const name of commands) {
  const rel = `dist/commands/${name}.js`;
  if (!existsSync(join(root, rel))) problems.push(`${rel} is missing (the "${name}" command would fail to load)`);
}

// The skill is installed by copying the whole folder, so references must be there too.
const refs = join(root, "skill", "references");
if (!existsSync(refs)) problems.push("skill/references/ is missing (the skill would install without its reference files)");
else if (readdirSync(refs).filter((f) => f.endsWith(".md")).length === 0) problems.push("skill/references/ has no .md files");

// The readme must not point at files that are not shipped.
const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
for (const m of readme.matchAll(/(?:src|href)="((?:docs|demo)\/[^"]+)"/g)) {
  if (!existsSync(join(root, m[1]))) problems.push(`README references ${m[1]}, which is not in the package`);
}

// A packaged install must not need the TypeScript sources.
for (const rel of ["dist/inpage/clock.js", "dist/inpage/gl-hooks.js"]) {
  const p = join(root, rel);
  if (existsSync(p) && readFileSync(p, "utf8").trim().length === 0) problems.push(`${rel} is empty`);
}

if (problems.length) {
  console.error("verify-dist: the package is not installable as published:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-dist: ok — ${commands.length} commands, ${mustExist.length} required files, in-page scripts present`);
