import { beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import {
  addVote,
  createInitialState,
  createProposal,
  getAuditLog,
  getDaoRoot,
  getProposal,
  getState,
  initStorage,
  listProposals,
  loadState,
  padId,
  recordAudit,
  setState,
  updateProposalStatus,
} from "@guyghost/swarm-dao-core";

describe("persistence", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    setState(state);
  });

  it("creates and retrieves proposals", () => {
    const p1 = createProposal("Feature A", "product-feature", "Add A", "user");
    expect(p1.id).toBe(1);

    const p2 = createProposal("Feature B", "product-feature", "Add B", "user");
    expect(p2.id).toBe(2);

    expect(getProposal(1)?.title).toBe("Feature A");
    expect(listProposals().length).toBe(2);
  });

  it("adds votes", () => {
    const p = createProposal("Vote test", "product-feature", "Test", "user");
    addVote(p.id, { agentId: "a", agentName: "A", position: "for", reasoning: "Yes", weight: 3 });
    expect(getProposal(p.id)?.votes.length).toBe(1);
  });

  it("updates proposal status", () => {
    const p = createProposal("Status test", "product-feature", "Test", "user");
    updateProposalStatus(p.id, "executed");
    expect(getProposal(p.id)?.status).toBe("executed");
    expect(getProposal(p.id)?.resolvedAt).toBeDefined();
  });

  it("records audit entries", () => {
    const p = createProposal("Audit test", "product-feature", "Test", "user");
    recordAudit(p.id, "governance", "test_action", "user", "details");
    const entries = getAuditLog(p.id);
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe("test_action");
  });

  it("pads IDs correctly", () => {
    expect(padId(1)).toBe("001");
    expect(padId(42)).toBe("042");
    expect(padId(999)).toBe("999");
  });

  it("returns dao root path", () => {
    expect(getDaoRoot("/project")).toBe("/project/.dao");
  });

  it("loadState repairs corrupted state.json missing proposals, agents, and auditLog", async () => {
    const cwd = `/tmp/dao-corruption-test-${Date.now()}`;

    try {
      // Create .dao/ directory
      await initStorage(cwd);

      // Write a malformed state.json missing proposals, agents, auditLog
      const corruptedState = {
        config: { quorumPercent: 60 },
        nextProposalId: 1,
        initialized: true,
        nextAuditId: 1,
        controlResults: {},
        deliveryPlans: {},
        artefacts: {},
        outcomes: {},
        snapshots: {},
        verifications: {},
        daoRoot: getDaoRoot(cwd),
      };
      const statePath = `${getDaoRoot(cwd)}/state.json`;
      await fs.writeFile(statePath, JSON.stringify(corruptedState), "utf-8");

      // Load the corrupted state
      const loaded = await loadState(cwd);
      expect(loaded).not.toBeNull();

      // Assert repaired arrays
      expect(getState().proposals).toEqual([]);
      expect(getState().agents).toEqual([]);
      expect(getState().auditLog).toEqual([]);
    } finally {
      // Clean up temp directory and reset state
      setState(null);
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  });
});
