// ============================================================
// Swarm DAO Core — Configuration System
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { composeSystemPrompt } from "./governance/charter.js";
import type { DAOAgent, DAOConfig, DelegationConfig } from "./types/index.js";
import { redactSensitiveFields } from "./utils/security.js";

export type ActivationMode = "opt-in" | "suggest" | "enforce";

export interface ExecutionConfig {
  /** "none" (default), "worktree", or "sandbox": isolation for proposal execution. */
  isolation?: "none" | "worktree" | "sandbox";
  /** Directory (relative to the repository root) holding execution worktrees. */
  worktreeRoot?: string;
  /** Base branch for execution branches; omit to let git use HEAD. */
  baseBranch?: string;
}

export interface DeliberationConfig {
  /** "parallel" (default): all agents at once. "sequential": pipeline —
   *  agents run in order, each receiving the prior analyses (never votes). */
  strategy?: "parallel" | "sequential";
  /** Sequential only: max analysis characters forwarded per prior agent. */
  charsPerAgent?: number;
}

export interface ShipConfig {
  /** Opt-in ship audit challenge: the first dao_ship call returns
   *  AUDIT_REQUIRED; only an unchanged second call executes. */
  auditChallenge?: boolean;
}

export interface HerdrConfig {
  /** herdr agent kind running each child session (pi, claude, codex, … —
   *  any kind herdr supports whose executable is installed). */
  kind?: string;
  /** Keep child workspaces alive after harvest (default false: closed). */
  keepPanes?: boolean;
  /** Per-child prompt timeout in ms (herdr ceiling: 300000). */
  timeoutMs?: number;
}

export interface TmuxConfig {
  /** Operator-owned agent command run in each pane session; $PROMPT carries
   *  the deliberation prompt (same trust level as package.json scripts). */
  command?: string;
  /** Keep child sessions alive after harvest (default false: killed). */
  keepSessions?: boolean;
  /** Per-child timeout in ms (default 300000). */
  timeoutMs?: number;
}

export interface ProjectConfig {
  mode: ActivationMode;
  agentOverrides?: Record<string, Partial<DAOAgent>>;
  criticalPaths?: string[];
  github?: { enabled: boolean; owner?: string; repo?: string };
  gitlab?: { enabled: boolean; projectId?: string };
  bitbucket?: { enabled: boolean; workspace?: string; repo?: string };
  execution?: ExecutionConfig;
  deliberation?: DeliberationConfig;
  ship?: ShipConfig;
  /** Delegated Facet Investigation budget (opt-in, disabled by default). */
  delegation?: DelegationConfig;
  /** herdr child-session defaults for multi-agent CLI flows
   *  (deliberate, roundtable, implement). */
  herdr?: HerdrConfig;
  /** tmux child-session defaults (used when the CLI detects a tmux session). */
  tmux?: TmuxConfig;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  mode: "opt-in",
  criticalPaths: ["src/auth/**", "src/payment/**", "src/migrations/**", ".env*", "**/secrets/**"],
};

const CONFIG_FILE = "config.json";

function splitPathSegments(value: string): string[] {
  return value.split("/").filter((segment) => segment.length > 0);
}

function matchSegment(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starMatchIndex = 0;
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === "*") {
      starIndex = patternIndex++;
      starMatchIndex = valueIndex;
      continue;
    }
    if (pattern[patternIndex] === value[valueIndex]) {
      patternIndex++;
      valueIndex++;
      continue;
    }
    if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      valueIndex = ++starMatchIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

function globMatchesPath(pattern: string, filePath: string): boolean {
  const patternSegments = splitPathSegments(pattern);
  const pathSegments = splitPathSegments(filePath);
  const matchesFrom = (patternIndex: number, pathIndex: number): boolean => {
    while (patternIndex < patternSegments.length) {
      const segment = patternSegments[patternIndex];
      if (segment === undefined) return false;
      if (segment === "**") {
        if (patternIndex === patternSegments.length - 1) return true;
        for (let skip = pathIndex; skip <= pathSegments.length; skip++) {
          if (matchesFrom(patternIndex + 1, skip)) return true;
        }
        return false;
      }
      if (pathIndex >= pathSegments.length) return false;
      const pathSegment = pathSegments[pathIndex];
      if (pathSegment === undefined) return false;
      if (!matchSegment(segment, pathSegment)) return false;
      patternIndex++;
      pathIndex++;
    }
    return pathIndex === pathSegments.length;
  };
  return matchesFrom(0, 0);
}

