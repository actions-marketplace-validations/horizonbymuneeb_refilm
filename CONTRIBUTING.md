# Contributing to refilm

Thanks for taking the time to contribute. This document is short on ceremony and long on the two
things that actually matter here: **measurement** and **honesty about what was measured**.

## Before you start

- Read [README.md](README.md) for what refilm is, and [CONTRACT.md](CONTRACT.md) for how it is put
  together.
- For anything larger than a typo, **open an issue first**. A pull request that changes behaviour
  without an agreed problem statement is hard to review and often gets rewritten.
- Bug reports are most useful with a **failing command and its output**. "It doesn't match" cannot
  be reproduced; `refilm verify …` exiting 1 with a named check can.

## Development setup

```bash
git clone https://github.com/horizonbymuneeb/refilm.git
cd refilm
npm ci --include=dev      # --include=dev matters: with NODE_ENV=production npm drops tsc
npm run build             # tsc + copy the in-page browser scripts into dist/
npm test                  # 142 tests: unit + integration, real browser, real captures
```

Requirements: **Node 20+**, **ffmpeg**, and Playwright's Chromium (`npx playwright install chromium`).
`refilm doctor` tells you what is missing.

Useful while iterating:

```bash
npm run build && node dist/cli.js <command> --help    # the help text is the flag reference
node --test test/integration/verify.test.js           # one suite
npm run typecheck
npm run verify:dist                                   # is the package installable as published?
```

## The rules this project actually enforces

These are not style preferences; they are the reason the tool is trustworthy. A pull request that
breaks one of them will be asked to change, even if the code is otherwise fine.

1. **Never report a measurement you did not take.** If a check cannot be measured, it is `skip` with
   a reason — never `pass`. A green run that silently skipped its checks is the one failure mode this
   project refuses to ship.
2. **A guess is worse than a gap.** When evidence is missing, the value goes into `unresolved` with
   an explanation. Do not fill a spec row with a plausible number and leave it looking measured.
3. **Never relax a threshold to make a test pass.** If a looser bar is genuinely correct, that is a
   design discussion in an issue, not a one-line change in a pull request.
4. **Determinism is a guarantee, not an aspiration.** `--clock virtual` captures must stay
   byte-identical. If you touch `src/inpage/clock.js` or the capture path, run the determinism test
   and say so in your pull request.
5. **Every command keeps its contract**: `--json` prints exactly one envelope on stdout (including on
   every error path), and exit codes mean what they say (`0` ok, `1` verification failed, `2` usage,
   `3` environment, `4` internal).
6. **Tests fail on real behaviour.** Assert exit codes, JSON fields and measured numbers. Do not
   assert on log wording that a contributor may legitimately improve.

## Pull requests

- One logical change per pull request. A fix plus an unrelated refactor is two pull requests.
- **Every bug fix needs a test that fails without the fix.** State in the description that you
  verified it fails first — that is the evidence the test is real.
- Run `npm run build && npm test` before pushing. CI runs Node 20 and 22 on Linux; a failure there
  is a failure.
- Describe what you measured, not what you intended. "verify now exits 1 on the wrong clone and
  names `h1-opacity.duration`" is reviewable; "improved verification" is not.
- Keep the diff focused: no drive-by formatting of untouched code, no dependency additions without a
  reason in the description.

## Commit messages

A short imperative subject line, then a body that explains **why** when the reason is not obvious.
Wrap the body at 72 columns. Reference the issue when there is one.

```
fix: ship dist/inpage in the package

clock.js and gl-hooks.js are plain browser scripts, so tsc never copied them into
dist/. A source checkout hid it because the engine also looks in src/inpage/, but
every 'refilm record' from an npm install failed with 'in-page script not found'.

Fixes #12
```

## Scope: what belongs in refilm

In scope: capturing motion from pages and videos, deriving a spec from evidence, measuring the
difference between two captures, and the gate and reporting around that loop.

Out of scope: generating the replacement animation for you (refilm measures, your code — or your
agent — writes it), hosting, accounts, telemetry, and anything that needs a server. refilm is a
local CLI with no network calls of its own.

## Reporting bugs

Open an issue with the template. The three things that make a report actionable:

1. the exact command,
2. the output (or the `--json` payload),
3. what you expected instead, and why.

If a capture is involved and you can share it, that is the single most helpful attachment. If you
cannot, the page HTML or a screenshot plus the command is usually enough.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be someone others can work
with.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
