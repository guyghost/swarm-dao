// ============================================================
// Swarm DAO Core — Delegation Orchestrator (DFI thin slice)
// ------------------------------------------------------------
// I/O layer ONLY. Drives the two delegation machines through their events.
// Owns: parse parent LLM signal, evaluate the pure gate, spawn child via
// `HostAdapter.spawnAgent`, fold child reasoning into the parent output, and
// run the drain/cancel cascade. Emits NO decision the machines do not
// authorize (INV-3). Child outputs fold into parent REASONING only — never
// into votes (INV-6, enforced structurally: weight 0, separate section).
//
// Fold integrity (B2): the request machine commits to a fold hash on
// CHILD_REPORTED (FNV-1a over the child output content) and the orchestrator
// must echo the identical hash on FOLD_COMPLETE. This binds the fold ack to
// the observed child report. A request cannot leave `reported` otherwise.
// ============================================================

import {
  buildChildAgent,
  computeMergedFoldHash,
  type DelegationSignal,
  evaluateDelegationGate,
  extractDelegationSignals,
  normalizeFacet,
} from "../governance/delegation.machine.js";
import {
  createCoordinatorState,
  createRequestState,
  type DelegationCoordinatorState,
  type DelegationRequestState,
  dispatchCoordinatorEvent,
  dispatchDelegationEvent,
  profileFor,
  registeredArchetypes,
} from "../governance/delegation.utils.js";
import type { AgentOutput, DAOAgent, DAOConfig, HostAdapter, Proposal } from "../types/index.js";
import { buildChildModelResolutionContext, type ModelResolutionContext, resolveAgentModel } from "./model.js";

export interface DelegationResult {
  /** Parent content with folded child reasoning appended (INV-6: votes untouched). */
  foldedContent: string;
  /** Every coordinator created for this parent (for the registry / cascade). */
  coordinators: DelegationCoordinatorState[];
  /** Every request created for this parent (for audit). */
  requests: DelegationRequestState[];
  /** True when at least one request reached `delegated`. */
  delegated: boolean;
}

/**
 * Run all declared delegations for a parent agent after it has produced an
 * output. Returns the (possibly folded) parent content and the live machine
 * states. No-op when delegation is disabled, the agent declares no delegates,
 * or the parent emitted no recognizable signal.
 */
