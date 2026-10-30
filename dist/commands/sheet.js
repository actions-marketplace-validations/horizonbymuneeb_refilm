// refilm sheet — labelled contact sheets, rendered with Chromium so labels need no ffmpeg drawtext.
//
// Two shapes:
//   filmstrip  one frame directory laid out as a grid, timestamp under each frame — the fastest way
//              to see "does this motion read right" without opening 90 PNGs
//   compare    reference / clone / diff side by side, one row per frame, so a mismatch is visible
//              as a row that drifts instead of a number
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { EXIT, abs, ensureDir, exists, listFrames, num, pad, parseArgs, readJson, reporter, str, usageError, } from "../lib.js";
export const help = `
refilm sheet — labelled contact sheets you can actually look at.

  refilm sheet filmstrip --frames <dir> --out <dir> [options]
  refilm sheet compare   --ref <dir> --clone <dir> --out <dir> [options]

  --fps N          used for the time labels (default: frames.json / capture.json beside the frames, else 25)
  --cols N         filmstrip: columns per sheet, default 6
  --per-sheet N    frames per sheet, default 24 for filmstrip and 8 for compare
  --width N        rendered width of each frame in pixels, default 240 filmstrip / 420 compare
  --every K        show every K-th frame, default 1
  --from I --to J  frame index range, inclusive, 0-based
  --diff <dir>     compare: diff images from refilm compare, drawn as a third column
  --offset K       compare: clone frame = reference frame + K (take it from report.json)

Writes <out>/sheet-01.png, <out>/sheet-02.png … and prints their paths.
With --json the payload is { files: [...] }.
`;
/** fps from frames.json in the directory, or capture.json one level up. */
function fpsOf(dir, fallback) {
    for (const p of [join(dir, "frames.json"), join(dir, "..", "capture.json")]) {
        if (!exists(p))
            continue;
        try {
            const meta = readJson(p);
            const fps = Number(meta?.fps);
            if (Number.isFinite(fps) && fps > 0)
                return fps;
        }
        catch {
            /* a broken sidecar must not stop the sheet from being built */
        }
    }
    return fallback;
}
const dataUri = (path) => "data:image/png;base64," + readFileSync(path).toString("base64");
const stamp = (index, fps) => `#${index} · ${(index / fps).toFixed(2)}s`;
const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#0f1115;color:#c9d1d9;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;padding:14px}
h1{font:600 13px/1.4 ui-monospace,monospace;margin:0 0 10px;color:#e6edf3;letter-spacing:.01em}
.meta{color:#7d8590;margin:0 0 12px}
.grid{display:grid;gap:12px}
.cell{display:flex;flex-direction:column;gap:4px}
.cell img{display:block;width:100%;height:auto;background:#000;outline:1px solid #21262d;border-radius:2px}
.cap{color:#8b949e;font-variant-numeric:tabular-nums;white-space:nowrap}
.row{display:grid;gap:10px;padding:0 0 12px;border-bottom:1px solid #161b22;margin-bottom:12px}
.row .cell .cap{color:#8b949e}
.cols{display:grid;gap:10px;color:#58a6ff;margin:0 0 8px;font-weight:600}
.bad{color:#f85149}
`;
function page(heading, meta, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>` +
        `<h1>${heading}</h1><p class="meta">${meta}</p>${body}</body></html>`;
}
function grid(cells, cols, width) {
    const inner = cells
        .map((c) => `<div class="cell" style="width:${width}px"><img src="${c.img}" alt=""><div class="cap">${c.caption}</div></div>`)
        .join("");
    return `<div class="grid" style="grid-template-columns:repeat(${cols},${width}px)">${inner}</div>`;
}
export async function run(argv, ctx) {
    const rep = reporter("sheet", { json: ctx.json });
    const args = parseArgs(argv);
    const first = Array.isArray(args._) ? args._[0] : args._;
    const chosen = typeof first === "string" ? first : "";
    const outArg = str(args.out);
    if (!outArg)
        throw usageError("sheet needs --out <dir>", "sheets are written there as sheet-01.png, …");
    if (chosen !== "filmstrip" && chosen !== "compare") {
        throw usageError(`unknown sheet mode ${JSON.stringify(chosen || "(none)")}`, "use: refilm sheet filmstrip --frames <dir> --out <dir>  |  refilm sheet compare --ref <dir> --clone <dir> --out <dir>");
    }
    const outDir = ensureDir(abs(outArg));
    const every = Math.max(1, Math.round(num(args.every, 1)));
    const docs = [];
    if (chosen === "filmstrip") {
        const framesArg = str(args.frames);
        if (!framesArg)
            throw usageError("sheet filmstrip needs --frames <dir>", "point it at a directory of numbered PNGs");
        const dir = abs(framesArg);
        const files = listFrames(dir);
        if (!files.length)
            throw usageError(`no PNG frames in ${dir}`, "run refilm frames or refilm record first");
        const fps = num(args.fps, fpsOf(dir, 25));
        const cols = Math.max(1, Math.round(num(args.cols, 6)));
        const per = Math.max(1, Math.round(num(args["per-sheet"], 24)));
        const width = Math.max(40, Math.round(num(args.width, 240)));
        const from = Math.max(0, Math.round(num(args.from, 0)));
        const to = Math.min(files.length - 1, Math.round(num(args.to, files.length - 1)));
        const picked = [];
        for (let i = from; i <= to; i += every)
            picked.push(i);
        if (!picked.length) {
            throw usageError(`--from ${from} / --to ${to} select no frames (the directory has ${files.length})`);
        }
        for (let s = 0; s * per < picked.length; s++) {
            const chunk = picked.slice(s * per, (s + 1) * per);
            const cells = chunk.map((i) => ({ img: dataUri(files[i]), caption: stamp(i, fps) }));
            docs.push({
                name: `sheet-${pad(s + 1, 2)}.png`,
                html: page(`${basename(dir)} — frames ${chunk[0]}–${chunk[chunk.length - 1]}`, `${fps} fps · ${picked.length} of ${files.length} frames shown · every ${every} · ${cols} columns`, grid(cells, cols, width)),
            });
        }
    }
    else {
        const refArg = str(args.ref);
        const cloneArg = str(args.clone);
        if (!refArg || !cloneArg) {
            throw usageError("sheet compare needs --ref <dir> --clone <dir>", "add --diff <dir> to draw the diff column too");
        }
        const refDir = abs(refArg);
        const cloneDir = abs(cloneArg);
        const refFiles = listFrames(refDir);
        const cloneFiles = listFrames(cloneDir);
        if (!refFiles.length)
            throw usageError(`no PNG frames in ${refDir}`);
        if (!cloneFiles.length)
            throw usageError(`no PNG frames in ${cloneDir}`);
        const diffArg = str(args.diff);
        const diffFiles = diffArg ? listFrames(abs(diffArg)) : [];
        const fps = num(args.fps, fpsOf(refDir, 25));
        const per = Math.max(1, Math.round(num(args["per-sheet"], 8)));
        const width = Math.max(60, Math.round(num(args.width, 420)));
        const offset = Math.round(num(args.offset, 0));
        // reuse compare's report when it is next to the diff images, so each row shows its own number
        let details = [];
        if (diffArg) {
            const reportPath = join(abs(diffArg), "..", "report.json");
            if (exists(reportPath)) {
                try {
                    const report = readJson(reportPath);
                    if (Array.isArray(report?.frameDetails))
                        details = report.frameDetails;
                }
                catch {
                    /* a stale report is not fatal: the sheet still renders */
                }
            }
        }
        const mismatchOf = new Map(details.map((d) => [d.index, d.mismatch]));
        const last = Math.min(refFiles.length - 1, cloneFiles.length - 1 - offset);
        const from = Math.max(0, Math.round(num(args.from, Math.max(0, -offset))));
        const to = Math.min(last, Math.round(num(args.to, last)));
        const picked = [];
        for (let i = from; i <= to; i += every)
            picked.push(i);
        if (!picked.length)
            throw usageError(`--from ${from} / --to ${to} select no comparable frames`);
        const cols = diffFiles.length ? 3 : 2;
        const headings = `<div class="cols" style="grid-template-columns:repeat(${cols},${width}px)">` +
            `<div>reference</div><div>clone</div>${diffFiles.length ? "<div>diff — red differs</div>" : ""}</div>`;
        for (let s = 0; s * per < picked.length; s++) {
            const chunk = picked.slice(s * per, (s + 1) * per);
            const rows = chunk
                .map((i) => {
                const cloneIndex = i + offset;
                const clonePath = cloneFiles[cloneIndex];
                const diffPath = diffFiles.length ? diffFiles[i] : undefined;
                const m = mismatchOf.get(i);
                const caption = `${stamp(i, fps)}${m !== undefined ? ` · mismatch ${(m * 100).toFixed(1)}%` : ""}`;
                const cls = m !== undefined && m > 0.05 ? "cap bad" : "cap";
                const cell = (src) => src
                    ? `<div class="cell" style="width:${width}px"><img src="${dataUri(src)}" alt=""></div>`
                    : `<div class="cell" style="width:${width}px"><div style="height:${Math.round(width * 0.6)}px;background:#161b22;outline:1px solid #21262d"></div></div>`;
                return (`<div class="row"><div class="${cls}" style="margin-bottom:4px">${caption}` +
                    `${cloneIndex !== i ? ` · clone #${cloneIndex}` : ""}</div>` +
                    `<div class="row" style="grid-template-columns:repeat(${cols},${width}px);border:0;margin:0;padding:0">` +
                    cell(refFiles[i]) +
                    cell(clonePath) +
                    (diffFiles.length ? cell(diffPath) : "") +
                    `</div></div>`);
            })
                .join("");
            docs.push({
                name: `sheet-${pad(s + 1, 2)}.png`,
                html: page(`reference vs clone — frames ${chunk[0]}–${chunk[chunk.length - 1]}`, `${fps} fps · ${picked.length} frames · clone offset ${offset}${diffFiles.length ? " · diff column from " + basename(abs(diffArg)) : ""}`, headings + rows),
            });
        }
    }
    if (!docs.length)
        throw usageError("nothing to render", "check --from/--to/--every");
    // Render each sheet from a temp HTML file: a page loaded from file:// can keep its own data URIs
    // without hitting setContent's argument size limits on long strips.
    const work = mkdtempSync(join(tmpdir(), "refilm-sheet-"));
    const files = [];
    let browser;
    try {
        browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
        const view = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        for (const doc of docs) {
            const htmlPath = join(work, doc.name.replace(/\.png$/, ".html"));
            writeFileSync(htmlPath, doc.html);
            await view.goto("file://" + htmlPath, { waitUntil: "load" });
            const target = join(outDir, doc.name);
            await view.screenshot({ path: target, fullPage: true });
            files.push(target);
            rep.info(`rendered ${target}`);
        }
    }
    finally {
        if (browser)
            await browser.close().catch(() => undefined);
        rmSync(work, { recursive: true, force: true });
    }
    rep.say(files.join("\n"));
    rep.emit("sheet", { files });
    return EXIT.OK;
}
