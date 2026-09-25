import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deriveGraphChildRunId } from "../src/child-runs.js";
import {
  advanceDeliveryOnce,
  type DeliveryExecutorPorts,
  type DeliveryGraphRunView,
  type DeliveryProductRunView,
} from "../src/executor.js";
import { createDeliveryRunner } from "../src/runner.js";

const roots: string[] = [];
const modelHash = "a".repeat(64);
const artifactHash = "b".repeat(64);
const clock = () => "2026-09-25T12:00:00.000Z";

const productView = (state = "execution", runId = "product-7"): DeliveryProductRunView => ({
  snapshot: {
    runId,
    state,
    status: "active",
    context: {
      runId,
      proposalId: "proposal-7",
      improvementCycleId: null,
      draft: {
        scope: "optimize-query-cache",
        category: "performance",
        touchesSensitive: false,
        dependencies: [],
        budgetAllocation: 20,
        rollbackArtifact: "rollback.json",
        evidence: "product:scope",
      },
      voteConfig: { quorum: 1, kind: "standard", expiryHours: 72 },
      favorableVotes: 1,
      budget: { initial: 20, consumed: 2, history: [] },
      controls: {},
      observationSamples: [],
      contactVoteOpen: false,
      contactVoteQuorumReached: false,
      contactRelayAuthorized: false,
      reviewReason: state === "review" ? "sensitive-deploy" : null,
      permissionsCleared: true,
      permissionEvidence: "product:permission-clear",
      signalLog: [],
      anchors: {
        "vote-quorum": { status: "passed", evidence: "vote:4" },
        "budget-envelope": { status: "passed", evidence: "budget:1" },
      },
      terminalReason: null,
    },
  } as DeliveryProductRunView["snapshot"],
  acceptedSignals: [],
});

const graphView = (state: string, overrides: Record<string, unknown> = {}): DeliveryGraphRunView => ({
  snapshot: {
    runId: "graph-7",
    state,
    status: "active",
    context: {
      runId: "graph-7",
      modelHash,
      approvedModelHash: modelHash,
      implementationHash: state === "succeeded" ? artifactHash : null,
      anchors:
        state === "succeeded"
          ? {
              "model-contract": { status: "passed", evidence: "contract:pass", attempt: 0 },
              "graph-tests": { status: "passed", evidence: "tests:pass", attempt: 0 },
              "architecture-contract": { status: "passed", evidence: "architecture:pass", attempt: 0 },
              "repository-ci": { status: "passed", evidence: "ci:pass", attempt: 0 },
              "runtime-scenario": { status: "passed", evidence: "runtime:pass", attempt: 0 },
              regression: { status: "passed", evidence: "regression:pass", attempt: 0 },
            }
          : { "model-contract": { status: "passed", evidence: "contract:pass", attempt: 0 } },
      attempt: 0,
      maxRetries: 2,
      terminalReason: null,
    },
    ...overrides,
  } as DeliveryGraphRunView["snapshot"],
  acceptedSignals: [
    {
      sequence: 3,
      eventType: "MODEL_APPROVED",
      source: "human",
      producer: "human-owner",
      payload: { modelHash },
      evidence: ["graph:approval"],
    },
  ],
});

const validMachineInput = {
  productRunId: "product-7",
  proposalId: "proposal-7",
  scope: "optimize-query-cache",
  scopeHash: createHash("sha256").update("optimize-query-cache").digest("hex"),
  riskClass: "standard" as const,
};

const makeRunner = async (runId: string, riskClass: "standard" | "sensitive" = "standard") => {
  const evidenceRoot = await mkdtemp(resolve(tmpdir(), "swarm-delivery-executor-"));
  roots.push(evidenceRoot);
  return createDeliveryRunner({
    evidenceRoot,
    runId,
    machineInput: { ...validMachineInput, graphRunId: deriveGraphChildRunId(runId), riskClass },
    clock,
  });
};

