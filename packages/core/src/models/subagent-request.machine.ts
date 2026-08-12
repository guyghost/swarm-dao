import { type ActorRefFrom, assign, createActor, setup } from "xstate";
import { evaluatePolicy, type PolicyEvaluationInput } from "./local-workspace.policy.js";
import {
  isNonEmpty,
  type LocalAgentState,
  type WorkspaceEffectIntent,
  type WorkspaceEventSource,
} from "./local-workspace.types.js";

export type SubagentRequestState =
  | "requested"
  | "policy_validating"
  | "awaiting_policy_override"
  | "approved"
  | "starting"
  | "retry_wait"
  | "started"
  | "refused"
  | "cancelled"
  | "failed";

export interface SubagentRequestContext {
  requestId: string;
  missionId: string;
  parentAgentId: string;
  parentState: LocalAgentState;
  requestedRole: string;
  requestedCapabilities: readonly string[];
  policyInput: PolicyEvaluationInput;
  retryLimit: number;
  humanRetryAttempt: number;
  startAttempt: number;
  childAgentId: string | null;
  policyRevision: string | null;
  reasonCodes: readonly string[];
  visibleNotice: string | null;
  pendingHumanRetryAttempt: number | null;
  effects: readonly WorkspaceEffectIntent[];
}

export interface SubagentRequestMachineInput {
  requestId: string;
  missionId: string;
  parentAgentId: string;
  parentState: LocalAgentState;
  requestedRole: string;
  requestedCapabilities: readonly string[];
  policyInput: PolicyEvaluationInput;
  retryLimit: number;
  humanRetryAttempt: number;
}

