// Fixture self-checks: the pages in test/fixtures/ must actually be what the
// other suites assume they are, and must render with no network and no errors.
//
// This suite is the guard on the guards. If a fixture silently stops animating,
// every downstream assertion gets weaker without failing — so the motion itself
// is measured here, in a real browser.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { FIXTURES, cleanup } from "../helpers.js";

const MANIFEST = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));

/** Playwright is a hard dependency of the CLI itself, so it is always present here. */
const { chromium } = await import("playwright");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
};

/**
 * Serve test/fixtures over http://127.0.0.1 — ES modules (the vendored three.js)
 * are blocked by CORS on file://, so the GL fixture needs a real origin.
 */
async function withServer(fn) {
  const server = createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent((req.url || "/").split("?")[0]));
      const path = join(FIXTURES, rel);
      if (!path.startsWith(FIXTURES)) {
        res.writeHead(403).end("no");
        return;
      }
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/** Open a fixture, collect page errors, and hand the page to the test. */
async function withPage(base, file, fn) {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    // No network at runtime except the page itself: block anything off-origin.
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(base) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      return route.abort();
    });
    await page.goto(`${base}/${file}`, { waitUntil: "load" });
    return await fn(page, errors);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ manifest

test("fixtures: every declared fixture exists and the manifest is consistent", () => {
  assert.ok(MANIFEST.fixtures, "manifest.json must have a fixtures object");
  for (const [name, spec] of Object.entries(MANIFEST.fixtures)) {
    const path = join(FIXTURES, name);
    assert.ok(existsSync(path), `manifest declares ${name} but the file is missing`);
    assert.ok(statSync(path).size > 0, `${name} is empty`);
    assert.equal(typeof spec.kind, "string", `${name}: manifest entry needs a kind`);
    assert.equal(typeof spec.description, "string", `${name}: manifest entry needs a description`);
  }
});