const reachGraphReady = async (runId: string, riskClass: "standard" | "sensitive" = "standard") => {
  const runner = await makeRunner(runId, riskClass);
  await runner.submit({
    runId,
    type: "INTAKE_ACCEPTED",
    source: "tool",
    producer: "intake-validator",
    occurredAt: clock(),
    payload: {},
    evidence: ["product:execution"],
  });
  await runner.submit({
    runId,
    type: "GRAPH_MODEL_DRAFTED",
    source: "ai",
    producer: "modeler",
    occurredAt: clock(),
    payload: { modelArtifactHash: modelHash },
    evidence: ["modeler:model"],
  });
  await runner.submit({
    runId,
    type: "MODEL_CONTRACT_VALID",
    source: "tool",
    producer: "model-contract-validator",
    occurredAt: clock(),
    payload: { modelHash },
    evidence: ["contract:pass"],
  });
  await runner.submit({
    runId,
    type: "GRAPH_APPROVAL_CONFIRMED",
    source: "tool",
    producer: "graph-child-adapter",
    occurredAt: clock(),
    payload: { modelHash },
    evidence: ["graph:ready"],
  });
  return runner;
};

const reachAwaitingGraphApproval = async (runId: string) => {
  const evidenceRoot = await mkdtemp(resolve(tmpdir(), "swarm-delivery-awaiting-approval-"));
  roots.push(evidenceRoot);
  const waiting = await createDeliveryRunner({
    evidenceRoot,
    runId,
    machineInput: { ...validMachineInput, graphRunId: deriveGraphChildRunId(runId) },
    clock,
  });
  await waiting.submit({
    runId,
    type: "INTAKE_ACCEPTED",
    source: "tool",
    producer: "intake-validator",
    occurredAt: clock(),
    payload: {},
    evidence: ["product:execution"],
  });
  await waiting.submit({
    runId,
    type: "GRAPH_MODEL_DRAFTED",
    source: "ai",
    producer: "modeler",
    occurredAt: clock(),
    payload: { modelArtifactHash: modelHash },
    evidence: ["modeler:model"],
  });
  await waiting.submit({
    runId,
    type: "MODEL_CONTRACT_VALID",
    source: "tool",
    producer: "model-contract-validator",
    occurredAt: clock(),
    payload: { modelHash },
    evidence: ["contract:pass"],
  });
  void evidenceRoot;
  return waiting;
};

