// ============================================================
// Swarm DAO Core — Delegation Lifecycle State Machines
// ------------------------------------------------------------
// Source of truth for Delegated Facet Investigation (DFI, thin slice,
// depth = 1). Two coordinated XState v5 machines:
//
//   • DelegationCoordinator — one per (parent agent, deliberation). Owns the
//     parent-scoped budget counters atomically (INV-7), the enabled check
//     (parentEnabled), and the drain/cancel cascade entry point.
//   • DelegationRequest     — one per request. Owns the per-request lifecycle
//     (requested → gated → spawned → reported → delegated | blocked |
//      cancelled | failed). Pure permission guards only.
//
// Discipline (unchanged from proposal.machine.ts): "Le modèle décide." The
// LLM produces ONE signal — `FACET_REQUESTED` — extracted by the orchestrator
// from the parent agent's output. That signal feeds `REQUEST_ARRIVED`. Every
// other transition is decided by guards + the coordinator. No call site
// chooses a target status; it emits the event that matches what happened.
//
// The orchestrator owns I/O only (parse, spawn child via adapter, fold output,
// run timers). It emits no decision the machines do not authorize. The
// proposal machine is untouched.
//
// Invariants enforced here: INV-1 (depth cap), INV-2 (no ungated spawn),
// INV-4 (terminal immutability), INV-5 (exact facet match), INV-7 (atomic
// budget). INV-3 (LLM boundary) is structural. INV-6 (child does not vote)
// is enforced in `intelligence/synthesis`. INV-8 (ordering) is enforced at
// the deliberation orchestrator via `allCoordinatorsClosed()`.
// ============================================================

import { assign, setup } from "xstate";
import type { AgentOutput, DAOAgent, DelegationProfileEntry } from "../types/index.js";

// ── Status unions ────────────────────────────────────────────

export type DelegationCoordinatorStatus = "open" | "blocked_signal" | "draining" | "closed";

export type DelegationRequestStatus =
  | "requested"
  | "gated"
  | "spawned"
  | "reported"
  | "delegated"
  | "blocked"
  | "cancelled"
  | "failed";

export const COORDINATOR_FINAL_STATUSES: ReadonlySet<DelegationCoordinatorStatus> = new Set([
  "blocked_signal",
  "closed",
]);

export const REQUEST_FINAL_STATUSES: ReadonlySet<DelegationRequestStatus> = new Set([
  "delegated",
  "blocked",
  "cancelled",
  "failed",
]);

export function isCoordinatorFinal(status: DelegationCoordinatorStatus): boolean {
  return COORDINATOR_FINAL_STATUSES.has(status);
}

export function isDelegationRequestFinal(status: DelegationRequestStatus): boolean {
  return REQUEST_FINAL_STATUSES.has(status);
}

// ── Pure helpers (INV-3, INV-5; W2, W5) ──────────────────────

/**
 * Normalize a facet token. Pure. The orchestrator MUST call this before
 * emitting REQUEST_ARRIVED; guards match on the normalized value exactly.
 */
export function normalizeFacet(facet: string): string {
  return facet.trim().toLowerCase();
}

/**
 * Reasons the per-request gate can cite. Pure function — the single authority
 * for facet/archetype/depth authorization (INV-2). The machine's `gateApproved`
 * guard trusts `ok`; the orchestrator is the only sanctioned dispatcher.
 */
export interface DelegationGateResult {
  ok: boolean;
  reasons: string[];
}

export interface DelegationGateInput {
  facet: string;
  archetype: string;
  parentDepth: number;
  maxDepth: number;
  /** Declared capabilities of the parent agent. */
  declared: readonly { facet: string; archetype: string }[];
  /** Archetypes with a registered profile. */
  registeredArchetypes: ReadonlySet<string>;
}

