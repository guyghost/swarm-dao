import { beforeEach, describe, expect, it } from "bun:test";
import type { ControlCheckResult, Proposal, TallyResult } from "@guyghost/swarm-dao-core";
import { dispatchProposalEvent, isProposalFinal, PROPOSAL_FINAL_STATUSES } from "@guyghost/swarm-dao-core";

// ── Test fixtures ────────────────────────────────────────────

function makeProposal(status: Proposal["status"] = "open"): Proposal {
  return {
    id: 1,
    title: "Test Proposal",
    type: "product-feature",
    description: "A test proposal",
    proposedBy: "agent-1",
    status,
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
  };
}

function makeTally(approved: boolean): TallyResult {
  return {
    proposalId: 1,
    approved,
    quorumMet: true,
    totalAgents: 5,
    votingAgents: 5,
    quorumPercent: 100,
    weightedFor: approved ? 10 : 2,
    weightedAgainst: approved ? 2 : 10,
    totalVotingWeight: 12,
    approvalScore: approved ? 83 : 17,
    votes: [],
  };
}

function makeControl(passed: boolean, blockers = 0): ControlCheckResult {
  return {
    proposalId: 1,
    timestamp: new Date().toISOString(),
    allGatesPassed: passed,
    blockerCount: blockers,
    warningCount: 0,
    gates: [],
    checklist: [],
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("proposal state machine — invariants", () => {
  it("final statuses are exactly executed, failed, rejected", () => {
    expect(PROPOSAL_FINAL_STATUSES.size).toBe(3);
    expect([...PROPOSAL_FINAL_STATUSES].sort()).toEqual(["executed", "failed", "rejected"]);
  });

  it("isProposalFinal identifies terminal statuses", () => {
    expect(isProposalFinal("executed")).toBe(true);
    expect(isProposalFinal("failed")).toBe(true);
    expect(isProposalFinal("rejected")).toBe(true);
    expect(isProposalFinal("open")).toBe(false);
    expect(isProposalFinal("deliberating")).toBe(false);
    expect(isProposalFinal("approved")).toBe(false);
    expect(isProposalFinal("controlled")).toBe(false);
  });
});

describe("proposal state machine — nominal transitions", () => {
  let proposal: Proposal;

  beforeEach(() => {
    proposal = makeProposal();
  });

  it("walks the full happy path open → executed", () => {
    expect(dispatchProposalEvent(proposal, { type: "DELIBERATE" })).toMatchObject({ ok: true, status: "deliberating" });
    expect(proposal.status).toBe("deliberating");

    expect(dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(true) })).toMatchObject({
      ok: true,
      status: "approved",
    });
    expect(proposal.status).toBe("approved");

    expect(dispatchProposalEvent(proposal, { type: "CONTROL_PASS", result: makeControl(true) })).toMatchObject({
      ok: true,
      status: "controlled",
    });
    expect(proposal.status).toBe("controlled");

    expect(dispatchProposalEvent(proposal, { type: "EXECUTE_SUCCESS" })).toMatchObject({
      ok: true,
      status: "executed",
    });
    expect(proposal.status).toBe("executed");
    expect(proposal.resolvedAt).toBeDefined();
  });

  it("uses the injected clock for transition and resolution timestamps", () => {
    const transitionTimes = [
      "2030-01-01T10:00:00.000Z",
      "2030-01-01T10:01:00.000Z",
      "2030-01-01T10:02:00.000Z",
      "2030-01-01T10:03:00.000Z",
    ];
    let index = 0;
    const clock = { now: () => transitionTimes[index++] };

    expect(dispatchProposalEvent(proposal, { type: "DELIBERATE" }, { clock }).ok).toBe(true);
    expect(dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(true) }, { clock }).ok).toBe(true);
    expect(dispatchProposalEvent(proposal, { type: "CONTROL_PASS", result: makeControl(true) }, { clock }).ok).toBe(
      true,
    );
    expect(dispatchProposalEvent(proposal, { type: "EXECUTE_SUCCESS" }, { clock }).ok).toBe(true);

    expect(proposal.resolvedAt).toBe("2030-01-01T10:03:00.000Z");
  });

  it("rejects from deliberating", () => {
    dispatchProposalEvent(proposal, { type: "DELIBERATE" });
    expect(dispatchProposalEvent(proposal, { type: "REJECT" }).ok).toBe(true);
    expect(proposal.status).toBe("rejected");
    expect(proposal.resolvedAt).toBeDefined();
  });

  it("fails on control failure from approved", () => {
    dispatchProposalEvent(proposal, { type: "DELIBERATE" });
    dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(true) });
    expect(dispatchProposalEvent(proposal, { type: "CONTROL_FAIL" }).ok).toBe(true);
    expect(proposal.status).toBe("failed");
  });

  it("fails on execution failure from controlled", () => {
    proposal.status = "approved";
    dispatchProposalEvent(proposal, { type: "CONTROL_PASS", result: makeControl(true) });
    expect(dispatchProposalEvent(proposal, { type: "FAIL" }).ok).toBe(true);
    expect(proposal.status).toBe("failed");
  });
});

