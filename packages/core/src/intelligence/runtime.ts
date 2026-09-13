// ============================================================
// Swarm DAO Core — Agent Runtime Resolution
// ============================================================
// Implements models/agent-runtime.md (approved at manifest hash
// 183507f568904059cba2084c5514d90568fa746c409feb2f6aa78784327274fa).
// Pure, total, deterministic: configuration in, (runtime | typed failure) out.
// The LLM never selects a runtime (invariant I2) — inputs are config only.

import type { DAOAgent } from "../types/index.js";

/** §4.1 — herdr-safe harness identifier. */
const SAFE_HARNESS_ID = /^[a-z][a-z0-9_-]{0,31}$/;
/** §4.2 — single argv token, provider-style model identifier. */
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,127}$/;
/** D3 — model flag override syntax. */
const SAFE_MODEL_FLAG = /^--[a-z][a-z0-9-]*$/;

export function isValidHarnessId(id: string): boolean {
  return SAFE_HARNESS_ID.test(id);
}

export function isValidModelId(id: string): boolean {
  return SAFE_MODEL_ID.test(id);
}

export function isValidModelFlag(flag: string): boolean {
  return SAFE_MODEL_FLAG.test(flag);
}

/**
 * D3 frozen flag table: harness → the CLI flag that carries its model.
 * Unknown harness + explicit model + no config override ⇒ E4 (never silent).
 */
export const HARNESS_MODEL_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  pi: "--model",
  claude: "--model",
  codex: "--model",
  copilot: "--model",
  opencode: "--model",
});

/** Project-level runtime configuration (`.dao/config.json` → `runtime`). */
export interface RuntimeConfig {
  defaultHarness?: string;
  harnessModelFlag?: Record<string, string>;
}

export interface RuntimeResolutionContext {
  projectRuntime?: RuntimeConfig;
  hostDefaultHarness?: string;
}

export interface ResolvedHarness {
  harness: string;
  source: "agent" | "project" | "host";
}

export interface ResolvedAgentRuntime {
  harness: string;
  harnessSource: "agent" | "project" | "host";
  model: string;
  modelFlag?: string;
}

export type AgentRuntimeResolution =
  | { ok: true; runtime: ResolvedAgentRuntime }
  | {
      ok: false;
      code:
        | "E_INVALID_HARNESS"
        | "E_NO_HARNESS"
        | "E_INVALID_MODEL"
        | "E_MODEL_FLAG_UNKNOWN"
        | "E_INVALID_FLAG_OVERRIDE";
      message: string;
    };

export function buildRuntimeResolutionContext(options?: {
  projectRuntime?: RuntimeConfig;
  hostDefaultHarness?: string;
}): RuntimeResolutionContext {
  return {
    projectRuntime: options?.projectRuntime,
    hostDefaultHarness: options?.hostDefaultHarness,
  };
}

/** §6 — deterministic host default (pi is its own harness; herdr defers to its kind; tmux has none). */
export function hostDefaultHarnessFor(hostId: string, herdrKind?: string): string | undefined {
  if (hostId === "herdr") return herdrKind;
  if (hostId === "tmux") return undefined;
  return hostId;
}

/**
 * D1 harness precedence:
 *
 *     agent.harness
 *       → runtime.defaultHarness   (project config — overrides legacy herdr kind)
 *       → hostDefaultHarness
 *
 * Returns undefined when the chain is exhausted (⇒ E2 at full resolution).
 */
export function resolveAgentHarness(agent: DAOAgent, ctx: RuntimeResolutionContext): ResolvedHarness | undefined {
  if (agent.harness) return { harness: agent.harness, source: "agent" };
  const projectDefault = ctx.projectRuntime?.defaultHarness;
  if (projectDefault) return { harness: projectDefault, source: "project" };
  if (ctx.hostDefaultHarness) return { harness: ctx.hostDefaultHarness, source: "host" };
  return undefined;
}

export function describeHarnessResolution(resolved: ResolvedHarness): string {
  switch (resolved.source) {
    case "agent":
      return `${resolved.harness} (agent override)`;
    case "project":
      return `${resolved.harness} (project default)`;
    case "host":
      return `${resolved.harness} (host default)`;
  }
}

/**
 * Full runtime resolution (D1 + D2 + D3). `resolvedModel` comes from the
 * existing model chain (resolveAgentModel) — "default" means host default and
 * disables flag emission. Pure and total: never throws (I1), never mutates
 * anything (I3), same inputs → same outputs (I4).
 */
export function resolveAgentRuntime(
  agent: DAOAgent,
  resolvedModel: string,
  ctx: RuntimeResolutionContext,
): AgentRuntimeResolution {
  const harness = resolveAgentHarness(agent, ctx);
  if (agent.harness && !isValidHarnessId(agent.harness)) {
    return {
      ok: false,
      code: "E_INVALID_HARNESS",
      message: `Agent "${agent.id}": invalid harness "${agent.harness}" (must match ^[a-z][a-z0-9_-]{0,31}$; fix agent.harness or runtime.defaultHarness)`,
    };
  }
  if (!harness) {
    return {
      ok: false,
      code: "E_NO_HARNESS",
      message: `Agent "${agent.id}": no harness resolvable — set runtime.defaultHarness or agent.harness`,
    };
  }
  if (resolvedModel !== "default" && !isValidModelId(resolvedModel)) {
    return {
      ok: false,
      code: "E_INVALID_MODEL",
      message: `Agent "${agent.id}": invalid model "${resolvedModel}" (must be a single token matching ^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,127}$)`,
    };
  }

  let modelFlag: string | undefined;
  if (resolvedModel !== "default") {
    const override = ctx.projectRuntime?.harnessModelFlag?.[harness.harness];
    if (override !== undefined && !isValidModelFlag(override)) {
      return {
        ok: false,
        code: "E_INVALID_FLAG_OVERRIDE",
        message: `Agent "${agent.id}": runtime.harnessModelFlag.${harness.harness} = "${override}" violates flag syntax (use --flag-name)`,
      };
    }
    modelFlag = override ?? HARNESS_MODEL_FLAGS[harness.harness];
    if (!modelFlag) {
      return {
        ok: false,
        code: "E_MODEL_FLAG_UNKNOWN",
        message: `Agent "${agent.id}": model "${resolvedModel}" requested for harness "${harness.harness}" with unknown model flag — set runtime.harnessModelFlag.${harness.harness} or drop the per-agent model`,
      };
    }
  }

  return {
    ok: true,
    runtime: {
      harness: harness.harness,
      harnessSource: harness.source,
      model: resolvedModel,
      modelFlag,
    },
  };
}