const fakePorts = (options: {
  product?: DeliveryProductRunView;
  graph: DeliveryGraphRunView | null;
  afterStart?: DeliveryGraphRunView;
  afterVerify?: DeliveryGraphRunView;
  calls: string[];
}): DeliveryExecutorPorts => ({
  readProductRun: async (runId) => {
    options.calls.push("read-product");
    const view = options.product ?? productView();
    return { ...view, snapshot: { ...view.snapshot, runId } };
  },
  readGraphRun: async (runId) => {
    options.calls.push("read-graph");
    if (!options.graph) return null;
    return {
      ...options.graph,
      snapshot: {
        ...options.graph.snapshot,
        runId,
        context: { ...options.graph.snapshot.context, runId },
      },
    };
  },
  createGraphRun: async (runId) => {
    options.calls.push("create-graph");
    return { evidence: `graph:${runId}:created` };
  },
  draftGraphModel: async () => {
    options.calls.push("draft-model");
    return { value: { modelArtifactHash: modelHash }, evidence: "modeler:model" };
  },
  validateGraphModel: async () => {
    options.calls.push("validate-model");
    return { value: { valid: true, modelHash }, evidence: "contract:pass" };
  },
  startGraphImplementation: async () => {
    options.calls.push("start-implementation");
    if (options.afterStart) options.graph = options.afterStart;
    return { evidence: "graph:implementing" };
  },
  runGraphImplementation: async () => {
    options.calls.push("run-implementation");
    return { value: { state: "verifying" }, evidence: "graph:implementation-turn" };
  },
  verifyGraphAnchors: async () => {
    options.calls.push("verify-graph-anchors");
    if (options.afterVerify) options.graph = options.afterVerify;
    return { evidence: "graph:anchors" };
  },
  submitProductSignal: async (_runId, signal) => {
    options.calls.push(`product:${String((signal as { type?: string }).type)}`);
    return { value: { accepted: true }, evidence: "product:signal" };
  },
  verifyProduct: async () => {
    options.calls.push("verify-product");
    return { value: { state: "ship" }, evidence: "product:verification" };
  },
  ship: async () => {
    options.calls.push("ship");
    return { value: { artifactHash }, evidence: "stage:ship" };
  },
  rollback: async () => {
    options.calls.push("rollback");
    return { evidence: "stage:rollback" };
  },
  sampleObservation: async () => {
    options.calls.push("sample-observation");
    return { value: { healthy: true, windowElapsed: false }, evidence: "stage:sample" };
  },
  cancelChildren: async () => {
    options.calls.push("cancel-children");
    return { evidence: "children:cancelled" };
  },
  hasReversibleStaging: async () => true,
  reconcileEffect: async () => ({ status: "not-started" }),
  stageRoot: "/tmp/delivery-stage",
  clock,
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("one-effect delivery executor", () => {
  it("starts Graph implementation only after observing Graph ready and exact approval", async () => {
    const runner = await reachGraphReady("delivery-start-order");
    const calls: string[] = [];
    const ports = fakePorts({
      graph: graphView("ready"),
      afterStart: graphView("implementing"),
      calls,
    });

    const result = await advanceDeliveryOnce(runner, ports);

    expect(calls).toEqual(["read-product", "read-graph", "start-implementation"]);
    expect(result.kind).toBe("advanced");
    expect(runner.snapshot().state).toBe("implementing");
    runner.stop();
  });

  it("never starts the worker from a Graph snapshot whose approval hash differs", async () => {
    const runner = await reachAwaitingGraphApproval("delivery-wrong-approval");
    const calls: string[] = [];
    const wrongApproval = graphView("ready", {
      context: { ...graphView("ready").snapshot.context, approvedModelHash: "c".repeat(64) },
    });
    const result = await advanceDeliveryOnce(runner, fakePorts({ graph: wrongApproval, calls }));

    expect(result.kind).toBe("waiting-human");
    expect(calls).not.toContain("start-implementation");
    expect(runner.snapshot().state).toBe("awaitingGraphApproval");
    runner.stop();
  });

  it("does not repeat an effect with an ambiguous outcome after restart", async () => {
    const runner = await reachGraphReady("delivery-effect-ambiguous");
    const calls: string[] = [];
    let startCount = 0;
    const ports: DeliveryExecutorPorts = {
      ...fakePorts({ graph: graphView("ready"), calls }),
      startGraphImplementation: async () => {
        startCount += 1;
        calls.push("start-implementation");
        throw new Error("simulated process interruption after dispatch");
      },
      reconcileEffect: async () => {
        calls.push("reconcile-effect");
        return { status: "ambiguous" };
      },
    };

    await expect(advanceDeliveryOnce(runner, ports)).rejects.toThrow(/simulated process interruption/);
    const resumed = await advanceDeliveryOnce(runner, ports);

    expect(resumed.kind).toBe("waiting-human");
    expect(startCount).toBe(1);
    expect(calls).toEqual([
      "read-product",
      "read-graph",
      "start-implementation",
      "read-product",
      "read-graph",
      "reconcile-effect",
    ]);
    runner.stop();
  });

  it("does not send Product EXECUTION_DONE until Graph reports succeeded", async () => {
    const runner = await reachGraphReady("delivery-graph-success-gate");
    await runner.submit({
      runId: "delivery-graph-success-gate",
      type: "GRAPH_IMPLEMENTATION_STARTED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["graph:implementing"],
    });
    const workerEffect = await runner.beginEffect({
      name: "run-graph-implementation",
      attempt: 0,
      intent: { graphRunId: "graph-7", modelHash },
    });
    await runner.completeEffect({
      key: workerEffect.key,
      result: { value: { state: "verifying" } },
      evidence: "graph:worker-complete",
    });
    const calls: string[] = [];
    const result = await advanceDeliveryOnce(runner, fakePorts({ graph: graphView("verifying"), calls }));

    expect(result.kind).toBe("waiting-observation");
    expect(calls).not.toContain("product:EXECUTION_DONE");
    expect(runner.snapshot().state).toBe("implementing");
    runner.stop();
  });

  it("pauses on Product review and reports authoritative child failures", async () => {
    const reviewRunner = await reachGraphReady("delivery-product-review", "sensitive");
    await reviewRunner.submit({
      runId: "delivery-product-review",
      type: "GRAPH_IMPLEMENTATION_STARTED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["graph:implementing"],
    });
    await reviewRunner.submit({
      runId: "delivery-product-review",
      type: "GRAPH_IMPLEMENTATION_SUCCEEDED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: { implementationHash: artifactHash, artifactHash },
      evidence: ["graph:succeeded"],
    });
    const reviewCalls: string[] = [];
    const review = await advanceDeliveryOnce(
      reviewRunner,
      fakePorts({ graph: graphView("succeeded"), product: productView("review"), calls: reviewCalls }),
    );
    expect(review.kind).toBe("waiting-human");
    expect(reviewRunner.snapshot().state).toBe("awaitingShipReview");
    expect(reviewCalls).not.toContain("ship");
    reviewRunner.stop();

    const failedRunner = await reachGraphReady("delivery-child-failed");
    const failedCalls: string[] = [];
    const failed = await advanceDeliveryOnce(
      failedRunner,
      fakePorts({ graph: graphView("failed"), calls: failedCalls }),
    );
    expect(failed.kind).toBe("terminal");
    expect(failedRunner.snapshot().state).toBe("failed");
    failedRunner.stop();
  });

  it("continues sensitive shipping only after Product journals human deploy authorization", async () => {
    const runner = await reachGraphReady("delivery-sensitive-authorization", "sensitive");
    await runner.submit({
      runId: "delivery-sensitive-authorization",
      type: "GRAPH_IMPLEMENTATION_STARTED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["graph:implementing"],
    });
    await runner.submit({
      runId: "delivery-sensitive-authorization",
      type: "GRAPH_IMPLEMENTATION_SUCCEEDED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: { implementationHash: artifactHash, artifactHash },
      evidence: ["graph:succeeded"],
    });
    const calls: string[] = [];
    const ports = fakePorts({ graph: graphView("succeeded"), product: productView("review"), calls });
    const review = await advanceDeliveryOnce(runner, ports);
    expect(review.kind).toBe("waiting-human");
    expect(runner.snapshot().state).toBe("awaitingShipReview");

    const authorizedProduct = productView("observation");
    const output = await advanceDeliveryOnce(runner, {
      ...ports,
      readProductRun: async () => ({
        ...authorizedProduct,
        acceptedSignals: [
          {
            sequence: 12,
            eventType: "REVIEW_RESOLVED",
            source: "human",
            producer: "human-owner",
            payload: { resolution: "deploy-authorized" },
            evidence: ["product:human-deploy-authorization"],
          },
        ],
      }),
    });

    expect(output.kind).toBe("advanced");
    expect(runner.snapshot().state).toBe("shipReady");
    runner.stop();
  });

  it("settles human cancellation before any further delivery effect", async () => {
    const runner = await makeRunner("delivery-cancel-gate");
    await runner.submit({
      runId: "delivery-cancel-gate",
      type: "INTAKE_ACCEPTED",
      source: "tool",
      producer: "intake-validator",
      occurredAt: clock(),
      payload: {},
      evidence: ["product:execution"],
    });
    await runner.submit({
      runId: "delivery-cancel-gate",
      type: "CANCEL_REQUESTED",
      source: "human",
      producer: "human-owner",
      occurredAt: clock(),
      payload: {},
      evidence: ["owner:cancel"],
    });
    const calls: string[] = [];
    const result = await advanceDeliveryOnce(runner, fakePorts({ graph: null, calls }));
    expect(result.kind).toBe("terminal");
    expect(calls).toEqual(["cancel-children"]);
    expect(runner.snapshot().state).toBe("cancelled");
    runner.stop();
  });

  it("pauses at ship capability when no reversible staging target exists", async () => {
    const runner = await reachGraphReady("delivery-stage-capability");
    await runner.submit({
      runId: "delivery-stage-capability",
      type: "GRAPH_IMPLEMENTATION_STARTED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["graph:implementing"],
    });
    await runner.submit({
      runId: "delivery-stage-capability",
      type: "GRAPH_IMPLEMENTATION_SUCCEEDED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: { implementationHash: artifactHash, artifactHash },
      evidence: ["graph:succeeded"],
    });
    await runner.submit({
      runId: "delivery-stage-capability",
      type: "PRODUCT_SHIP_READY",
      source: "tool",
      producer: "product-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["product:ship"],
    });
    const calls: string[] = [];
    const ports = { ...fakePorts({ graph: graphView("succeeded"), calls }), hasReversibleStaging: async () => false };
    const result = await advanceDeliveryOnce(runner, ports);
    expect(result.kind).toBe("waiting-capability");
    expect(runner.snapshot().state).toBe("awaitingShipCapability");
    expect(calls).not.toContain("ship");
    runner.stop();
  });
});
