# Reading the numbers

A round is: record the clone the same way as the reference → `refilm compare` → `refilm sheet compare` → `refilm fit --compare-track` per tracked element → read everything → fix one cause → next round.

Keep every round's directory (`clone-1`, `compare-1`, `clone-2`, …). The progression is part of the report.

## What `compare` tells you

`report.md` / `report.json`:

- **offset** — the clone frame matched to reference frame 0, found by auto-alignment over the first frames. A large offset means the clone starts late or early: fix the trigger timing or `--wait-before`. Do not let alignment hide it.
- **mean mismatch / worst frames** — the fraction of pixels that differ per frame. `pixel` work reads this directly; `motion` work reads it as a trend: it should be low at rest and spike only where the two are in different states.
- **motion window** — first / last / peak frame with visible change, per side. The **timing error** is the difference in seconds for start, end, duration and peak. This is the main motion metric and it is independent of colours and copy.
- **activity curve** — change per frame. Same shape = same easing and stagger. A clone that is front-loaded against an even reference is using too strong an ease-out; a clone that is spiky against an even reference is using linear where the reference is ease-out.
- **`setupWarnings`** — the two captures were made with different settings. That is not a clone problem, it is a measurement problem: re-record before you change code.
- **`diff/NNNN.png`** — red where pixels differ. `refilm sheet compare --diff` puts reference, clone and diff side by side with the mismatch per row.

`refilm fit --compare-track other.json` prints `maxAbsDiff` / `meanAbsDiff` of one property over time between two tracks (in CSS px or opacity units) and the best-fit easing of the clone, to compare against the reference's.

## Pass criteria

**motion** (per spec row):

- start and end timing error ≤ 80 ms (two frames at 25 fps); duration error ≤ 80 ms
- easing: same best-fit family (out / in / in-out / linear / spring) and the reference's best fit applied to the clone's track has RMSE ≤ 0.05, or `meanAbsDiff` ≤ 5 % of the travel distance
- stagger order and gaps within 40 ms
- travel distance within 10 % of the reference, relative to element size, same direction
- nothing moves in the clone that is still in the reference, and vice versa
- the compare sheets show the same visual state at the same timestamp (allowing different copy and colours)

**pixel** adds:

- mean mismatch ≤ 2 %, no frame above 5 %; rest frames ≤ 0.5 %
- fonts loaded and identical (compare `inspect.json › fonts` on both captures)
- colours and sizes equal in `nodes`
- the same assets at the same size

**mixed**: the cloned region passes one of the above with `--region` limited to it; the additions are shown on a sheet and described in the report.

**canvas / WebGL / 3D** (captured with `--clock virtual --gl`):

- `refilm gl compare --ref ref --clone clone-N`: every animated channel in the reference has a clone channel of the same kind, start and end within 80 ms, mean error ≤ 5 % of the reference's range (`--map` when the names differ)
- canvas attributes, renderer settings and draw structure (primitive, vertex count, blend state, cadence) the same, or the difference explained
- pixels as above. If the clone ports the reference's generator, the seeded random gives the same particles and the sharp mismatch applies. If not, judge with `compare --blur 4` and report the sharp number next to it.

## Failure → usual fix

| Symptom | Usual cause | Fix |
|---|---|---|
| everything shifted by the same offset, shape identical | trigger latency or a missing initial delay | adjust the delay; check `--wait-before` |
| clone shorter and front-loaded | easing too aggressive (expo where the reference is quint), or duration taken from the visible window instead of the declared one | use the fitted `durationMs`, set the declared duration |
| clone ends on time but starts late | delay too long, duration too short | fix both together |
| bars even in the clone, spiky in the reference | linear or ease-in-out where the reference is ease-out | change the easing family |
| mismatch high on rest frames | layout or style differences, font fallback, crop differs | fix the capture crop; for pixel work load the font and fix sizes |
| reference overshoots, clone does not | spring vs bezier | use a spring (Framer `type: "spring"`, GSAP `back.out`/`elastic`, CSS `linear()` with a sampled curve) |
| stagger gaps differ | per-item delay math | `delay = base + index × step`; check where the index comes from |
| activity in the clone where the reference is still | an element animates that should not, or a hover state is triggered by the pointer position | move the pointer out, remove the stray transition |
| only the last frames differ | fill mode or end state (`forwards` missing), or the final value rounds differently | set `animation-fill-mode: forwards` / `fill: "forwards"` |
| scroll trigger: clone starts earlier or later | IntersectionObserver threshold / rootMargin differ | match the threshold to the reference's entry point (`y` where motion begins in `track.json`) |
| everything differs, timing is fine | element boxes are the wrong size | copy sizes, gaps and padding from `inspect.json › nodes` |

## When to stop

- Stop when every spec row passes its criteria and the latest sheets look the same state by state. Say so with the numbers.
- Stop after 5 rounds without progress on a row, or when the remaining difference is outside your control (a font licence, a shader or model the user may not copy, a third-party embed, physics you approximated). Report the row, its last numbers and the reason.
- Never relax a threshold silently. If a looser bar is genuinely appropriate, say which one and why, and let the user decide.
