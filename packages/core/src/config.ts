// ============================================================
// Swarm DAO Core — Configuration System
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DAOAgent, DAOConfig } from "./types/index.js";
import { redactSensitiveFields } from "./utils/security.js";

export type ActivationMode = "opt-in" | "suggest" | "enforce";

export interface ProjectConfig {
  mode: ActivationMode;
  agentOverrides?: Record<string, Partial<DAOAgent>>;
  criticalPaths?: string[];
  github?: { enabled: boolean; owner?: string; repo?: string };
  gitlab?: { enabled: boolean; projectId?: string };
  bitbucket?: { enabled: boolean; workspace?: string; repo?: string };
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
  try {
    const data = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(data);
    return { ...DEFAULT_PROJECT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_PROJECT_CONFIG };
  }
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
      return override ? { ...agent, ...override } : agent;
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
