import { beforeEach, describe, expect, it } from "bun:test";
import {
  canRollback,
  captureSnapshot,
  createExecutionSnapshot,
  createInitialState,
  formatDryRun,
  formatRollback,
  getSnapshot,
  performDryRun,
  performRollback,
  setState,
} from "@guyghost/swarm-dao-core";

describe("delivery/dry-run", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    setState(state);
  });

  it("performs dry-run on proposal", async () => {
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

    const result = await performDryRun(proposal);
    expect(result.proposalId).toBe(1);
    expect(result.filesAffected).toContain("src/feature.ts");
    expect(result.canProceed).toBe(true);
    expect(result.estimatedDuration).toBe("3-7 days");
  });

  it("detects risks in red-zone proposals", async () => {
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

    const result = await performDryRun(proposal);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(result.risks.some((r) => r.includes("Red-zone"))).toBe(true);
  });

  it("formats dry-run result", async () => {
    const result = await performDryRun({
      id: 1,
      title: "Test",
      type: "product-feature",
      description: "",
      proposedBy: "",
      status: "approved",
      votes: [],
      agentOutputs: [],
      createdAt: "",
    });
    const formatted = formatDryRun(result);
    expect(formatted).toContain("Dry-Run");
    expect(formatted).toContain("Can Proceed");
  });

  it("checks rollback availability", async () => {
    expect(canRollback(1)).toBe(false);
    await captureSnapshot(1, {
      proposalId: 1,
      timestamp: "",
      branch: "main",
      commitSha: "abc123",
      filesChanged: [],
      stateSnapshot: "",
    });
    expect(canRollback(1)).toBe(true);
  });

  it("performs rollback", async () => {
    await captureSnapshot(1, {
      proposalId: 1,
      timestamp: "",
      branch: "main",
      commitSha: "abc123def456",
      filesChanged: [],
      stateSnapshot: "",
    });

    const result = await performRollback(1);
    expect(result.success).toBe(true);
    expect(result.message).toContain("abc123de");
  });

  it("fails rollback without snapshot", async () => {
    const result = await performRollback(999);
    expect(result.success).toBe(false);
  });

  it("formats rollback result", () => {
    expect(formatRollback({ success: true, message: "Rolled back" })).toContain("Rollback Successful");
    expect(formatRollback({ success: false, message: "No snapshot" })).toContain("Rollback Failed");
  });

  it("creates execution snapshot", async () => {
    const proposal = {
      id: 2,
      title: "Test Snapshot",
      type: "technical-change" as const,
      description: "Testing createExecutionSnapshot",
      proposedBy: "test",
      status: "approved" as const,
      votes: [],
      agentOutputs: [],
      affectedPaths: ["file1.txt"],
      createdAt: "",
    };

    const snapshot = await createExecutionSnapshot(proposal, process.cwd());
    expect(snapshot.proposalId).toBe(2);
    expect(snapshot.filesChanged).toContain("file1.txt");
    // Since we are in a git repo during tests, these should ideally not be "unknown"
    // but even if they are, the function should return something.
    expect(snapshot.branch).toBeDefined();
    expect(snapshot.commitSha).toBeDefined();

    const storedSnapshot = getSnapshot(2);
    expect(storedSnapshot).toBeDefined();
    expect(storedSnapshot?.proposalId).toBe(2);
  });
});
