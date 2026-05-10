import { describe, it, expect, beforeEach } from "bun:test";
import {
  performDryRun,
  formatDryRun,
  canRollback,
  performRollback,
  formatRollback,
  createInitialState,
  setState,
  captureSnapshot,
} from "@guyghost/swarm-dao-core";

describe("delivery/dry-run", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    setState(state);
  });

  it("performs dry-run on proposal", () => {
    const proposal = {
      id: 1,
      title: "Add feature",
      type: "product-feature" as const,
      description: "Add new feature",
      proposedBy: "test",
      status: "approved" as const,
      votes: [],
      agentOutputs: [],
      affectedPaths: ["src/feature.ts", "tests/feature.test.ts"],
      createdAt: "",
    };

    const result = performDryRun(proposal);
    expect(result.proposalId).toBe(1);
    expect(result.filesAffected).toContain("src/feature.ts");
    expect(result.canProceed).toBe(true);
    expect(result.estimatedDuration).toBe("3-7 days");
  });

  it("detects risks in red-zone proposals", () => {
    const proposal = {
      id: 1,
      title: "Auth change",
      type: "security-change" as const,
      description: "Update auth",
      proposedBy: "test",
      status: "approved" as const,
      votes: [],
      agentOutputs: [],
      riskZone: "red" as const,
      createdAt: "",
    };

    const result = performDryRun(proposal);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(result.risks.some((r) => r.includes("Red-zone"))).toBe(true);
  });

  it("formats dry-run result", () => {
    const result = performDryRun({
      id: 1, title: "Test", type: "product-feature", description: "", proposedBy: "", status: "approved", votes: [], agentOutputs: [], createdAt: "",
    });
    const formatted = formatDryRun(result);
    expect(formatted).toContain("Dry-Run");
    expect(formatted).toContain("Can Proceed");
  });

  it("checks rollback availability", () => {
    expect(canRollback(1)).toBe(false);
    captureSnapshot(1, {
      proposalId: 1,
      timestamp: "",
      branch: "main",
      commitSha: "abc123",
      filesChanged: [],
      stateSnapshot: "",
    });
    expect(canRollback(1)).toBe(true);
  });

  it("performs rollback", () => {
    captureSnapshot(1, {
      proposalId: 1,
      timestamp: "",
      branch: "main",
      commitSha: "abc123def456",
      filesChanged: [],
      stateSnapshot: "",
    });

    const result = performRollback(1);
    expect(result.success).toBe(true);
    expect(result.message).toContain("abc123de");
  });

  it("fails rollback without snapshot", () => {
    const result = performRollback(999);
    expect(result.success).toBe(false);
  });

  it("formats rollback result", () => {
    expect(formatRollback({ success: true, message: "Rolled back" })).toContain("Rollback Successful");
    expect(formatRollback({ success: false, message: "No snapshot" })).toContain("Rollback Failed");
  });
});