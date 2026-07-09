// ============================================================
// Swarm DAO Core — Delegation Dispatch Service
// ------------------------------------------------------------
// The only sanctioned way to mutate a delegation lifecycle. Mirrors
// `dispatchProposalEvent`: rehydrate an actor at the persisted status,
// ask the machine whether the event is permitted (guards included),
// and only then write the new status + context back. No other writer.
//
// Two services, one per machine:
//   • dispatchCoordinatorEvent — mutates a DelegationCoordinatorState
//   • dispatchDelegationEvent  — mutates a DelegationRequestState
//
// The orchestrator (intelligence layer) owns these state objects and drives
// them through the cascade: signal → REQUEST_ARRIVED → COORD_ACK →
// GATE_DECIDED → SPAWN_ACKED → CHILD_REPORTED → FOLD_COMPLETE. It never
// names a target status; it emits events.
// ============================================================

import { createActor } from "xstate";
import type { DAOAgent, DAOConfig, DelegationProfileEntry } from "../types/index.js";
import {
  createDelegationCoordinatorMachine,
  createDelegationRequestMachine,
  type DelegationCoordinatorContext,
  type DelegationCoordinatorEvent,
  type DelegationCoordinatorInput,
  type DelegationCoordinatorStatus,
  type DelegationRequestContext,
  type DelegationRequestEvent,
  type DelegationRequestInput,
  type DelegationRequestStatus,
  isCoordinatorFinal,
  isDelegationRequestFinal,
} from "./delegation.machine.js";

// ── Persisted state shapes ───────────────────────────────────
//
// These are the records the orchestrator holds (and may persist). They mirror
// machine context 1:1 plus the current status. Rehydration seeds the actor
// from these fields; on success the new status + context are written back.

export interface DelegationCoordinatorState {
  parentAgentId: string;
  parentDepth: number;
  parentEnabled: boolean;
  maxChildren: number;
  maxDepth: number;
  activeRequests: number;
  status: DelegationCoordinatorStatus;
  lastTransitionTime: string;
  errorMessage?: string;
}

export interface DelegationRequestState {
  requestId: string;
  parentAgentId: string;
  facet: string;
  archetype: string;
  status: DelegationRequestStatus;
  childAgentId?: string;
  mergedAgentOutputHash?: string;
  errorMessage?: string;
  gateReasons: string[];
  lastTransitionTime: string;
}

// ── Factories ────────────────────────────────────────────────

export function createCoordinatorState(
  parent: DAOAgent,
  config: DAOConfig,
  now: string = new Date().toISOString(),
): DelegationCoordinatorState {
  const delegation = config.delegation;
  return {
    parentAgentId: parent.id,
    parentDepth: 0, // thin slice: the council member is always depth 0
    parentEnabled: Boolean(parent.enabled !== false && delegation?.enabled === true),
    maxChildren: delegation?.maxChildrenPerParent ?? 0,
    maxDepth: delegation?.maxDepth ?? 0,
    activeRequests: 0,
    status: "open",
    lastTransitionTime: now,
  };
}

export function createRequestState(
  requestId: string,
  coordinator: DelegationCoordinatorState,
  facet: string,
  archetype: string,
  now: string = new Date().toISOString(),
): DelegationRequestState {
  return {
    requestId,
    parentAgentId: coordinator.parentAgentId,
    facet,
    archetype,
    status: "requested",
    gateReasons: [],
    lastTransitionTime: now,
  };
}

// ── Coordinator dispatch ─────────────────────────────────────

export interface CoordinatorAck {
  requestId: string;
  accepted: boolean;
  reason?: string;
}

export type CoordinatorDispatchResult =
  | { ok: true; status: DelegationCoordinatorStatus; ack?: CoordinatorAck }
  | { ok: false; error: string };

function coordinatorReason(state: DelegationCoordinatorState): string {
  if (!state.parentEnabled) return "delegation is disabled for this parent";
  if (state.parentDepth + 1 > state.maxDepth) return "depth cap reached";
  if (state.activeRequests >= state.maxChildren) return "children budget exhausted";
  return "rejected";
}

