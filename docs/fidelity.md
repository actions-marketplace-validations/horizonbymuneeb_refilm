# Fidelity levels

refilm checks different things depending on what you asked for. Pick the level before you start and say it out loud — it decides what `refilm verify` treats as a failure.

## `motion` (default)

Use it when you want the *feel*: "clone this animation", "make ours move like theirs", "same hero as X but with our copy".

**Must match**

- trigger and order of events
- stagger between siblings
- timing of every step, within **80 ms** (two frames at 25 fps)
- easing family (out / in / in-out / linear / spring), with the reference's fitted curve matching the clone within 5 % of the travel distance
- direction and distance of movement, relative to the element's size (within 10 %)

**May differ** — copy, colours, fonts, images, brand details.

## `pixel`

Use it when the user says "match it exactly", "pixel-perfect", "1:1", "details should match".

**Must match** — everything in `motion`, plus fonts, sizes, colours, spacing, radii, shadows and assets. Mean frame mismatch **≤ 2 %**, no single frame above 5 %, rest frames ≤ 0.5 %.

This level fails for reasons that have nothing to do with motion — a fallback font, a 2 px padding difference — so fix layout and fonts *before* chasing timing.

## `mixed`

Use it for "clone X and add Y" — their animation plus your content, pricing tiers, extra features.

**Must match** — the cloned part at one of the levels above. Your additions are described and shown in the report, and verified only for not disturbing the cloned motion.

Keep additions in their own components or blocks, and verify the cloned region with `--region x,y,w,h` when the additions sit next to it.

## How the level changes the gate

`refilm verify --fidelity motion|pixel|mixed` decides which checks run. A check that cannot be measured is reported as `skip` with the reason, never as `pass` — a green run that skipped its checks is worse than a red one.

## What no level promises

- **The reference's assets are yours to use.** Fonts, images, shaders and code from another site still belong to their owners. Cloning the motion is one thing; shipping someone else's font file is another.
- **Physics you approximated.** A spring fitted from overshoot and settle time is close, not identical.
- **Randomness you cannot reproduce.** Particle systems whose generator you cannot port are compared with a blurred mismatch and reported as such.
