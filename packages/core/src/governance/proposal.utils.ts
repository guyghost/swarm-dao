import { createActor } from "xstate";
import { proposalMachine, type ProposalContext, type ProposalEvent } from "./proposal.machine.js";
import type { Proposal, PipelineStage } from "../types/index.js";

/**
 * Crée un acteur XState pour une proposition
 */
export function createProposalActor(proposal: Proposal, initialStage?: string) {
  const initialContext: ProposalContext = {
    proposal,
    deliberationCount: 0,
    retryCount: 0,
    lastTransitionTime: new Date().toISOString(),
    stage: (initialStage as PipelineStage) || "intake",
    status: "open",
  };

  const actor = createActor(proposalMachine, { input: initialContext as any });
  actor.start();
  return actor;
}

/**
 * Bascule une proposition à travers ses états de manière séquentielle
 */
export function sendProposalEvent(
  actor: ReturnType<typeof createProposalActor>,
  event: Omit<ProposalEvent, never> | Extract<ProposalEvent, { type: string }>
) {
  actor.send(event as ProposalEvent);
  return actor.getSnapshot();
}

/**
 * Récupère le contexte actuel de la machine
 */
export function getProposalContext(actor: ReturnType<typeof createProposalActor>) {
  return actor.getSnapshot().context;
}

/**
 * Récupère l'état actuel de la machine
 */
export function getProposalState(actor: ReturnType<typeof createProposalActor>) {
  return actor.getSnapshot().value;
}

/**
 * Vérifie si la proposition peut faire une transition donnée
 */
export function canSendProposalEvent(
  actor: ReturnType<typeof createProposalActor>,
  eventType: string
): boolean {
  try {
    const state = actor.getSnapshot();
    return (state.can as any)({ type: eventType }) ?? false;
  } catch {
    return false;
  }
}

/**
 * Retourne toutes les transitions possibles depuis l'état actuel
 */
export function getAvailableProposalEvents(
  actor: ReturnType<typeof createProposalActor>
): string[] {
  const eventTypes: Array<ProposalEvent['type']> = [
    "SUBMIT", "QUALIFY", "ANALYZE", "CRITIQUE", "SCORE",
    "SEND_TO_COUNCIL", "VOTE", "APPROVE", "REJECT",
    "REQUEST_SPEC", "REVIEW_SPEC", "APPROVE_SPEC",
    "EXECUTION_GATE_PASS", "EXECUTION_GATE_FAIL", "EXECUTE",
    "EXECUTION_SUCCESS", "EXECUTION_FAILED", "POSTMORTEM",
    "RETRY", "DISCARD"
  ];

  return eventTypes.filter(eventType =>
    canSendProposalEvent(actor, eventType)
  );
}

/**
 * Helper pour l'auto-progression d'une proposition dans le pipeline
 * Utilise les événements de progression linéaire
 */
export function progressProposal(
  actor: ReturnType<typeof createProposalActor>
): string | null {
  const current = actor.getSnapshot().value;
  const progressMap: Record<string, ProposalEvent['type']> = {
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
    const event: Extract<ProposalEvent, { type: typeof nextEventType }> = { type: nextEventType } as any;
    sendProposalEvent(actor, event);
    return nextEventType;
  }

  return null;
}

/**
 * Crée un gestionnaire pour basculer facilement les événements de rejet
 */
export function rejectProposal(actor: ReturnType<typeof createProposalActor>) {
  sendProposalEvent(actor, { type: "REJECT" });
  return getProposalState(actor);
}

/**
 * Listener pour surveiller les changements d'état
 */
export function onProposalStateChange(
  actor: ReturnType<typeof createProposalActor>,
  callback: (state: string, context: ProposalContext) => void
) {
  const subscription = actor.subscribe((snapshot) => {
    callback(String(snapshot.value), snapshot.context);
  });
  return () => subscription.unsubscribe();
}
