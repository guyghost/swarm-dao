import { describe, expect, it } from "bun:test";
import type { DAOState, Proposal } from "@guyghost/swarm-dao-core";
import { createInitialState } from "@guyghost/swarm-dao-core";
import {
  ARCHIVE_VERSION,
  archiveSignature,
  isArchivedStatus,
  mergeArchive,
  parseArchive,
  partitionState,
} from "../src/adapters/persistence/archive.js";

function proposal(id: number, status: Proposal["status"], title = `Proposal #${id}`): Proposal {
  return {
    id,
    title,
    type: "product-feature",
    description: `Description ${id}`,
    problemStatement: "problem",
    acceptanceCriteria: [],
    successMetrics: [],
    rollbackConditions: [],
    proposedBy: "test",
    status,
    votes: [],
    agentOutputs: [],
    createdAt: "2031-01-01T00:00:00.000Z",
  };
}

function stateWith(...proposals: Proposal[]): DAOState {
  const state = createInitialState("/tmp/dao-test");
  state.proposals = proposals;
  return state;
}

describe("archive partition", () => {
  it("classifies open/deliberating as live and everything else as archived", () => {
    expect(isArchivedStatus("open")).toBe(false);
    expect(isArchivedStatus("deliberating")).toBe(false);
    for (const closed of ["approved", "controlled", "rejected", "executed", "failed"] as const) {
      expect(isArchivedStatus(closed)).toBe(true);
    }
  });

  it("partitions proposals and satellite maps without mutating the input state", () => {
    const state = stateWith(proposal(1, "open"), proposal(2, "executed"), proposal(3, "open"), proposal(4, "rejected"));
    state.outcomes[2] = { proposalId: 2, overall: 4, ratedBy: "tester", ratedAt: "2031-01-02T00:00:00.000Z" } as never;
    state.deliveryPlans[2] = { proposalId: 2, phases: [] } as never;
    state.deliveryPlans[1] = { proposalId: 1, phases: [] } as never;
    const before = structuredClone(state);

    const { live, archive } = partitionState(state);

    expect(live.proposals.map((p) => p.id)).toEqual([1, 3]);
    expect(archive.proposals.map((p) => p.id)).toEqual([2, 4]);
    expect(Object.keys(live.outcomes)).toEqual([]);
    expect(Object.keys(live.deliveryPlans)).toEqual(["1"]);
    expect(Object.keys(archive.outcomes)).toEqual(["2"]);
    expect(Object.keys(archive.deliveryPlans)).toEqual(["2"]);
    // Input untouched (partition is a pure view).
    expect(state).toEqual(before);
    expect(state.proposals).toHaveLength(4);
  });

  it("keeps satellite entries with non-numeric keys in the live partition", () => {
    const state = stateWith(proposal(1, "executed"));
    (state.outcomes as Record<string, unknown>)["legacy-key"] = { anything: true };
    const { live, archive } = partitionState(state);
    expect(Object.keys(live.outcomes)).toContain("legacy-key");
    expect(Object.keys(archive.outcomes)).toEqual([]);
  });

  it("merges the archive back: archived ids shadow same-id live proposals", () => {
    const state = stateWith(proposal(1, "open"), proposal(5, "open")); // stale open copy of #5
    const archive = parseArchive(
      JSON.stringify({
        version: ARCHIVE_VERSION,
        proposals: [proposal(5, "executed"), proposal(2, "rejected")],
        controlResults: {},
        deliveryPlans: {},
        artefacts: {},
        outcomes: { 5: { proposalId: 5, overall: 5 } },
        snapshots: {},
        verifications: {},
      }),
    );

    mergeArchive(state, archive);

    expect(state.proposals.map((p) => p.id)).toEqual([1, 2, 5]);
    const five = state.proposals.find((p) => p.id === 5);
    expect(five?.status).toBe("executed"); // archive version wins
    expect(state.outcomes[5]).toBeDefined();
  });

  it("round-trips partition → serialize → parse → merge losslessly", () => {
    const state = stateWith(proposal(1, "open"), proposal(2, "executed"), proposal(3, "failed"));
    state.outcomes[2] = { proposalId: 2, overall: 3, ratedBy: "t", ratedAt: "x" } as never;
    state.snapshots[3] = { proposalId: 3, branch: "b", workspace: "/w" } as never;

    const { live, archive } = partitionState(state);
    const parsed = parseArchive(JSON.stringify(archive));
    mergeArchive(state, parsed);

    expect(state.proposals.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(state.proposals.find((p) => p.id === 2)?.status).toBe("executed");
    expect(state.outcomes[2]).toEqual({ proposalId: 2, overall: 3, ratedBy: "t", ratedAt: "x" });
    expect(state.snapshots[3]).toEqual({ proposalId: 3, branch: "b", workspace: "/w" });
    expect(live.proposals.map((p) => p.id)).toEqual([1]);
  });

  it("rejects corrupt or unsupported archive payloads", () => {
    expect(() => parseArchive("not json")).toThrow(/Corrupt proposal archive/);
    expect(() => parseArchive(JSON.stringify({ version: 99 }))).toThrow(/Unsupported archive version/);
    expect(() => parseArchive(JSON.stringify({ version: ARCHIVE_VERSION, proposals: "nope" }))).toThrow(
      /Corrupt proposal archive/,
    );
  });
});

describe("archive signature", () => {
  it("is stable when nothing changes", () => {
    const state = stateWith(proposal(1, "open"), proposal(2, "executed"));
    expect(archiveSignature(state)).toBe(archiveSignature(state));
  });

  it("changes when a closed proposal transitions between closed statuses", () => {
    const state = stateWith(proposal(2, "controlled"));
    const before = archiveSignature(state);
    state.proposals[0] = { ...state.proposals[0], status: "executed" };
    expect(archiveSignature(state)).not.toBe(before);
  });

  it("changes when a proposal closes or reopens", () => {
    const state = stateWith(proposal(1, "open"), proposal(2, "executed"));
    const closed = archiveSignature(state);
    state.proposals[0] = { ...state.proposals[0], status: "rejected" };
    expect(archiveSignature(state)).not.toBe(closed);
    state.proposals[0] = { ...state.proposals[0], status: "open" };
    expect(archiveSignature(state)).toBe(closed);
  });

  it("changes when a satellite entry appears for an archived proposal", () => {
    const state = stateWith(proposal(2, "executed"));
    const before = archiveSignature(state);
    state.outcomes[2] = { proposalId: 2, overall: 4 } as never;
    expect(archiveSignature(state)).not.toBe(before);
  });

  it("does not change for open-proposal-only mutations", () => {
    const state = stateWith(proposal(1, "open"), proposal(2, "executed"));
    const before = archiveSignature(state);
    state.proposals[0] = { ...state.proposals[0], title: "Retitled open proposal" };
    state.outcomes[1] = { proposalId: 1, overall: 2 } as never;
    expect(archiveSignature(state)).toBe(before);
  });
});