export function dispatchCoordinatorEvent(
  state: DelegationCoordinatorState,
  event: DelegationCoordinatorEvent,
): CoordinatorDispatchResult {
  if (isCoordinatorFinal(state.status)) {
    return { ok: false, error: `Coordinator is in terminal status "${state.status}"; no transitions are permitted.` };
  }

  const machine = createDelegationCoordinatorMachine(state.status);
  const actor = createActor(machine, {
    input: {
      parentAgentId: state.parentAgentId,
      parentDepth: state.parentDepth,
      parentEnabled: state.parentEnabled,
      maxChildren: state.maxChildren,
      maxDepth: state.maxDepth,
      activeRequests: state.activeRequests,
      lastTransitionTime: state.lastTransitionTime,
      errorMessage: state.errorMessage,
    } satisfies DelegationCoordinatorInput,
  });
  actor.start();

  if (!actor.getSnapshot().can(event)) {
    return { ok: false, error: `Event "${event.type}" is not permitted from coordinator status "${state.status}".` };
  }

  const before = state.activeRequests;
  actor.send(event);
  const snapshot = actor.getSnapshot();
  const status = snapshot.value as DelegationCoordinatorStatus;
  const ctx = snapshot.context as DelegationCoordinatorContext;

  state.status = status;
  state.activeRequests = ctx.activeRequests;
  state.lastTransitionTime = ctx.lastTransitionTime;
  state.errorMessage = ctx.errorMessage;

  let ack: CoordinatorAck | undefined;
  if (event.type === "REQUEST_ARRIVED") {
    const accepted = ctx.activeRequests > before;
    ack = accepted
      ? { requestId: event.requestId, accepted: true }
      : { requestId: event.requestId, accepted: false, reason: coordinatorReason(state) };
  }

  return { ok: true, status, ack };
}

// ── Request dispatch ─────────────────────────────────────────

export type RequestDispatchResult = { ok: true; status: DelegationRequestStatus } | { ok: false; error: string };

export function dispatchDelegationEvent(
  state: DelegationRequestState,
  event: DelegationRequestEvent,
): RequestDispatchResult {
  if (isDelegationRequestFinal(state.status)) {
    return { ok: false, error: `Request is in terminal status "${state.status}"; no transitions are permitted.` };
  }

  const machine = createDelegationRequestMachine(state.status);
  const actor = createActor(machine, {
    input: {
      requestId: state.requestId,
      parentAgentId: state.parentAgentId,
      facet: state.facet,
      archetype: state.archetype,
      childAgentId: state.childAgentId,
      mergedAgentOutputHash: state.mergedAgentOutputHash,
      errorMessage: state.errorMessage,
      gateReasons: state.gateReasons,
      lastTransitionTime: state.lastTransitionTime,
    } satisfies DelegationRequestInput,
  });
  actor.start();

  if (!actor.getSnapshot().can(event)) {
    return { ok: false, error: `Event "${event.type}" is not permitted from request status "${state.status}".` };
  }

  actor.send(event);
  const snapshot = actor.getSnapshot();
  const status = snapshot.value as DelegationRequestStatus;
  const ctx = snapshot.context as DelegationRequestContext;

  state.status = status;
  state.childAgentId = ctx.childAgentId;
  state.mergedAgentOutputHash = ctx.mergedAgentOutputHash;
  state.errorMessage = ctx.errorMessage;
  state.gateReasons = ctx.gateReasons;
  state.lastTransitionTime = ctx.lastTransitionTime;

  return { ok: true, status };
}

// ── Convenience: is this archetype registered? ───────────────

export function registeredArchetypes(config: DAOConfig): Set<string> {
  const set = new Set<string>();
  for (const key of Object.keys(config.delegationProfile ?? {})) set.add(key);
  return set;
}

export function profileFor(config: DAOConfig, archetype: string): DelegationProfileEntry | undefined {
  return config.delegationProfile?.[archetype];
}

// ── Proposal ↔ coordinator registry (INV-8) ──────────────────
//
// The deliberation orchestrator owns DelegationCoordinator states. For the
// `delegation-closed` control gate to enforce INV-8 (no APPROVE while a
// delegation is in flight), the orchestrator registers the live coordinators
// for a proposal; the gate reads this registry. Cleared when a proposal leaves
// the deliberation phase.

const proposalCoordinators = new Map<number, DelegationCoordinatorState[]>();

export function registerProposalCoordinators(proposalId: number, states: DelegationCoordinatorState[]): void {
  proposalCoordinators.set(proposalId, states);
}

export function clearProposalCoordinators(proposalId: number): void {
  proposalCoordinators.delete(proposalId);
}

export function allCoordinatorsClosed(proposalId: number): boolean {
  const states = proposalCoordinators.get(proposalId);
  if (!states || states.length === 0) return true;
  return states.every((s) => s.status === "closed" || s.status === "blocked_signal");
}
