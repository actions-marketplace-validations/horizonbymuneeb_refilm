// refilm install — put the bundled agent skill where an agent will find it.
//
// The skill is what teaches an agent to use this tool, so it has to be installed, not described.
// Three targets because three agents look in three places, and the wrong directory is silently
// useless: a skill in ~/.claude/skills/ does nothing for codex.

import { EXIT, PKG_DIR, exists, isDir, parseArgs, reporter, str, usageError } from "../lib.js";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export const help = `
refilm install — install the bundled agent skill into an agent's skill directory.

  refilm install --agent claude|codex|dsh|all [--dry-run] [--force]

  claude   ~/.claude/skills/refilm/          (Claude Code)
  codex    ~/.codex/skills/refilm/           (Codex CLI)
  dsh      $DSH_HOME/skills/refilm/          (falls back to ~/.dsh-home/skills/refilm/)
  all      every target whose parent directory exists

  --dry-run   print what would be copied and where, change nothing
  --force     overwrite an existing install (default: never overwrite)

Copies SKILL.md and references/ from the package's own skill/ directory. Nothing is downloaded
and nothing outside the three skill directories is touched. Exit 0 even when a target is skipped:
install reports, it does not gate.
`;

type Agent = "claude" | "codex" | "dsh";
const AGENTS: Agent[] = ["claude", "codex", "dsh"];

interface Target {
  agent: Agent;
  dir: string;
  /** Why this target is being skipped, when it is. */
  skip?: string;
}

/** Where the skill lives inside the package. */
function skillSource(): string {
  return join(PKG_DIR, "skill");
}

function dshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(homedir(), ".dsh-home");
}

function targetFor(agent: Agent): Target {
  const home = homedir();
  if (agent === "claude") return { agent, dir: join(home, ".claude", "skills", "refilm") };
  if (agent === "codex") return { agent, dir: join(home, ".codex", "skills", "refilm") };
  return { agent, dir: join(dshHome(), "skills", "refilm") };
}

/** `all` means every agent whose *parent* skills directory exists: that is the one the agent reads. */
function targetsFor(agent: string): Target[] {
  if (agent === "all") {
    return AGENTS.map((a) => {
      const target = targetFor(a);
      const parent = dirname(target.dir);
      if (!isDir(parent)) {
        return { ...target, skip: `${parent} does not exist, so ${a} is not installed on this machine` };
      }
      return target;
    });
  }
  return [targetFor(agent as Agent)];
}

interface CopyPlan {
  from: string;
  to: string;
  bytes: number;
}

function planCopy(srcDir: string, destDir: string): CopyPlan[] {
  const plan: CopyPlan[] = [];
  const skillFile = join(srcDir, "SKILL.md");
  if (exists(skillFile)) plan.push({ from: skillFile, to: join(destDir, "SKILL.md"), bytes: statSync(skillFile).size });

  const refsDir = join(srcDir, "references");
  if (isDir(refsDir)) {
    for (const name of readdirSync(refsDir).sort()) {
      const from = join(refsDir, name);
      if (!statSync(from).isFile()) continue;
      plan.push({ from, to: join(destDir, "references", name), bytes: statSync(from).size });
    }
  }
  return plan;
}

/** The published package may omit skill/; the fix is re-running install from the package. */
function missingSkillMessage(): string {
  return [
    `the bundled skill is missing at ${skillSource()}`,
    "this happens when the package was published without its skill/ directory",
    "fix: npx refilm install --agent <claude|codex|dsh|all>",
    "if it is still missing after that, reinstall the package: npm install -g refilm",
  ].join("\n");
}

