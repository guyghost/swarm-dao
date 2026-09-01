// Swarm DAO CLI — `doctor`: environment and configuration diagnostic.
//
// One command a new operator can run before anything else: runtime, git,
// worker agents, sandbox, DAO storage, improvement config, evidence roots,
// pending gates — each green/yellow/red with the fix that turns it green.

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { collectAttention, FsAttentionStore, loadConfig } from "@guyghost/swarm-dao-core";
import { loadProjectImprovementConfig } from "@guyghost/swarm-dao-improvement";
import { c, GLYPH } from "./render.js";

const execAsync = promisify(exec);

type Level = "ok" | "warn" | "fail";

interface Check {
  name: string;
  level: Level;
  detail: string;
  hint?: string;
}

const ran = async (command: string): Promise<string | null> => {
  try {
    const { stdout } = await execAsync(command, { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
};

export async function cmdDoctor(cwd: string): Promise<number> {
  const checks: Check[] = [];

  // Runtime — the CLI itself (always true when this code runs).
  checks.push({
    name: "runtime",
    level: "ok",
    detail: `bun ${process.versions.bun ?? "?"}`,
  });

  // Git repository (worktrees, branches, evidence history).
  const gitDir = await fs.stat(path.join(cwd, ".git")).then(
    () => true,
    () => false,
  );
  checks.push(
    gitDir
      ? { name: "git repository", level: "ok" as Level, detail: "present" }
      : {
          name: "git repository",
          level: "warn" as Level,
          detail: "not found",
          hint: "git init — worktree isolation and evidence history need a repository",
        },
  );

  // herdr — the worker agent runtime for improvement loops.
  const herdrVersion = await ran("herdr --version");
  checks.push(
    herdrVersion
      ? { name: "herdr (worker agents)", level: "ok" as Level, detail: herdrVersion.split("\n")[0] ?? herdrVersion }
      : {
          name: "herdr (worker agents)",
          level: "warn" as Level,
          detail: "not on PATH",
          hint: "improve once needs herdr to run sensor/counter-sensor/drift-auditor workers",
        },
  );

  // Docker — optional, for container sandboxes.
  const dockerVersion = await ran("docker version --format {{.Server.Version}}");
  checks.push(
    dockerVersion
      ? { name: "docker (container sandbox)", level: "ok" as Level, detail: `server ${dockerVersion}` }
      : {
          name: "docker (container sandbox)",
          level: "warn" as Level,
          detail: "unavailable",
          hint: "optional — needed only for --exec container / --sandbox docker",
        },
  );

  // DAO storage + agents.
  try {
    loadConfig(cwd);
    const state = await fs.readFile(path.join(cwd, ".dao", "state.json"), "utf8");
    const agents = (JSON.parse(state) as { agents?: unknown[] }).agents?.length ?? 0;
    checks.push({
      name: "DAO storage",
      level: agents > 0 ? "ok" : "warn",
      detail: agents > 0 ? `${agents} agents configured` : "no agents",
      hint: agents > 0 ? undefined : "swarm-dao setup",
    });
  } catch {
    checks.push({
      name: "DAO storage",
      level: "warn",
      detail: "not initialized",
      hint: "swarm-dao init && swarm-dao setup — needed for proposals/votes, not for improve/graph",
    });
  }

  // Improvement loop config (anchor commands, worker defaults).
  const improvementConfig = await loadProjectImprovementConfig(cwd);
  const hasAnchorCommands =
    improvementConfig !== null && typeof (improvementConfig.raw as Record<string, unknown>).anchorCommands === "object";
  checks.push(
    improvementConfig === null
      ? {
          name: "improvement config",
          level: "warn",
          detail: ".dao/improvement.json not found (a series worktree may carry its own)",
          hint: "improve init needs anchor commands bound in the project config",
        }
      : hasAnchorCommands
        ? { name: "improvement config", level: "ok", detail: ".dao/improvement.json (anchorCommands present)" }
        : {
            name: "improvement config",
            level: "warn",
            detail: ".dao/improvement.json has no anchorCommands",
            hint: "bind the four command-backed anchors before improve once",
          },
  );

  // Evidence roots — where workflow state lives.
  const roots = [".dao/improvement-series", ".dao/graph-runs", ".dao/product-loops", "evidence"];
  const present = (
    await Promise.all(
      roots.map(async (r) => ({
        r,
        ok: await fs.stat(path.join(cwd, r)).then(
          () => true,
          () => false,
        ),
      })),
    )
  ).filter((x) => x.ok);
  checks.push(
    present.length > 0
      ? { name: "evidence roots", level: "ok", detail: present.map((x) => x.r).join(", ") }
      : { name: "evidence roots", level: "ok", detail: "none yet (fresh project — created on first use)" },
  );

  // Pending human gates — the thing doctor exists to surface.
  const items = await collectAttention(new FsAttentionStore(cwd));
  checks.push(
    items.length === 0
      ? { name: "human gates", level: "ok", detail: "none pending" }
      : {
          name: "human gates",
          level: "fail",
          detail: `${items.length} pending (${items.map((i) => `${i.source}/${i.runId}`).join(", ")})`,
          hint: "swarm-dao next",
        },
  );

  const glyphFor = (level: Level): string =>
    level === "ok" ? c.ok(GLYPH.ok) : level === "warn" ? c.warn(GLYPH.warn) : c.fail(GLYPH.fail);
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    process.stdout.write(`${glyphFor(check.level)} ${check.name.padEnd(width)}  ${c.dim(check.detail)}\n`);
    if (check.hint) process.stdout.write(`  ${" ".repeat(width)}  ${GLYPH.arrow} ${check.hint}\n`);
  }
  const failed = checks.filter((check) => check.level === "fail").length;
  const warned = checks.filter((check) => check.level === "warn").length;
  process.stdout.write(
    `\n${failed > 0 ? c.fail(`${failed} failing`) : c.ok("all critical checks green")}${warned > 0 ? c.dim(`, ${warned} warning(s)`) : ""}\n`,
  );
  return failed > 0 ? 1 : 0;
}
