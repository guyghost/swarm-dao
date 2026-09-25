import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ObservationSample } from "@guyghost/swarm-dao-core";
import { deriveGraphChildRunId } from "../src/child-runs.js";
import {
  advanceDeliveryOnce,
  type DeliveryExecutorPorts,
  type DeliveryGraphRunView,
  type DeliveryProductRunView,
} from "../src/executor.js";
import { createDeliveryRunner, deriveDeliveryEffectKey } from "../src/runner.js";

const roots: string[] = [];
const modelHash = "a".repeat(64);
const artifactHash = "b".repeat(64);
let clockTicks = 0;
const clock = () => new Date(Date.UTC(2026, 8, 25, 12, 0, clockTicks++)).toISOString();

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
        rollbackArtifact: "active.json",
        evidence: "product:scope",
      },
      voteConfig: { quorum: 1, kind: "standard", expiryHours: 72 },
      favorableVotes: 1,
      budget: { initial: 20, consumed: 2, history: [] },
      controls: ["review", "ship", "observation"].includes(state)
        ? { smoke: { name: "smoke", status: "passed", evidence: "control:smoke" } }
        : {},
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
        ...(["review", "ship", "observation"].includes(state)
          ? {
              "qualification-passed": { status: "passed", evidence: "qualification:pass" },
              "frozen-set-intact": { status: "passed", evidence: "frozen:pass" },
              regression: { status: "passed", evidence: "regression:pass" },
              "rollback-path-exists": { status: "passed", evidence: "stage:rollback-path" },
            }
          : {}),
      },
      terminalReason: null,
    },
  } as DeliveryProductRunView["snapshot"],
  acceptedSignals: ["review", "ship", "observation"].includes(state)
    ? [
        {
          sequence: 7,
          eventType: "VERIFY_RUN",
          source: "tool",
          producer: "verifier",
          payload: { control: { name: "smoke", status: "passed", evidence: "control:smoke" } },
          evidence: ["control:smoke"],
        },
        {
          sequence: 8,
          eventType: "VERIFY_EVALUATE",
          source: "system",
          producer: "product-runner",
          payload: {},
          evidence: ["product:verify-evaluate"],
        },
      ]
    : [],
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
  creditsPerGraphAttempt: 2,
  observationWindowMs: 3_000,
  observationIntervalMs: 1_000,
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

