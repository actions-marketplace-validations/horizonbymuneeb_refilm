# refilm

**Record a reference animation, rebuild it in your code, then re-film the copy and compare the two frame by frame until the numbers match.**

Most "clone this animation" attempts fail for one reason: nobody measures the result. An agent (or a person) looks at a reference, writes something that seems close, and stops. refilm makes the loop explicit and gives every step a number.

```bash
npx refilm record --url https://example.com --selector ".hero" --out .refilm/hero/ref --trigger load --duration 2000
npx refilm spec   --capture .refilm/hero/ref --name hero
# ... build the clone in your project ...
npx refilm record --url http://localhost:5173 --selector ".hero" --out .refilm/hero/clone-1 --trigger load --duration 2000
npx refilm compare --ref .refilm/hero/ref/frames --clone .refilm/hero/clone-1/frames --out .refilm/hero/compare-1
npx refilm verify --spec .refilm/hero/spec.json --ref .refilm/hero/ref --clone .refilm/hero/clone-1 --out .refilm/hero/verify-1
```

`verify` exits **1** when the copy does not match yet. That exit code is the whole product: it turns "looks about right" into a gate an agent or CI can loop on.

## What it does

| Step | Command | What you get |
|---|---|---|
| **Record** | `refilm record` | video, numbered frames, every declared CSS/WAAPI animation with exact timing, per-frame element tracks, fonts, detected libraries |
| **Cut** | `refilm frames` | a screen recording or gif turned into numbered frames with a known time base |
| **Spec** | `refilm spec` | one row per element per property: start, duration, from → to, easing, stagger — with `unresolved` listed honestly instead of guessed |
| **Measure** | `refilm compare` | per-frame pixel mismatch, timing error, activity curve, diff images, pass/fail |
| **Fit** | `refilm fit` | which named easing is this curve, and how long does it actually last |
| **Look** | `refilm sheet` | labelled contact sheets: reference, clone and diff side by side |
| **Gate** | `refilm verify` | every spec row checked against the pass criteria, exit 1 on failure |
| **Report** | `refilm report` | one self-contained HTML file with the numbers and the sheets |
| **Canvas** | `refilm gl` | shaders, uniforms, passes and every animated channel from a WebGL/WebGPU/three.js trace, plus a ref-vs-clone channel diff |

## Fidelity levels

Pick one and say it out loud; it decides what gets checked.

| Level | When you would say | Must match |
|---|---|---|
| `motion` (default) | "clone this animation", "make it feel like theirs" | trigger, order, stagger, timing (±80 ms), easing family, direction and distance; copy, colours and fonts are yours |
| `pixel` | "match it exactly", "1:1", "pixel-perfect" | all of the above plus fonts, sizes, colours, spacing, assets; mean frame mismatch ≤ 2 % |
| `mixed` | "clone X and add Y" | the cloned part at one of the levels above; your additions described and shown, verified only for not disturbing the cloned motion |

## Canvas, WebGL and 3D

A canvas only shows pixels, so `refilm record --gl` records the calls that drew them: shader sources, constant uniforms, render passes, textures, models, and every animated uniform or scene-graph property as a curve that can be fitted and compared.

`--clock virtual` runs the page on a clock advanced frame by frame (with `Math.random` seeded), so frame *k* is exactly *t = k/fps* however slow the GPU is. Two captures of the same WebGL scene come out **byte-identical** — that is what makes a canvas comparison meaningful instead of a measurement of machine load.

```bash
npx refilm record --url https://example.com --out ref --clock virtual --gl --assets --duration 2000
npx refilm gl summary ref
npx refilm gl compare --ref ref --clone clone-1
```

## Determinism

Same input, same output. refilm seeds `Math.random` under the virtual clock, sorts every directory walk, and refuses to compare captures whose settings differ (`compare` reads `capture.json` on both sides and warns when viewport, fps, trigger, clock or seed disagree — a comparison across different captures measures the setup, not the work).

## Install

```bash
npm install -g refilm     # or: npx refilm
refilm doctor             # checks node, ffmpeg, Chromium, and prints the exact fix for anything missing
refilm install --agent claude    # also: codex, dsh, all
```

Requirements: **Node 20+**, **ffmpeg**, and Playwright's Chromium (`npx playwright install chromium`). refilm never downloads anything behind your back; `refilm doctor` tells you what is missing and how to install it.

No API keys. No account. No telemetry. Everything runs locally.

## Using it from an agent

`refilm install --agent claude|codex|dsh|all` drops the bundled skill into the agent's skill directory. The skill is a thin wrapper: it tells the agent when to reach for refilm and how to read the numbers, while all the measurement lives in the CLI. Any agent that can run a shell command can use refilm without the skill.

## Commands

```
refilm record   --url <url|file.html> --out <dir> [options]
refilm frames   --in <video|gif> --out <dir> [options]
refilm spec     --capture <dir> | --frames <dir> | --lottie <f>
refilm compare  --ref <dir> --clone <dir> --out <dir>
refilm sheet    filmstrip|compare ...
refilm fit      --track <json> --selector <css> --prop <p>
refilm gl       summary|channels|compare ...
refilm verify   --spec <spec.json> --ref <dir> --clone <dir>
refilm report   --dir <run dir> [--out <file.html>]
refilm install  --agent claude|codex|dsh|all
refilm init     [--dir <project>]
refilm doctor
```

Every command takes `--json` and prints one envelope:

```json
{ "ok": true, "command": "compare", "version": "0.1.0", "warnings": [], "data": { } }
```

Exit codes: `0` success · `1` verification failed · `2` usage error · `3` environment problem · `4` internal error.

## How it fits together

```
src/lib.ts       args, output envelope, exit codes, ffmpeg resolution
src/types.ts     every on-disk and JSON shape (schema versioned)
src/cli.ts       dispatch
src/engine/      the capture engine (playwright + in-page clock and GPU tracer)
src/commands/    one file per command
skill/           the agent skill installed by `refilm install`
```

`CONTRACT.md` documents the internal contract; `docs/` has the per-topic notes (fidelity, capture recipes, reading a compare report).

## Limits

- Pages behind a login and YouTube/Loom links cannot be recorded directly — hand it a screen recording.
- Physics springs are fitted from overshoot and settle time, not read from source.
- Workers are traced, but their own clocks run in real time.
- Software GL (the default) is slower than a real GPU but produces identical pixels on every machine.
- It clones what you point it at. Fonts, images and code from another site still belong to their owners — make sure you may use what you copy.

## License

MIT. See [LICENSE](LICENSE).
