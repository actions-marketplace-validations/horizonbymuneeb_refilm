// refilm report — one self-contained HTML file that proves what happened.
//
// The report is the artefact a user forwards to someone else, so it must open from a file://
// URL with no network at all: every image is inlined as a data URI, every style is inline,
// and there is no <script src>, no <link href>, no font fetch. `--check` exists so a test can
// assert exactly that instead of trusting the template.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { EXIT, abs, bool, ensureDir, isDir, listFrames, parseArgs, readJson, reporter, str, usageError, writeText } from "../lib.js";
import type { CompareReport, Spec, VerifyResult } from "../types.js";

export const help = `
refilm report — one self-contained HTML report for a clone run.

  refilm report --dir <runDir> [--out <file.html>] [--title <text>] [--json]

  --dir DIR      the run directory that holds spec.json, clone-*/ and compare-*/
  --out FILE     output path, default <runDir>/report.html
  --title TEXT   report heading, default the run directory name
  --max-images N cap on embedded sheet images, default 12 (keeps the file openable)
  --check        verify the written file makes no external requests; exit 1 if it does
  --json         machine-readable result

Reads whatever exists and says what is missing. A report that quietly omits a failed round is
worse than no report, so every round found in the directory is listed, newest last.
`;

interface Round {
  name: string;
  dir: string;
  compare?: CompareReport;
  verify?: VerifyResult;
  sheets: string[];
  hasSpec: boolean;
}

const IMAGE_EXT = new Set([".png", ".webp", ".jpg", ".jpeg"]);

function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
}

function dataUri(path: string): string {
  return `data:${mimeOf(path)};base64,${readFileSync(path).toString("base64")}`;
}

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pct = (value: number | undefined) =>
  value === undefined || Number.isNaN(value) ? "—" : `${(value * 100).toFixed(2)}%`;

/** Finds clone-*, compare-* and verify-* directories under a run directory. */
function collectRounds(runDir: string): Round[] {
  const entries = readdirSync(runDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const cloneDirs = entries.filter((n) => /^clone(-\d+)?$/.test(n));
  const rounds: Round[] = [];

  for (const name of cloneDirs) {
    const dir = join(runDir, name);
    const round: Round = { name, dir, sheets: [], hasSpec: false };

    for (const candidate of [`compare-${name.replace("clone-", "")}`, `${name}-compare`, "compare"]) {
      const p = join(runDir, candidate, "report.json");
      if (existsSync(p)) {
        try {
          round.compare = readJson<CompareReport>(p);
          break;
        } catch {
          /* a malformed report is reported as missing, not fatal */
        }
      }
    }
    for (const candidate of [`verify-${name.replace("clone-", "")}`, `${name}-verify`, "verify"]) {
      const p = join(runDir, candidate, "verify.json");
      if (existsSync(p)) {
        try {
          round.verify = readJson<VerifyResult>(p);
          break;
        } catch {
          /* same */
        }
      }
    }
    // sheets live under compare-*/sheets or clone-*/sheets
    for (const base of [`compare-${name.replace("clone-", "")}`, name, "compare"]) {
      const sheetDir = join(runDir, base, "sheets");
      if (isDir(sheetDir)) {
        round.sheets.push(...listFrames(sheetDir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())));
      }
    }
    rounds.push(round);
  }

  // A run with a single "clone" directory named differently still deserves a section.
  if (rounds.length === 0) {
    const compare = existsSync(join(runDir, "compare", "report.json"))
      ? readJson<CompareReport>(join(runDir, "compare", "report.json"))
      : undefined;
    const verify = existsSync(join(runDir, "verify", "verify.json"))
      ? readJson<VerifyResult>(join(runDir, "verify", "verify.json"))
      : undefined;
    if (compare || verify) rounds.push({ name: basename(runDir), dir: runDir, compare, verify, sheets: [], hasSpec: false });
  }
  return rounds;
}

