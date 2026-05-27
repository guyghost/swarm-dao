import { beforeEach, describe, expect, it } from "bun:test";
import { createInitialState, executeAmendment, getState, previewAmendment, setState } from "@guyghost/swarm-dao-core";
import type { DAOAgent, ProposalType } from "../src/types/index.js";

describe("governance/amendments code health", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test-health");
    state.initialized = true;
    state.agents = [
      {
        id: "strategist",
        name: "Strategist",
        role: "vision",
        description: "Visionary",
        weight: 3,
        systemPrompt: "Prompt",
        enabled: true,
      } as DAOAgent,
    ];
    setState(state);
  });

  describe("quorum-update", () => {
    it("updates quorum settings correctly", () => {
      const type: ProposalType = "product-feature";
      const changes = { quorumPercent: 88 };

      const payload = {
        type: "quorum-update" as const,
        typeQuorum: {
          [type]: changes,
        },
      };

      const before = getState().config.typeQuorum[type];
      expect(before).toBeDefined();
      const originalDescription = before?.description;
      const originalApprovalPercent = before?.approvalPercent;

      const result = executeAmendment(payload);
      expect(result.success).toBe(true);

      const after = getState().config.typeQuorum[type];
      expect(after?.quorumPercent).toBe(88);
      expect(after?.approvalPercent).toBe(originalApprovalPercent);
      expect(after?.description).toBe(originalDescription);
    });

    it("handles new quorum type by falling back to defaults if possible", () => {
      const state = getState();
      const type: ProposalType = "security-change";
      delete state.config.typeQuorum[type];
      setState(state);

      const changes = { quorumPercent: 99 };
      const payload = {
        type: "quorum-update" as const,
        typeQuorum: {
          [type]: changes,
        },
      };

      const result = executeAmendment(payload);
      expect(result.success).toBe(true);

      const after = getState().config.typeQuorum[type];
      expect(after).toBeDefined();
      expect(after?.quorumPercent).toBe(99);
    });
  });

  describe("previews", () => {
    it("previews agent-update correctly", () => {
      const payload = {
        type: "agent-update" as const,
        agentId: "strategist",
        changes: { weight: 5, role: "new role" },
      };

      const diffs = previewAmendment(payload);
      expect(diffs).toContainEqual({ field: "strategist.weight", before: "3", after: "5" });
      expect(diffs).toContainEqual({ field: "strategist.role", before: "vision", after: "new role" });
    });

    it("previews config-update correctly", () => {
      const payload = {
        type: "config-update" as const,
        changes: { quorumPercent: 75 },
      };

      const diffs = previewAmendment(payload);
      expect(diffs).toContainEqual({ field: "config.quorumPercent", before: "60", after: "75" });
    });
  });
});
