import { beforeEach, describe, expect, it } from "bun:test";
import {
  canSendProposalEvent,
  createProposalActor,
  getAvailableProposalEvents,
  getProposalContext,
  getProposalState,
  onProposalStateChange,
  progressProposal,
  rejectProposal,
  sendProposalEvent,
} from "@guyghost/swarm-dao-core/governance";
import type { Proposal } from "@guyghost/swarm-dao-core/types";

describe("Proposal State Machine", () => {
  let mockProposal: Proposal;

  beforeEach(() => {
    mockProposal = {
      id: 1,
      title: "Test Proposal",
      type: "product-feature",
      description: "A test proposal",
      proposedBy: "agent-1",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
  });

  it("should create a proposal actor in draft state", () => {
    const actor = createProposalActor(mockProposal);
    const state = getProposalState(actor);
    expect(state).toBe("draft");
    expect(getProposalContext(actor).proposal).toEqual(mockProposal);
  });

  it("should transition from draft to intake on SUBMIT", () => {
    const actor = createProposalActor(mockProposal);
    sendProposalEvent(actor, { type: "SUBMIT" });
    const state = getProposalState(actor);
    expect(state).toBe("intake");
  });

  it("should track deliberation count during analysis phases", () => {
    const actor = createProposalActor(mockProposal);
    sendProposalEvent(actor, { type: "SUBMIT" });
    sendProposalEvent(actor, { type: "QUALIFY" });
    sendProposalEvent(actor, { type: "ANALYZE" });
    sendProposalEvent(actor, { type: "CRITIQUE" });

    const context = getProposalContext(actor);
    expect(context.deliberationCount).toBeGreaterThan(0);
  });

  it("should update status appropriately on transitions", () => {
    const actor = createProposalActor(mockProposal);
    sendProposalEvent(actor, { type: "SUBMIT" });

    let context = getProposalContext(actor);
    expect(context.status).toBe("open");

    sendProposalEvent(actor, { type: "QUALIFY" });
    sendProposalEvent(actor, { type: "ANALYZE" });
    sendProposalEvent(actor, { type: "CRITIQUE" });
    context = getProposalContext(actor);
    expect(context.status).toBe("deliberating");
  });

  it("should verify available events", () => {
    const actor = createProposalActor(mockProposal);
    expect(canSendProposalEvent(actor, "SUBMIT")).toBe(true);
    expect(canSendProposalEvent(actor, "QUALIFY")).toBe(false);
  });

  it("should return list of available events", () => {
    const actor = createProposalActor(mockProposal);
    const events = getAvailableProposalEvents(actor);
    expect(events).toContain("SUBMIT");
    expect(events.length).toBeGreaterThan(0);
  });

  it("should auto-progress proposal through pipeline", () => {
    const actor = createProposalActor(mockProposal);

    let nextEvent = progressProposal(actor);
    expect(nextEvent).toBe("SUBMIT");
    expect(getProposalState(actor)).toBe("intake");

    nextEvent = progressProposal(actor);
    expect(nextEvent).toBe("QUALIFY");
    expect(getProposalState(actor)).toBe("qualification");

    nextEvent = progressProposal(actor);
    expect(nextEvent).toBe("ANALYZE");
    expect(getProposalState(actor)).toBe("analysis");
  });

  it("should allow rejection from any deliberation state", () => {
    const actor = createProposalActor(mockProposal);
    sendProposalEvent(actor, { type: "SUBMIT" });
    sendProposalEvent(actor, { type: "QUALIFY" });
    sendProposalEvent(actor, { type: "ANALYZE" });

    const state = rejectProposal(actor);
    expect(state).toBe("rejected");
  });

  it("should track lastTransitionTime on state changes", () => {
    const actor = createProposalActor(mockProposal);
    const initialTime = new Date(getProposalContext(actor).lastTransitionTime);

    sendProposalEvent(actor, { type: "SUBMIT" });
    const newTime = new Date(getProposalContext(actor).lastTransitionTime);

    expect(newTime.getTime()).toBeGreaterThanOrEqual(initialTime.getTime());
  });

  it("should handle state change listeners", () => {
    const actor = createProposalActor(mockProposal);
    const states: string[] = [];

    // Subscribe after actor is started
    const unsubscribe = onProposalStateChange(actor, (state) => {
      states.push(state);
    });

    sendProposalEvent(actor, { type: "SUBMIT" });
    sendProposalEvent(actor, { type: "QUALIFY" });

    unsubscribe();

    // Should capture state changes after subscription
    expect(states.length).toBeGreaterThan(0);
  });

  it("should transition through full approval workflow", () => {
    const actor = createProposalActor(mockProposal);

    const transitions = [
      { event: { type: "SUBMIT" as const }, expectedState: "intake" },
      { event: { type: "QUALIFY" as const }, expectedState: "qualification" },
      { event: { type: "ANALYZE" as const }, expectedState: "analysis" },
      { event: { type: "CRITIQUE" as const }, expectedState: "critique" },
      { event: { type: "SCORE" as const }, expectedState: "scoring" },
      { event: { type: "SEND_TO_COUNCIL" as const }, expectedState: "council" },
      { event: { type: "VOTE" as const }, expectedState: "voting" },
      { event: { type: "APPROVE" as const }, expectedState: "specDraft" },
    ];

    for (const { event, expectedState } of transitions) {
      sendProposalEvent(actor, event);
      expect(getProposalState(actor)).toBe(expectedState);
    }

    const context = getProposalContext(actor);
    expect(context.status).toBe("approved");
  });

  it("should handle execution flow", () => {
    const actor = createProposalActor(mockProposal);

    // Fast-track to execution gate
    sendProposalEvent(actor, { type: "SUBMIT" });
    sendProposalEvent(actor, { type: "QUALIFY" });
    sendProposalEvent(actor, { type: "ANALYZE" });
    sendProposalEvent(actor, { type: "CRITIQUE" });
    sendProposalEvent(actor, { type: "SCORE" });
    sendProposalEvent(actor, { type: "SEND_TO_COUNCIL" });
    sendProposalEvent(actor, { type: "VOTE" });
    sendProposalEvent(actor, { type: "APPROVE" });
    sendProposalEvent(actor, { type: "REQUEST_SPEC" });
    sendProposalEvent(actor, { type: "APPROVE_SPEC" });
    sendProposalEvent(actor, { type: "EXECUTION_GATE_PASS" });

    expect(getProposalState(actor)).toBe("executing");

    sendProposalEvent(actor, { type: "EXECUTION_SUCCESS" });
    expect(getProposalState(actor)).toBe("postmortem");

    const context = getProposalContext(actor);
    expect(context.status).toBe("executed");
  });

  it("should reset retry count on approval", () => {
    const actor = createProposalActor(mockProposal);

    sendProposalEvent(actor, { type: "SUBMIT" });
    sendProposalEvent(actor, { type: "QUALIFY" });
    sendProposalEvent(actor, { type: "ANALYZE" });
    sendProposalEvent(actor, { type: "CRITIQUE" });
    sendProposalEvent(actor, { type: "SCORE" });
    sendProposalEvent(actor, { type: "SEND_TO_COUNCIL" });
    sendProposalEvent(actor, { type: "VOTE" });
    sendProposalEvent(actor, { type: "APPROVE" });

    const context = getProposalContext(actor);
    // After APPROVE event, retryCount should be reset to 0
    expect(context.retryCount).toBe(0);
    expect(context.stage).toBe("spec");
  });

  it("should handle REVIEW_SPEC and EXECUTE events", () => {
    const actor = createProposalActor(mockProposal);

    sendProposalEvent(actor, { type: "SUBMIT" });
    sendProposalEvent(actor, { type: "QUALIFY" });
    sendProposalEvent(actor, { type: "ANALYZE" });
    sendProposalEvent(actor, { type: "CRITIQUE" });
    sendProposalEvent(actor, { type: "SCORE" });
    sendProposalEvent(actor, { type: "SEND_TO_COUNCIL" });
    sendProposalEvent(actor, { type: "VOTE" });
    sendProposalEvent(actor, { type: "APPROVE" });
    sendProposalEvent(actor, { type: "REVIEW_SPEC" });
    sendProposalEvent(actor, { type: "APPROVE_SPEC" });
    sendProposalEvent(actor, { type: "EXECUTE" });

    expect(getProposalState(actor)).toBe("executing");
  });

  it("should handle DISCARD and ERROR events", () => {
    const discardedActor = createProposalActor(mockProposal);
    sendProposalEvent(discardedActor, { type: "DISCARD" });
    expect(getProposalState(discardedActor)).toBe("rejected");

    const erroredActor = createProposalActor(mockProposal);
    sendProposalEvent(erroredActor, { type: "ERROR", message: "Unexpected error" });
    expect(getProposalState(erroredActor)).toBe("executionError");
    expect(getProposalContext(erroredActor).errorMessage).toBe("Unexpected error");
  });
});