test("fixtures: no fixture reaches the network", () => {
  // The whole point of vendoring three.js is offline CI; a CDN URL sneaking back
  // into a fixture would make the suite flaky in a sandbox.
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".html"));
  assert.ok(files.length >= 6, `expected the six fixture pages, found ${files.length}`);
  for (const f of files) {
    const html = readFileSync(join(FIXTURES, f), "utf8");
    assert.doesNotMatch(
      html,
      /(?:src|href)\s*=\s*["']https?:\/\//i,
      `${f} loads a remote resource; fixtures must be offline-safe`,
    );
    assert.doesNotMatch(
      html,
      /@import\s+url\(\s*["']?https?:/i,
      `${f} imports a remote stylesheet`,
    );
  }
});

test("fixtures: the vendored three.js is present and is the declared revision", () => {
  const mod = join(FIXTURES, "vendor", "three.module.js");
  const core = join(FIXTURES, "vendor", "three.core.js");
  assert.ok(existsSync(mod), "vendor/three.module.js must be committed so CI is offline");
  assert.ok(existsSync(core), "vendor/three.core.js must be committed (three.module.js imports it)");

  const coreSrc = readFileSync(core, "utf8");
  const rev = coreSrc.match(/REVISION\s*=\s*["']([^"']+)["']/);
  assert.ok(rev, "could not read REVISION from the vendored three.core.js");
  assert.equal(rev[1], MANIFEST.fixtures["gl-three.html"].threeVersion, "vendored revision drifted from the manifest");

  // three.module.js must import its core sibling by relative path, not a URL.
  const modSrc = readFileSync(mod, "utf8");
  assert.match(modSrc, /from\s+["']\.\/three\.core\.js["']/, "three.module.js must import ./three.core.js");
  assert.doesNotMatch(modSrc.slice(0, 4000), /from\s+["']https?:/, "vendored three must not import a URL");
});

test("fixtures: the video fixture is small enough to commit", () => {
  const clip = join(FIXTURES, "clip.mp4");
  assert.ok(existsSync(clip), "clip.mp4 must exist");
  const size = statSync(clip).size;
  assert.ok(size > 0, "clip.mp4 is empty");
  assert.ok(size < 200 * 1024, `clip.mp4 is ${size} bytes; the budget is 200 KB — regenerate it smaller`);
});

// ------------------------------------------------------------------ rendering

test("fixtures: fade-up renders 3 cards that actually move up 40px", async () => {
  await withServer(async (base) => {
    await withPage(base, "fade-up.html", async (page, errors) => {
      const before = await page.evaluate(() => {
        const el = document.querySelector("#card-0");
        const r = el.getBoundingClientRect();
        return { y: r.y, opacity: Number(getComputedStyle(el).opacity) };
      });
      await page.waitForTimeout(1100);
      const after = await page.evaluate(() => {
        const el = document.querySelector("#card-0");
        const r = el.getBoundingClientRect();
        return { y: r.y, opacity: Number(getComputedStyle(el).opacity) };
      });

      const moved = after.y - before.y;
      assert.ok(
        Math.abs(moved - -40) < 2,
        `card-0 should rise 40px, measured ${moved}px`,
      );
      assert.ok(after.opacity > 0.99, `card-0 should end opaque, got ${after.opacity}`);
      assert.ok(before.opacity < 0.5, `card-0 should start transparent, got ${before.opacity}`);

      const count = await page.evaluate(() => document.querySelectorAll(".card").length);
      assert.equal(count, MANIFEST.fixtures["fade-up.html"].cardCount);
      assert.deepEqual(errors, [], `fade-up.html logged errors: ${errors.join("; ")}`);
    });
  });
});

test("fixtures: fade-up staggers its three cards by 120ms", async () => {
  await withServer(async (base) => {
    await withPage(base, "fade-up.html", async (page) => {
      // getAnimations() exposes the declared delays directly: the stagger is real CSS.
      const delays = await page.evaluate(() =>
        document
          .getAnimations()
          .map((a) => ({ delay: Number(a.effect.getTiming().delay), duration: Number(a.effect.getTiming().duration) }))
          .sort((a, b) => a.delay - b.delay),
      );
      assert.equal(delays.length, 3, `expected 3 animations, got ${delays.length}`);
      assert.deepEqual(delays.map((d) => d.delay), [0, 120, 240], "declared stagger must be 0/120/240ms");
      for (const d of delays) assert.equal(d.duration, 900, "every card animates for 900ms");
    });
  });
});

test("fixtures: hover-tilt only moves on hover, and is still under --trigger load", async () => {
  await withServer(async (base) => {
    await withPage(base, "hover-tilt.html", async (page, errors) => {
      const idle = await page.evaluate(() => getComputedStyle(document.querySelector("#tilt")).transform);
      await page.hover("#tilt");
      await page.waitForTimeout(450);
      const hovered = await page.evaluate(() => getComputedStyle(document.querySelector("#tilt")).transform);

      assert.notEqual(hovered, idle, "the element must transform on hover");
      assert.match(hovered, /matrix/, `expected a matrix transform, got ${hovered}`);

      // No load animation at all: the page must be static without interaction.
      const anims = await page.evaluate(() => document.getAnimations().length);
      assert.equal(anims, 0, `hover-tilt must have no load animation, found ${anims}`);
      assert.deepEqual(errors, [], `hover-tilt.html logged errors: ${errors.join("; ")}`);
    });
  });
});

test("fixtures: scroll-reveal is tall and reveals elements on scroll", async () => {
  await withServer(async (base) => {
    await withPage(base, "scroll-reveal.html", async (page, errors) => {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      assert.equal(height, MANIFEST.fixtures["scroll-reveal.html"].scrollHeight, `scroll height is ${height}`);

      const hiddenOpacity = await page.evaluate(() => {
        const els = [...document.querySelectorAll(".reveal")];
        const last = els[els.length - 1];
        return Number(getComputedStyle(last).opacity);
      });
      assert.ok(hiddenOpacity < 0.5, `an off-screen reveal should start hidden, got opacity ${hiddenOpacity}`);

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(900);
      const revealed = await page.evaluate(() =>
        [...document.querySelectorAll(".reveal")].filter((e) => e.classList.contains("in")).length,
      );
      assert.ok(revealed > 0, "scrolling must reveal elements");
      assert.deepEqual(errors, [], `scroll-reveal.html logged errors: ${errors.join("; ")}`);
    });
  });
});

test("fixtures: marquee loops linearly at 0.6 px/ms", async () => {
  await withServer(async (base) => {
    await withPage(base, "marquee.html", async (page, errors) => {
      const sample = () =>
        page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("#track")).transform).m41);

      const a = await sample();
      await page.waitForTimeout(500);
      const b = await sample();
      const dx = b - a;
      const speed = Math.abs(dx) / 500;

      // 1200px over 2000ms = 0.6 px/ms. Allow 15% for scheduling jitter.
      assert.ok(
        Math.abs(speed - 0.6) / 0.6 < 0.15,
        `marquee speed should be ~0.6 px/ms, measured ${speed.toFixed(3)} px/ms (dx ${dx.toFixed(1)}px in 500ms)`,
      );
      assert.ok(dx < 0, "the marquee must travel left (negative translateX)");
      assert.deepEqual(errors, [], `marquee.html logged errors: ${errors.join("; ")}`);
    });
  });
});

test("fixtures: canvas-2d draws a non-blank canvas from its seeded PRNG", async () => {
  await withServer(async (base) => {
    await withPage(base, "canvas-2d.html", async (page, errors) => {
      // The page must not touch Math.random at all: that is what makes it deterministic
      // regardless of --seed.
      const usedRandom = await page.evaluate(() => window.__usedMathRandom === true);
      assert.equal(usedRandom, false, "canvas-2d must not use Math.random()");

      const stats = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        const ctx = c.getContext("2d");
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const colors = new Set();
        let nonBg = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 50) nonBg++;
          colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        }
        return { nonBg, colors: colors.size, w: c.width, h: c.height };
      });
      assert.deepEqual([stats.w, stats.h], [640, 480]);
      assert.ok(stats.nonBg > 500, `canvas looks blank: only ${stats.nonBg} non-background pixels`);
      assert.ok(stats.colors > 3, `expected a multi-colour drawing, found ${stats.colors} distinct colours`);

      // It must animate: two samples a moment apart differ.
      const shot1 = await page.screenshot();
      await page.waitForTimeout(350);
      const shot2 = await page.screenshot();
      assert.ok(!shot1.equals(shot2), "canvas-2d is not animating");
      assert.deepEqual(errors, [], `canvas-2d.html logged errors: ${errors.join("; ")}`);
    });
  });
});