function specTable(spec: Spec): string {
  const rows = spec.rows
    .map(
      (row) => `<tr>
      <td class="mono">${esc(row.id)}</td>
      <td class="mono">${esc(row.element)}</td>
      <td>${esc(row.property)}</td>
      <td class="mono">${esc(row.from)} → ${esc(row.to)}</td>
      <td class="num">${row.startMs ?? "—"}</td>
      <td class="num">${row.durationMs ?? "—"}</td>
      <td class="mono">${esc(row.easing ?? "—")}</td>
      <td class="num">${row.staggerMs ?? "—"}</td>
      <td>${esc(row.source)}</td>
      <td class="conf-${esc(row.confidence)}">${esc(row.confidence)}</td>
    </tr>`,
    )
    .join("\n");

  return `<div class="tablewrap"><table>
  <thead><tr>
    <th>id</th><th>element</th><th>property</th><th>from → to</th><th>start ms</th>
    <th>duration ms</th><th>easing</th><th>stagger</th><th>source</th><th>confidence</th>
  </tr></thead>
  <tbody>${rows || `<tr><td colspan="10" class="muted">no rows</td></tr>`}</tbody>
</table></div>`;
}

function compareSection(report: CompareReport): string {
  const timing = report.timingError ?? { start: 0, end: 0, duration: 0, peak: 0 };
  const fails = (report.failures ?? []).map((f) => `<li>${esc(f)}</li>`).join("");
  const worst = (report.worstFrames ?? [])
    .slice(0, 6)
    .map((f) => `<tr><td class="num">#${f.index}</td><td class="num">${f.t.toFixed(2)}s</td><td class="num">${pct(f.mismatch)}</td></tr>`)
    .join("");

  const activity = (report.activity ?? [])
    .map((a) => {
      const ref = Math.round(Math.min(1, a.ref) * 40);
      const clone = Math.round(Math.min(1, a.clone) * 40);
      return `<tr>
        <td class="num">${a.t.toFixed(2)}</td>
        <td class="mono"><span class="bar ref">${"█".repeat(ref)}</span></td>
        <td class="mono"><span class="bar clone">${"█".repeat(clone)}</span></td>
      </tr>`;
    })
    .join("");

  return `
  <div class="grid">
    <div class="stat"><span class="label">verdict</span><span class="value ${report.pass ? "ok" : "bad"}">${report.pass ? "PASS" : "FAIL"}</span></div>
    <div class="stat"><span class="label">mean mismatch</span><span class="value">${pct(report.meanMismatch)}</span><span class="sub">limit ${pct(report.threshold)}</span></div>
    <div class="stat"><span class="label">max mismatch</span><span class="value">${pct(report.maxMismatch)}</span></div>
    <div class="stat"><span class="label">offset</span><span class="value">${report.offset}</span><span class="sub">frames</span></div>
    <div class="stat"><span class="label">timing error</span><span class="value">${(Math.max(Math.abs(timing.start), Math.abs(timing.end), Math.abs(timing.duration)) * 1000).toFixed(0)}</span><span class="sub">ms, limit ${(report.motionThreshold * 1000).toFixed(0)} ms</span></div>
    <div class="stat"><span class="label">frames compared</span><span class="value">${report.compared}/${report.frames}</span></div>
  </div>
  ${fails ? `<div class="callout bad"><strong>failures</strong><ul>${fails}</ul></div>` : `<div class="callout ok">every criterion passed</div>`}
  ${worst ? `<h4>worst frames</h4><div class="tablewrap"><table class="tight"><thead><tr><th>frame</th><th>t</th><th>mismatch</th></tr></thead><tbody>${worst}</tbody></table></div>` : ""}
  ${activity ? `<h4>activity per frame</h4><p class="muted">bar length = how much changed since the previous frame; the shape is the easing and the stagger</p>
    <div class="tablewrap"><table class="tight activity"><thead><tr><th>t (s)</th><th>reference</th><th>clone</th></tr></thead><tbody>${activity}</tbody></table></div>` : ""}`;
}

