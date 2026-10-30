---
name: refilm
description: Rebuild an animation from a reference (a live website, a screen recording, an mp4/mov/webm, a gif, a Lottie file) in the user's own codebase, then film the copy the same way and compare the two frame by frame until timing, easing, sequence and layout match. Use whenever the user wants to clone, copy, replicate, recreate, port or "steal" a hero, section, widget, marquee, carousel, hover effect, page transition, loader, scroll animation or interaction from a site or a video, says "make it look/feel/move like this", "same animation as", "match this exactly", or hands over a gif/video and asks to build it — including when they want their own content, colours or extra features on top, or only want part of the reference. Covers canvas, WebGL, WebGPU and three.js/Pixi/Babylon 3D scenes as well as CSS and JS motion.
---

# refilm

You are rebuilding a reference animation so that it *moves* like the original, and you prove it with numbers. "It looks close" is not a result. A `refilm verify` run that exits 0 is a result.

Every command has `--json` and a documented exit code. Read the JSON; do not scrape the human output.

## 0. Before you start

```bash
refilm doctor            # node, ffmpeg, Chromium — installs nothing, prints the exact fix for anything missing
refilm init              # creates .refilm/ in the project and gitignores it
```

If `doctor` exits 3, stop and report the missing piece with its fix command. Do not silently install browsers or binaries.

## 1. State the fidelity level

Decide from the user's words and say it in your first message. It changes what `verify` checks.

| Level | User said | Checked |
|---|---|---|
| `motion` (default) | "clone this animation", "make ours feel like theirs" | trigger, order, stagger, timing ±80 ms, easing family, direction and distance |
| `pixel` | "match it exactly", "1:1", "pixel-perfect" | all of the above plus fonts, sizes, colours, spacing, assets; mean mismatch ≤ 2 % |
| `mixed` | "clone X and add Y" | the cloned part at one level; additions described and shown |

Narrow the target to what they named: one section, one widget, one time range of a video. Do not clone the rest of the page.

Write the scope into `.refilm/runs/<name>/scope.md` before capturing: **target**, **destination** (path + stack, read the project's `package.json` and existing components — reuse the animation library already in the project), **fidelity**, and for `mixed` the list of additions.

## 2. Record the reference

```bash
refilm record --url <url|file.html> --out .refilm/runs/<name>/ref \
  --selector "<section>" --trigger load|scroll|hover|click|move|drag|none \
  --duration 2000 --track "<moving elements>"
```

This writes `frames/`, `inspect.json` (declared CSS/WAAPI animations with exact delay/duration/easing per keyframe, computed styles, fonts, libraries), `track.json` (per-frame position/size/opacity/transform of each tracked element) and `capture.json`.

- **Video or gif reference**: `refilm frames --in <file> --out ref/frames --fps 20 --start 0:03 --end 0:05 --crop x,y,w,h`. Probe first with `--probe`, then look at a few frames to find the crop.
- **Canvas / WebGL / 3D**: add `--clock virtual --gl --assets` and read `refilm gl summary ref`. The virtual clock makes every frame exact and every capture identical.
- **Lottie**: the file is the spec — `refilm spec --lottie <file>` reads layers and keyframes directly. Do not re-derive it from pixels.

Then **look at the frames**: `refilm sheet filmstrip --frames ref/frames --out ref/sheets`. Read every sheet. This is not optional; the numbers say something is off, the sheets say what.

## 3. Derive the spec

```bash
refilm spec --capture ref --name <name> --fidelity motion --md .refilm/runs/<name>/spec.md
```

One row per element per property: start, duration, from → to, easing, stagger, and a `source` (`declared` > `track` > `frames`) plus `confidence`. Anything the evidence cannot answer lands in `unresolved` — **resolve those before building**, by reading more frames or asking the user. Never fill a row with a guess and leave it looking measured.

The spec is the contract. Every row becomes a check in step 5.

## 4. Build

Implement in the project's own stack, following `references/implementation.md` (easing tables, stagger math, scroll and hover triggers, reduced motion). Keep the DOM structure close to the reference's role structure so tracked selectors have equivalents in the clone.

Give the clone a way to be filmed identically: a route or a static page that renders the component at the reference viewport with the same trigger.

## 5. Verify, fix, repeat

```bash
refilm record --url <clone url> --out .refilm/runs/<name>/clone-1 --selector "<section>" \
  --trigger <same> --duration <same> --track "<same>"
refilm compare --ref .refilm/runs/<name>/ref/frames --clone .refilm/runs/<name>/clone-1/frames \
  --out .refilm/runs/<name>/compare-1
refilm sheet compare --ref .../ref/frames --clone .../clone-1/frames --diff .../compare-1/diff \
  --out .../compare-1/sheets
refilm verify --spec .refilm/runs/<name>/spec.json --ref .../ref --clone .../clone-1 \
  --out .refilm/runs/<name>/verify-1
```

`verify` exits **1** while anything is off and names the failing check. `references/verify.md` maps each failure to its usual fix. Read the compare sheets every round — the numbers tell you that something is off, the sheets tell you what.

Each round: change the smallest thing the evidence points at, re-record, re-compare. Expect 2 to 5 rounds. If a row still fails after 5, stop and report it with its numbers and the reason — never lower a threshold to make a run green.

## 6. Report

The final message stands alone:

- fidelity level, what was cloned, what was added;
- where the code is and how to trigger the motion;
- a table of the last verify round: per-check measured vs limit, pass/fail;
- paths to the compare sheets (and embed them if the environment shows images);
- every residual deviation with a number and a reason.

`refilm report --dir .refilm/runs/<name> --out .refilm/runs/<name>/report.html` produces one self-contained file with all of the above.

## Rules that save rounds

- **Same capture settings on both sides.** Different viewport, crop, fps, trigger or clock means you are measuring your setup. `compare` warns about it; treat the warning as a failure.
- **Read the middle frames.** Easing lives between the first and last frame; sampling two frames tells you nothing.
- **Fonts.** A fallback font changes every frame's pixels. For `pixel` work load the same font (names are in `inspect.json › fonts`) before judging mismatch; for `motion` work ignore text pixels and read the timing columns.
- **Cold page vs warm page.** If the reference was recorded on a loaded page and the clone is captured cold, use `--wait-before`, or `--trigger none` with a `--pre-js` that restarts the animation, so both start from rest.
- **Scroll motion is a function of scroll position, not time.** Capture both with the same `--scroll-steps` and `--scroll-ms` and compare per scroll position, not per second.
- **JS libraries are not slowed by `--playback-rate`.** Use `track.json` + `refilm fit` (it reports overshoot and "spring-like") and tune spring parameters by overshoot and settle time.
- **Screen recordings of someone else's screen** have a cursor, browser chrome and compression noise: crop them out and raise `--pixel-threshold` slightly instead of chasing noise.
- **Canvas on the real clock** drops frames and differs every load. Capture both sides with `--clock virtual` and the same `--seed`.
- **Rebuilding a shader from screenshots** is wasted work: `refilm gl summary` already has the source and every constant uniform.

## Reference files

| File | Read it when |
|---|---|
| `references/capture.md` | choosing the trigger, viewport, crop and duration for each source type |
| `references/analysis.md` | turning frames and tracks into spec rows, and the patterns worth recognising |
| `references/implementation.md` | easing tables, stagger math, scroll/hover triggers, reduced motion, per-stack patterns |
| `references/verify.md` | reading a compare report, the pass criteria, and the fix for each failure |
| `references/webgl.md` | canvas/WebGL/WebGPU/3D capture, reading a GPU trace, channel comparison |