test("fixtures: gl-three renders an animated three.js scene from the local vendor copy", async () => {
  await withServer(async (base) => {
    await withPage(base, "gl-three.html", async (page, errors) => {
      await page.waitForFunction(() => window.__glReady === true, null, { timeout: 30_000 });

      const info = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        return { three: window.__threeVersion, w: c.width, h: c.height };
      });
      assert.equal(info.three, MANIFEST.fixtures["gl-three.html"].threeVersion, "three revision");
      assert.deepEqual([info.w, info.h], [640, 480]);

      // Something is actually drawn, and it changes over time.
      const stats = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        const px = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let nonBg = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] > 40 || px[i + 1] > 50 || px[i + 2] > 60) nonBg++;
        return nonBg;
      });
      assert.ok(stats > 1000, `the GL scene looks empty: ${stats} non-background pixels`);

      const shot1 = await page.screenshot();
      await page.waitForTimeout(400);
      const shot2 = await page.screenshot();
      assert.ok(!shot1.equals(shot2), "the mesh is not rotating");

      assert.deepEqual(errors, [], `gl-three.html logged errors: ${errors.join("; ")}`);
    });
  });
});

test("fixtures: canvas-random does use Math.random (it is the --seed control)", async () => {
  await withServer(async (base) => {
    await withPage(base, "canvas-random.html", async (page, errors) => {
      const src = readFileSync(join(FIXTURES, "canvas-random.html"), "utf8");
      assert.match(src, /Math\.random\(\)/, "canvas-random must call Math.random so --seed can affect it");

      const stats = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        const ctx = c.getContext("2d");
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBg = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 50) nonBg++;
        return nonBg;
      });
      assert.ok(stats > 500, `canvas-random looks blank: ${stats} non-background pixels`);
      assert.deepEqual(errors, [], `canvas-random.html logged errors: ${errors.join("; ")}`);
    });
  });
});
