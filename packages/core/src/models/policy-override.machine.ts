import { type ActorRefFrom, assign, createActor, setup } from "xstate";
import {
  type PolicyEvaluationInput,
  type PolicyOverrideDiff,
  validatePolicyOverride,
} from "./local-workspace.policy.js";
import { isNonEmpty, type WorkspaceEventSource } from "./local-workspace.types.js";

export interface PolicyOverrideContext {
  overrideId: string;
  missionId: string;
  ownerId: string;
  requestId: string;
  diff: PolicyOverrideDiff;
  fingerprint: string;
  policyRevision: string | null;
  rejectionReason: string | null;
  active: boolean;
}

export interface PolicyOverrideMachineInput {
  overrideId: string;
  missionId: string;
  ownerId: string;
  requestId: string;
  diff: PolicyOverrideDiff;
  fingerprint: string;
}

export type PolicyOverrideEvent =
  | Readonly<{ type: "OVERRIDE_FACTS_REQUESTED"; source: WorkspaceEventSource }>
  | Readonly<{ type: "OVERRIDE_FACTS_RECORDED"; source: WorkspaceEventSource; policy: PolicyEvaluationInput }>
  | Readonly<{
      type: "POLICY_OVERRIDE_CONFIRMED";
      source: WorkspaceEventSource;
      ownerId: string;
      fingerprint: string;
    }>
  | Readonly<{
      type: "POLICY_OVERRIDE_DECLINED";
      source: WorkspaceEventSource;
      ownerId: string;
      fingerprint: string;
    }>
  | Readonly<{
      type: "POLICY_OVERRIDE_EXPIRED";
      source: WorkspaceEventSource;
      missionTerminalizationAuthorized: boolean;
      liveDependencyCount: number;
    }>
  | Readonly<{
      type: "POLICY_OVERRIDE_CANCELLED";
      source: WorkspaceEventSource;
      ownerId?: string;
      liveDependencyCount: number;
      reason: string;
    }>;

const overrideSetup = setup({
  types: {
    context: {} as PolicyOverrideContext,
    input: {} as PolicyOverrideMachineInput,
    events: {} as PolicyOverrideEvent,
  },
  guards: {
    structuredDiff: ({ context, event }) =>
      event.type === "OVERRIDE_FACTS_REQUESTED" &&
      event.source === "system" &&
      isNonEmpty(context.overrideId) &&
      isNonEmpty(context.missionId) &&
      isNonEmpty(context.requestId) &&
      isNonEmpty(context.fingerprint) &&
      context.diff.to > context.diff.from,
    allowedByCeilings: ({ context, event }) =>
      event.type === "OVERRIDE_FACTS_RECORDED" &&
      event.source === "tool" &&
      validatePolicyOverride(context.diff, event.policy) === "allowed",
    deniedByCeilings: ({ context, event }) =>
      event.type === "OVERRIDE_FACTS_RECORDED" &&
      event.source === "tool" &&
      validatePolicyOverride(context.diff, event.policy) !== "allowed",
    exactOwnerConfirmation: ({ context, event }) =>
      event.type === "POLICY_OVERRIDE_CONFIRMED" &&
      event.source === "human" &&
      event.ownerId === context.ownerId &&
      event.fingerprint === context.fingerprint,
    exactOwnerDecline: ({ context, event }) =>
      event.type === "POLICY_OVERRIDE_DECLINED" &&
      event.source === "human" &&
      event.ownerId === context.ownerId &&
      event.fingerprint === context.fingerprint,
    terminalExpiry: ({ event }) =>
      event.type === "POLICY_OVERRIDE_EXPIRED" &&
      event.source === "system" &&
      event.missionTerminalizationAuthorized &&
      event.liveDependencyCount === 0,
    safeCancellation: ({ context, event }) =>
      event.type === "POLICY_OVERRIDE_CANCELLED" &&
      (event.source === "system" || (event.source === "human" && event.ownerId === context.ownerId)) &&
      event.liveDependencyCount === 0 &&
      isNonEmpty(event.reason),
  },
  actions: {
    recordPolicyRevision: assign(({ event }) =>
      event.type === "OVERRIDE_FACTS_RECORDED" ? { policyRevision: event.policy.globalRules.revision } : {},
    ),
    recordPolicyRejection: assign(({ context, event }) => ({
      policyRevision: event.type === "OVERRIDE_FACTS_RECORDED" ? event.policy.globalRules.revision : null,
      rejectionReason:
        event.type === "OVERRIDE_FACTS_RECORDED"
          ? validatePolicyOverride(context.diff, event.policy)
          : "policy_override_rejected",
    })),
    activate: assign({ active: true, rejectionReason: null }),
    decline: assign({ active: false, rejectionReason: "human_declined" }),
    deactivate: assign({ active: false }),
  },
});

export const policyOverrideMachine = overrideSetup.createMachine({
  id: "policyOverride",
  initial: "proposed",
  context: ({ input }) => ({
    ...input,
    policyRevision: null,
    rejectionReason: null,
    active: false,
  }),
  states: {
    proposed: {
      on: {
        OVERRIDE_FACTS_REQUESTED: { guard: "structuredDiff", target: "ceiling_check" },
        POLICY_OVERRIDE_CANCELLED: { guard: "safeCancellation", target: "cancelled", actions: "deactivate" },
      },
    },
    ceiling_check: {
      on: {
        OVERRIDE_FACTS_RECORDED: [
          { guard: "allowedByCeilings", target: "awaiting_confirmation", actions: "recordPolicyRevision" },
          { guard: "deniedByCeilings", target: "rejected", actions: "recordPolicyRejection" },
        ],
        POLICY_OVERRIDE_CANCELLED: { guard: "safeCancellation", target: "cancelled", actions: "deactivate" },
      },
    },
    awaiting_confirmation: {
      on: {
        POLICY_OVERRIDE_CONFIRMED: { guard: "exactOwnerConfirmation", target: "active", actions: "activate" },
        POLICY_OVERRIDE_DECLINED: { guard: "exactOwnerDecline", target: "rejected", actions: "decline" },
        POLICY_OVERRIDE_CANCELLED: { guard: "safeCancellation", target: "cancelled", actions: "deactivate" },
      },
    },
    active: {
      on: {
        POLICY_OVERRIDE_EXPIRED: { guard: "terminalExpiry", target: "expired", actions: "deactivate" },
        POLICY_OVERRIDE_CANCELLED: { guard: "safeCancellation", target: "cancelled", actions: "deactivate" },
      },
    },
    rejected: { type: "final" },
    expired: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type PolicyOverrideActor = ActorRefFrom<typeof policyOverrideMachine>;

export const createPolicyOverrideActor = (input: PolicyOverrideMachineInput): PolicyOverrideActor => {
  const actor = createActor(policyOverrideMachine, { input });
  actor.start();
  return actor;
};
