# refilm

**Record a reference animation, rebuild it in your code, then re-film the copy and compare the two frame by frame until the numbers match.**

[![npm](https://img.shields.io/npm/v/refilm?color=3b6cf6&label=npm)](https://www.npmjs.com/package/refilm)
[![downloads](https://img.shields.io/npm/dm/refilm?color=3b6cf6)](https://www.npmjs.com/package/refilm)
[![CI](https://github.com/horizonbymuneeb/refilm/actions/workflows/ci.yml/badge.svg)](https://github.com/horizonbymuneeb/refilm/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/refilm?color=3b6cf6)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/refilm?color=3b6cf6)](LICENSE)
[![Marketplace](https://img.shields.io/badge/marketplace-refilm--verify-6f42c1?logo=github)](https://github.com/marketplace/actions/refilm-verify)
[![docs](https://img.shields.io/badge/docs-horizonbymuneeb.github.io%2Frefilm-3b6cf6)](https://horizonbymuneeb.github.io/refilm/)

<p align="center">
  <img src="https://raw.githubusercontent.com/horizonbymuneeb/refilm/main/docs/media/compare.gif" width="620" alt="Reference animation on top, the clone below, both filmed the same way at the same timestamps">
</p>
<p align="center"><sub>The same 1.8s entrance, filmed identically. Top: the reference. Bottom: the clone, with different copy and a different accent colour — which is what motion fidelity allows.</sub></p>

Most "clone this animation" attempts fail for one reason: nobody measures the result. An agent — or a person — looks at a reference, writes something that seems close, and stops. refilm makes the loop explicit and gives every step a number you can check.

**[Documentation](https://horizonbymuneeb.github.io/refilm/)** · [Getting started](https://horizonbymuneeb.github.io/refilm/site/getting-started.html) · [Command reference](https://horizonbymuneeb.github.io/refilm/site/commands/) · [npm](https://www.npmjs.com/package/refilm) · [Changelog](CHANGELOG.md)

```bash
npx refilm record  --url https://example.com --selector ".hero" --out .refilm/hero/ref --duration 1800
npx refilm spec    --capture .refilm/hero/ref --out .refilm/hero --name hero
# ... build the clone in your project ...
npx refilm record  --url http://localhost:5173 --selector ".hero" --out .refilm/hero/clone-1 --duration 1800
npx refilm compare --ref .refilm/hero/ref/frames --clone .refilm/hero/clone-1/frames --out .refilm/hero/compare-1
npx refilm verify  --spec .refilm/hero/spec.json --ref .refilm/hero/ref --clone .refilm/hero/clone-1
```

`verify` exits **1** while the copy does not match. That exit code is the whole product: it turns "looks about right" into a gate an agent or CI can loop on.

---

## The loop, on a real run

The images below are not mock-ups. They are the output of the commands in this repository, on the demo in [`demo/`](demo/).

### Round 1 — the first pass an agent writes

Same layout, but the cards rise together in 420ms on a linear curve instead of the reference's 820ms ease-out with a 100ms stagger. It looks fine at a glance.

<img src="https://raw.githubusercontent.com/horizonbymuneeb/refilm/main/docs/media/verify-fail.png" width="700" alt="refilm verify reporting 37 failed checks with measured values and limits">

```
result: FAIL — 37 check(s) failed (exit 1)
```

Note what it says: not "looks different" but *`ease-out → linear`*, *`-700 ms (limit ±80 ms)`*, *`travel 14.1% (limit ≤10%)`*. Every failure is a number and a named cause.

### Round 2 — after fixing exactly what the report named

<img src="https://raw.githubusercontent.com/horizonbymuneeb/refilm/main/docs/media/verify-pass.png" width="700" alt="refilm verify reporting 49 passing checks and exit 0">

```
result: PASS (exit 0)
```

49 checks pass, 0 fail, and **11 are skipped with a reason** — because a skip is not a pass, and refilm refuses to report a check it could not measure as green.

### What the comparison itself looks like

<img src="https://raw.githubusercontent.com/horizonbymuneeb/refilm/main/docs/media/compare-report.png" width="760" alt="refilm compare report: mean mismatch, motion window, timing error and a per-frame activity chart">

The **activity chart** is the part that makes easing debuggable: bar length is how much changed since the previous frame. Same shape means same easing and stagger. A clone that is front-loaded against an even reference is using too strong an ease-out — you can see it before you look at a single frame.

### And the frames, side by side

<img src="https://raw.githubusercontent.com/horizonbymuneeb/refilm/main/docs/media/sheet-compare.png" width="820" alt="Labelled contact sheet: reference, clone and pixel diff for each timestamp">

`refilm sheet compare` lays out reference, clone and diff for every timestamp, so "what is still off" is something you look at rather than something you infer.

---

## Install

```bash
npm install -g refilm     # or run it with npx refilm
refilm doctor             # checks node, ffmpeg and Chromium, prints the exact fix for anything missing
refilm install --agent claude    # also: codex, dsh, all
```

**Requirements:** Node 20+, ffmpeg, and Playwright's Chromium (`npx playwright install chromium`). refilm never downloads anything behind your back — `doctor` tells you what is missing and how to install it. No API keys, no account, no telemetry.

---

## What it does

| Step | Command | What you get |
|---|---|---|
| **Record** | `refilm record` | video, numbered frames, every declared CSS/WAAPI animation with exact timing, per-frame element tracks, fonts, detected libraries |
| **Cut** | `refilm frames` | a screen recording or gif turned into numbered frames with a known time base |
| **Spec** | `refilm spec` | one row per element per property: start, duration, from → to, easing, stagger — with `unresolved` listed honestly instead of guessed |
| **Measure** | `refilm compare` | per-frame pixel mismatch, timing error, activity curve, diff images, pass/fail |
| **Fit** | `refilm fit` | which named easing this curve is, and how long it actually lasts |
| **Look** | `refilm sheet` | labelled contact sheets: reference, clone and diff side by side |
| **Gate** | `refilm verify` | every spec row checked against the pass criteria, **exit 1 on failure** |
| **Report** | `refilm report` | one self-contained HTML file with the numbers and the sheets |
| **Canvas** | `refilm gl` | shaders, uniforms, passes and every animated channel from a WebGL/WebGPU/three.js trace, plus a ref-vs-clone channel diff |

## Fidelity levels

Pick one and say it out loud; it decides what gets checked.

| Level | When you would say | Must match |
|---|---|---|
| `motion` (default) | "clone this animation", "make it feel like theirs" | trigger, order, stagger, timing (±80 ms), easing family, direction and distance; copy, colours and fonts are yours |
| `pixel` | "match it exactly", "1:1", "pixel-perfect" | all of the above plus fonts, sizes, colours, spacing, assets; mean frame mismatch ≤ 2% |
| `mixed` | "clone X and add Y" | the cloned part at one of the levels above; your additions described and shown, verified only for not disturbing the cloned motion |

## Determinism

Same input, same output — this is the guarantee the whole measurement rests on.

```bash
# two captures of the same page, on a virtual clock
refilm record --url ./page.html --out a --clock virtual --seed 1 --duration 1500
refilm record --url ./page.html --out b --clock virtual --seed 1 --duration 1500
cd a/frames && sha256sum *.png | md5sum   #  identical
cd ../../b/frames && sha256sum *.png | md5sum
```

Under `--clock virtual` the page runs on a clock advanced frame by frame, with `Math.random` seeded, so frame *k* is exactly *t = k/fps* however slow the machine is. Two captures of a WebGL scene come out **byte-identical** — verified on 46-frame captures and on three.js scenes across repeated runs. Without it, a software-GL box drops frames and the comparison measures the machine instead of the work.

`refilm compare` also reads `capture.json` on both sides and warns when viewport, fps, trigger, clock or seed disagree: a comparison across different captures measures the setup, not the clone.

## Canvas, WebGL and 3D

A canvas only shows pixels, so `refilm record --gl` records the calls that drew them: shader sources, constant uniforms, render passes, textures, models, and every animated uniform or scene-graph property as a curve that can be fitted and compared.

```bash
refilm record --url https://example.com --out ref --clock virtual --gl --assets --duration 2000
refilm gl summary ref                     # canvases, programs, passes, animated channels
refilm gl channels ref --grep emissive     # one family of channels, with kind and change window
refilm gl compare --ref ref --clone clone-1
```

Channels are classified (`clock`, `transition`, `there-and-back`, `oscillation`, `steps`), so "this uniform moves 0.9 per second" is something the tool tells you rather than something you guess from screenshots.

## Using it from an agent

```bash
refilm install --agent claude    # also: codex, dsh, all
```

This drops the bundled skill into the agent's skill directory. The skill is a thin wrapper: it tells the agent when to reach for refilm and how to read the numbers, while all the measurement lives in the CLI. Any agent that can run a shell command can use refilm without the skill.

Every command takes `--json` and prints one envelope, so an agent never has to scrape human output:

```json
{ "ok": true, "command": "compare", "version": "0.1.3", "warnings": [], "data": { } }
```

Exit codes: `0` success · `1` verification failed · `2` usage error · `3` environment problem · `4` internal error.

## Programmatic use

```js
import { record, compare, verify } from "refilm";

const cap = await record({ url: "https://example.com", out: ".refilm/ref", duration: 1800 });
const cmp = await compare({ ref: ".refilm/ref/frames", clone: ".refilm/clone-1/frames", out: ".refilm/cmp" });
if (!cmp.pass) console.log(cmp.failures);
```

Each helper resolves with the same object the CLI prints under `data`.

## In CI

```yaml
- run: npx refilm verify --spec .refilm/hero/spec.json --ref .refilm/hero/ref --clone .refilm/hero/clone-1 --json
```

The job fails when the motion drifts. That is the point: an animation regression becomes a red build instead of a review comment nobody can measure.

## Watch mode

The loop does not need a human to drive it. `refilm watch` re-records the clone and
re-measures it whenever the clone changes, printing one line per iteration:

```console
$ refilm watch --url http://localhost:3000 --ref .refilm/hero/ref
[12:03:04] 80 frames · 7.74% mismatch (budget 5.00%) · start +0.032s · FAIL · 4.4s
[12:03:19] 80 frames · 2.10% mismatch (budget 5.00%) · start +0.004s · PASS · 4.5s
```

It detects changes by mtime for a local file and by ETag/Last-Modified for a URL, so a
rebuild or a save triggers exactly one new measurement. A failing comparison never
stops the watch — watching the number come down is the point.
`--once` runs a single iteration (handy in CI), `--spec` gates with `refilm verify`
instead of `refilm compare`.

## GitHub Action

```yaml
- uses: horizonbymuneeb/refilm@v0.2.0
  with:
    spec: .refilm/hero/spec.json
    ref: .refilm/hero/ref
    clone: .refilm/hero/clone-1
```

Posts a summary to the job (mismatch, timing, failing checks), uploads the diff
images and the HTML report as `refilm-evidence`, and fails the build on drift.
[Listed on the Marketplace](https://github.com/marketplace/actions/refilm-verify).
`mode: compare` switches to the frame diff with `threshold` /
`motion-threshold` budgets.

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
refilm report   --dir <run dir> [--out <file.html>] [--check]
refilm install  --agent claude|codex|dsh|all
refilm init     [--dir <project>]
refilm doctor
```

Run any of them with `--help` for the full flag list, or read the
[command reference](https://horizonbymuneeb.github.io/refilm/site/commands/) — one page per command
with every flag, what it writes to disk, and the exit codes it can return.

## How it fits together

```
src/lib.ts       args, output envelope, exit codes, ffmpeg resolution
src/types.ts     every on-disk and JSON shape (schema versioned)
src/cli.ts       dispatch
src/engine/      the capture engine (playwright + in-page clock and GPU tracer)
src/inpage/      clock.js, gl-hooks.js — injected into the page
src/commands/    one file per command
skill/           the agent skill installed by `refilm install`
```

[`CONTRACT.md`](CONTRACT.md) documents the internal contract, [`docs/`](docs/) has the per-topic notes (fidelity levels, reading a compare report), and [`demo/`](demo/) holds the reference and both clone rounds used in the images above.

## Documentation

Full documentation lives at **[horizonbymuneeb.github.io/refilm](https://horizonbymuneeb.github.io/refilm/)**:

| | |
|---|---|
| [Getting started](https://horizonbymuneeb.github.io/refilm/site/getting-started.html) | install, `doctor`, and a first complete run |
| [The workflow](https://horizonbymuneeb.github.io/refilm/site/workflow.html) | the loop in depth, fidelity levels, pass criteria |
| [Command reference](https://horizonbymuneeb.github.io/refilm/site/commands/) | every command and flag |
| [Canvas and 3D](https://horizonbymuneeb.github.io/refilm/site/canvas.html) | `--gl`, `--clock virtual`, channel kinds |
| [Determinism](https://horizonbymuneeb.github.io/refilm/site/determinism.html) | what the byte-identical guarantee covers |
| [Using it from an agent](https://horizonbymuneeb.github.io/refilm/site/agents.html) | the skill, the `--json` contract, CI |
| [Fidelity levels](https://horizonbymuneeb.github.io/refilm/site/fidelity.html) | `motion` vs `pixel` vs `mixed` |
| [Reading a compare report](https://horizonbymuneeb.github.io/refilm/site/compare-report.html) | what the numbers mean and what to fix |
| [Changelog](https://horizonbymuneeb.github.io/refilm/site/changelog.html) | every release |

In the repository: [CONTRACT.md](CONTRACT.md) (internal architecture), [skill/SKILL.md](skill/SKILL.md)
(the agent skill), [demo/](demo/) (the reference and both clone rounds used in the images above),
[CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup and the
five rules the project actually enforces — the short version is that a check which cannot be measured
is reported as `skip`, never as `pass`, and a threshold is never relaxed to make a run green.

- [Report a bug](https://github.com/horizonbymuneeb/refilm/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/horizonbymuneeb/refilm/issues/new?template=feature_request.md)
- [Report a bad capture](https://github.com/horizonbymuneeb/refilm/issues/new?template=capture_quality.md)
- [Ask a question](https://github.com/horizonbymuneeb/refilm/discussions)

Security issues go to email, not a public issue — see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install --include=dev    # this box exports NODE_ENV=production; --include=dev keeps tsc
npm run build                # tsc, strict, NodeNext ESM
npm test                     # 135 tests: unit + integration, real browser, real captures
npm run typecheck
```

The test suite drives the built CLI as a child process and asserts on exit codes and JSON payloads, not on log wording. It includes a determinism test that hashes every frame of two `--clock virtual` captures, and a control fixture that uses real `Math.random` so the seed cannot be silently ignored.

## Limits

- Pages behind a login and YouTube/Loom links cannot be recorded directly — hand it a screen recording.
- Physics springs are fitted from overshoot and settle time, not read from source.
- Workers are traced, but their own clocks run in real time.
- `--clock real` captures are **not** byte-identical (they pass through video encoding); the determinism guarantee is for `--clock virtual`.
- Software GL (the default) is slower than a real GPU but produces identical pixels on every machine.
- The in-page tracker samples the first match per selector, so sibling rows beyond the first are reported as `skip` with the exact selector that would measure them — never as `pass`.
- It clones what you point it at. Fonts, images and code from another site still belong to their owners — make sure you may use what you copy.

## License

MIT. See [LICENSE](LICENSE).