export function evaluateDelegationGate(input: DelegationGateInput): DelegationGateResult {
  const reasons: string[] = [];
  const normalized = normalizeFacet(input.facet);

  const declared = input.declared.find((d) => normalizeFacet(d.facet) === normalized);
  if (!declared) {
    reasons.push(`facet "${normalized}" is not declared by the parent agent`);
  } else if (normalizeFacet(declared.archetype) !== normalizeFacet(input.archetype)) {
    reasons.push(`facet "${normalized}" is declared for archetype "${declared.archetype}", not "${input.archetype}"`);
  }
  if (!input.registeredArchetypes.has(normalizeFacet(input.archetype))) {
    reasons.push(`archetype "${input.archetype}" has no registered delegation profile`);
  }
  if (input.parentDepth + 1 > input.maxDepth) {
    reasons.push(`depth cap exceeded (parentDepth ${input.parentDepth} + 1 > maxDepth ${input.maxDepth})`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * INV-6 boundary marker — the hash the orchestrator must compute when it
 * merges a child output into the parent's reasoning. Verified by the
 * `reported → delegated` guard before the fold is acknowledged.
 */
export function computeMergedFoldHash(mergedContent: string): string {
  // FNV-1a 32-bit over UTF-8. Deterministic, dependency-free; sufficient as a
  // tampering/integrity check for the fold ack (not a security boundary).
  let hash = 0x811c9dc5;
  for (let i = 0; i < mergedContent.length; i++) {
    hash ^= mergedContent.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Extract a delegation signal from a parent agent's output. Pure. The ONLY
 * place an LLM influences delegation. Returns one signal per recognized
 * directive; malformed directives are ignored (they become REQUEST_REJECTED
 * upstream, never REQUEST_ARRIVED — W2).
 *
 * Recognized format (sibling section, not inside `## Vote`):
 *
 *   ## Delegation Requests
 *   - facet: <token> | archetype: <token>
 */
export interface DelegationSignal {
  facet: string;
  archetype: string;
}

export function extractDelegationSignals(content: string | undefined): DelegationSignal[] {
  if (!content) return [];
  const signals: DelegationSignal[] = [];
  const section = content.match(/##\s*Delegation Requests\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!section || !section[1]) return [];
  for (const line of section[1].split("\n")) {
    const m = line.match(/^\s*[-*]\s*facet:\s*([^|]+?)\s*\|\s*archetype:\s*(.+?)\s*$/i);
    if (!m || !m[1] || !m[2]) continue;
    const facet = m[1].trim();
    const archetype = m[2].trim();
    if (facet.length > 0 && archetype.length > 0) {
      signals.push({ facet: normalizeFacet(facet), archetype });
    }
  }
  return signals;
}

// ── Machine 1: DelegationCoordinator ─────────────────────────

export interface DelegationCoordinatorContext {
  parentAgentId: string;
  parentDepth: number;
  parentEnabled: boolean;
  maxChildren: number;
  maxDepth: number;
  activeRequests: number;
  lastTransitionTime: string;
  errorMessage?: string;
}

export interface DelegationCoordinatorInput extends Omit<DelegationCoordinatorContext, "lastTransitionTime"> {
  lastTransitionTime?: string;
}

export type DelegationCoordinatorEvent =
  | { type: "REQUEST_ARRIVED"; requestId: string; facet: string; archetype: string }
  | { type: "REQUEST_RESOLVED"; requestId: string; terminalStatus: DelegationRequestStatus }
  | { type: "DRAIN"; reason: string }
  | { type: "ERROR"; message: string };

const coordinatorSetup = setup({
  types: {
    context: {} as DelegationCoordinatorContext,
    input: {} as DelegationCoordinatorInput,
    events: {} as DelegationCoordinatorEvent,
  },
  guards: {
    slotAvailable: ({ context }) => context.activeRequests < context.maxChildren,
    parentEnabled: ({ context }) => context.parentEnabled === true,
    depthWithinBudget: ({ context }) => context.parentDepth + 1 <= context.maxDepth,
    requestAccepted: ({ context }) =>
      context.activeRequests < context.maxChildren &&
      context.parentEnabled === true &&
      context.parentDepth + 1 <= context.maxDepth,
    // "Last in flight" — this REQUEST_RESOLVED brings activeRequests to 0, so
    // the coordinator can close. Guards evaluate BEFORE actions, hence the `<= 1`
    // (current count minus one == zero). Without this the coordinator could never
    // reach `closed` during a drain while children were still in flight.
    lastInFlight: ({ context }) => context.activeRequests <= 1,
  },
});

function buildCoordinatorMachine(initial: DelegationCoordinatorStatus) {
  return coordinatorSetup.createMachine({
    id: "delegationCoordinator",
    initial,
    context: ({ input }) => ({
      parentAgentId: input.parentAgentId,
      parentDepth: input.parentDepth,
      parentEnabled: input.parentEnabled,
      maxChildren: input.maxChildren,
      maxDepth: input.maxDepth,
      activeRequests: input.activeRequests,
      lastTransitionTime: input.lastTransitionTime ?? new Date().toISOString(),
    }),
    states: {
      open: {
        on: {
          REQUEST_ARRIVED: [
            {
              guard: "requestAccepted",
              target: "open",
              actions: assign({
                activeRequests: ({ context }) => context.activeRequests + 1,
                lastTransitionTime: () => new Date().toISOString(),
              }),
            },
            // Guards failed: stay open, no budget consumed. COORD_ACK{ok:false}
            // is synthesized by the dispatch service from the unchanged
            // context + the guard outcome (see delegation.utils.ts).
            { target: "open" },
          ],
          DRAIN: {
            target: "draining",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          ERROR: {
            target: "blocked_signal",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },
      draining: {
        on: {
          REQUEST_RESOLVED: [
            {
              guard: "lastInFlight",
              target: "closed",
              actions: assign({
                activeRequests: ({ context }) => Math.max(0, context.activeRequests - 1),
                lastTransitionTime: () => new Date().toISOString(),
              }),
            },
            {
              target: "draining",
              actions: assign({
                activeRequests: ({ context }) => Math.max(0, context.activeRequests - 1),
                lastTransitionTime: () => new Date().toISOString(),
              }),
            },
          ],
        },
      },
      blocked_signal: { type: "final" },
      closed: { type: "final" },
    },
  });
}

const coordinatorCache = new Map<DelegationCoordinatorStatus, ReturnType<typeof buildCoordinatorMachine>>();

export function createDelegationCoordinatorMachine(initial: DelegationCoordinatorStatus) {
  let machine = coordinatorCache.get(initial);
  if (!machine) {
    machine = buildCoordinatorMachine(initial);
    coordinatorCache.set(initial, machine);
  }
  return machine;
}

export type DelegationCoordinatorMachine = ReturnType<typeof buildCoordinatorMachine>;

// ── Machine 2: DelegationRequest ─────────────────────────────

export interface DelegationRequestContext {
  requestId: string;
  parentAgentId: string;
  facet: string;
  archetype: string;
  childAgentId?: string;
  mergedAgentOutputHash?: string;
  errorMessage?: string;
  gateReasons: string[];
  lastTransitionTime: string;
}

export interface DelegationRequestInput extends Omit<DelegationRequestContext, "lastTransitionTime"> {
  lastTransitionTime?: string;
}

export type DelegationRequestEvent =
  | { type: "GATE_DECIDED"; ok: boolean; reasons: string[] }
  | { type: "SPAWN_ACKED"; childAgentId: string }
  | { type: "CHILD_REPORTED"; output: AgentOutput }
  | { type: "CHILD_FAILED"; error: string }
  | { type: "SPAWN_FAILED"; error: string }
  | { type: "FOLD_COMPLETE"; foldedInto: string; mergedAgentOutputHash: string }
  | { type: "FOLD_TIMEOUT" }
  | { type: "CANCEL"; reason: string }
  | { type: "ERROR"; message: string };

const requestSetup = setup({
  types: {
    context: {} as DelegationRequestContext,
    input: {} as DelegationRequestInput,
    events: {} as DelegationRequestEvent,
  },
  guards: {
    gateApproved: ({ event }) => event.type === "GATE_DECIDED" && event.ok === true,
    foldHashMatches: ({ event, context }) =>
      event.type === "FOLD_COMPLETE" &&
      typeof event.mergedAgentOutputHash === "string" &&
      event.mergedAgentOutputHash === context.mergedAgentOutputHash,
  },
});

function buildRequestMachine(initial: DelegationRequestStatus) {
  return requestSetup.createMachine({
    id: "delegationRequest",
    initial,
    context: ({ input }) => ({
      requestId: input.requestId,
      parentAgentId: input.parentAgentId,
      facet: input.facet,
      archetype: input.archetype,
      childAgentId: input.childAgentId,
      mergedAgentOutputHash: input.mergedAgentOutputHash,
      errorMessage: input.errorMessage,
      gateReasons: input.gateReasons,
      lastTransitionTime: input.lastTransitionTime ?? new Date().toISOString(),
    }),
    states: {
      requested: {
        on: {
          GATE_DECIDED: [
            {
              guard: "gateApproved",
              target: "gated",
              actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
            },
            {
              target: "blocked",
              actions: assign({
                gateReasons: ({ event }) => (event.type === "GATE_DECIDED" ? event.reasons : []),
                lastTransitionTime: () => new Date().toISOString(),
              }),
            },
          ],
          CANCEL: { target: "cancelled", actions: assign({ lastTransitionTime: () => new Date().toISOString() }) },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },
      gated: {
        on: {
          SPAWN_ACKED: {
            target: "spawned",
            actions: assign({
              childAgentId: ({ event }) => (event.type === "SPAWN_ACKED" ? event.childAgentId : ""),
              lastTransitionTime: () => new Date().toISOString(),
            }),
          },
          CANCEL: { target: "cancelled", actions: assign({ lastTransitionTime: () => new Date().toISOString() }) },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },
      spawned: {
        on: {
          CHILD_REPORTED: {
            target: "reported",
            actions: assign({
              // The orchestrator computes the fold hash when it merges the
              // child output into the parent's reasoning and stores it here.
              // The `reported → delegated` guard verifies FOLD_COMPLETE carries
              // the same hash (INV-6 integrity check, B2).
              mergedAgentOutputHash: ({ event }) =>
                event.type === "CHILD_REPORTED" ? computeMergedFoldHash(event.output.content ?? "") : "",
            }),
          },
          CHILD_FAILED: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "CHILD_FAILED" ? event.error : ""),
            }),
          },
          SPAWN_FAILED: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "SPAWN_FAILED" ? event.error : ""),
            }),
          },
          CANCEL: { target: "cancelled", actions: assign({ lastTransitionTime: () => new Date().toISOString() }) },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },
      reported: {
        on: {
          FOLD_COMPLETE: {
            guard: "foldHashMatches",
            target: "delegated",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          FOLD_TIMEOUT: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: "fold timeout",
            }),
          },
          CANCEL: { target: "cancelled", actions: assign({ lastTransitionTime: () => new Date().toISOString() }) },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },
      delegated: { type: "final" },
      blocked: { type: "final" },
      cancelled: { type: "final" },
      failed: { type: "final" },
    },
  });
}

const requestCache = new Map<DelegationRequestStatus, ReturnType<typeof buildRequestMachine>>();

export function createDelegationRequestMachine(initial: DelegationRequestStatus) {
  let machine = requestCache.get(initial);
  if (!machine) {
    machine = buildRequestMachine(initial);
    requestCache.set(initial, machine);
  }
  return machine;
}

export type DelegationRequestMachine = ReturnType<typeof buildRequestMachine>;

// ── Child agent + model resolution helpers ───────────────────

/**
 * Build the child agent descriptor for a declared delegation spec. Pure.
 * The orchestrator spawns this via `HostAdapter.spawnAgent` using the model
 * resolved through `buildChildModelResolutionContext`.
 */
export function buildChildAgent(parent: DAOAgent, spec: NonNullable<DAOAgent["delegates"]>[number]): DAOAgent {
  return {
    id: `${parent.id}:delegate:${normalizeFacet(spec.facet)}`,
    name: `${parent.name} → ${spec.facet}`,
    role: `Delegated facet investigation (${spec.archetype})`,
    description: `Sub-agent spawned by ${parent.id} to investigate the "${spec.facet}" facet.`,
    weight: 0, // INV-6: a child never votes.
    systemPrompt: "", // resolved from delegationProfile[archetype].promptId by the orchestrator
    model: spec.model && spec.model !== "inherit" ? spec.model : undefined,
    enabled: true,
  };
}

/**
 * Resolve the profile entry for an archetype from a DAO config. Returns
 * undefined when no profile is registered (the gate then rejects the request).
 */
export function resolveDelegationProfile(
  profiles: Partial<Record<string, DelegationProfileEntry>> | undefined,
  archetype: string,
): DelegationProfileEntry | undefined {
  return profiles?.[archetype];
}
