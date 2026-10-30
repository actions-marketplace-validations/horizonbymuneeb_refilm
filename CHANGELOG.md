# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-10-30

Documentation and correctness release. No breaking changes.

### Added

- **A real worked example in the README.** `demo/` holds a reference page and two clone
  rounds: round 1 is the plausible-looking first pass an agent writes, round 2 fixes exactly
  what the report named. The README images are the tool's own output on those pages —
  `verify` failing with 37 named checks, then passing with 49, plus the compare report and a
  labelled contact sheet.
- **`docs/media/`** — the comparison GIF, the verify screenshots, the compare report and the
  contact sheet, all generated from the demo run and committed so the README renders offline.
- **Programmatic API** (`src/index.ts`): `record`, `compare`, `verify`, … resolve with the same
  object the CLI prints under `data`, and `toArgv()` converts an options object into CLI flags.
- **`scale-in.html` test fixture** — the only fixture that animates a uniform `scale`, plus a
  regression test for it.
- `refilm report --check` now gates a report that already exists on disk.

### Fixed

- **`verify` stillness check rejected uniform scale.** The spec records one `scale` for a
  declared transform while the tracker exposes the matrix as two axes (`scaleX`, `scaleY`), so a
  correct clone failed with "the clone animates .card.scaleY, which the spec does not describe".
  Property aliases now map the two spellings onto each other (`scale` ⇄ `scaleX`/`scaleY`,
  `translateX` ⇄ `x`, `translateY` ⇄ `y`).
- **`report` broke the `--json` contract on its usage-error paths** — exit 2 with no output at
  all, which an agent parses as a crash. Both paths now emit the standard error envelope.
- **`report --check` could never fail**: it regenerated the report and scanned the string it was
  about to write. It now leaves the file alone, re-reads it from disk, and exits 1 when any
  non-`data:` `src`/`href` is present.
- **`report` overflowed horizontally at 390px** (404px on a phone). Wide tables now scroll inside
  a wrapper; measured 0 overflow at 1440×980 and 390×844.
- **`init` / `report` were missing from the command dispatch**, so both failed with
  "Cannot find module".

## [0.1.0] — 2026-10-30

First release.

### Added

- `record` — films a page deterministically: video, numbered frames, declared CSS/WAAPI
  animations with exact timing, per-frame element tracks, fonts, detected libraries.
  Triggers: load, scroll, hover, leave, move, drag, click, none.
- `frames` — cuts a video or gif into numbered frames with a known time base.
- `spec` — derives the motion spec from evidence (declared animations → element tracks →
  GL channels → pixels, in that order of preference) and lists what it could not measure as
  `unresolved` rather than guessing.
- `compare` — frame-by-frame pixel mismatch, auto-alignment, motion window, timing error,
  per-frame activity curve, diff images.
- `fit` — fits a tracked curve to named easings, reporting duration, delay, overshoot and
  whether it looks spring-like.
- `sheet` — labelled contact sheets (filmstrip and reference/clone/diff).
- `gl` — reads a WebGL/WebGPU/canvas trace: scene graph, shaders, constant uniforms, render
  passes, and every animated channel, plus a reference-vs-clone channel diff.
- `verify` — the gate: every spec row checked against the pass criteria, exit 1 on failure,
  and unmeasurable checks reported as `skip` with a reason.
- `report` — one self-contained, offline-safe HTML report.
- `install` — installs the bundled agent skill for Claude Code, Codex or DSH.
- `init` — scaffolds `.refilm/` in a project, idempotently.
- `doctor` — checks node, ffmpeg and Chromium and prints the exact fix for anything missing.
- `--clock virtual`: a page clock advanced frame by frame with `Math.random` seeded, so frame
  *k* is exactly *t = k/fps* and two captures are byte-identical.
- Every command supports `--json` with one envelope and documented exit codes
  (`0` ok, `1` verification failed, `2` usage, `3` environment, `4` internal).