function verifySection(result: VerifyResult): string {
  const rows = result.checks
    .map(
      (c) => `<tr class="row-${esc(c.status)}">
      <td><span class="pill ${esc(c.status)}">${esc(c.status)}</span></td>
      <td class="mono">${esc(c.id)}</td>
      <td>${esc(c.label)}</td>
      <td class="num">${esc(c.measured)}</td>
      <td class="num">${esc(c.limit)}</td>
      <td class="muted">${esc(c.detail ?? "")}</td>
    </tr>`,
    )
    .join("");
  return `
  <div class="grid">
    <div class="stat"><span class="label">verdict</span><span class="value ${result.pass ? "ok" : "bad"}">${result.pass ? "PASS" : "FAIL"}</span></div>
    <div class="stat"><span class="label">passed</span><span class="value ok">${result.counts.pass}</span></div>
    <div class="stat"><span class="label">failed</span><span class="value ${result.counts.fail ? "bad" : ""}">${result.counts.fail}</span></div>
    <div class="stat"><span class="label">skipped</span><span class="value">${result.counts.skip}</span></div>
  </div>
  <div class="tablewrap"><table><thead><tr><th>status</th><th>check</th><th>what</th><th>measured</th><th>limit</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const a = parseArgs(argv);
  const out = reporter("report", { json: ctx.json });
  const dirArg = str(a.dir);
  // Usage problems are thrown, not returned: cli.ts turns a RefilmError into the JSON envelope and
  // the exit code, so `--json` never produces empty output on an error path.
  if (!dirArg) {
    throw usageError(
      "report needs a run directory",
      'pass --dir <runDir> (the folder holding spec.json and clone-*/), or run "refilm report --help"',
    );
  }
  const runDir = abs(dirArg);
  if (!isDir(runDir)) {
    throw usageError(
      `not a directory: ${runDir}`,
      "point --dir at the run folder created by record/spec, for example .refilm/runs/hero",
    );
  }

  const maxImages = Number(str(a["max-images"]) ?? 12) || 12;
  const title = str(a.title) ?? basename(runDir);
  const outPath = a.out ? abs(String(a.out)) : join(runDir, "report.html");

  const specPath = join(runDir, "spec.json");
  const spec = existsSync(specPath) ? readJson<Spec>(specPath) : undefined;
  const rounds = collectRounds(runDir);
  const missing: string[] = [];
  if (!spec) missing.push("spec.json (run `refilm spec --capture <ref> --out " + runDir + "`)");
  if (rounds.length === 0) missing.push("no clone-*/compare-* round found");

  let imageBudget = maxImages;
  const roundSections = rounds.map((round, index) => {
    const images = round.sheets.slice(0, Math.max(0, imageBudget));
    imageBudget -= images.length;
    const figures = images
      .map(
        (img) => `<figure>
          <img src="${dataUri(img)}" alt="${esc(basename(img))}">
          <figcaption>${esc(relative(runDir, img))}</figcaption>
        </figure>`,
      )
      .join("\n");
    const omitted = round.sheets.length - images.length;
    return `<section class="round">
      <h2>round ${index + 1} — ${esc(round.name)}</h2>
      ${round.verify ? `<h3>verify</h3>${verifySection(round.verify)}` : ""}
      ${round.compare ? `<h3>compare</h3>${compareSection(round.compare)}` : ""}
      ${figures ? `<h3>sheets</h3><div class="sheets">${figures}</div>` : ""}
      ${omitted > 0 ? `<p class="muted">${omitted} more sheet(s) not embedded (raise --max-images to include them)</p>` : ""}
      ${!round.verify && !round.compare && !figures ? `<p class="muted">this round has no report or sheets yet</p>` : ""}
    </section>`;
  });

  const residual = rounds
    .flatMap((r) => (r.verify?.checks ?? []).filter((c) => c.status === "fail").map((c) => ({ round: r.name, check: c })))
    .map(({ round, check }) => `<li><span class="mono">${esc(round)} · ${esc(check.id)}</span> — measured <strong>${esc(check.measured)}</strong> against limit ${esc(check.limit)}${check.detail ? ` (${esc(check.detail)})` : ""}</li>`)
    .join("");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>refilm report — ${esc(title)}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #17171b; --muted: #6b6b76; --line: #e4e4ea;
    --ok: #147d4b; --bad: #b3261e; --warn: #8a5a00; --chip: #f5f5f8;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #131316; --fg: #ececf1; --muted: #9a9aa6; --line: #2c2c33; --ok: #4ec98a; --bad: #ff7a70; --warn: #e0b25a; --chip: #1c1c21; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 64px; background: var(--bg); color: var(--fg);
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 22px 0 8px; }
  h4 { font-size: 13px; margin: 18px 0 6px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 10px; margin: 10px 0 16px; }
  .stat { background: var(--chip); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .stat .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .sub { font-size: 11px; color: var(--muted); }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 8px 0 18px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 18px; font-size: 13px; }
  .tablewrap table { margin: 0; min-width: 100%; }
  th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase;
       letter-spacing: 0.05em; border-bottom: 1px solid var(--line); padding: 6px 8px; }
  td { border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.mono, .mono { font-family: var(--mono); font-size: 12px; }
  table.tight td, table.tight th { padding: 3px 8px; }
  .activity td { border: none; padding: 1px 8px; }
  .bar.ref { color: var(--muted); } .bar.clone { color: var(--ok); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .pill.pass { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .pill.fail { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .pill.skip { background: var(--chip); color: var(--muted); }
  .callout { border: 1px solid var(--line); border-left-width: 3px; border-radius: 6px; padding: 10px 12px; margin: 10px 0 16px; font-size: 13px; }
  .callout.ok { border-left-color: var(--ok); }
  .callout.bad { border-left-color: var(--bad); }
  .callout ul { margin: 6px 0 0; padding-left: 20px; }
  .conf-high { color: var(--ok); } .conf-medium { color: var(--warn); } .conf-low { color: var(--bad); }
  .sheets { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  figure { margin: 0; }
  figure img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; display: block; }
  figcaption { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 4px; }
  @media (max-width: 640px) {
    body { padding: 20px 14px 48px; }
    .sheets { grid-template-columns: 1fr; }
    .grid { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
    h1 { font-size: 19px; }
  }
  footer { margin-top: 48px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
</style>
</head>
<body><div class="wrap">
<h1>${esc(title)}</h1>
<div class="meta">
  run directory <span class="mono">${esc(runDir)}</span>
  ${spec ? ` · target <span class="mono">${esc(spec.target)}</span> · fidelity <strong>${esc(spec.fidelity)}</strong> · ${spec.viewport.width}×${spec.viewport.height} @ ${spec.fps}fps · trigger ${esc(spec.trigger)}` : ""}
  · generated ${esc(new Date().toISOString())}
</div>
${missing.length ? `<div class="callout bad"><strong>missing</strong><ul>${missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
${spec ? `<h2>motion spec</h2>
  <div class="meta">${spec.rows.length} rows · ${spec.rows.filter((r) => r.source === "declared").length} declared · ${spec.unresolved.length} unresolved · total ${spec.totalMs} ms</div>
  ${specTable(spec)}
  ${spec.unresolved.length ? `<div class="callout bad"><strong>unresolved — the spec does not cover these yet</strong><ul>${spec.unresolved.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>` : ""}
  ${spec.additions.length ? `<h4>additions (mixed fidelity)</h4><ul>${spec.additions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}` : ""}
${roundSections.join("\n")}
${residual ? `<h2>residual deviations</h2><ul>${residual}</ul>` : rounds.length ? `<h2>residual deviations</h2><p class="muted">none — every check in every round passed</p>` : ""}
<footer>Generated by refilm. Every image is embedded, so this file works offline.</footer>
</div></body></html>`;

  const checkOnly = bool(a.check);
  if (checkOnly && !existsSync(outPath)) {
    throw usageError(
      `nothing to check: ${outPath} does not exist`,
      "run `refilm report --dir <runDir>` first (without --check), or drop --check to generate and check in one pass",
    );
  }
  // --check is a gate on the report that EXISTS, so it never rewrites the file: a gate that
  // regenerates its own subject can never fail. Without --check we generate, then still scan
  // what landed on disk.
  if (!checkOnly) {
    ensureDir(join(outPath, ".."));
    writeText(outPath, html);
  }

  // A report that needs the network is not a report. Scan the file ON DISK, not the string we
  // were about to write: --check has to catch anything appended to the report after generation,
  // otherwise it is a gate that can never fail.
  const scanExternal = (markup: string) =>
    [...markup.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((url) => !url.startsWith("data:") && !url.startsWith("#"));
  const onDisk = readFileSync(outPath, "utf8");
  const external = scanExternal(onDisk);
  const size = statSync(outPath).size;

  if (external.length) {
    out.warn(`report references ${external.length} external resource(s): ${external.slice(0, 5).join(", ")}`);
  }
  out.say(
    checkOnly
      ? `checked ${outPath} (${(size / 1024).toFixed(1)} KB) — not rewritten`
      : `wrote ${outPath} (${(size / 1024).toFixed(1)} KB, ${rounds.length} round(s), ${spec ? spec.rows.length : 0} spec row(s))`,
  );
  out.say(external.length ? `external references: ${external.length} — this file is NOT offline-safe` : "external references: 0 — opens offline");

  out.emit("report", {
    mode: checkOnly ? "check" : "write",
    out: outPath,
    sizeBytes: size,
    title,
    runDir,
    rounds: rounds.length,
    specRows: spec?.rows.length ?? 0,
    unresolved: spec?.unresolved.length ?? 0,
    missing,
    externalReferences: external,
    offlineSafe: external.length === 0,
  });

  if (checkOnly && external.length > 0) return EXIT.VERIFY_FAILED;
  return EXIT.OK;
}
