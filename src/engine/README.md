# refilm capture engine

How `refilm record` turns a page into evidence, and why each choice is the way it is.

```
src/commands/record.ts   the command: help text, argv, progress, --json envelope
src/engine/options.ts    argv -> CaptureOptions (types.ts) + every path the capture writes
src/engine/capture.ts    the run: browser, navigation, trigger, frames, artifacts
src/engine/triggers.ts   load | scroll | hover | leave | move | drag | click | none
src/engine/inspect-script.ts  the in-page dump: animations, keyframes, styles, fonts, libraries
src/engine/tracker.ts    the per-rAF element sampler and the canvas context probes
src/engine/crop.ts       PNG cropping in process (pngjs), so frame bytes stay reproducible
src/engine/gl.ts         GPU trace -> gl/, gl-track.json; channel classification; gl compare
src/engine/inpage.ts     loads src/inpage/*.js and wraps them as init scripts
src/inpage/clock.js      the virtual clock
src/inpage/gl-hooks.js   the GPU tracer
```

## Two clocks

`--clock real` lets Playwright record the page and cuts frames out of the video with ffmpeg. Frame *k* is
approximately `t = k/fps`; a loaded machine drops frames.

`--clock virtual` injects `src/inpage/clock.js` before any page script. `performance.now`, `Date`, timers,
`requestAnimationFrame`, `requestIdleCallback`, `document.timeline.currentTime`, `Event.timeStamp` and every
CSS / WAAPI animation then read one counter the capturer moves by hand. For each frame the capturer advances
to exactly `t = k/fps` and screenshots, so a slow render costs wall time and never accuracy.

### Why the clock counts integer microseconds from zero

The first version anchored the counter on the wall clock (`st.t = performance.now()`) and stepped the rAF grid
at `tick = 1000/60` ms. That grid's fractional phase was random per run, so `step(100)` fired 5 or 6
animation frames depending on where the anchor landed, and one frame of a capture could be drawn one rAF
early or late. The clock now counts **integer microseconds from a fixed origin of 0**, with an integer tick
(`round(1e6 / rafHz)`), so "how many animation frames fall inside `step(ms)`" is a pure function of `ms`.

Two consequences worth knowing if you touch it:

- `hold()` **rebases every pending timer** (`dueUs -= wallUs`). Timers queued before the clock was held carry
  wall-clock deadlines; without rebasing they are due millions of milliseconds in the future and `step()`
  never reaches them — that is the hang you get from "just set the time to 0".
- Intervals keep their cadence: the next firing is one delay after the previous due time, never a catch-up
  from "now", which would make the sequence depend on how late a callback ran.

### What else nondeterminism came from

Byte-identical frames needed more than the clock. In order:

1. **Script boot racing frame 0.** With the clock held at navigation, a page's module scripts still finish on
   the real clock. `settleBoot()` steps a few frames and watches how many time sources the page registers
   (`state().signups`); once that stops moving, frame 0 is taken on the same path every run.
2. **The drawing buffer.** A WebGL context without `preserveDrawingBuffer` is cleared once the compositor has
   taken the frame, so a screenshot could read a half-drawn canvas. `DRAWING_BUFFER_PATCH` forces the
   attribute on under `--clock virtual`; it changes nothing about what the page draws.
3. **The compositor's own tick.** `__filmClock.present()` awaits two *native* animation frames (not the
   virtualised `requestAnimationFrame`) before each screenshot, without moving virtual time.
4. **Compositor flags.** `--clock virtual` launches Chromium with `--run-all-compositor-stages-before-draw`,
   `--disable-partial-raster`, `--disable-checker-imaging`, `--disable-threaded-animation`,
   `--disable-threaded-scrolling`, `--force-color-profile=srgb` and `--disable-lcd-text`.
   **`--deterministic-mode` is deliberately absent**: it stops the native animation frames that `present()`
   waits for, which deadlocks the frame loop.

## Trigger model

Every trigger is a list of `{ at, run }` actions stamped with a virtual millisecond, whether or not the
clock is virtual. The real-clock path replays the same list against the wall clock, so the two cannot drift.
A pointer glide issues one move per virtual tick (`--path-ms` / `--raf-hz`), and a scroll issues
`--scroll-steps` wheel events spread over `--scroll-ms`.

## GPU tracing

`--gl` injects `src/inpage/gl-hooks.js` before any page script. It wraps WebGL 1/2 (shaders, programs,
attribute layouts, textures and their source URLs, buffers, framebuffers, every draw with state and bound
textures, uniform deltas), WebGPU (WGSL modules, pipelines, draw counts, small uniform writes), canvas 2D
(call counts per frame, full log on sampled frames), and the devtools entry points three.js, Pixi, PlayCanvas,
Babylon and OGL publish — so it works on bundled builds with no globals. Workers are instrumented over a
second CDP session with `Target.setAutoAttach` + `waitForDebuggerOnStart`.

`src/engine/gl.ts` turns the raw trace into `gl/gl.json` (static: contexts, programs, passes, textures),
`gl/shaders/`, `gl/draws.json` (per frame, in draw order) and `gl-track.json` (one sample per rendered frame,
every channel that changes). Each channel is classified, because the kind decides how a clone drives it:

| kind | meaning | how you clone it |
|---|---|---|
| `clock` | monotonic through the whole capture at a steady rate | drive from elapsed time |
| `transition` | monotonic, settles | ease from the start value to the end value |
| `there-and-back` | one turn | ease out and back |
| `oscillation` | 3+ turns, moving most of the time | loop, `periodMs` is the period |
| `steps` | 3+ turns, mostly still | keyframed steps |

`gl compare` matches channels by property name (or `--map`), then requires the same kind, start and end
within `--timing` ms, and a mean value error ≤ 5 % of the reference range.

## Determinism evidence

`test/fixtures/canvas-2d.html` (10 runs, `--clock virtual --seed 1`, 640x480, 10 fps, 1000 ms): one hash,
count 10, and every individual frame file has `uniq = 1` across the runs.

A three.js page with a `ShaderMaterial` (`uTime` clock, `uHover` transition) and an oscillating box,
captured four times with `--clock virtual --gl` at 640x400, 30 fps, 1600 ms: all four frames directories
hash to `b0b5d229b943a3e35234aa963587c730bcf60d70d0a3752432afe065bd353605`, and `gl summary` reports
2 programs and 11 animated channels (3 clock, 4 transition, 4 there-and-back).
