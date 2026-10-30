<!--
Thanks for the pull request. Two things decide whether it gets merged quickly:

1. Does it come with a test that fails without the change? Every bug fix needs one; state in the
   description that you watched it fail first.
2. Does it respect the project's rules? The short version: never report an unmeasured check as
   passed, never relax a threshold to go green, keep the --json envelope and exit codes intact,
   and keep --clock virtual captures byte-identical.

CONTRIBUTING.md has the full list and the reasoning.
-->

## What this changes

<!-- One or two sentences. -->

## Why

<!--
Link the issue. If there is no issue and the change is larger than a typo, explain the problem the
change solves — a pull request without an agreed problem statement is hard to review.
-->

Closes #

## How it was verified

<!--
Paste the commands and their real output. Measured numbers, exit codes, and the test you added.
"The tests pass" is a claim; `npm test → 142 pass, 0 fail` plus the name of the new test is evidence.
-->

```bash
npm run build
npm test
```

## Checklist

- [ ] `npm run build` is clean (no TypeScript errors)
- [ ] `npm test` passes locally
- [ ] a test was added that **fails without this change** (or: this is a docs-only change)
- [ ] no threshold, tolerance or pass criterion was relaxed
- [ ] `--json` still prints exactly one envelope on every path this touches, including errors
- [ ] exit codes still match the documented contract (`0` ok, `1` verification failed, `2` usage, `3` environment, `4` internal)
- [ ] if `src/inpage/clock.js` or the capture path changed: the determinism test was run and passes
- [ ] `npm run verify:dist` passes (the package is installable as published)
- [ ] the change is one logical unit — no unrelated refactoring or formatting in the diff

## Screenshots or captures

<!--
For anything visual — sheets, reports, a compare result — attach the image. A reviewer should be
able to see what changed without running it.
-->

## Anything reviewers should know

<!--
Tradeoffs, things you tried that did not work, parts you are unsure about. Being explicit about the
weak part of a change gets it reviewed faster than presenting it as finished.
-->
