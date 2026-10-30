# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Email **horizonbymuneeb@gmail.com** with:

- what the issue is, and where in the code it lives,
- how to reproduce it (a command, a page, a payload),
- the impact you believe it has,
- whether you want to be credited, and under what name.

You can expect an acknowledgement within a few days. If you do not get one, please follow up — a
missed email is more likely than a deliberate silence.

## What counts as a vulnerability here

refilm is a local CLI that drives a headless browser and reads files. The interesting attack surface
is small but real:

- **Arbitrary code execution through a capture.** `refilm record --url` loads a page you point it at,
  and `--pre-js` evaluates JavaScript by design. Running it against a hostile page is expected to be
  as dangerous as visiting that page in a browser. A bug where refilm executes something *beyond*
  what the page itself would run is a vulnerability.
- **Path traversal or overwrite.** A crafted `--out`, a crafted capture directory, or a malicious
  `spec.json` / `track.json` / `capture.json` causing refilm to write or read outside the paths it
  was given.
- **A crafted input crashing the process outside the error contract.** Every command promises a JSON
  envelope and a documented exit code. A malformed Lottie file, spec, or frame set that produces a
  stack trace instead of `{ ok: false, errors: [...] }` is a bug worth reporting.
- **Dependency vulnerabilities** in `playwright`, `pixelmatch` or `pngjs` that refilm's usage
  actually exposes.

## What does not count

- **Recording a page you do not own, or reusing its assets.** That is a licensing question, not a
  vulnerability. refilm clones motion you point it at; whether you may use someone else's fonts,
  images or code is your responsibility.
- **A hostile page doing hostile things inside its own browser context.** That is what browsers are
  for; report it to the browser.
- **Resource exhaustion from an enormous input** unless it is unbounded in a way a reasonable
  argument could avoid (a 4-hour video is going to take a while).

## Supported versions

The latest published minor version receives fixes. Security fixes are released as a patch on the
current version, with an entry in [CHANGELOG.md](CHANGELOG.md).

| Version | Supported |
|---|---|
| 0.1.x | yes |
| < 0.1.2 | no — 0.1.0 and 0.1.1 were broken when installed from npm; upgrade |

## What refilm does on its own network-wise

Nothing. There is no telemetry, no update check, no analytics, and no account. The only network
traffic is the page you asked it to record, fetched by the browser it drives. `refilm doctor` checks
for local binaries; it does not download them.