describe("proposal state machine — guards (permissions)", () => {
  let proposal: Proposal;

  beforeEach(() => {
    proposal = makeProposal();
    dispatchProposalEvent(proposal, { type: "DELIBERATE" });
  });

  it("blocks APPROVE when the tally is not approved", () => {
    const result = dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(false) });
    expect(result.ok).toBe(false);
    expect(proposal.status).toBe("deliberating");
  });

  it("blocks CONTROL_PASS when gates did not all pass", () => {
    dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(true) });
    const result = dispatchProposalEvent(proposal, { type: "CONTROL_PASS", result: makeControl(false) });
    expect(result.ok).toBe(false);
    expect(proposal.status).toBe("approved");
  });

  it("blocks CONTROL_PASS when there are blockers", () => {
    dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(true) });
    const result = dispatchProposalEvent(proposal, {
      type: "CONTROL_PASS",
      result: makeControl(true, 1),
    });
    expect(result.ok).toBe(false);
    expect(proposal.status).toBe("approved");
  });
});

describe("proposal state machine — forbidden transitions", () => {
  it("blocks EXECUTE_SUCCESS from open", () => {
    const proposal = makeProposal("open");
    expect(dispatchProposalEvent(proposal, { type: "EXECUTE_SUCCESS" }).ok).toBe(false);
    expect(proposal.status).toBe("open");
  });

  it("blocks DELIBERATE from approved", () => {
    const proposal = makeProposal("approved");
    expect(dispatchProposalEvent(proposal, { type: "DELIBERATE" }).ok).toBe(false);
    expect(proposal.status).toBe("approved");
  });

  it("blocks APPROVE from open (must deliberate first)", () => {
    const proposal = makeProposal("open");
    expect(dispatchProposalEvent(proposal, { type: "APPROVE", tally: makeTally(true) }).ok).toBe(false);
    expect(proposal.status).toBe("open");
  });

  it("blocks CONTROL_PASS from deliberating (must be approved)", () => {
    const proposal = makeProposal("deliberating");
    expect(dispatchProposalEvent(proposal, { type: "CONTROL_PASS", result: makeControl(true) }).ok).toBe(false);
    expect(proposal.status).toBe("deliberating");
  });
});

describe("proposal state machine — global escape hatches", () => {
  it("DISCARD reaches rejected from any non-terminal state", () => {
    for (const status of ["open", "deliberating", "approved", "controlled"] as const) {
      const proposal = makeProposal(status);
      const result = dispatchProposalEvent(proposal, { type: "DISCARD" });
      expect(result.ok).toBe(true);
      expect(proposal.status).toBe("rejected");
    }
  });

  it("ERROR reaches failed from any non-terminal state", () => {
    for (const status of ["open", "deliberating", "approved", "controlled"] as const) {
      const proposal = makeProposal(status);
      const result = dispatchProposalEvent(proposal, { type: "ERROR", message: "boom" });
      expect(result.ok).toBe(true);
      expect(proposal.status).toBe("failed");
    }
  });
});

describe("proposal state machine — terminal states are immutable", () => {
  it("ignores every event once terminal", () => {
    for (const terminal of ["executed", "failed", "rejected"] as const) {
      const proposal = makeProposal(terminal);
      const events: Parameters<typeof dispatchProposalEvent>[1][] = [
        { type: "DELIBERATE" },
        { type: "APPROVE", tally: makeTally(true) },
        { type: "REJECT" },
        { type: "CONTROL_PASS", result: makeControl(true) },
        { type: "CONTROL_FAIL" },
        { type: "EXECUTE_SUCCESS" },
        { type: "FAIL" },
        { type: "DISCARD" },
        { type: "ERROR", message: "late" },
      ];
      for (const event of events) {
        expect(dispatchProposalEvent(proposal, event).ok).toBe(false);
        expect(proposal.status).toBe(terminal);
      }
    }
  });
});
