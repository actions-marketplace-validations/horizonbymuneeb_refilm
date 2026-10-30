# Implementing the motion in the project's stack

Match what the project already uses. Adding GSAP to a project that animates with CSS, or Framer Motion to a Vue app, is a change the user did not ask for.

Preference order when nothing exists yet: CSS (keyframes/transitions, scroll-driven animations where supported) → Web Animations API → the framework's motion library (Framer Motion / `motion` for React, `@vueuse/motion` or GSAP for Vue, Svelte transitions) → GSAP for long timelines with many dependencies.

## Easing equivalents

| Reference | CSS | Framer Motion / motion | GSAP |
|---|---|---|---|
| easeOutExpo `cubic-bezier(0.16,1,0.3,1)` | same | `ease: [0.16, 1, 0.3, 1]` | `"expo.out"` |
| easeOutQuint `cubic-bezier(0.22,1,0.36,1)` | same | `[0.22, 1, 0.36, 1]` | `"quint.out"` |
| easeOutCubic `cubic-bezier(0.33,1,0.68,1)` | same | `[0.33, 1, 0.68, 1]` or `"easeOut"` | `"power2.out"` |
| easeInOutCubic `cubic-bezier(0.65,0,0.35,1)` | same | `[0.65, 0, 0.35, 1]` | `"power2.inOut"` |
| material standard `cubic-bezier(0.4,0,0.2,1)` | same | `[0.4, 0, 0.2, 1]` | `"power1.inOut"` ≈ |
| easeOutBack `cubic-bezier(0.34,1.56,0.64,1)` | same | `[0.34, 1.56, 0.64, 1]` | `"back.out(1.7)"` |
| spring, 10 % overshoot, ~600 ms settle | sampled `linear(...)` or WAAPI keyframes | `type: "spring", stiffness: 300, damping: 20` | `"elastic.out(1, 0.5)"` |
| linear | `linear` | `"linear"` | `"none"` |

Spring tuning from measurements: less damping → more overshoot; lower stiffness → slower. 10 % overshoot → ζ ≈ 0.59, 5 % → 0.69, 20 % → 0.46.

## Patterns

**Fade-up stagger (CSS)**

```css
.item {
  opacity: 0;
  transform: translateY(32px);
  animation: up 700ms cubic-bezier(.16, 1, .3, 1) forwards;
  animation-delay: calc(var(--i) * 90ms + 200ms);
}
@keyframes up { to { opacity: 1; transform: none; } }
```

Set `--i` per child, or use `:nth-child` rules. Keep `forwards` so the end state holds.

**Framer Motion stagger**

```tsx
const parent = { hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.2 } } };
const child = {
  hidden: { opacity: 0, y: 32 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] } },
};
```

**Enter-viewport trigger** — Framer `whileInView` + `viewport={{ once: true, amount: 0.25 }}`; plain JS `IntersectionObserver` with the threshold set to the fraction visible when the reference starts (read the `y` of the element at its first moving sample in `track.json`). CSS scroll-driven: `animation-timeline: view(); animation-range: entry 0% entry 40%`.

**Scroll-linked** — CSS `animation-timeline: scroll()` with `animation-range`, GSAP ScrollTrigger `scrub: true`, or Framer `useScroll` + `useTransform([0, 600], [0, -120])`. Take the two endpoints from the track.

**Text reveal by line or word** — split into spans with an `overflow: hidden` wrapper per line, animate `translateY(110%) → 0`. Keep the accessible text intact (`aria-label` on the container, `aria-hidden` on the spans).

**Hover lift** — `transition: transform 220ms cubic-bezier(.2,.8,.2,1), box-shadow 220ms` on the card; animate `transform`, never `top`. Check the hover-out frames too: the reverse often has different timing.

**Marquee** — duplicate the content once, `animation: scroll Ns linear infinite` from `translateX(0)` to `translateX(-50%)`. `N` is the measured period. Pause on hover only if the reference does.

**Clip or mask reveal** — `clip-path: inset(0 100% 0 0)` → `inset(0 0 0 0)`, or `mask-image` with an animated gradient position.

**Canvas / WebGL / 3D** — rebuild from the trace, not from the pixels (see `webgl.md`): same engine and version, same renderer settings and context attributes, port the user-authored shaders with their constant uniforms, map the traced blend state to the material, drive each animated uniform with the timing and easing its channel showed. A per-frame lag `x += (target − x) · k` stays frame-rate independent as `x += (target − x) · (1 − (1 − k) ** (dt / 16.67))`.

## Details that decide the match

- **`transform-origin`** — scale-ins grow from the anchor (a menu from its button corner, a modal from centre). Check `inspect.json › nodes` when it is non-default.
- **Compositing** — `will-change: transform` or `translateZ(0)` on the elements the reference composites, so the comparison video is not measuring jank.
- **`overflow: hidden` wrappers** decide whether a sliding element is clipped or visible outside its box. Copy them.
- **Transform order** — `translate() scale()` ≠ `scale() translate()`. Prefer the individual `translate` / `scale` / `rotate` properties when the stack allows.
- **Fill mode and initial state** — render the pre-motion state in CSS (opacity 0 and so on) so frame 0 already matches, and avoid a flash of the final state before JS runs.
- **`prefers-reduced-motion`** — wrap non-essential motion in `@media (prefers-reduced-motion: no-preference)` or `useReducedMotion()`. If the reference ignores it, add it anyway unless the user says not to, and mention it in the report.
- **Fonts (pixel work)** — load the same family and weights listed in `inspect.json › fonts` before capturing the clone (`document.fonts.ready`), otherwise every frame mismatches for a reason that has nothing to do with motion.
- **Layout** — the clone's element boxes must be the same size as the reference's, or every frame's pixels differ even when the timing is perfect. Copy the sizes and gaps from `inspect.json › nodes` before chasing timing.

## Keeping the user's additions separate (mixed fidelity)

Put the additions in their own components or blocks, list them in `spec.md` under "Additions", and keep them out of the region you compare (or verify the cloned region with `--region`). If an addition changes the layout of the cloned part, that is a fidelity decision — say so in the report.
