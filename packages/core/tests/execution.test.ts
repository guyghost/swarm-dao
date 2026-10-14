import { beforeEach, describe, expect, it } from "bun:test";
import {
  createInitialState,
  type ExecutionVerification,
  executeProposal,
  formatVerification,
  generateDeliveryPlan,
  InMemoryDaoStateRepository,
  initializeAgents,
  type Proposal,
  validateProposalQuality,
  verifyExecution,
} from "@guyghost/swarm-dao-core";

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 9,
    title: "Execution test",
    type: "product-feature",
    description: "Implement execution test coverage",
    proposedBy: "user",
    status: "controlled",
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
    problemStatement: "Users need reliable execution state transitions and snapshots.",
    acceptanceCriteria: ["State transitions from controlled to executed"],
    successMetrics: ["100% test coverage on executeProposal"],
    ...overrides,
  };
}

describe("delivery/execution.ts", () => {
  let repository: InMemoryDaoStateRepository;

  beforeEach(() => {
    const state = createInitialState("/tmp/dao-execution-test");
    state.initialized = true;
    state.agents = initializeAgents();
    repository = new InMemoryDaoStateRepository(state);
  });

  it("validates proposal quality and formats verification", () => {
    const invalidProposal = makeProposal({
      problemStatement: "Too short",
      acceptanceCriteria: [],
      successMetrics: [],
    });
    const quality = validateProposalQuality(invalidProposal);
    expect(quality.valid).toBe(false);
    expect(quality.missing).toEqual(["problemStatement", "acceptanceCriteria", "successMetrics"]);

    const validQuality = validateProposalQuality(makeProposal());
    expect(validQuality).toEqual({ valid: true, missing: [] });

    const verification: ExecutionVerification = {
      proposalId: 9,
      status: "success",
      timestamp: new Date().toISOString(),
      filesChanged: ["a.ts"],
      missingFiles: [],
      compilationOk: true,
      gitClean: true,
      summary: "ok",
    };
    expect(formatVerification(verification)).toContain("Verification");
  });

  it("executeProposal transitions a controlled proposal to executed and records a snapshot", async () => {
    const proposal = makeProposal({ id: 42, status: "controlled" });
    repository.get().proposals.push(proposal);

    const result = await executeProposal(proposal, repository);

    expect(result.success).toBe(true);
    expect(result.result).toContain("Proposal Executed — #42");
    expect(proposal.status).toBe("executed");
    expect(proposal.executionResult).toContain("Executed with delivery plan:");

    const state = repository.get();
    expect(state.deliveryPlans[42]).toBeDefined();
    expect(state.snapshots[42]).toBeDefined();
    expect(state.snapshots[42]?.proposalId).toBe(42);
    expect(state.snapshots[42]?.branch).toBe(state.deliveryPlans[42]?.branchStrategy);
  });

  it("executeProposal reuses an existing delivery plan when already present", async () => {
    const proposal = makeProposal({ id: 7, status: "controlled" });
    const existingPlan = generateDeliveryPlan(proposal);
    existingPlan.branchStrategy = "feat/custom-branch-7";
    repository.get().deliveryPlans[7] = existingPlan;

    const result = await executeProposal(proposal, repository);

    expect(result.success).toBe(true);
    expect(result.result).toContain("feat/custom-branch-7");
    expect(proposal.executionResult).toBe("Executed with delivery plan: feat/custom-branch-7");
    expect(repository.get().snapshots[7]?.branch).toBe("feat/custom-branch-7");
  });

  it("executeProposal rejects proposals that are not in controlled status", async () => {
    const proposal = makeProposal({ id: 15, status: "approved" });

    const result = await executeProposal(proposal, repository);

    expect(result.success).toBe(false);
    expect(result.result).toBe('Cannot execute proposal from status "approved"');
    expect(proposal.status).toBe("approved");
    expect(repository.get().snapshots[15]).toBeUndefined();
  });

  it("verifyExecution records success, partial, and failed statuses", async () => {
    const proposal = makeProposal({ id: 11, status: "executed" });

    const okVerification = await verifyExecution(
      proposal,
      {
        filesChanged: ["src/a.ts", "tests/a.test.ts"],
        expectedFiles: ["src/a.ts", "tests/a.test.ts"],
        testsPassed: 4,
        testsFailed: 0,
        compilationOk: true,
        gitClean: true,
      },
      repository,
    );
    expect(okVerification.status).toBe("success");
    expect(repository.get().verifications[11]?.status).toBe("success");

    const failedTestsVerification = await verifyExecution(
      proposal,
      {
        filesChanged: ["src/a.ts"],
        testsPassed: 3,
        testsFailed: 1,
        compilationOk: true,
      },
      repository,
    );
    expect(failedTestsVerification.status).toBe("partial");

    const failedCompileVerification = await verifyExecution(
      proposal,
      {
        filesChanged: ["src/a.ts"],
        compilationOk: false,
      },
      repository,
    );
    expect(failedCompileVerification.status).toBe("failed");
  });
});
