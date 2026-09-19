// ============================================================
// Swarm DAO Core — Model Resolution
// ============================================================

import type { DAOAgent, DelegationProfileEntry } from "../types/index.js";

export interface ModelResolutionContext {
  /** Model set on a parent agent (delegation inheritance). */
  parentAgentModel?: string;
  /** Model declared by the delegation profile for the child's archetype. */
  profileModel?: string;
  parentSessionModel?: string;
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
 *       → profile.model             (delegation profile, child archetype — user spec)
 *       → parentAgent.resolvedModel (delegation parent)
 *       → parentSessionModel        (the main model)
 *       → host main model
 *       → "default" sentinel (host decides; no flag emitted, D3 row 3)
 *
 * There is no DAO-wide default model (ADR-006): a model is either pinned
 * explicitly in configuration (agent frontmatter `model:`, delegation-profile
 * `model:`) or inherited from the main model. The chain is strictly additive:
 * every layer may only refine, never branch.
 */
export function resolveAgentModel(agent: DAOAgent, ctx: ModelResolutionContext): string {
  const childOverride = agent.model && agent.model !== "inherit" ? agent.model : undefined;
  return (
    pickModel(childOverride, ctx.profileModel, ctx.parentAgentModel, ctx.parentSessionModel, ctx.hostDefaultModel) ??
    "default"
  );
}

export function describeModelResolution(agent: DAOAgent, resolved: string, ctx: ModelResolutionContext): string {
  const childOverride = agent.model && agent.model !== "inherit" ? agent.model : undefined;
  if (childOverride && resolved === childOverride) {
    return `${resolved} (agent override)`;
  }
  if (ctx.profileModel && resolved === ctx.profileModel) {
    return `${resolved} (delegation profile model)`;
  }
  if (ctx.parentAgentModel && resolved === ctx.parentAgentModel) {
    return `${resolved} (inherited from parent agent)`;
  }
  if (ctx.parentSessionModel && resolved === ctx.parentSessionModel) {
    return `${resolved} (inherited from parent session)`;
  }
  if (ctx.hostDefaultModel && resolved === ctx.hostDefaultModel) {
    return `${resolved} (host main model)`;
  }
  return resolved;
}

export function buildModelResolutionContext(options?: {
  parentAgentModel?: string;
  parentSessionModel?: string;
  hostDefaultModel?: string;
}): ModelResolutionContext {
  return {
    parentAgentModel: options?.parentAgentModel,
    parentSessionModel: options?.parentSessionModel,
    hostDefaultModel: options?.hostDefaultModel,
  };
}

/**
 * Build a resolution context for a delegated child. `profileModel` is sourced
 * from the DAO's delegation profile for the child's archetype (an explicit
 * user spec); without it the child inherits the parent agent's resolved model.
 */
export function buildChildModelResolutionContext(options: {
  parentAgentModel: string;
  profile?: DelegationProfileEntry;
  parentSessionModel?: string;
  hostDefaultModel?: string;
}): ModelResolutionContext {
  return {
    parentAgentModel: options.parentAgentModel,
    profileModel: options.profile?.model,
    parentSessionModel: options.parentSessionModel,
    hostDefaultModel: options.hostDefaultModel,
  };
}