export type SubagentRequestEvent =
  | Readonly<{ type: "POLICY_VALIDATION_REQUESTED"; source: WorkspaceEventSource }>
  | Readonly<{ type: "POLICY_FACTS_RECORDED"; source: WorkspaceEventSource; facts: PolicyEvaluationInput }>
  | Readonly<{ type: "POLICY_OVERRIDE_ACTIVATED"; source: WorkspaceEventSource; facts: PolicyEvaluationInput }>
  | Readonly<{ type: "POLICY_OVERRIDE_REJECTED"; source: WorkspaceEventSource; reasonCode: string }>
  | Readonly<{
      type: "SUBAGENT_START_AUTHORIZED";
      source: WorkspaceEventSource;
      facts: PolicyEvaluationInput;
      missionState: "active" | "human_intervention_required" | "paused" | "cancelling";
      parentState: LocalAgentState;
    }>
  | Readonly<{
      type: "CHILD_AGENT_ACTIVE";
      source: WorkspaceEventSource;
      childAgentId: string;
      missionId: string;
      parentAgentId: string;
    }>
  | Readonly<{ type: "CHILD_AGENT_FAILED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{ type: "SUBAGENT_RETRY_DUE"; source: WorkspaceEventSource; attempt: number }>
  | Readonly<{
      type: "SUBAGENT_RETRY_AUTHORIZED";
      source: WorkspaceEventSource;
      ownerAuthorized: boolean;
      attempt: number;
    }>
  | Readonly<{ type: "SUBAGENT_REQUEST_CANCELLED"; source: WorkspaceEventSource; reason: string }>;

const retryableErrors = new Set(["process-temporary", "resource-temporary", "worker-unavailable"]);

const addEffect = (
  context: SubagentRequestContext,
  kind: string,
  attempt = context.startAttempt,
): readonly WorkspaceEffectIntent[] => [
  ...context.effects,
  {
    kind,
    aggregateId: context.requestId,
    idempotencyKey: `${context.missionId}:${context.requestId}:${kind}:${attempt}`,
  },
];

const requestSetup = setup({
  types: {
    context: {} as SubagentRequestContext,
    input: {} as SubagentRequestMachineInput,
    events: {} as SubagentRequestEvent,
  },
  guards: {
    validRequest: ({ context, event }) =>
      event.type === "POLICY_VALIDATION_REQUESTED" &&
      event.source === "system" &&
      context.parentState === "active" &&
      isNonEmpty(context.requestId) &&
      isNonEmpty(context.missionId) &&
      isNonEmpty(context.parentAgentId) &&
      isNonEmpty(context.requestedRole) &&
      context.requestedCapabilities.length > 0,
    invalidRequest: ({ context, event }) =>
      event.type === "POLICY_VALIDATION_REQUESTED" &&
      event.source === "system" &&
      (context.parentState !== "active" ||
        !isNonEmpty(context.requestId) ||
        !isNonEmpty(context.missionId) ||
        !isNonEmpty(context.parentAgentId) ||
        !isNonEmpty(context.requestedRole) ||
        context.requestedCapabilities.length === 0),
    policyAllows: ({ event }) =>
      event.type === "POLICY_FACTS_RECORDED" &&
      event.source === "tool" &&
      evaluatePolicy(event.facts).decision === "allow",
    policyNeedsOverride: ({ event }) =>
      event.type === "POLICY_FACTS_RECORDED" &&
      event.source === "tool" &&
      evaluatePolicy(event.facts).decision === "requires_human_confirmation",
    policyDenies: ({ event }) =>
      event.type === "POLICY_FACTS_RECORDED" &&
      event.source === "tool" &&
      evaluatePolicy(event.facts).decision === "deny",
    overrideActivated: ({ event }) => event.type === "POLICY_OVERRIDE_ACTIVATED" && event.source === "system",
    overrideRejected: ({ event }) =>
      event.type === "POLICY_OVERRIDE_REJECTED" && event.source === "system" && isNonEmpty(event.reasonCode),
    startStillAuthorized: ({ event }) =>
      event.type === "SUBAGENT_START_AUTHORIZED" &&
      event.source === "system" &&
      event.missionState === "active" &&
      event.parentState === "active" &&
      evaluatePolicy(event.facts).decision === "allow",
    matchingChild: ({ context, event }) =>
      event.type === "CHILD_AGENT_ACTIVE" &&
      event.source === "system" &&
      event.missionId === context.missionId &&
      event.parentAgentId === context.parentAgentId &&
      isNonEmpty(event.childAgentId),
    automaticRetry: ({ context, event }) => {
      if (event.type !== "CHILD_AGENT_FAILED" || event.source !== "system") return false;
      const next = context.startAttempt + 1;
      return retryableErrors.has(event.errorCode) && next < context.humanRetryAttempt && next <= context.retryLimit;
    },
    humanRetry: ({ context, event }) => {
      if (event.type !== "CHILD_AGENT_FAILED" || event.source !== "system") return false;
      const next = context.startAttempt + 1;
      return retryableErrors.has(event.errorCode) && next >= context.humanRetryAttempt && next <= context.retryLimit;
    },
    cannotRetry: ({ context, event }) =>
      event.type === "CHILD_AGENT_FAILED" &&
      event.source === "system" &&
      (!retryableErrors.has(event.errorCode) || context.startAttempt + 1 > context.retryLimit),
    automaticRetryDue: ({ context, event }) =>
      event.type === "SUBAGENT_RETRY_DUE" &&
      event.source === "system" &&
      context.pendingHumanRetryAttempt === null &&
      event.attempt === context.startAttempt,
    exactHumanRetry: ({ context, event }) =>
      event.type === "SUBAGENT_RETRY_AUTHORIZED" &&
      event.source === "human" &&
      event.ownerAuthorized &&
      event.attempt === context.pendingHumanRetryAttempt,
    cancellable: ({ event }) =>
      event.type === "SUBAGENT_REQUEST_CANCELLED" &&
      (event.source === "human" || event.source === "system") &&
      isNonEmpty(event.reason),
  },
  actions: {
    requestPolicyFacts: assign(({ context }) => ({ effects: addEffect(context, "collect_policy_facts") })),
    recordAllowedPolicy: assign(({ event }) => {
      if (event.type !== "POLICY_FACTS_RECORDED") return {};
      const decision = evaluatePolicy(event.facts);
      return { policyInput: event.facts, policyRevision: decision.policyRevision, reasonCodes: decision.reasonCodes };
    }),
    requestOverride: assign(({ context, event }) => {
      if (event.type !== "POLICY_FACTS_RECORDED") return {};
      const decision = evaluatePolicy(event.facts);
      return {
        policyInput: event.facts,
        policyRevision: decision.policyRevision,
        reasonCodes: decision.reasonCodes,
        visibleNotice: `Subagent request ${context.requestId} requires human policy confirmation.`,
        effects: addEffect(context, "open_policy_override"),
      };
    }),
    recordRefusal: assign(({ context, event }) => {
      const reasonCodes =
        event.type === "POLICY_FACTS_RECORDED"
          ? evaluatePolicy(event.facts).reasonCodes
          : event.type === "POLICY_OVERRIDE_REJECTED"
            ? [event.reasonCode]
            : ["invalid_request"];
      return {
        reasonCodes,
        visibleNotice: `Subagent request ${context.requestId} refused: ${reasonCodes.join(", ")}.`,
      };
    }),
    revalidatePolicy: assign(({ context, event }) =>
      event.type === "POLICY_OVERRIDE_ACTIVATED"
        ? { policyInput: event.facts, effects: addEffect(context, "collect_policy_facts") }
        : {},
    ),
    createChild: assign(({ context, event }) => ({
      policyInput: event.type === "SUBAGENT_START_AUTHORIZED" ? event.facts : context.policyInput,
      effects: addEffect(context, "create_and_start_child_agent"),
    })),
    recordChild: assign(({ context, event }) =>
      event.type === "CHILD_AGENT_ACTIVE"
        ? {
            childAgentId: event.childAgentId,
            visibleNotice: `Subagent ${event.childAgentId} started for ${context.parentAgentId}.`,
          }
        : {},
    ),
    recordAutomaticRetry: assign(({ context }) => ({
      startAttempt: context.startAttempt + 1,
      pendingHumanRetryAttempt: null,
    })),
    recordHumanRetry: assign(({ context }) => {
      const attempt = context.startAttempt + 1;
      return {
        startAttempt: attempt,
        pendingHumanRetryAttempt: attempt,
        visibleNotice: `Subagent retry ${attempt} requires human confirmation.`,
      };
    }),
    clearHumanRetry: assign({ pendingHumanRetryAttempt: null }),
    recordFailure: assign(({ context, event }) => ({
      reasonCodes: [event.type === "CHILD_AGENT_FAILED" ? event.errorCode : "child_start_failed"],
      visibleNotice: `Subagent request ${context.requestId} failed.`,
    })),
    recordCancellation: assign(({ context, event }) => ({
      visibleNotice: `Subagent request ${context.requestId} cancelled.`,
      effects: addEffect(context, "release_subagent_reservation"),
      reasonCodes: [event.type === "SUBAGENT_REQUEST_CANCELLED" ? event.reason : "cancelled"],
    })),
  },
});

export const subagentRequestMachine = requestSetup.createMachine({
  id: "subagentRequest",
  initial: "requested",
  context: ({ input }) => ({
    ...input,
    startAttempt: 0,
    childAgentId: null,
    policyRevision: null,
    reasonCodes: [],
    visibleNotice: null,
    pendingHumanRetryAttempt: null,
    effects: [],
  }),
  states: {
    requested: {
      on: {
        POLICY_VALIDATION_REQUESTED: [
          { guard: "validRequest", target: "policy_validating", actions: "requestPolicyFacts" },
          { guard: "invalidRequest", target: "refused", actions: "recordRefusal" },
        ],
        SUBAGENT_REQUEST_CANCELLED: { guard: "cancellable", target: "cancelled", actions: "recordCancellation" },
      },
    },
    policy_validating: {
      on: {
        POLICY_FACTS_RECORDED: [
          { guard: "policyAllows", target: "approved", actions: "recordAllowedPolicy" },
          { guard: "policyNeedsOverride", target: "awaiting_policy_override", actions: "requestOverride" },
          { guard: "policyDenies", target: "refused", actions: "recordRefusal" },
        ],
        SUBAGENT_REQUEST_CANCELLED: { guard: "cancellable", target: "cancelled", actions: "recordCancellation" },
      },
    },
    awaiting_policy_override: {
      on: {
        POLICY_OVERRIDE_ACTIVATED: {
          guard: "overrideActivated",
          target: "policy_validating",
          actions: "revalidatePolicy",
        },
        POLICY_OVERRIDE_REJECTED: { guard: "overrideRejected", target: "refused", actions: "recordRefusal" },
        SUBAGENT_REQUEST_CANCELLED: { guard: "cancellable", target: "cancelled", actions: "recordCancellation" },
      },
    },
    approved: {
      on: {
        SUBAGENT_START_AUTHORIZED: { guard: "startStillAuthorized", target: "starting", actions: "createChild" },
        SUBAGENT_REQUEST_CANCELLED: { guard: "cancellable", target: "cancelled", actions: "recordCancellation" },
      },
    },
    starting: {
      on: {
        CHILD_AGENT_ACTIVE: { guard: "matchingChild", target: "started", actions: "recordChild" },
        CHILD_AGENT_FAILED: [
          { guard: "automaticRetry", target: "retry_wait", actions: "recordAutomaticRetry" },
          { guard: "humanRetry", target: "retry_wait", actions: "recordHumanRetry" },
          { guard: "cannotRetry", target: "failed", actions: "recordFailure" },
        ],
        SUBAGENT_REQUEST_CANCELLED: { guard: "cancellable", target: "cancelled", actions: "recordCancellation" },
      },
    },
    retry_wait: {
      on: {
        SUBAGENT_RETRY_DUE: { guard: "automaticRetryDue", target: "approved" },
        SUBAGENT_RETRY_AUTHORIZED: { guard: "exactHumanRetry", target: "approved", actions: "clearHumanRetry" },
        SUBAGENT_REQUEST_CANCELLED: { guard: "cancellable", target: "cancelled", actions: "recordCancellation" },
      },
    },
    started: { type: "final" },
    refused: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

export type SubagentRequestActor = ActorRefFrom<typeof subagentRequestMachine>;

export const createSubagentRequestActor = (input: SubagentRequestMachineInput): SubagentRequestActor => {
  const actor = createActor(subagentRequestMachine, { input });
  actor.start();
  return actor;
};
