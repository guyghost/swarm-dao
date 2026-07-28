// ============================================================
// Swarm DAO Core — Model Resolution
// ============================================================

import type { DAOAgent, DelegationProfileEntry } from "../types/index.js";

export interface ModelResolutionContext {
  /** Model set on a parent agent (delegation inheritance). */
  parentAgentModel?: string;
  /** Model declared by the delegation profile for the child's archetype. */
  profileDefaultModel?: string;
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
 *
 *     agent.model
 *       → profile.defaultModel      (delegation profile, child archetype)
 *       → parentAgent.resolvedModel (delegation parent — default behaviour)
 *       → parentSessionModel
 *       → config.defaultModel
 *       → host default
 *
 * For a delegated child, `agent.model` carries the child's `DelegationSpec.model`
 * (where `"inherit"` / omitted ⇒ fall through to the parent). The chain is
 * strictly additive: every layer may only refine, never branch.
 */
export function resolveAgentModel(agent: DAOAgent, ctx: ModelResolutionContext): string {
  const childOverride = agent.model && agent.model !== "inherit" ? agent.model : undefined;
  return (
    pickModel(
      childOverride,
      ctx.profileDefaultModel,
      ctx.parentAgentModel,
      ctx.parentSessionModel,
      ctx.configDefaultModel,
      ctx.hostDefaultModel,
    ) ?? "default"
  );
}

export function describeModelResolution(agent: DAOAgent, resolved: string, ctx: ModelResolutionContext): string {
  const childOverride = agent.model && agent.model !== "inherit" ? agent.model : undefined;
  if (childOverride && resolved === childOverride) {
    return `${resolved} (agent override)`;
  }
  if (ctx.profileDefaultModel && resolved === ctx.profileDefaultModel) {
    return `${resolved} (delegation profile default)`;
  }
  if (ctx.parentAgentModel && resolved === ctx.parentAgentModel) {
    return `${resolved} (inherited from parent agent)`;
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
    parentAgentModel?: string;
    parentSessionModel?: string;
    hostDefaultModel?: string;
  },
): ModelResolutionContext {
  return {
    parentAgentModel: options?.parentAgentModel,
    parentSessionModel: options?.parentSessionModel,
    configDefaultModel,
    hostDefaultModel: options?.hostDefaultModel,
  };
}

/**
 * Build a resolution context for a delegated child. `profileDefaultModel` is
 * sourced from the DAO's delegation profile for the child's archetype; the
 * parent agent's resolved model is the default the child inherits.
 */
export function buildChildModelResolutionContext(
  configDefaultModel: string,
  options: {
    parentAgentModel: string;
    profile?: DelegationProfileEntry;
    parentSessionModel?: string;
    hostDefaultModel?: string;
  },
): ModelResolutionContext {
  return {
    parentAgentModel: options.parentAgentModel,
    profileDefaultModel: options.profile?.defaultModel,
    parentSessionModel: options.parentSessionModel,
    configDefaultModel,
    hostDefaultModel: options.hostDefaultModel,
  };
}