export async function runDelegations(params: {
  parent: DAOAgent;
  parentOutput: AgentOutput;
  proposal: Proposal;
  adapter: HostAdapter;
  config: DAOConfig;
  parentModelContext: ModelResolutionContext;
  onCoordinatorCreated?: (coordinator: DelegationCoordinatorState) => void;
}): Promise<DelegationResult> {
  const { parent, parentOutput, proposal, adapter, config, parentModelContext } = params;
  const content = parentOutput.content ?? "";
  const coordinators: DelegationCoordinatorState[] = [];
  const requests: DelegationRequestState[] = [];

  const delegation = config.delegation;
  const declared = parent.delegates ?? [];
  const signals = delegation?.enabled === true && declared.length > 0 ? extractDelegationSignals(content) : [];

  if (signals.length === 0) {
    return { foldedContent: content, coordinators, requests, delegated: false };
  }

  const coordinator = createCoordinatorState(parent, config);
  coordinators.push(coordinator);
  params.onCoordinatorCreated?.(coordinator);
  const archetypes = registeredArchetypes(config);
  const parentResolvedModel = resolveAgentModel(parent, parentModelContext);
  let counter = 0;
  let delegated = false;
  let foldedContent = content;

  for (const signal of signals) {
    const requestId = `${parent.id}:${normalizeFacet(signal.facet)}:${counter++}`;
    const arrived = dispatchCoordinatorEvent(coordinator, {
      type: "REQUEST_ARRIVED",
      requestId,
      facet: signal.facet,
      archetype: signal.archetype,
    });
    if (!arrived.ok || arrived.ack?.accepted === false) {
      // Coordinator-level refusal (budget / disabled / depth). Record a blocked
      // request for audit; no child is spawned (INV-2, W4).
      const req = createRequestState(requestId, coordinator, signal.facet, signal.archetype);
      requests.push(req);
      dispatchDelegationEvent(req, {
        type: "GATE_DECIDED",
        ok: false,
        reasons: [arrived.ok ? (arrived.ack?.reason ?? "rejected by coordinator") : arrived.error],
      });
      continue;
    }

    const req = createRequestState(requestId, coordinator, signal.facet, signal.archetype);
    requests.push(req);

    // Per-request gate (pure). Single authority for facet/archetype/depth.
    const gate = evaluateDelegationGate({
      facet: signal.facet,
      archetype: signal.archetype,
      parentDepth: coordinator.parentDepth,
      maxDepth: delegation?.maxDepth ?? 0,
      declared,
      registeredArchetypes: archetypes,
    });
    dispatchDelegationEvent(req, { type: "GATE_DECIDED", ok: gate.ok, reasons: gate.reasons });
    if (!gate.ok) {
      // Resolve the coordinator slot we consumed: a blocked request is terminal.
      dispatchCoordinatorEvent(coordinator, { type: "REQUEST_RESOLVED", requestId, terminalStatus: "blocked" });
      continue;
    }

    dispatchDelegationEvent(req, {
      type: "SPAWN_ACKED",
      childAgentId: `${parent.id}:delegate:${normalizeFacet(signal.facet)}`,
    });

    const spec = declared.find((d) => normalizeFacet(d.facet) === normalizeFacet(signal.facet));
    const childAgent = buildChildAgent(parent, spec ?? { facet: signal.facet, archetype: signal.archetype });
    const profile = profileFor(config, signal.archetype);
    const childModel = resolveAgentModel(
      childAgent,
      buildChildModelResolutionContext(config.defaultModel, {
        parentAgentModel: parentResolvedModel,
        profile,
        parentSessionModel: parentModelContext.parentSessionModel,
        hostDefaultModel: parentModelContext.hostDefaultModel,
      }),
    );

    try {
      const childOutput = await adapter.spawnAgent({
        agent: childAgent,
        proposal,
        systemPrompt: profile?.promptId ? `[prompt:${profile.promptId}]` : childAgent.systemPrompt,
        model: childModel,
        timeoutMs: delegation?.foldTimeoutMs,
      });
      if (childOutput.error) {
        dispatchDelegationEvent(req, { type: "CHILD_FAILED", error: childOutput.error });
        dispatchCoordinatorEvent(coordinator, { type: "REQUEST_RESOLVED", requestId, terminalStatus: "failed" });
        continue;
      }
      dispatchDelegationEvent(req, { type: "CHILD_REPORTED", output: childOutput });

      // Fold: merge child reasoning into the parent's content (INV-6).
      foldedContent = foldChildIntoParent(foldedContent, signal, childOutput);
      // Echo the machine's commitment hash to acknowledge the fold (B2).
      dispatchDelegationEvent(req, {
        type: "FOLD_COMPLETE",
        foldedInto: parent.id,
        mergedAgentOutputHash: computeMergedFoldHash(childOutput.content ?? ""),
      });
      delegated = true;
      dispatchCoordinatorEvent(coordinator, { type: "REQUEST_RESOLVED", requestId, terminalStatus: "delegated" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "spawn failed";
      dispatchDelegationEvent(req, { type: "SPAWN_FAILED", error: message });
      dispatchCoordinatorEvent(coordinator, { type: "REQUEST_RESOLVED", requestId, terminalStatus: "failed" });
    }
  }

  return { foldedContent, coordinators, requests, delegated };
}

/**
 * Append the child's investigation under a `## Delegated Facets` section.
 * Pure. The parent's `## Vote` section is never touched (INV-6).
 */
export function foldChildIntoParent(parentContent: string, signal: DelegationSignal, childOutput: AgentOutput): string {
  const childBlock = [
    "",
    "## Delegated Facets",
    `### facet: ${signal.facet} | archetype: ${signal.archetype}`,
    childOutput.content?.trim() ?? "_(no output)_",
    "",
  ].join("\n");
  return `${parentContent.replace(/\n*$/, "")}\n${childBlock}`;
}

/**
 * Drain/cancel cascade (B3). Emit DRAIN to each coordinator, then CANCEL to
 * every non-terminal request. Idempotent: terminal states ignore events.
 */
export function drainDelegations(coordinators: DelegationCoordinatorState[], requests: DelegationRequestState[]): void {
  for (const c of coordinators) {
    dispatchCoordinatorEvent(c, { type: "DRAIN", reason: "proposal-terminal" });
  }
  const byParent = new Map(coordinators.map((c) => [c.parentAgentId, c]));
  for (const r of requests) {
    dispatchDelegationEvent(r, { type: "CANCEL", reason: "proposal-terminal" });
    const owner = byParent.get(r.parentAgentId) ?? coordinators[0];
    if (owner) {
      dispatchCoordinatorEvent(owner, {
        type: "REQUEST_RESOLVED",
        requestId: r.requestId,
        terminalStatus: "cancelled",
      });
    }
  }
}
