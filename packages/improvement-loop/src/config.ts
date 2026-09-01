// ============================================================
// Swarm DAO Improvement Loop — per-project config (.dao/improvement.json)
// ============================================================
// The human-owned binding of a project's ground-truth gate commands onto the
// frozen improvement-machine anchors. The machine fixes WHICH anchors exist
// (REQUIRED_IMPROVEMENT_ANCHORS); the project owns WHICH commands prove them.
// Two anchors are recorded automatically by the machine (the sample seal and
// the deterministic arbitration) and can never carry project commands.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REQUIRED_IMPROVEMENT_ANCHORS } from "@guyghost/swarm-dao-core/models/improvement";
import type { SandboxMode, SandboxRequest } from "./sandbox.js";
import { SAFE_HERDR_KIND } from "./workers.js";

export const PROJECT_CONFIG_PATH = ".dao/improvement.json";

/** Anchors recorded automatically by the machine (SAMPLES_SEALED, ARBITRATION). */
export const AUTO_RECORDED_ANCHORS: ReadonlySet<string> = new Set(["counter-metric-paired", "arbitration-policy"]);

/** Anchors a project must bind commands for. */
export const COMMAND_BACKED_ANCHORS: readonly string[] = REQUIRED_IMPROVEMENT_ANCHORS.filter(
  (anchor) => !AUTO_RECORDED_ANCHORS.has(anchor),
);

export interface ProjectImprovementConfig {
  /** Absolute path the config was loaded from. */
  path: string;
  /** Parsed file. Only `anchorCommands` is validated here; unknown sections (e.g. `sandbox`) pass through. */
  raw: {
    anchorCommands: Record<string, string>;
    [key: string]: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate the anchorCommands section: exactly the command-backed required
 * anchors, each bound to a non-empty command string. Strict set equality — a
 * missing gate must not silently pass unanchored, an unknown anchor must not
 * silently do nothing, and the machine-recorded anchors must not be
 * overridden.
 */
export function validateProjectAnchorCommands(raw: unknown): Record<string, string> {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    throw new Error(`${PROJECT_CONFIG_PATH}: 'anchorCommands' must be an object mapping anchors to commands`);
  }
  const keys = Object.keys(raw);
  const expected = new Set(COMMAND_BACKED_ANCHORS);
  for (const key of keys) {
    if (AUTO_RECORDED_ANCHORS.has(key)) {
      issues.push(`'${key}' is recorded automatically by the machine and must not carry a project command`);
      continue;
    }
    if (!expected.has(key)) {
      issues.push(`'${key}' is not a required improvement anchor (expected: ${COMMAND_BACKED_ANCHORS.join(", ")})`);
      continue;
    }
    const command = raw[key];
    if (typeof command !== "string" || command.trim().length === 0) {
      issues.push(`'${key}' must be bound to a non-empty command string`);
    }
  }
  for (const anchor of COMMAND_BACKED_ANCHORS) {
    if (!keys.includes(anchor)) issues.push(`missing command for required anchor '${anchor}'`);
  }
  if (issues.length > 0) throw new Error(`${PROJECT_CONFIG_PATH}: ${issues.join("; ")}`);
  return raw as unknown as Record<string, string>;
}

/**
 * Load `.dao/improvement.json` from the project. Returns null when the file
 * does not exist (callers fall back to repo-local frozen configuration);
 * throws when it exists but is invalid — a malformed human-owned config is
 * never silently ignored.
 */
export async function loadProjectImprovementConfig(workDir: string): Promise<ProjectImprovementConfig | null> {
  const path = resolve(workDir, PROJECT_CONFIG_PATH);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${PROJECT_CONFIG_PATH} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${PROJECT_CONFIG_PATH} must contain a JSON object`);
  const anchorCommands = validateProjectAnchorCommands(parsed.anchorCommands);
  return { path, raw: { ...parsed, anchorCommands } };
}

const configSection = (config: ProjectImprovementConfig | null, key: string): Record<string, unknown> => {
  const value = config?.raw[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

const configString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** herdr worker options from the `worker` section of .dao/improvement.json
 * (host-triggered advances never accept per-call overrides). */
export function workerOptionsFromConfig(config: ProjectImprovementConfig | null): {
  kind?: string;
  agentArgs?: readonly string[];
} {
  const section = configSection(config, "worker");
  const kind = configString(section.kind);
  if (kind !== undefined && !SAFE_HERDR_KIND.test(kind)) {
    throw new Error(`worker.kind must be a valid herdr agent kind (e.g. pi, codex, claude), got '${kind}'`);
  }
  const agentArgs =
    Array.isArray(section.agentArgs) && section.agentArgs.every((a) => typeof a === "string")
      ? (section.agentArgs as string[])
      : undefined;
  return { ...(kind !== undefined ? { kind } : {}), ...(agentArgs !== undefined ? { agentArgs } : {}) };
}

/** Sandbox request from the `sandbox` section of .dao/improvement.json. */
export function sandboxRequestFromConfig(config: ProjectImprovementConfig | null): SandboxRequest {
  const section = configSection(config, "sandbox");
  const mode = configString(section.mode) as SandboxMode | undefined;
  if (mode !== undefined && !["none", "docker", "container", "auto"].includes(mode)) {
    throw new Error(`sandbox.mode must be one of none|docker|container|auto, got '${mode}'`);
  }
  return {
    ...(mode !== undefined ? { sandbox: mode } : {}),
    ...(configString(section.image) !== undefined ? { image: configString(section.image) } : {}),
    ...(typeof section.cpus === "number" ? { cpus: section.cpus } : {}),
    ...(typeof section.memoryMb === "number" ? { memoryMb: section.memoryMb } : {}),
    ...(typeof section.timeoutMs === "number" ? { timeoutMs: section.timeoutMs } : {}),
  };
}
