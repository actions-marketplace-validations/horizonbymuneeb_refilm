# refilm internal contract

Read this before touching code. `src/lib.ts` and `src/types.ts` are owned by the Lead and are stable;
build against them, do not edit them (ask the Lead if a field is genuinely missing).

## Repo layout

```
src/lib.ts            shared primitives (args, output, errors, files, ffmpeg)   [Lead]
src/types.ts          every on-disk and --json shape                           [Lead]
src/cli.ts            command dispatch + usage + exit codes                    [Lead]
src/engine/           capture engine (playwright, in-page scripts)             [engine]
src/inpage/           clock.js, gl-hooks.js — injected into the page           [engine]
src/commands/*.ts     one file per command                                     [split, see below]
test/                 node:test suites + fixtures                              [tester]
skill/                agent skill package (SKILL.md + references)              [Lead]
```

## Command module shape

Every command file exports:

```ts
export const help: string;               // printed on `refilm <cmd> --help`
export async function run(argv: string[], ctx: { json: boolean }): Promise<number>;
```

`run` must return an exit code from `EXIT` (never call `process.exit`). Throw `RefilmError`
(`usageError`, `envError`) for expected failures; `cli.ts` turns those into JSON errors + exit codes.
Use `reporter("<cmd>", { json: ctx.json })` for all output: `say()` for human lines, `emit()` for the
JSON payload, `warn()` for non-fatal problems. Nothing may write to stdout except through the reporter.

## Determinism rules (these are product requirements, not style)

- Reference and clone must be captured with the same viewport, fps, trigger, duration and clock.
  `compare` already warns when `capture.json` differs; do not weaken that.
- No network access at runtime except the page being captured. No telemetry. No auto-download of
  browsers or binaries: `doctor` reports what is missing and prints the exact fix command.
- Same input, same output: seeded `Math.random`, virtual clock for canvas, sorted directory walks.

## Ownership (one writer per file)

| Owner | Files |
|---|---|
| Lead | `src/lib.ts`, `src/types.ts`, `src/cli.ts`, `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `skill/**` |
| engine | `src/engine/**`, `src/inpage/**`, `src/commands/gl.ts` |
| analysis | `src/commands/compare.ts`, `src/commands/sheet.ts`, `src/commands/fit.ts`, `src/commands/frames.ts` |
| authoring | `src/commands/spec.ts`, `src/commands/verify.ts`, `src/commands/report.ts`, `src/commands/doctor.ts`, `src/commands/install.ts`, `src/commands/init.ts`, `src/spec/**` |
| tester | `test/**`, `.github/workflows/**` |

Never edit a file outside your scope. If you need a change there, message the Lead.

## Commands to run before you report

```bash
npm run build          # tsc, must be clean (no `any` escapes that break strict)
npm run typecheck
node dist/cli.js <cmd> --help
```

`npm test` is the tester's job; keep your own smoke run short and real.

## Brand

Product name: **refilm**. Binary: `refilm`. npm package: `refilm`. No other project or author name
appears anywhere in code, docs, fixtures, comments, help text or file names.
