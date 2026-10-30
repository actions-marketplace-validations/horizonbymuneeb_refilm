# Recording a reference

The capture decides whether every later number means anything. Two rules above all:

1. The reference and the clone are recorded with the **same** viewport, crop, trigger, duration, fps and clock.
2. What you record is exactly what the user pointed at — not the whole page around it.

## Choosing the source path

| Reference is | Do this | You get |
|---|---|---|
| a live URL | `refilm record --url …` | declared animations with exact timing, computed styles, fonts, element tracks |
| a local dev server | `refilm record --url http://localhost:PORT/route` | same |
| a video / gif / screen recording | `refilm frames --in …` | frames with a known time base |
| a Lottie / Rive export | `refilm spec --lottie file.json` | the file *is* the spec; do not re-derive from pixels |
| a canvas / WebGL / 3D scene | `refilm record --clock virtual --gl --assets` | shaders, uniforms, passes, animated channels |

## Website captures

```bash
refilm record --url <url> --out <dir> \
  --selector "<css>" \          # the section to clone; frames get cropped to it
  --trigger load \              # how the motion starts
  --duration 2000 \             # how long to film after the trigger
  --track "<css>, <css>"        # elements whose position/size/opacity/transform you want per frame
```

`--track` is the single most valuable flag: it gives you a numeric curve per element, which `refilm fit` turns into a duration and an easing. Track the elements you will animate, plus their parent if the parent moves.

### Picking the trigger

| Motion looks like | `--trigger` | Extra flags |
|---|---|---|
| plays when the page loads | `load` | — |
| appears when scrolled into view | `scroll` | `--scroll-ms`, `--scroll-steps`, `--scroll-to` |
| reacts to the pointer over an element | `hover` | `--hover-at 0.5,0.5`, `--target` |
| plays when the pointer leaves | `leave` | `--pre-hover` + `--pre-hover-ms` |
| follows the pointer across an element | `move` | `--path "0.2,0.5;0.8,0.5"`, `--path-ms` |
| drag interaction | `drag` | `--path`, `--path-ms` |
| plays on click | `click` | `--target` |
| a loop that never stops | `none` | `--duration` long enough for 2 periods |

### Timing hygiene

- `--wait-before` (default 800 ms) lets the page settle after load. If the reference was recorded on a warm page and the clone is captured cold, that gap shows up as an offset in `compare` — fix it here, not in the code.
- `--pre-js` runs before the trigger: dismiss a cookie banner, open a menu, set a scroll position. Anything that would otherwise change what you film.
- `--playback-rate 0.25` slows CSS/WAAPI animation with CDP. **It does not slow JS-driven motion** (GSAP, Framer springs, rAF loops). For those use `track.json` + `refilm fit`.
- Long durations on a software-GL box drop frames. Keep reference and clone short (≤ 3 s) and identical in length.

## Video and gif captures

```bash
refilm frames --in recording.mov --out ref/frames --probe        # size, duration, fps first
refilm frames --in recording.mov --out ref/frames --fps 20 \
  --start 0:03 --end 0:05 --crop 240,120,760,520
```

- Find the crop on a full frame first, then crop. Cropping out browser chrome, a cursor or a taskbar removes pixels that can never match.
- 10 fps is enough for slow fades; use 25–30 fps for fast motion or short springs.
- A phone recording is not the same time base as a 25 fps desktop capture. Say which one you used and compare like with like.

## Canvas, WebGL, WebGPU and 3D

```bash
refilm record --url <url> --out ref --clock virtual --gl --assets --duration 2000
refilm gl summary ref
```

- `--clock virtual` advances the page clock frame by frame and seeds `Math.random`. Frame *k* is exactly *t = k/fps*, so a slow GPU no longer changes the result and two captures of the same scene are identical. Use it for **both** sides, with the same `--seed`.
- `--gl` traces WebGL/WebGL2/WebGPU/canvas 2D and the three.js/Pixi/PlayCanvas/Babylon/OGL scene graphs, including inside workers.
- `--gpu software` (default) is SwiftShader: slower, identical pixels everywhere. `--gpu hardware` uses the real GPU and enables WebGPU. Record both sides with the same mode.
- A canvas that renders nothing usually means a script failed to load (a module import 404). Check the page's console before blaming the tracer.

## What a good capture looks like

Before you move on, check all of these:

- `frames/` has a plausible count: `fps × (duration + pre-roll) / 1000`, ±2.
- `inspect.json › animations` is non-empty for CSS/WAAPI motion. If it is empty and the element clearly animates, the motion is JS-driven — rely on `track.json` instead.
- `track.json` samples exist for every `--track` selector, and the element's `y`/`opacity` actually changes somewhere.
- `capture.json › libs` lists the libraries the page uses. An unexpected entry (for example `gsap` when you assumed CSS) changes how you implement the clone.
- For pixel work: `inspect.json › fonts` is what you will need to load in the clone.
- You have looked at a filmstrip: `refilm sheet filmstrip --frames ref/frames --out ref/sheets`.
