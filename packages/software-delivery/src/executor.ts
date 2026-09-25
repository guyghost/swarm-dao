import type { PersistedGraphSnapshot } from "@guyghost/swarm-dao-graph";
import type { PersistedProductSnapshot } from "@guyghost/swarm-dao-product";
import {
  type AcceptedChildSignal,
  deriveGraphChildRunId,
  inspectGraphChild,
  inspectProductChild,
} from "./child-runs.js";
import { type DeliveryRunner, deriveDeliveryEffectKey, type PersistedDeliveryEffect } from "./runner.js";

export type DeliveryProductRunView = Readonly<{
  snapshot: PersistedProductSnapshot;
  acceptedSignals: readonly AcceptedChildSignal[];
}>;

export type DeliveryGraphRunView = Readonly<{
  snapshot: PersistedGraphSnapshot;
  acceptedSignals: readonly AcceptedChildSignal[];
}>;

export type DeliveryEffectOutput<T = unknown> = Readonly<{
  evidence: string;
  value?: T;
}>;

export type DeliveryReconciliation =
  | Readonly<{ status: "completed"; result: unknown; evidence: string }>
  | Readonly<{ status: "not-started" | "ambiguous" }>;

export type DeliveryExecutorPorts = Readonly<{
  readProductRun: (runId: string) => Promise<DeliveryProductRunView | null>;
  readGraphRun: (runId: string) => Promise<DeliveryGraphRunView | null>;
  createGraphRun: (runId: string, effectId: string) => Promise<DeliveryEffectOutput>;
  draftGraphModel: (input: {
    runId: string;
    scope: string;
    scopeHash: string;
    riskClass: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput<{ modelArtifactHash: string }>>;
  validateGraphModel: (input: {
    runId: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput<{ valid: boolean; modelHash: string }>>;
  startGraphImplementation: (input: {
    runId: string;
    modelHash: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput>;
  runGraphImplementation: (input: {
    runId: string;
    modelHash: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput<{ state?: string }>>;
  verifyGraphAnchors: (input: { runId: string; effectId: string }) => Promise<DeliveryEffectOutput>;
  submitProductSignal: (runId: string, signal: unknown) => Promise<DeliveryEffectOutput<{ accepted?: boolean }>>;
  verifyProduct: (input: {
    runId: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput<{ state: "ship" | "review" | "blocked" }>>;
  hasReversibleStaging: () => Promise<boolean>;
  ship: (input: {
    runId: string;
    implementationHash: string;
    artifactHash: string;
    rollbackArtifact: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput<{ artifactHash: string }>>;
  rollback: (input: {
    runId: string;
    artifactHash: string;
    rollbackArtifact: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput>;
  sampleObservation: (input: {
    runId: string;
    artifactHash: string;
    sampleIndex: number;
    effectId: string;
  }) => Promise<DeliveryEffectOutput<{ healthy: boolean; windowElapsed: boolean }>>;
  cancelChildren: (input: {
    productRunId: string;
    graphRunId: string;
    effectId: string;
  }) => Promise<DeliveryEffectOutput>;
  reconcileEffect: (effect: PersistedDeliveryEffect) => Promise<DeliveryReconciliation>;
  stageRoot?: string;
  clock: () => string;
}>;

export type DeliveryAdvanceResult =
  | Readonly<{ kind: "advanced"; state: string; evidence?: string }>
  | Readonly<{ kind: "waiting-human"; state: string; reason: string }>
  | Readonly<{ kind: "waiting-capability"; state: string; reason: string }>
  | Readonly<{ kind: "waiting-observation"; state: string; reason: string }>
  | Readonly<{ kind: "terminal"; state: string; outcome: string | null }>;

type EffectOutput = Readonly<{ evidence: string; value?: unknown }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const advanceResult = (runner: DeliveryRunner, evidence?: string): DeliveryAdvanceResult => ({
  kind: "advanced",
  state: runner.snapshot().state,
  ...(evidence ? { evidence } : {}),
});

const submitParent = async (
  runner: DeliveryRunner,
  ports: DeliveryExecutorPorts,
  type: string,
  producer: string,
  evidence: string,
  payload: Readonly<Record<string, unknown>> = {},
  source: "ai" | "tool" = "tool",
): Promise<DeliveryAdvanceResult> => {
  const result = await runner.submit({
    runId: runner.snapshot().runId,
    type,
    source,
    producer,
    occurredAt: ports.clock(),
    payload,
    evidence: [evidence],
  });
  if (!result.accepted) throw new Error(`delivery parent rejected ${type}: ${result.issues.join("; ")}`);
  return advanceResult(runner, evidence);
};

const outputFromEffect = (effect: PersistedDeliveryEffect): EffectOutput => {
  if (effect.status !== "completed" || !effect.evidence) throw new Error(`effect ${effect.key} is not completed`);
  const result = isRecord(effect.result) ? effect.result : {};
  return { evidence: effect.evidence, ...(Object.hasOwn(result, "value") ? { value: result.value } : {}) };
};

const decodeOutput = (result: unknown, fallbackEvidence: string): EffectOutput => {
  if (!isRecord(result)) return { evidence: fallbackEvidence, value: result };
  const evidence = typeof result.evidence === "string" && result.evidence.trim() ? result.evidence : fallbackEvidence;
  return { evidence, ...(Object.hasOwn(result, "value") ? { value: result.value } : {}) };
};

/** Journal an effect before invoking its adapter and reconcile pending effects after restart. */
const runEffect = async <T>(
  runner: DeliveryRunner,
  ports: DeliveryExecutorPorts,
  name: string,
  attempt: number,
  intent: unknown,
  action: (effectId: string) => Promise<DeliveryEffectOutput<T>>,
): Promise<DeliveryEffectOutput<T> | DeliveryAdvanceResult> => {
  const previous = runner.getEffect(deriveDeliveryEffectKey(runner.snapshot().runId, name, attempt));
  const effect = await runner.beginEffect({ name, attempt, intent });
  if (effect.status === "completed") return outputFromEffect(effect) as DeliveryEffectOutput<T>;

  let reconciled: DeliveryReconciliation = { status: "not-started" };
  if (previous?.status === "pending") reconciled = await ports.reconcileEffect(effect);
  if (reconciled.status === "ambiguous") {
    return { kind: "waiting-human", state: runner.snapshot().state, reason: `effect ${name} has an ambiguous outcome` };
  }
  if (reconciled.status === "completed") {
    const reconciledOutput = decodeOutput(reconciled.result, reconciled.evidence);
    const completed = await runner.completeEffect({
      key: effect.key,
      result: { ...(Object.hasOwn(reconciledOutput, "value") ? { value: reconciledOutput.value } : {}) },
      evidence: reconciledOutput.evidence,
    });
    return outputFromEffect(completed) as DeliveryEffectOutput<T>;
  }

  const produced = await action(effect.key);
  if (!produced || typeof produced.evidence !== "string" || !produced.evidence.trim()) {
    throw new Error(`effect ${name} returned no evidence`);
  }
  const completed = await runner.completeEffect({
    key: effect.key,
    result: { ...(Object.hasOwn(produced, "value") ? { value: produced.value } : {}) },
    evidence: produced.evidence,
  });
  return outputFromEffect(completed) as DeliveryEffectOutput<T>;
};

const isAdvanceResult = (value: unknown): value is DeliveryAdvanceResult =>
  isRecord(value) &&
  typeof value.kind === "string" &&
  ["advanced", "waiting-human", "waiting-capability", "waiting-observation", "terminal"].includes(value.kind);

const finishEffect = async <T>(
  action: Promise<DeliveryEffectOutput<T> | DeliveryAdvanceResult>,
  continuation: (output: DeliveryEffectOutput<T>) => Promise<DeliveryAdvanceResult>,
): Promise<DeliveryAdvanceResult> => {
  const output = await action;
  return isAdvanceResult(output) ? output : continuation(output);
};

const childSignal = async (
  runner: DeliveryRunner,
  ports: DeliveryExecutorPorts,
  type: string,
  producer: string,
  evidence: string,
  payload: Readonly<Record<string, unknown>> = {},
): Promise<DeliveryAdvanceResult> => {
  const result = await submitParent(runner, ports, type, producer, evidence, payload);
  const state = runner.snapshot().state;
  if (["validated", "rolledBack", "failed", "blocked", "cancelled", "rejected"].includes(state)) {
    return { kind: "terminal", state, outcome: runner.snapshot().context.outcome };
  }
  if (["awaitingRiskReview", "awaitingGraphApproval", "awaitingShipReview"].includes(state)) {
    return { kind: "waiting-human", state, reason: evidence };
  }
  if (state === "awaitingShipCapability") return { kind: "waiting-capability", state, reason: evidence };
  if (state === "observing") return { kind: "waiting-observation", state, reason: evidence };
  return result;
};

const cancelledOrFailedGraph = async (
  runner: DeliveryRunner,
  ports: DeliveryExecutorPorts,
  graph: DeliveryGraphRunView | null,
  expectedModelHash?: string,
): Promise<DeliveryAdvanceResult | null> => {
  if (!graph) return null;
  const result = inspectGraphChild(
    runner.snapshot().context.graphRunId,
    graph.snapshot,
    graph.acceptedSignals,
    expectedModelHash,
  );
  if (result.kind === "failed")
    return childSignal(runner, ports, "CHILD_FAILED", "graph-child-adapter", result.evidence);
  if (result.kind === "blocked")
    return childSignal(runner, ports, "CHILD_BLOCKED", "graph-child-adapter", result.evidence);
  if (result.kind === "cancelled")
    return childSignal(runner, ports, "CHILD_CANCELLED", "graph-child-adapter", result.evidence);
  if (result.kind === "rejected") {
    if (runner.snapshot().state === "awaitingGraphApproval") {
      return childSignal(runner, ports, "GRAPH_APPROVAL_REJECTED", "graph-child-adapter", result.evidence);
    }
    return childSignal(runner, ports, "CHILD_BLOCKED", "graph-child-adapter", result.evidence);
  }
  if (result.kind === "invalid") {
    return childSignal(runner, ports, "CHILD_BLOCKED", "graph-child-adapter", result.issues.join("; "));
  }
  return null;
};

export const advanceDeliveryOnce = async (
  runner: DeliveryRunner,
  ports: DeliveryExecutorPorts,
): Promise<DeliveryAdvanceResult> => {
  const current = runner.snapshot();
  const context = current.context;
  if (
    current.status === "done" ||
    ["validated", "rolledBack", "failed", "blocked", "cancelled", "rejected"].includes(current.state)
  ) {
    return { kind: "terminal", state: current.state, outcome: context.outcome };
  }

  if (context.cancellationRequested) {
    const output = await runEffect(
      runner,
      ports,
      "cancel-children",
      0,
      {
        productRunId: context.productRunId,
        graphRunId: context.graphRunId,
        cancellationEvidence: context.cancellationEvidence,
      },
      (effectId) =>
        ports.cancelChildren({ productRunId: context.productRunId, graphRunId: context.graphRunId, effectId }),
    );
    return finishEffect(Promise.resolve(output), async (completed) =>
      childSignal(runner, ports, "CANCEL_SETTLED", "effect-executor", completed.evidence),
    );
  }

  const expectedGraphRunId = deriveGraphChildRunId(current.runId);
  if (context.graphRunId !== expectedGraphRunId) {
    if (current.state === "intake") {
      return childSignal(
        runner,
        ports,
        "INTAKE_REJECTED",
        "intake-validator",
        `Graph child run ID must be ${expectedGraphRunId}`,
      );
    }
    return childSignal(
      runner,
      ports,
      "CHILD_BLOCKED",
      "graph-child-adapter",
      `Graph child run ID must be ${expectedGraphRunId}`,
    );
  }

  const [product, graph] = await Promise.all([
    ports.readProductRun(context.productRunId),
    ports.readGraphRun(context.graphRunId),
  ]);

  if (current.state === "intake") {
    if (!product)
      return childSignal(runner, ports, "INTAKE_REJECTED", "intake-validator", "Product child run was not found");
    const inspected = inspectProductChild(context.productRunId, product.snapshot, { stageRoot: ports.stageRoot });
    if (inspected.kind === "rejected") {
      return childSignal(runner, ports, "INTAKE_REJECTED", "intake-validator", inspected.issues.join("; "));
    }
    if (context.proposalId !== inspected.proposalId || context.scopeHash !== inspected.scopeHash) {
      return childSignal(
        runner,
        ports,
        "INTAKE_REJECTED",
        "intake-validator",
        "Product proposal or immutable scope does not match delivery intake",
      );
    }
    if (context.riskClass !== "unknown" && context.riskClass !== inspected.riskClass) {
      return childSignal(
        runner,
        ports,
        "INTAKE_REJECTED",
        "intake-validator",
        "Product risk classification does not match delivery intake",
      );
    }
    return childSignal(
      runner,
      ports,
      "INTAKE_ACCEPTED",
      "intake-validator",
      `product-journal:${product.snapshot.runId}:execution`,
      {},
    );
  }

  if (current.state === "awaitingRiskReview") {
    if (!product) {
      return childSignal(
        runner,
        ports,
        "CHILD_BLOCKED",
        "product-child-adapter",
        "Product child run is unavailable during risk review",
      );
    }
    const inspected = inspectProductChild(context.productRunId, product.snapshot, {
      stageRoot: ports.stageRoot,
      allowedStates: ["execution", "verification", "review", "ship", "observation"],
    });
    if (inspected.kind === "rejected") {
      return childSignal(runner, ports, "CHILD_BLOCKED", "product-child-adapter", inspected.issues.join("; "));
    }
    if (inspected.scopeHash !== context.scopeHash || inspected.proposalId !== context.proposalId) {
      return childSignal(
        runner,
        ports,
        "CHILD_BLOCKED",
        "product-child-adapter",
        "Product scope or proposal changed during risk review",
      );
    }
    return { kind: "waiting-human", state: current.state, reason: "risk classification requires an owner decision" };
  }

  if (product) {
    if (product.snapshot.state === "cancelled") {
      return childSignal(
        runner,
        ports,
        "CHILD_CANCELLED",
        "product-child-adapter",
        product.snapshot.context.terminalReason ?? "Product task was cancelled",
      );
    }
    if (["budgetBlocked", "blocked", "rejected"].includes(product.snapshot.state)) {
      return childSignal(
        runner,
        ports,
        "CHILD_BLOCKED",
        "product-child-adapter",
        product.snapshot.context.terminalReason ?? `Product child ended in ${product.snapshot.state}`,
      );
    }
    const inspected = inspectProductChild(context.productRunId, product.snapshot, {
      stageRoot: ports.stageRoot,
      allowedStates: ["execution", "verification", "review", "ship", "observation"],
    });
    if (inspected.kind === "rejected") {
      return childSignal(runner, ports, "CHILD_BLOCKED", "product-child-adapter", inspected.issues.join("; "));
    }
    if (inspected.scopeHash !== context.scopeHash || inspected.proposalId !== context.proposalId) {
      return childSignal(
        runner,
        ports,
        "CHILD_BLOCKED",
        "product-child-adapter",
        "Product scope or proposal changed after intake",
      );
    }
    if (context.riskClass === "standard" && inspected.riskClass === "sensitive") {
      return childSignal(
        runner,
        ports,
        "CHILD_BLOCKED",
        "product-child-adapter",
        "Product risk evidence exceeds the delivery classification",
      );
    }
  } else {
    return childSignal(runner, ports, "CHILD_BLOCKED", "product-child-adapter", "Product child run is unavailable");
  }

  const childOutcome = await cancelledOrFailedGraph(runner, ports, graph, context.modelHash ?? undefined);
  if (childOutcome) return childOutcome;

  if (current.state === "draftingGraphModel") {
    if (!graph) {
      return finishEffect(
        runEffect(runner, ports, "create-graph-run", 0, { graphRunId: context.graphRunId }, (effectId) =>
          ports.createGraphRun(context.graphRunId, effectId),
        ),
        async (output) => advanceResult(runner, output.evidence),
      );
    }
    return finishEffect(
      runEffect(
        runner,
        ports,
        "draft-graph-model",
        0,
        { graphRunId: context.graphRunId, scopeHash: context.scopeHash, riskClass: context.riskClass },
        (effectId) =>
          ports.draftGraphModel({
            runId: context.graphRunId,
            scope: context.scope,
            scopeHash: context.scopeHash,
            riskClass: context.riskClass,
            effectId,
          }),
      ),
      async (output) => {
        const value = output.value;
        const modelArtifactHash = isRecord(value) ? value.modelArtifactHash : undefined;
        if (!validHash(modelArtifactHash))
          return childSignal(
            runner,
            ports,
            "INTAKE_REJECTED",
            "intake-validator",
            "modeler did not return a valid artifact hash",
          );
        return submitParent(
          runner,
          ports,
          "GRAPH_MODEL_DRAFTED",
          "modeler",
          output.evidence,
          { modelArtifactHash },
          "ai",
        );
      },
    );
  }

  if (current.state === "validatingGraphModel") {
    if (!graph)
      return { kind: "waiting-observation", state: current.state, reason: "Graph child run has not appeared yet" };
    const validationIntent = runner.getEffect(deriveDeliveryEffectKey(current.runId, "validate-graph-model", 0));
    if (
      !validHash(graph.snapshot.context.modelHash) ||
      graph.snapshot.context.modelHash !== context.modelArtifactHash ||
      (graph.snapshot.state !== "modelReview" && !validationIntent)
    ) {
      return childSignal(
        runner,
        ports,
        "CHILD_BLOCKED",
        "graph-child-adapter",
        "Graph model state or hash does not match the drafted delivery artifact",
      );
    }
    return finishEffect(
      runEffect(
        runner,
        ports,
        "validate-graph-model",
        0,
        { graphRunId: context.graphRunId, modelArtifactHash: context.modelArtifactHash },
        (effectId) => ports.validateGraphModel({ runId: context.graphRunId, effectId }),
      ),
      async (output) => {
        const value = output.value;
        if (
          !isRecord(value) ||
          value.valid !== true ||
          !validHash(value.modelHash) ||
          value.modelHash !== graph.snapshot.context.modelHash
        ) {
          return childSignal(runner, ports, "MODEL_CONTRACT_INVALID", "model-contract-validator", output.evidence);
        }
        return childSignal(runner, ports, "MODEL_CONTRACT_VALID", "model-contract-validator", output.evidence, {
          modelHash: value.modelHash,
        });
      },
    );
  }

  if (current.state === "awaitingGraphApproval") {
    if (!graph)
      return {
        kind: "waiting-human",
        state: current.state,
        reason: "Graph child run is unavailable for owner approval",
      };
    const inspected = inspectGraphChild(
      context.graphRunId,
      graph.snapshot,
      graph.acceptedSignals,
      context.modelHash ?? undefined,
    );
    if (inspected.kind === "rejected")
      return childSignal(runner, ports, "GRAPH_APPROVAL_REJECTED", "graph-child-adapter", inspected.evidence);
    if (inspected.kind !== "ready")
      return {
        kind: "waiting-human",
        state: current.state,
        reason: "Graph owner has not approved the exact model hash",
      };
    return childSignal(runner, ports, "GRAPH_APPROVAL_CONFIRMED", "graph-child-adapter", inspected.evidence, {
      modelHash: inspected.modelHash,
    });
  }

  if (current.state === "graphReady") {
    if (!graph) return { kind: "waiting-human", state: current.state, reason: "Graph child run is unavailable" };
    const inspected = inspectGraphChild(
      context.graphRunId,
      graph.snapshot,
      graph.acceptedSignals,
      context.modelHash ?? undefined,
    );
    const existingStartEffect = runner.getEffect(
      deriveDeliveryEffectKey(current.runId, "start-graph-implementation", 0),
    );
    if (inspected.kind !== "ready" && !(inspected.kind === "implementing" && existingStartEffect))
      return {
        kind: "waiting-human",
        state: current.state,
        reason: "Graph child is no longer ready with exact owner approval",
      };
    const approvedModelHash = inspected.modelHash;
    return finishEffect(
      runEffect(
        runner,
        ports,
        "start-graph-implementation",
        0,
        { graphRunId: context.graphRunId, modelHash: approvedModelHash },
        (effectId) =>
          ports.startGraphImplementation({ runId: context.graphRunId, modelHash: approvedModelHash, effectId }),
      ),
      async (output) =>
        childSignal(runner, ports, "GRAPH_IMPLEMENTATION_STARTED", "graph-child-adapter", output.evidence),
    );
  }

  if (current.state === "implementing") {
    if (!graph)
      return { kind: "waiting-observation", state: current.state, reason: "Graph child run is not available yet" };
    const inspected = inspectGraphChild(
      context.graphRunId,
      graph.snapshot,
      graph.acceptedSignals,
      context.modelHash ?? undefined,
    );
    if (inspected.kind === "succeeded") {
      return childSignal(runner, ports, "GRAPH_IMPLEMENTATION_SUCCEEDED", "graph-child-adapter", inspected.evidence, {
        implementationHash: inspected.implementationHash,
        artifactHash: inspected.implementationHash,
      });
    }
    if (inspected.kind === "verifying") {
      const implementationEffect = runner.getEffect(
        deriveDeliveryEffectKey(current.runId, "run-graph-implementation", 0),
      );
      if (implementationEffect?.status === "pending") {
        return finishEffect(
          runEffect(
            runner,
            ports,
            "run-graph-implementation",
            0,
            { graphRunId: context.graphRunId, modelHash: inspected.modelHash },
            (effectId) =>
              ports.runGraphImplementation({ runId: context.graphRunId, modelHash: inspected.modelHash, effectId }),
          ),
          async (output) => ({ kind: "waiting-observation", state: runner.snapshot().state, reason: output.evidence }),
        );
      }
      if (!implementationEffect) {
        return childSignal(
          runner,
          ports,
          "CHILD_BLOCKED",
          "graph-child-adapter",
          "Graph reached verification without a delivery implementation effect",
        );
      }
      return finishEffect(
        runEffect(
          runner,
          ports,
          "verify-graph-anchors",
          0,
          { graphRunId: context.graphRunId, modelHash: inspected.modelHash },
          (effectId) => ports.verifyGraphAnchors({ runId: context.graphRunId, effectId }),
        ),
        async (output) => ({ kind: "waiting-observation", state: runner.snapshot().state, reason: output.evidence }),
      );
    }
    if (inspected.kind === "implementing") {
      return finishEffect(
        runEffect(
          runner,
          ports,
          "run-graph-implementation",
          0,
          { graphRunId: context.graphRunId, modelHash: inspected.modelHash },
          (effectId) =>
            ports.runGraphImplementation({ runId: context.graphRunId, modelHash: inspected.modelHash, effectId }),
        ),
        async (output) => advanceResult(runner, output.evidence),
      );
    }
    return {
      kind: "waiting-observation",
      state: current.state,
      reason: `Graph implementation is currently ${graph.snapshot.state}`,
    };
  }

  if (current.state === "productVerification") {
    if (!product) return { kind: "waiting-human", state: current.state, reason: "Product child run is unavailable" };
    const productState = product.snapshot.state;
    if (productState === "review") {
      return childSignal(
        runner,
        ports,
        "PRODUCT_REVIEW_REQUIRED",
        "product-child-adapter",
        product.snapshot.context.reviewReason ?? "Product requested owner review",
      );
    }
    if (productState === "budgetBlocked" || productState === "blocked" || productState === "rejected") {
      return childSignal(
        runner,
        ports,
        "PRODUCT_REVIEW_BLOCKED",
        "product-child-adapter",
        product.snapshot.context.terminalReason ?? `Product child ended in ${productState}`,
      );
    }
    if (productState === "execution") {
      return finishEffect(
        runEffect(
          runner,
          ports,
          "product-execution-done",
          0,
          { productRunId: context.productRunId, implementationHash: context.implementationHash },
          (effectId) =>
            ports.submitProductSignal(context.productRunId, {
              runId: context.productRunId,
              type: "EXECUTION_DONE",
              source: "tool",
              producer: "budget-ledger",
              occurredAt: ports.clock(),
              payload: { deliveryRunId: current.runId, implementationHash: context.implementationHash, effectId },
              evidence: [`delivery:${current.runId}:graph:${context.implementationHash}`],
            }),
        ),
        async (output) => {
          if (isRecord(output.value) && output.value.accepted === false)
            return { kind: "waiting-human", state: current.state, reason: "Product rejected EXECUTION_DONE" };
          return advanceResult(runner, output.evidence);
        },
      );
    }
    if (productState === "verification") {
      return finishEffect(
        runEffect(
          runner,
          ports,
          "verify-product",
          0,
          { productRunId: context.productRunId, implementationHash: context.implementationHash },
          (effectId) => ports.verifyProduct({ runId: context.productRunId, effectId }),
        ),
        async (output) => {
          const value = output.value;
          if (!isRecord(value))
            return { kind: "waiting-human", state: current.state, reason: "Product verification returned no decision" };
          if (value.state === "ship")
            return childSignal(runner, ports, "PRODUCT_SHIP_READY", "product-child-adapter", output.evidence);
          if (value.state === "review")
            return childSignal(runner, ports, "PRODUCT_REVIEW_REQUIRED", "product-child-adapter", output.evidence);
          return childSignal(runner, ports, "PRODUCT_REVIEW_BLOCKED", "product-child-adapter", output.evidence);
        },
      );
    }
    if (productState === "ship" || productState === "observation") {
      return childSignal(
        runner,
        ports,
        "PRODUCT_SHIP_READY",
        "product-child-adapter",
        `Product child reached ${productState}`,
      );
    }
    return {
      kind: "waiting-observation",
      state: current.state,
      reason: `Product verification is currently ${productState}`,
    };
  }

  if (current.state === "awaitingShipReview") {
    const authorization = product.acceptedSignals.find(
      (signal) =>
        signal.eventType === "REVIEW_RESOLVED" &&
        signal.source === "human" &&
        signal.producer === "human-owner" &&
        signal.payload.resolution === "deploy-authorized" &&
        signal.evidence.some((entry) => typeof entry === "string" && entry.trim().length > 0),
    );
    if ((product.snapshot.state === "ship" || product.snapshot.state === "observation") && authorization) {
      return childSignal(
        runner,
        ports,
        "PRODUCT_SHIP_AUTHORIZED",
        "product-child-adapter",
        authorization.evidence.find((entry) => entry.trim().length > 0) ?? "Product owner authorized sensitive deploy",
      );
    }
    return {
      kind: "waiting-human",
      state: current.state,
      reason: "sensitive delivery requires Product's accepted human deploy authorization",
    };
  }

  if (current.state === "shipReady" || current.state === "awaitingShipCapability") {
    const hasCapability = await ports.hasReversibleStaging();
    if (!hasCapability) {
      if (current.state === "awaitingShipCapability")
        return {
          kind: "waiting-capability",
          state: current.state,
          reason: "reversible staging capability is still unavailable",
        };
      return childSignal(
        runner,
        ports,
        "SHIP_CAPABILITY_MISSING",
        "staging-target",
        "reversible staging target is not configured",
      );
    }
    if (current.state === "awaitingShipCapability") {
      return childSignal(
        runner,
        ports,
        "SHIP_CAPABILITY_CONFIRMED",
        "staging-target",
        "reversible staging target is available",
      );
    }
    const rollbackArtifact = product?.snapshot.context.draft?.rollbackArtifact;
    const implementationHash = context.implementationHash;
    const artifactHash = context.artifactHash;
    if (!rollbackArtifact || !implementationHash || !artifactHash) {
      return {
        kind: "waiting-human",
        state: current.state,
        reason: "ship request lacks implementation or rollback artifact evidence",
      };
    }
    return finishEffect(
      runEffect(
        runner,
        ports,
        "ship-staging-artifact",
        0,
        { implementationHash, artifactHash, rollbackArtifact },
        (effectId) =>
          ports.ship({ runId: current.runId, implementationHash, artifactHash, rollbackArtifact, effectId }),
      ),
      async (output) => {
        const value = output.value;
        if (!isRecord(value) || value.artifactHash !== context.artifactHash)
          return {
            kind: "waiting-human",
            state: current.state,
            reason: "staging target shipped a different artifact hash",
          };
        return childSignal(runner, ports, "SHIP_CONFIRMED", "effect-executor", output.evidence, {
          artifactHash: value.artifactHash,
        });
      },
    );
  }

  if (current.state === "observing") {
    if (context.rollbackRequired) {
      if (context.rollbackConfirmed) {
        return {
          kind: "waiting-human",
          state: current.state,
          reason: "rollback completed; a corrective Product task must be opened separately",
        };
      }
      if (!context.artifactHash || !product?.snapshot.context.draft?.rollbackArtifact) {
        return {
          kind: "waiting-capability",
          state: current.state,
          reason: "rollback capability or artifact is unavailable",
        };
      }
      const rollbackArtifact = product.snapshot.context.draft.rollbackArtifact;
      const artifactHash = context.artifactHash;
      const attempt = runner.effects().filter((effect) => effect.name === "rollback-staging-artifact").length;
      return finishEffect(
        runEffect(runner, ports, "rollback-staging-artifact", attempt, { artifactHash, rollbackArtifact }, (effectId) =>
          ports.rollback({ runId: current.runId, artifactHash, rollbackArtifact, effectId }),
        ),
        async (output) => childSignal(runner, ports, "ROLLBACK_CONFIRMED", "staging-target", output.evidence),
      );
    }
    const sampleIndex = context.observationEvidence.length;
    const output = await runEffect(
      runner,
      ports,
      "sample-staging-observation",
      sampleIndex,
      {
        artifactHash: context.artifactHash,
        sampleIndex,
      },
      (effectId) =>
        ports.sampleObservation({
          runId: current.runId,
          artifactHash: context.artifactHash ?? "",
          sampleIndex,
          effectId,
        }),
    );
    return finishEffect(Promise.resolve(output), async (completed) => {
      const value = completed.value;
      if (!isRecord(value))
        return { kind: "waiting-observation", state: current.state, reason: "observation sample has no health result" };
      if (value.healthy !== true)
        return childSignal(runner, ports, "ROLLBACK_REQUIRED", "product-child-adapter", completed.evidence);
      if (value.windowElapsed === true)
        return childSignal(runner, ports, "OBSERVATION_VALIDATED", "product-child-adapter", completed.evidence);
      return childSignal(runner, ports, "OBSERVATION_SAMPLE_RECORDED", "observer", completed.evidence);
    });
  }

  return {
    kind: "waiting-observation",
    state: current.state,
    reason: "delivery is waiting for a child or owner update",
  };
};