export async function run(argv: string[], ctx: { json: boolean }): Promise<number> {
  const rep = reporter("install", { json: ctx.json });
  const args = parseArgs(argv);

  const agentArg = str(args.agent);
  if (!agentArg) {
    throw usageError(
      "install needs --agent claude|codex|dsh|all",
      "example: refilm install --agent all",
    );
  }
  if (agentArg !== "all" && !(AGENTS as string[]).includes(agentArg)) {
    throw usageError(`unknown agent "${agentArg}"`, `expected one of: ${AGENTS.join(", ")}, all`);
  }

  const dryRun = !!args["dry-run"];
  const force = !!args.force;
  const source = skillSource();

  // A missing source is not an error exit: the message IS the result, and the fix is a command.
  if (!isDir(source) || !exists(join(source, "SKILL.md"))) {
    const message = missingSkillMessage();
    for (const line of message.split("\n")) rep.say(line);
    rep.emit("install", {
      source,
      dryRun,
      force,
      results: [],
      missingSource: true,
      fix: "npx refilm install --agent <claude|codex|dsh|all>",
    });
    return EXIT.OK;
  }

  const targets = targetsFor(agentArg);
  const results: Array<{
    agent: Agent;
    dir: string;
    status: "installed" | "would-install" | "exists" | "skipped";
    files: string[];
    reason?: string;
  }> = [];

  rep.say(dryRun ? `install (dry run) — source ${source}` : `install — source ${source}`);
  rep.say("");

  for (const target of targets) {
    if (target.skip) {
      results.push({ agent: target.agent, dir: target.dir, status: "skipped", files: [], reason: target.skip });
      rep.say(`  skip  ${target.agent.padEnd(6)} ${target.dir}`);
      rep.say(`        ${target.skip}`);
      continue;
    }

    const already = exists(join(target.dir, "SKILL.md"));
    if (already && !force) {
      results.push({
        agent: target.agent,
        dir: target.dir,
        status: "exists",
        files: [],
        reason: "already installed; pass --force to overwrite",
      });
      rep.say(`  keep  ${target.agent.padEnd(6)} ${target.dir}`);
      rep.say(`        already installed — pass --force to overwrite`);
      continue;
    }

    const plan = planCopy(source, target.dir);
    if (!plan.length) {
      results.push({ agent: target.agent, dir: target.dir, status: "skipped", files: [], reason: "the skill source has no SKILL.md or references/" });
      rep.say(`  skip  ${target.agent.padEnd(6)} ${target.dir} (nothing to copy)`);
      continue;
    }

    if (dryRun) {
      results.push({ agent: target.agent, dir: target.dir, status: "would-install", files: plan.map((p) => p.to) });
      rep.say(`  plan  ${target.agent.padEnd(6)} ${target.dir}  (${plan.length} file(s), ${plan.reduce((n, p) => n + p.bytes, 0)} bytes)`);
      for (const p of plan) rep.say(`          ${relative(process.cwd(), p.from) || p.from} -> ${p.to}`);
      continue;
    }

    try {
      for (const item of plan) {
        mkdirSync(dirname(item.to), { recursive: true });
        copyFileSync(item.from, item.to);
      }
      results.push({ agent: target.agent, dir: target.dir, status: "installed", files: plan.map((p) => p.to) });
      rep.say(`  ok    ${target.agent.padEnd(6)} ${target.dir}  (${plan.length} file(s))`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({ agent: target.agent, dir: target.dir, status: "skipped", files: [], reason });
      rep.say(`  fail  ${target.agent.padEnd(6)} ${target.dir}`);
      rep.say(`        ${reason}`);
      rep.say(`        fix: check permissions on ${dirname(target.dir)}`);
    }
  }

  const installed = results.filter((r) => r.status === "installed").length;
  const planned = results.filter((r) => r.status === "would-install").length;
  const kept = results.filter((r) => r.status === "exists").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  rep.say("");
  rep.say(
    dryRun
      ? `would install into ${planned} target(s); ${kept} already installed, ${skipped} skipped. Nothing was changed.`
      : `installed into ${installed} target(s); ${kept} already installed, ${skipped} skipped.`,
  );
  if (installed || planned) {
    rep.say("the agent now knows the refilm workflow: it will call `refilm doctor` first, then record → spec → build → verify.");
  }

  rep.emit("install", {
    source,
    dryRun,
    force,
    results,
  });

  return EXIT.OK;
}
