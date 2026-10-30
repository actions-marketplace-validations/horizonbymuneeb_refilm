# Reading a compare report

`refilm compare` writes `report.md` (for humans), `report.json` (the same numbers, typed) and `diff/NNNN.png` (red where the pixels differ).

## The header

```
- frames compared: 55/55 at 25 fps, clone offset 0
- mean mismatch: 1.83% (threshold 5.0%) → FAIL
- motion window — reference: frames 3–51 (0.12s–2.04s, peak #12); clone: 4–53 (0.16s–2.12s, peak #13)
- timing error (clone − ref): start +0.04s, end +0.08s, duration +0.04s, peak +0.04s → FAIL (limit 0.08s)
- worst frames: #13 (3.1% @ 0.52s), #14 (2.9% @ 0.56s), …
```

Read it in this order:

1. **`setupWarnings`** — if the two captures were made with different settings, stop. Nothing below means anything. Re-record with the same command, changing only `--url` and `--out`.
2. **offset** — how far the clone is shifted against the reference. A big offset is a trigger or delay problem, not a rendering problem.
3. **timing error** — start, end, duration, peak. This is the motion metric that is independent of colours, fonts and copy.
4. **mean mismatch** — the pixel metric. For `motion` fidelity, treat it as a trend; for `pixel`, as the verdict.
5. **worst frames** — go look at those frames on the compare sheet.

## The activity curve

```
frame   t(s)   reference                                 clone
   10   0.40   ███████████████████████                   ██████████████████████████████
   11   0.44   ██████████████                            ████████████████████
```

Each bar is how much changed since the previous frame. The *shape* is the easing and the stagger:

- bars front-loaded in the clone but even in the reference → the clone's easing is too strong (expo where the reference is quint)
- bars flat and even in the clone but spiky in the reference → linear where the reference is ease-out
- bars in the clone where the reference has none → something animates that should be still
- bars shifted right in the clone → a delay is too long
- fewer, taller bars → the clone drops frames (check the capture settings, not the code)

## Sheets

```bash
refilm sheet compare --ref ref/frames --clone clone-1/frames \
  --diff compare-1/diff --out compare-1/sheets --every 2
```

One row per frame: reference, clone, diff. Read every sheet, not just the first — the interesting part of a motion is usually the middle, and the last frames tell you whether the end state holds.

## What to do with a failure

| What you see | First thing to check |
|---|---|
| offset large | trigger timing, `--wait-before`, a missing initial delay |
| duration short, front-loaded | easing too aggressive, or duration taken from the visible window instead of the declared one |
| start late, end on time | delay too long and duration too short — fix both together |
| mismatch high at rest | layout, fonts, crop — not motion |
| overshoot in reference only | spring vs bezier |
| stagger gaps wrong | per-item delay math |
| last frames differ | fill mode / end state |
| everything differs | element boxes are the wrong size |

The full failure table with fixes is in the skill's `references/verify.md`.
