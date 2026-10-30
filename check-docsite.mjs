// Temporary verification harness — deleted before reporting. Run from the repo root.
import { chromium } from "playwright";
import { mkdirSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "/home/ubuntu/work/refilm/docs";
const ORIGIN = "http://127.0.0.1:8901";
const SHOTS = "/tmp/docsite-shots";
mkdirSync(SHOTS, { recursive: true });

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const pages = walk(ROOT).sort();
const VIEWPORTS = [
  { name: "desk", width: 1440, height: 980 },
  { name: "mob", width: 390, height: 844 },
];

const browser = await chromium.launch();
const rows = [];
let failures = 0;

for (const page of pages) {
  const rel = relative(ROOT, page).replace(/\\/g, "/");
  const url = `${ORIGIN}/${rel}`;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const p = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failed = [];
    const offOrigin = [];

    p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    p.on("pageerror", (e) => pageErrors.push(String(e)));
    p.on("requestfailed", (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));
    p.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) offOrigin.push(u);
    });

    const resp = await p.goto(url, { waitUntil: "load" });
    await p.waitForTimeout(120);

    const imgs = await p.evaluate(() =>
      Array.from(document.images).map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, alt: i.alt })),
    );
    const brokenImgs = imgs.filter((i) => i.w === 0);
    const noAlt = imgs.filter((i) => !i.alt || !i.alt.trim());

    const m = await p.evaluate(() => {
      const de = document.documentElement;
      const badAnchors = [];
      for (const a of document.querySelectorAll('a[href^="#"]')) {
        const id = a.getAttribute("href").slice(1);
        if (id && !document.getElementById(id)) badAnchors.push(id);
      }
      const seen = new Set();
      const dupIds = [];
      for (const el of document.querySelectorAll("[id]")) {
        if (seen.has(el.id)) dupIds.push(el.id);
        seen.add(el.id);
      }
      return {
        overflow: de.scrollWidth - window.innerWidth,
        h1: document.querySelectorAll("h1").length,
        current: document.querySelectorAll('[aria-current="page"]').length,
        hasSkip: Boolean(document.querySelector("a.skip")),
        hasHeader: Boolean(document.querySelector("header")),
        hasNav: Boolean(document.querySelector("nav")),
        hasMain: Boolean(document.querySelector("main")),
        hasFooter: Boolean(document.querySelector("footer")),
        lang: de.lang,
        imgsNoDim: Array.from(document.images).filter((i) => !i.getAttribute("width") && !i.getAttribute("height")).length,
        badAnchors, dupIds,
      };
    });

    const shot = join(SHOTS, `${rel.replace(/\//g, "_").replace(/\.html$/, "")}-${vp.name}.png`);
    await p.screenshot({ path: shot, fullPage: true });

    const bad = [];
    if (m.overflow !== 0) bad.push(`overflow ${m.overflow}px`);
    if (consoleErrors.length) bad.push(`console ${consoleErrors.length}: ${consoleErrors[0]}`);
    if (pageErrors.length) bad.push(`pageerror: ${pageErrors[0]}`);
    if (failed.length) bad.push(`failedReq: ${failed[0]}`);
    if (offOrigin.length) bad.push(`offOrigin: ${offOrigin[0]}`);
    if (brokenImgs.length) bad.push(`brokenImg: ${brokenImgs[0].src}`);
    if (noAlt.length) bad.push(`imgNoAlt ${noAlt.length}`);
    if (m.h1 !== 1) bad.push(`h1 count ${m.h1}`);
    if (m.current !== 1) bad.push(`aria-current ${m.current}`);
    if (!m.hasSkip) bad.push("no skip link");
    if (!m.hasHeader) bad.push("no header");
    if (!m.hasNav) bad.push("no nav");
    if (!m.hasMain) bad.push("no main");
    if (!m.hasFooter) bad.push("no footer");
    if (m.lang !== "en") bad.push(`lang ${m.lang}`);
    if (resp?.status() !== 200) bad.push(`status ${resp?.status()}`);
    if (m.imgsNoDim) bad.push(`img w/o dims ${m.imgsNoDim}`);
    if (m.badAnchors.length) bad.push(`badAnchor: ${m.badAnchors.join(",")}`);
    if (m.dupIds.length) bad.push(`dupId: ${m.dupIds.join(",")}`);

    if (bad.length) failures++;
    rows.push({ page: rel, vp: vp.name, overflow: m.overflow, console: consoleErrors.length, pageErr: pageErrors.length, failed: failed.length, offOrigin: offOrigin.length, imgs: imgs.length, broken: brokenImgs.length, ok: bad.length === 0, bad });
    await ctx.close();
  }
}

await browser.close();
for (const r of rows) {
  console.log(`${r.page} [${r.vp}] ovf=${r.overflow} con=${r.console} pe=${r.pageErr} req=${r.failed} off=${r.offOrigin} img=${r.imgs}/${r.broken} ${r.ok ? "OK" : "FAIL"}`);
  if (!r.ok) console.log(`    -> ${r.bad.join(" | ")}`);
}
const pageCount = new Set(rows.map((r) => r.page)).size;
console.log(`\npages=${pageCount} checks=${rows.length} failing=${failures}`);
process.exit(failures === 0 ? 0 : 1);
