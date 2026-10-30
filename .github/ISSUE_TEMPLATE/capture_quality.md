---
name: Capture quality report
about: refilm recorded something, but the capture itself is wrong or incomplete
title: ""
labels: capture
assignees: ""
---

<!--
This is a different kind of bug from "the clone doesn't match". Here the reference capture itself is
the problem: frames missing, animations not detected, a canvas not traced, wrong crop, wrong timing
base. Everything downstream inherits the fault, so these reports matter.
-->

## What is wrong with the capture

<!-- Tick every symptom you saw. -->

- [ ] frames are missing, duplicated, or out of order
- [ ] a declared CSS/WAAPI animation is not in `inspect.json`
- [ ] a JS-driven animation moves on screen but `track.json` does not show it
- [ ] a canvas / WebGL scene was not traced (`--gl` produced nothing)
- [ ] the crop is wrong (`--selector`, `--clip`)
- [ ] the trigger fired at the wrong moment (or not at all)
- [ ] fonts are missing from `inspect.json`
- [ ] timing looks wrong: the same page captured twice gives different numbers
- [ ] other (describe below)

## The command

```bash
```

## What the capture contains

<!--
The most useful numbers: how many frames you expected vs how many landed, and what capture.json
reports for fps / durationMs / frameCount / trigger / triggerFrame / clock.
-->

```
# jq '.fps, .frameCount, .durationMs, .trigger, .triggerFrame, .clock' <capture>/capture.json
```

## What the page actually does

<!--
Describe the motion in words, and say how it is implemented if you know: CSS keyframes, WAAPI,
GSAP, Framer Motion, a canvas rAF loop, a WebGL uniform, a scroll listener. That is usually enough
to identify which capture path should have caught it.
-->

## Does it reproduce?

<!-- Captures on the real clock are allowed to differ slightly; --clock virtual must be identical. -->

- [ ] every time
- [ ] intermittently (how often: )
- [ ] only on this machine

## Environment

```
refilm doctor --json
```

## Can you share the page?

<!--
A public URL, the HTML, or a minimal reproduction. If the page is behind a login, a screen recording
of the motion is still useful — `refilm frames` can work from that instead.
-->
