# Canvas, WebGL, WebGPU and 3D

A canvas only shows pixels, so `refilm record --gl` records the calls that drew them. You get shader sources, every constant uniform, the render passes, the textures and models, and each animated uniform or scene-graph property as a curve that can be fitted and compared.

## Recording

```bash
refilm record --url <url> --out ref --clock virtual --gl --assets --duration 2000 --fps 20
refilm gl summary ref
```

- **`--clock virtual`** — the page runs on a clock advanced frame by frame (`performance.now`, `Date`, timers, `requestAnimationFrame`, CSS/WAAPI timing, event timestamps), with `Math.random` seeded. Frame *k* is exactly *t = k/fps* whatever the GPU or machine load, and two captures of the same scene come out byte-identical. Without it, a software-GL box drops frames and random particles differ on every load, so the comparison measures the machine.
- **`--gl`** — traces WebGL, WebGL2, WebGPU and canvas 2D, and hooks the three.js, Pixi, PlayCanvas, Babylon and OGL scene graphs through their own devtools entry points, including inside workers.
- **`--assets`** — saves the models, textures, shader files, Lottie/Rive/Spline files and scripts the page loaded.
- **`--gpu software`** (default) is SwiftShader: slower, but the same pixels on every machine. `--gpu hardware` uses the real GPU and enables WebGPU. Record **both** sides with the same mode.

Output: `gl/gl.json`, `gl/draws.json`, `gl/shaders/`, `gl/summary.md`, `gl-track.json`, `assets/`.

## Reading the trace

```bash
refilm gl summary ref                      # canvases, scene graph, programs, passes, textures, animated channels
refilm gl channels ref                     # every animated channel: kind, range, change window
refilm gl channels ref --grep emissive     # just the ones you care about
refilm gl channels ref --series "three:s0/Mesh#2.rotation.x"   # one channel as [[t, v], …]
```

Channel kinds:

| Kind | Meaning | How to implement |
|---|---|---|
| `clock` | advances linearly with time (`+0.9/s`) | drive it from a clock at that rate |
| `transition` | monotonic move from A to B inside a window | that window is the duration; fit the easing |
| `there-and-back` | leaves and returns | two-phase; note the turn point |
| `oscillation` | periodic | period and amplitude, usually a sine |
| `steps` | discrete jumps | a state machine, not an interpolation |

Fit any channel exactly like a DOM property: `refilm fit --track ref/gl-track.json --channel "three:s0/Mesh#2.rotation.x"`.

## Comparing a clone

```bash
refilm gl compare --ref ref --clone clone-1 [--grep RE] [--map "uHover=u_hover"] [--timing 80]
```

It checks canvas attributes and renderer settings, draw structure (primitive, vertex count, blend state, cadence) and every animated channel: same kind, start and end within `--timing` ms, mean error ≤ 5 % of the reference's range. Use `--map` when the clone's channel names differ.

## Building the clone

1. **Same engine, same version.** Port the shaders from `gl/shaders/` verbatim where they are the user's own; keep every constant uniform exactly as recorded (a single wrong constant changes the whole look).
2. **Copy the fixed uniforms.** They are the art direction, not noise. `gl summary` separates constants from animated channels.
3. **Drive each animated channel** with the timing and easing its curve showed, through the same property (uniform, object transform, camera).
4. **Match the render passes.** A four-pass composite is not one pass with a fancy shader.
5. **Match the renderer settings** — context attributes, tone mapping, colour space, pixel ratio.
6. **Frame-rate-independent smoothing** for pointer-followed values: `x += (target − x) · (1 − (1 − k) ** (dt / 16.67))`.
7. **Random content**: if you port the generator, seed it the same way and the particles match dot for dot. If you cannot, say so and compare with `--blur`.

## Limits worth knowing

- Workers are seeded and traced, but their own clocks run in real time.
- Canvases inside iframes need the iframe's own URL.
- When the clone cannot reproduce the reference's random generator, particles are compared with a blurred mismatch (density, colour, motion) instead of dot by dot.
- Software GL is slow: keep canvas captures short (≤ 2 s) and the viewport modest.
- A canvas that renders nothing after a `--gl` run is usually a script that failed to load — check the page console before blaming the tracer.
