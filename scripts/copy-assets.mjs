// Copies the plain browser scripts the engine injects into the page into dist/.
//
// `src/inpage/*.js` are not TypeScript, so `tsc` leaves them where they are. They still have
// to ship: without them a packaged install fails at record time with "clock.js not found",
// which is exactly what happened to 0.1.0 on npm. This runs as part of `npm run build`, and
// `npm run verify:dist` asserts the result so the mistake cannot come back silently.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "inpage");
const to = join(root, "dist", "inpage");

mkdirSync(to, { recursive: true });

const scripts = readdirSync(from).filter((f) => f.endsWith(".js"));
if (scripts.length === 0) {
  console.error("copy-assets: no .js files in src/inpage — the engine would have nothing to inject");
  process.exit(1);
}
for (const file of scripts) {
  copyFileSync(join(from, file), join(to, file));
}
console.log(`copy-assets: ${scripts.length} in-page script(s) → dist/inpage (${scripts.join(", ")})`);
