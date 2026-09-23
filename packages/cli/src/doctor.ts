// Swarm DAO CLI — `doctor`: environment and configuration diagnostic.
//
// One command a new operator can run before anything else: runtime, git,
// worker agents, sandbox, DAO storage, improvement config, evidence roots,
// pending gates — each green/yellow/red with the fix that turns it green.

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  CURRENT_CONFIG_VERSION,
  collectAttention,
  effectiveConfigVersion,
  FsAttentionStore,
  loadConfig,
  type ProjectConfig,
  resolveDaoLayout,
} from "@guyghost/swarm-dao-core";
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
    // Version probes must stay far below the 5s test timeout: a CLI that is
    // installed but wedged (e.g. docker with a dead daemon) otherwise makes
    // every doctor call — and every test that runs doctor — hang. The E2E
    // suite spawns doctor twice in one 5s test, so the probe budget is
    // 2 × timeout + process startup ≪ 5000ms; a probe that needs longer is
    // reporting "unavailable", which doctor treats as an optional-tool warn.
    const { stdout } = await execAsync(command, { timeout: 800 });
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

  // External tool probes run in parallel: each can wait for its own timeout
  // when the binary hangs, so sequential awaits would stack the worst cases.
  const [herdrVersion, dockerVersion, tmuxVersion] = await Promise.all([
    ran("herdr --version"),
    ran("docker version --format {{.Server.Version}}"),
    ran("tmux -V"),
  ]);

  // Git repository (worktrees, branches, evidence history, ADR-007 home id).
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
          hint: "git init — home layout and worktree isolation need a repository",
        },
  );

  // herdr — the worker agent runtime for improvement loops / CLI deliberate.
  checks.push(
    herdrVersion
      ? { name: "herdr (worker agents)", level: "ok" as Level, detail: herdrVersion.split("\n")[0] ?? herdrVersion }
      : {
          name: "herdr (worker agents)",
          level: "warn" as Level,
          detail: "not on PATH",
          hint: "improve once / CLI deliberate need herdr to run worker agents",
        },
  );

  // Docker — optional, for container sandboxes.
  checks.push(
    dockerVersion
      ? { name: "docker (container sandbox)", level: "ok" as Level, detail: `server ${dockerVersion}` }
      : {
          name: "docker (container sandbox)",
          level: "warn" as Level,
          detail: "unavailable",
          hint: "optional — needed when sandbox mode is docker|container|auto",
        },
  );

  checks.push(
    tmuxVersion
      ? { name: "tmux (pane host)", level: "ok" as Level, detail: tmuxVersion }
      : {
          name: "tmux (pane host)",
          level: "warn" as Level,
          detail: "not on PATH",
          hint: "optional — only for the tmux host adapter",
        },
  );

  // Layout resolution (ADR-007) — before config/storage so hints point at the
  // real state root, not a guessed `.dao/` path.
  const layout = await resolveDaoLayout(cwd, { ensure: false });
  const homeEnv = process.env.SWARM_DAO_HOME;
  checks.push({
    name: "DAO layout",
    level: "ok",
    detail:
      layout.mode === "home"
        ? `home · ${layout.stateRoot}${homeEnv ? ` (SWARM_DAO_HOME=${homeEnv})` : ""}`
        : `legacy · ${layout.stateRoot}`,
    hint: layout.mode === "legacy" && gitDir ? "optional: swarm-dao migrate --to home (ADR-007)" : undefined,
  });

  // Project config — strict validation surfaces typos instead of fail-open.
  let projectConfig: ProjectConfig | null = null;
  try {
    const config = await loadConfig(layout.stateRoot);
    projectConfig = config;
    const enforceEmpty = config.mode === "enforce" && (!config.criticalPaths || config.criticalPaths.length === 0);
    checks.push(
      enforceEmpty
        ? {
            name: "project config",
            level: "warn" as Level,
            detail: 'mode "enforce" with no criticalPaths allows everything',
            hint: `set criticalPaths in ${path.join(layout.stateRoot, "config.json")} or use mode "suggest"`,
          }
        : {
            name: "project config",
            level: "ok" as Level,
            detail: `mode "${config.mode}" valid`,
          },
    );
  } catch (error) {
    checks.push({
      name: "project config",
      level: "fail" as Level,
      detail: (error as Error).message,
      hint: `fix ${path.join(layout.stateRoot, "config.json")} (see models/CHOICE.md and README Configuration)`,
    });
  }

  // Config schema version — aligned with the running tool?
  if (projectConfig !== null) {
    const version = effectiveConfigVersion(projectConfig);
    checks.push(
      version === CURRENT_CONFIG_VERSION
        ? { name: "config version", level: "ok", detail: `v${version} (current)` }
        : version < CURRENT_CONFIG_VERSION
          ? {
              name: "config version",
              level: "warn",
              detail: `v${version} (tool: v${CURRENT_CONFIG_VERSION})`,
              hint: "swarm-dao config upgrade",
            }
          : {
              name: "config version",
              level: "fail",
              detail: `v${version} is newer than this tool (v${CURRENT_CONFIG_VERSION})`,
              hint: "upgrade swarm-dao",
            },
    );
  }

  // DAO storage + agents — resolved state root, not cwd/.dao only.
  try {
    const state = await fs.readFile(path.join(layout.stateRoot, "state.json"), "utf8");
    const agents = (JSON.parse(state) as { agents?: unknown[] }).agents?.length ?? 0;
    checks.push({
      name: "DAO storage",
      level: agents > 0 ? "ok" : "warn",
      detail: agents > 0 ? `${agents} agents · ${layout.stateRoot}` : `no agents · ${layout.stateRoot}`,
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

  // Improvement loop config (anchor commands, worker defaults, sandbox).
  const improvementConfig = await loadProjectImprovementConfig(cwd);
  const rawImprovement = improvementConfig !== null ? (improvementConfig.raw as Record<string, unknown>) : null;
  const hasAnchorCommands = rawImprovement !== null && typeof rawImprovement.anchorCommands === "object";
  const sandboxSection =
    rawImprovement !== null && typeof rawImprovement.sandbox === "object" && rawImprovement.sandbox !== null
      ? (rawImprovement.sandbox as Record<string, unknown>)
      : null;
  // Runtime default is auto when improvement.json exists but omits sandbox.mode.
  // With no improvement config at all, sandbox is N/A (do not fail fresh projects).
  const sandboxMode =
    typeof sandboxSection?.mode === "string" ? sandboxSection.mode : improvementConfig !== null ? "auto" : "none";

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

  if (improvementConfig !== null && sandboxMode !== "none" && !dockerVersion) {
    checks.push({
      name: "sandbox runtime",
      level: "fail",
      detail:
        sandboxSection?.mode === undefined
          ? 'improvement sandbox defaults to "auto" (sandbox.mode omitted) but docker is unavailable'
          : `improvement sandbox mode "${sandboxMode}" but docker is unavailable`,
      hint: "install docker, or set sandbox.mode to none in .dao/improvement.json",
    });
  } else {
    checks.push({
      name: "sandbox runtime",
      level: "ok",
      detail:
        improvementConfig === null
          ? "n/a (no improvement config)"
          : sandboxMode === "none"
            ? "mode none (host anchors)"
            : sandboxSection?.mode === undefined
              ? "mode auto (default when sandbox.mode omitted)"
              : `mode ${sandboxMode}`,
    });
  }

  // Evidence roots — where workflow state lives (still workspace-relative).
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