export function getConfigPath(daoRoot: string): string {
  return path.join(daoRoot, CONFIG_FILE);
}

export async function loadConfig(daoRoot: string): Promise<ProjectConfig> {
  const configPath = getConfigPath(daoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_PROJECT_CONFIG };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${configPath}: expected a JSON object`);
  }
  return validateProjectConfig(parsed as Record<string, unknown>, configPath);
}

function validateProjectConfig(input: Record<string, unknown>, configPath: string): ProjectConfig {
  const fail = (msg: string): never => {
    throw new Error(`Invalid config in ${configPath}: ${msg}`);
  };
  const out: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG };

  if (input.mode !== undefined) {
    if (input.mode !== "opt-in" && input.mode !== "suggest" && input.mode !== "enforce") {
      fail(`"mode" must be one of opt-in|suggest|enforce (got ${JSON.stringify(input.mode)})`);
    }
    out.mode = input.mode as ActivationMode;
  }

  if (input.criticalPaths !== undefined) {
    if (!Array.isArray(input.criticalPaths) || !input.criticalPaths.every((p) => typeof p === "string")) {
      fail(`"criticalPaths" must be a string array`);
    }
    out.criticalPaths = input.criticalPaths as string[];
  }

  if (input.agentOverrides !== undefined) {
    if (
      typeof input.agentOverrides !== "object" ||
      input.agentOverrides === null ||
      Array.isArray(input.agentOverrides)
    ) {
      fail(`"agentOverrides" must be an object`);
    }
    out.agentOverrides = input.agentOverrides as ProjectConfig["agentOverrides"];
  }

  if (input.execution !== undefined) {
    if (typeof input.execution !== "object" || input.execution === null || Array.isArray(input.execution)) {
      fail(`"execution" must be an object`);
    }
    const e = input.execution as Record<string, unknown>;
    if (
      e.isolation !== undefined &&
      e.isolation !== "none" &&
      e.isolation !== "worktree" &&
      e.isolation !== "sandbox"
    ) {
      fail(`"execution.isolation" must be one of none|worktree|sandbox`);
    }
    if (e.worktreeRoot !== undefined && typeof e.worktreeRoot !== "string")
      fail(`"execution.worktreeRoot" must be a string`);
    if (e.baseBranch !== undefined && typeof e.baseBranch !== "string") fail(`"execution.baseBranch" must be a string`);
    out.execution = {
      ...(typeof e.isolation === "string" ? { isolation: e.isolation as ExecutionConfig["isolation"] } : {}),
      ...(typeof e.worktreeRoot === "string" ? { worktreeRoot: e.worktreeRoot } : {}),
      ...(typeof e.baseBranch === "string" ? { baseBranch: e.baseBranch } : {}),
    };
  }

  if (input.deliberation !== undefined) {
    if (typeof input.deliberation !== "object" || input.deliberation === null || Array.isArray(input.deliberation)) {
      fail(`"deliberation" must be an object`);
    }
    const d = input.deliberation as Record<string, unknown>;
    if (d.strategy !== undefined && d.strategy !== "parallel" && d.strategy !== "sequential") {
      fail(`"deliberation.strategy" must be one of parallel|sequential`);
    }
    if (d.charsPerAgent !== undefined) {
      if (
        typeof d.charsPerAgent !== "number" ||
        !Number.isInteger(d.charsPerAgent) ||
        d.charsPerAgent < 100 ||
        d.charsPerAgent > 20000
      ) {
        fail(`"deliberation.charsPerAgent" must be an integer in [100, 20000]`);
      }
    }
    out.deliberation = {
      ...(typeof d.strategy === "string" ? { strategy: d.strategy as DeliberationConfig["strategy"] } : {}),
      ...(typeof d.charsPerAgent === "number" ? { charsPerAgent: d.charsPerAgent } : {}),
    };
  }

  if (input.ship !== undefined) {
    if (typeof input.ship !== "object" || input.ship === null || Array.isArray(input.ship))
      fail(`"ship" must be an object`);
    const s = input.ship as Record<string, unknown>;
    if (s.auditChallenge !== undefined && typeof s.auditChallenge !== "boolean")
      fail(`"ship.auditChallenge" must be a boolean`);
    out.ship = typeof s.auditChallenge === "boolean" ? { auditChallenge: s.auditChallenge } : {};
  }

  if (input.delegation !== undefined) {
    if (typeof input.delegation !== "object" || input.delegation === null || Array.isArray(input.delegation)) {
      fail(`"delegation" must be an object`);
    }
    const dg = input.delegation as Record<string, unknown>;
    if (dg.enabled !== undefined && typeof dg.enabled !== "boolean") fail(`"delegation.enabled" must be a boolean`);
    for (const k of ["maxDepth", "maxChildrenPerParent", "foldTimeoutMs"] as const) {
      const v = dg[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail(`"delegation.${k}" must be a positive integer`);
    }
    const md = dg.maxDepth as number | undefined;
    if (md !== undefined && md !== 1) fail(`"delegation.maxDepth" must be 1 (only one level is supported)`);
    const mc = dg.maxChildrenPerParent as number | undefined;
    if (mc !== undefined && (mc < 1 || mc > 10)) fail(`"delegation.maxChildrenPerParent" must be in [1, 10]`);
    const ft = dg.foldTimeoutMs as number | undefined;
    if (ft !== undefined && (ft < 1000 || ft > 300000)) fail(`"delegation.foldTimeoutMs" must be in [1000, 300000]`);
    out.delegation = {
      enabled: typeof dg.enabled === "boolean" ? dg.enabled : false,
      maxDepth: 1,
      maxChildrenPerParent: typeof mc === "number" ? mc : 3,
      foldTimeoutMs: typeof ft === "number" ? ft : 30000,
    };
  }

  for (const key of ["github", "gitlab", "bitbucket", "herdr", "tmux"] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`"${key}" must be an object`);
    const rec = v as Record<string, unknown>;
    if ((key === "herdr" || key === "tmux") && rec.timeoutMs !== undefined) {
      const t = rec.timeoutMs;
      if (typeof t !== "number" || !Number.isInteger(t) || t <= 0 || t > 300000) {
        fail(`"${key}.timeoutMs" must be an integer in (0, 300000]`);
      }
    }
    (out as unknown as Record<string, unknown>)[key] = { ...rec };
  }

  // Unknown top-level keys are ignored to stay forward-compatible
  // with newer config writers.
  return out;
}

export async function saveConfig(daoRoot: string, config: ProjectConfig): Promise<void> {
  const configPath = getConfigPath(daoRoot);
  const redacted = redactSensitiveFields(config);
  await fs.mkdir(daoRoot, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(redacted, null, 2), "utf-8");
}

export function mergeConfig(base: DAOConfig, overrides: Partial<DAOConfig>): DAOConfig {
  return {
    ...base,
    ...overrides,
    typeQuorum: { ...base.typeQuorum, ...overrides.typeQuorum },
  };
}

export function filterEnabledAgents(agents: DAOAgent[], config: ProjectConfig): DAOAgent[] {
  if (!config.agentOverrides) return agents;
  return agents
    .filter((agent) => {
      const override = config.agentOverrides?.[agent.id];
      return override?.enabled !== false;
    })
    .map((agent) => {
      const override = config.agentOverrides?.[agent.id];
      if (!override) return agent;
      // A configured systemPrompt becomes the agent's ROLE — the shared
      // charter (vote format the tally parses) is still prepended.
      const systemPrompt =
        override.systemPrompt && override.systemPrompt.trim().length > 0
          ? composeSystemPrompt(override.systemPrompt)
          : agent.systemPrompt;
      return { ...agent, ...override, systemPrompt };
    });
}

// ── Mode Logic ───────────────────────────────────────────────

export function shouldSuggestProposal(text: string): boolean {
  const triggers = [
    "feature",
    "add",
    "implement",
    "create",
    "refactor",
    "rewrite",
    "migrate",
    "security",
    "auth",
    "permission",
    "release",
    "deploy",
    "ship",
    "dark mode",
    "onboarding",
    "api",
  ];
  const lower = text.toLowerCase();
  return triggers.some((t) => lower.includes(t));
}

export function isCriticalPath(filePath: string, criticalPaths: string[]): boolean {
  for (const pattern of criticalPaths) {
    if (globMatchesPath(pattern, filePath)) return true;
  }
  return false;
}

export function canEditWithoutProposal(
  filePath: string,
  mode: ActivationMode,
  criticalPaths: string[],
  approvedPaths: string[],
): boolean {
  if (mode === "opt-in") return true;
  if (mode === "enforce") {
    if (!isCriticalPath(filePath, criticalPaths)) return true;
    return approvedPaths.some((approvedPath) => globMatchesPath(approvedPath, filePath));
  }
  // suggest mode: always allow but may prompt
  return true;
}
