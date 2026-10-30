# From evidence to spec

The spec turns "I watched it" into rows that can be checked. It is the contract between the reference and the clone: every row becomes a check in `refilm verify`.

`refilm spec` writes it. Your job is to **read it and resolve what it could not**.

## Where the numbers come from, in order of preference

1. **`inspect.json › animations`** — declared CSS animations and WAAPI animations: `timing.delay`, `timing.duration`, `timing.easing`, `iterations`, `direction`, `fill`, and per-keyframe `offset` + `easing`. These are exact. If the row says `source: "declared"`, copy it, do not re-measure it.
2. **`track.json` + `refilm fit`** — any technology, including JS-driven motion: per element and property, delay (first change), visible duration (first → last change), overshoot %, and the best-fitting named easing with a fitted duration. `source: "track"`.
3. **`gl-track.json` + `refilm fit --channel`** — canvas/WebGL: animated uniforms and scene-graph values. `gl summary` classifies each channel (`clock`, `transition`, `there-and-back`, `oscillation`, `steps`) with its change window.
4. **Frames only** — for video/gif references. For each element, find the first frame where it changes and the last frame where it changes: `start = first/fps`, `duration = (last − first + 1)/fps`. `source: "frames"`, `confidence: "low"`.

## Reading easing from a curve

| What you see | What it is |
|---|---|
| covers > half its distance in the first third | ease-out (expo/quint/cubic-out) |
| covers < a quarter in the first third | ease-in |
| symmetric | ease-in-out |
| even steps | linear |
| overshoots then returns | back easing or a spring — read `overshoot` % and the settle time |
| oscillates before settling | spring with low damping |

Overshoot → damping, then settle time → stiffness: `overshoot ≈ exp(−πζ / √(1 − ζ²))` so 10 % → ζ ≈ 0.59, 5 % → 0.69, 20 % → 0.46. `settle ≈ 4 / (ζω)` with `ω = √(stiffness/mass)`. Start with mass 1, pick ζ from overshoot, stiffness from settle time, then confirm with `refilm fit --compare-track`.

## Stagger

The gap between the start times of siblings. Constant gaps ("each +120 ms") are the common case; note the base delay separately. Per-character and per-word reveals are staggers too — measure the gap between the first two units and multiply.

## Patterns worth recognising

Most landing-page motion is one of these. Naming it saves rounds.

| Pattern | Tell-tale | Typical numbers |
|---|---|---|
| fade-up stagger | siblings rise 16–48 px while fading, each slightly later | 500–800 ms, ease-out, stagger 60–150 ms |
| scale-in | grows from 0.9–0.95 to 1 with opacity | 300–600 ms, ease-out |
| slide-in from an edge | translate 40–120 px along one axis | 400–800 ms, ease-out |
| hover lift | shadow + 2–8 px rise on hover, reverses on leave | 150–300 ms, ease-out |
| marquee | continuous translate, content duplicated | period = distance / speed, linear, infinite |
| text reveal | lines rise inside `overflow: hidden` wrappers | 600–900 ms, stagger 40–80 ms per line |
| scroll-linked parallax | value is a function of scroll position, not time | map scroll px → value from the track |
| spring pop | overshoot 5–20 %, settles in 300–700 ms | spring, not a bezier |

## The spec file

`refilm spec` writes `spec.json` (machine-readable, schema-versioned) and, with `--md`, a `spec.md` for humans:

```markdown
# <name> motion spec

Target: …   Viewport: WxH   Fps: N   Trigger: …
Destination: …   Fidelity: motion|pixel|mixed

## Timeline (t=0 is the trigger)
| # | element | property | from → to | start ms | duration ms | easing | stagger | source | confidence |

## Unresolved
- …

## Additions (mixed only)
- …
```

## Rules

- **A row with a guess is worse than a row marked unresolved.** `unresolved` is a to-do list; a wrong number silently passes verification and the clone ships wrong.
- **Every row needs a source.** If you cannot name where the number came from, it is not measured.
- **Static facts matter as much as the timeline**: element sizes and positions, z-order, `overflow` clipping, `transform-origin`, and for pixel work fonts, colours, spacing and assets. They go in `staticFacts`.
- **Total length** is the last visible change, not the animation's declared duration — a 3 s loop is measured over one period.
- Update the spec when verification teaches you something. It is the first thing to show the user when they ask "does it match?".
