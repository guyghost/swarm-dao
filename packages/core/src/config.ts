// ============================================================
// Swarm DAO Core — Configuration System
// ============================================================

import { promises as fs } from "fs";
import path from "path";
import type { DAOConfig, DAOAgent } from "./types/index.js";
import { DEFAULT_CONFIG } from "./types/index.js";

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
  await fs.mkdir(daoRoot, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
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
  return agents.filter((agent) => {
    const override = config.agentOverrides?.[agent.id];
    return override?.enabled !== false;
  }).map((agent) => {
    const override = config.agentOverrides?.[agent.id];
    return override ? { ...agent, ...override } : agent;
  });
}

// ── Mode Logic ───────────────────────────────────────────────

export function shouldSuggestProposal(text: string): boolean {
  const triggers = [
    "feature", "add", "implement", "create",
    "refactor", "rewrite", "migrate",
    "security", "auth", "permission",
    "release", "deploy", "ship",
    "dark mode", "onboarding", "api",
  ];
  const lower = text.toLowerCase();
  return triggers.some((t) => lower.includes(t));
}

export function isCriticalPath(filePath: string, criticalPaths: string[]): boolean {
  for (const pattern of criticalPaths) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*\*/g, "<<<DOUBLESTAR>>>").replace(/\*/g, "[^/]*").replace(/<<<DOUBLESTAR>>>/g, ".*") + "$"
    );
    if (regex.test(filePath)) return true;
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
    return approvedPaths.some((ap) => {
      const regex = new RegExp("^" + ap.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
      return regex.test(filePath);
    });
  }
  // suggest mode: always allow but may prompt
  return true;
}