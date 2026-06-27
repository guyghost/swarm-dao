// ============================================================
// Swarm DAO Core — Model Resolution
// ============================================================

import type { DAOAgent } from "../types/index.js";

export interface ModelResolutionContext {
  parentSessionModel?: string;
  configDefaultModel: string;
  hostDefaultModel?: string;
}

function pickModel(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the model for a DAO agent using the inheritance chain:
 * agent.model → parent session → config.defaultModel → host default
 */
export function resolveAgentModel(agent: DAOAgent, ctx: ModelResolutionContext): string {
  return pickModel(agent.model, ctx.parentSessionModel, ctx.configDefaultModel, ctx.hostDefaultModel) ?? "default";
}

export function describeModelResolution(agent: DAOAgent, resolved: string, ctx: ModelResolutionContext): string {
  if (agent.model) {
    return `${resolved} (agent override)`;
  }
  if (ctx.parentSessionModel && resolved === ctx.parentSessionModel) {
    return `${resolved} (inherited from parent session)`;
  }
  if (resolved === ctx.configDefaultModel) {
    return `${resolved} (DAO default)`;
  }
  if (ctx.hostDefaultModel && resolved === ctx.hostDefaultModel) {
    return `${resolved} (host default)`;
  }
  return resolved;
}

export function buildModelResolutionContext(
  configDefaultModel: string,
  options?: {
    parentSessionModel?: string;
    hostDefaultModel?: string;
  },
): ModelResolutionContext {
  return {
    parentSessionModel: options?.parentSessionModel,
    configDefaultModel,
    hostDefaultModel: options?.hostDefaultModel,
  };
}
