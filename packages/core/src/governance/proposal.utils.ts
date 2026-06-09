import { createActor } from "xstate";
import type { PipelineStage, Proposal } from "../types/index.js";
import {
  type ProposalContext,
  type ProposalEvent,
  type ProposalMachineInput,
  proposalMachine,
} from "./proposal.machine.js";

/**
 * Creates an XState actor for a proposal
 */
export function createProposalActor(proposal: Proposal, initialStage?: PipelineStage) {
  const initialContext: ProposalMachineInput = {
    proposal,
    deliberationCount: 0,
    retryCount: 0,
    lastTransitionTime: new Date().toISOString(),
    stage: initialStage ?? "intake",
    status: proposal.status,
  };

  const actor = createActor(proposalMachine, {
    input: initialContext,
  });
  actor.start();
  return actor;
}

/**
 * Moves a proposal through its states sequentially
 */
export function sendProposalEvent(actor: ReturnType<typeof createProposalActor>, event: ProposalEvent) {
  actor.send(event);
  return actor.getSnapshot();
}

/**
 * Returns the machine's current context
 */
export function getProposalContext(actor: ReturnType<typeof createProposalActor>) {
  return actor.getSnapshot().context;
}

/**
 * Returns the machine's current state
 */
export function getProposalState(actor: ReturnType<typeof createProposalActor>) {
  return actor.getSnapshot().value;
}

/**
 * Checks whether the proposal can take a given transition
 */
export function canSendProposalEvent(actor: ReturnType<typeof createProposalActor>, eventType: string): boolean {
  try {
    if (eventType === "ERROR") {
      return false;
    }

    const state = actor.getSnapshot();
    return state.can({ type: eventType } as ProposalEvent);
  } catch {
    return false;
  }
}

/**
 * Returns all possible transitions from the current state
 */
export function getAvailableProposalEvents(actor: ReturnType<typeof createProposalActor>): string[] {
  const eventTypes: Array<ProposalEvent["type"]> = [
    "SUBMIT",
    "QUALIFY",
    "ANALYZE",
    "CRITIQUE",
    "SCORE",
    "SEND_TO_COUNCIL",
    "VOTE",
    "APPROVE",
    "REJECT",
    "REQUEST_SPEC",
    "REVIEW_SPEC",
    "APPROVE_SPEC",
    "EXECUTION_GATE_PASS",
    "EXECUTION_GATE_FAIL",
    "EXECUTE",
    "EXECUTION_SUCCESS",
    "EXECUTION_FAILED",
    "POSTMORTEM",
    "RETRY",
    "DISCARD",
  ];

  return eventTypes.filter((eventType) => canSendProposalEvent(actor, eventType));
}

/**
 * Helper for auto-progressing a proposal through the pipeline
 * Uses linear progression events
 */
export function progressProposal(actor: ReturnType<typeof createProposalActor>): string | null {
  const current = actor.getSnapshot().value;
  const progressMap: Record<string, ProposalEvent["type"]> = {
    draft: "SUBMIT",
    intake: "QUALIFY",
    qualification: "ANALYZE",
    analysis: "CRITIQUE",
    critique: "SCORE",
    scoring: "SEND_TO_COUNCIL",
    council: "VOTE",
    voting: "APPROVE",
    specDraft: "REQUEST_SPEC",
    specReview: "APPROVE_SPEC",
    executionGate: "EXECUTION_GATE_PASS",
  };

  const nextEventType = progressMap[String(current)];
  if (nextEventType && canSendProposalEvent(actor, nextEventType)) {
    const event = { type: nextEventType } as ProposalEvent;
    sendProposalEvent(actor, event);
    return nextEventType;
  }

  return null;
}

/**
 * Creates a helper to trigger rejection events easily
 */
export function rejectProposal(actor: ReturnType<typeof createProposalActor>) {
  sendProposalEvent(actor, { type: "REJECT" });
  return getProposalState(actor);
}

/**
 * Listener for observing state changes
 */
export function onProposalStateChange(
  actor: ReturnType<typeof createProposalActor>,
  callback: (state: string, context: ProposalContext) => void,
) {
  const subscription = actor.subscribe((snapshot) => {
    callback(String(snapshot.value), snapshot.context);
  });
  return () => subscription.unsubscribe();
}