const reachProductVerification = async (runId: string) => {
  const runner = await reachGraphReady(runId);
  await runner.submit({
    runId,
    type: "GRAPH_IMPLEMENTATION_STARTED",
    source: "tool",
    producer: "graph-child-adapter",
    occurredAt: clock(),
    payload: {},
    evidence: ["graph:implementing"],
  });
  await runner.submit({
    runId,
    type: "GRAPH_IMPLEMENTATION_SUCCEEDED",
    source: "tool",
    producer: "graph-child-adapter",
    occurredAt: clock(),
    payload: { implementationHash: artifactHash, artifactHash },
    evidence: ["graph:succeeded"],
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
    const type = String((signal as { type?: string }).type);
    options.calls.push(`product:${type}`);
    return {
      value: { accepted: true, state: type === "OBSERVATION_EVALUATE" ? "validated" : "execution" },
      evidence: "product:signal",
    };
  },
  verifyProduct: async () => {
    options.calls.push("verify-product");
    return { value: { state: "ship" }, evidence: "product:verification" };
  },
  verifyRollbackPath: async () => {
    options.calls.push("verify-rollback-path");
    return { value: { restorable: true }, evidence: "stage:rollback-path" };
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
    return {
      value: {
        samples: [
          { metric: "errors", value: 0, threshold: 0, exceeded: false, evidence: "stage:errors" },
          { metric: "latency", value: 10, threshold: 1_000, exceeded: false, evidence: "stage:latency" },
        ],
        windowElapsed: false,
        observedAt: clock(),
      },
      evidence: "stage:sample",
    };
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
    const budgetEffect = await runner.beginEffect({
      name: "charge-product-budget",
      attempt: 0,
      intent: { productRunId: "product-7", graphRunId: "graph-7", attempt: 0, creditsPerGraphAttempt: 2 },
    });
    await runner.completeEffect({
      key: budgetEffect.key,
      result: { value: { accepted: true, state: "execution" } },
      evidence: "product:budget-charge",
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

  it("verifies and records the exact rollback pointer before Product verification", async () => {
    const runner = await reachProductVerification("delivery-rollback-proof");
    const calls: string[] = [];
    const proof = await advanceDeliveryOnce(
      runner,
      fakePorts({ graph: graphView("succeeded"), product: productView("verification"), calls }),
    );

    expect(proof.kind).toBe("advanced");
    expect(calls).toContain("verify-rollback-path");
    expect(calls).not.toContain("verify-product");
    expect(calls.filter((call) => call.startsWith("product:"))).toHaveLength(0);

    const recorded = await advanceDeliveryOnce(
      runner,
      fakePorts({ graph: graphView("succeeded"), product: productView("verification"), calls }),
    );
    expect(recorded.kind).toBe("advanced");
    expect(calls).toContain("product:ANCHOR_RECORDED");
    expect(calls.filter((call) => call.startsWith("product:"))).toHaveLength(1);
    expect(runner.snapshot().state).toBe("productVerification");
    runner.stop();
  });

  it("does not ship from a Product observation missing rollback gate proof", async () => {
    const runner = await reachProductVerification("delivery-missing-ship-proof");
    await runner.submit({
      runId: "delivery-missing-ship-proof",
      type: "PRODUCT_SHIP_READY",
      source: "tool",
      producer: "product-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["test:parent-ship-ready"],
    });
    const product = productView("observation");
    delete product.snapshot.context.anchors["rollback-path-exists"];
    const calls: string[] = [];
    const result = await advanceDeliveryOnce(runner, fakePorts({ graph: graphView("succeeded"), product, calls }));

    expect(result.kind).toBe("waiting-human");
    expect(calls).not.toContain("ship");
    expect(runner.snapshot().state).toBe("shipReady");
    runner.stop();
  });

  it("requires a Product verification decision after accepted controls at the ship gate", async () => {
    const runner = await reachProductVerification("delivery-missing-product-decision");
    await runner.submit({
      runId: "delivery-missing-product-decision",
      type: "PRODUCT_SHIP_READY",
      source: "tool",
      producer: "product-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["test:parent-ship-ready"],
    });
    const calls: string[] = [];
    const product = productView("observation");
    const result = await advanceDeliveryOnce(
      runner,
      fakePorts({
        graph: graphView("succeeded"),
        product: {
          ...product,
          acceptedSignals: product.acceptedSignals.filter((signal) => signal.eventType !== "VERIFY_RUN"),
        },
        calls,
      }),
    );

    expect(result.kind).toBe("waiting-human");
    expect(calls).not.toContain("ship");
    expect(runner.snapshot().state).toBe("shipReady");
    runner.stop();
  });

  it("charges Product budget once before running each Graph implementation attempt", async () => {
    const runner = await reachGraphReady("delivery-budget-before-worker");
    await runner.submit({
      runId: "delivery-budget-before-worker",
      type: "GRAPH_IMPLEMENTATION_STARTED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["graph:implementing"],
    });
    const calls: string[] = [];
    const ports = fakePorts({ graph: graphView("implementing"), calls });

    const charged = await advanceDeliveryOnce(runner, ports);
    expect(charged.kind).toBe("advanced");
    expect(calls).toEqual(["read-product", "read-graph", "product:BUDGET_CHARGE"]);
    expect(runner.getEffect(deriveDeliveryEffectKey(runner.snapshot().runId, "charge-product-budget", 0))?.status).toBe(
      "completed",
    );

    await advanceDeliveryOnce(runner, ports);
    expect(calls.filter((call) => call === "product:BUDGET_CHARGE")).toHaveLength(1);
    expect(calls).toContain("run-implementation");
    runner.stop();
  });

  it("does not run the Graph worker when Product rejects its budget charge", async () => {
    const runner = await reachGraphReady("delivery-budget-rejected");
    await runner.submit({
      runId: "delivery-budget-rejected",
      type: "GRAPH_IMPLEMENTATION_STARTED",
      source: "tool",
      producer: "graph-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["graph:implementing"],
    });
    const calls: string[] = [];
    const ports: DeliveryExecutorPorts = {
      ...fakePorts({ graph: graphView("implementing"), calls }),
      submitProductSignal: async (_runId, signal) => {
        const type = String((signal as { type?: string }).type);
        calls.push(`product:${type}`);
        return { value: { accepted: false, state: "execution" }, evidence: "product:rejected-charge" };
      },
    };

    const result = await advanceDeliveryOnce(runner, ports);
    expect(result.kind).toBe("waiting-human");
    expect(calls).not.toContain("run-implementation");

    const resumed = await advanceDeliveryOnce(runner, ports);
    expect(resumed.kind).toBe("waiting-human");
    expect(calls.filter((call) => call === "product:BUDGET_CHARGE")).toHaveLength(1);
    expect(calls).not.toContain("run-implementation");
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
            sequence: 7,
            eventType: "VERIFY_RUN",
            source: "tool",
            producer: "verifier",
            payload: { control: { name: "smoke", status: "passed", evidence: "control:smoke" } },
            evidence: ["control:smoke"],
          },
          {
            sequence: 8,
            eventType: "VERIFY_EVALUATE",
            source: "system",
            producer: "product-runner",
            payload: {},
            evidence: ["product:verify-evaluate"],
          },
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
    const ports = {
      ...fakePorts({ graph: graphView("succeeded"), product: productView("observation"), calls }),
      hasReversibleStaging: async () => false,
    };
    const result = await advanceDeliveryOnce(runner, ports);
    expect(result.kind).toBe("waiting-capability");
    expect(runner.snapshot().state).toBe("awaitingShipCapability");
    expect(calls).not.toContain("ship");
    runner.stop();
  });

  it("requires three measured Product samples and the elapsed window before parent validation", async () => {
    const runner = await reachProductVerification("delivery-observation-window");
    await runner.submit({
      runId: "delivery-observation-window",
      type: "PRODUCT_SHIP_READY",
      source: "tool",
      producer: "product-child-adapter",
      occurredAt: clock(),
      payload: {},
      evidence: ["product:ship-gate"],
    });
    await runner.submit({
      runId: "delivery-observation-window",
      type: "SHIP_CONFIRMED",
      source: "tool",
      producer: "effect-executor",
      occurredAt: clock(),
      payload: { artifactHash },
      evidence: ["stage:ship"],
    });

    const product = productView("observation");
    const productSamples: ObservationSample[] = [];
    const calls: string[] = [];
    let measurementCount = 0;
    const basePorts = fakePorts({ graph: graphView("succeeded"), product, calls });
    const ports: DeliveryExecutorPorts = {
      ...basePorts,
      readProductRun: async (runId) => ({
        ...product,
        snapshot: {
          ...product.snapshot,
          runId,
          context: { ...product.snapshot.context, runId, observationSamples: productSamples },
        },
      }),
      submitProductSignal: async (_runId, signal) => {
        const row = signal as { type?: string; payload?: Record<string, unknown> };
        const type = String(row.type);
        calls.push(`product:${type}`);
        if (type === "OBSERVATION_SAMPLE" && row.payload && typeof row.payload.sample === "object") {
          productSamples.push(row.payload.sample as ObservationSample);
        }
        return {
          value: { accepted: true, state: type === "OBSERVATION_EVALUATE" ? "validated" : "observation" },
          evidence: `product:${type}:accepted`,
        };
      },
      sampleObservation: async () => {
        measurementCount += 1;
        calls.push("sample-observation");
        return {
          value: {
            samples: [
              {
                metric: "errors",
                value: 0,
                threshold: 0,
                exceeded: false,
                evidence: `stage:errors:${measurementCount}`,
              },
              {
                metric: "latency",
                value: 10,
                threshold: 1_000,
                exceeded: false,
                evidence: `stage:latency:${measurementCount}`,
              },
            ],
            windowElapsed: measurementCount >= 3,
            observedAt: clock(),
          },
          evidence: `stage:measurement:${measurementCount}`,
        };
      },
    };

    for (let advance = 0; advance < 14 && runner.snapshot().state !== "validated"; advance += 1) {
      await advanceDeliveryOnce(runner, ports);
    }

    expect(runner.snapshot().state).toBe("validated");
    expect(measurementCount).toBe(3);
    expect(productSamples).toHaveLength(6);
    expect(calls.filter((call) => call === "product:OBSERVATION_EVALUATE")).toHaveLength(1);
    expect(runner.snapshot().context.observationEvidence).toHaveLength(3);
    runner.stop();
  });
});
