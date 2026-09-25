import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type ObservationSample, REQUIRED_GRAPH_ANCHORS } from "@guyghost/swarm-dao-core";
import { createGraphRunner, type GraphRunner } from "@guyghost/swarm-dao-graph";
import { createProductRunner, type ProductRunner } from "@guyghost/swarm-dao-product";
import { deriveGraphChildRunId, openGraphChild, openProductChild } from "../child-runs.js";
import { advanceDeliveryOnce, type DeliveryAdvanceResult, type DeliveryExecutorPorts } from "../executor.js";
import { createDeliveryRunner, type DeliveryRunner } from "../runner.js";
import { createLocalStagingTarget } from "../staging-target.js";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const artifact = Buffer.from("reference implementation artifact\n", "utf8");
const artifactHash = sha256(artifact);

export type ReferenceScenarioOptions = Readonly<{
  riskClass?: "unknown" | "standard" | "sensitive";
  budgetAllocation?: number;
  creditsPerGraphAttempt?: number;
  stagingAvailable?: boolean;
  failedControl?: boolean;
  degradedObservations?: boolean;
  graphApproval?: "exact" | "stale" | "manual";
  failGraphCreationOnce?: boolean;
  recoverPendingGraphCreation?: boolean;
}>;

export type ReferenceScenario = Readonly<{
  root: string;
  delivery: DeliveryRunner;
  productRunner: ProductRunner;
  graphRunner: () => GraphRunner | null;
  productSubmissions: readonly Readonly<{ signal: Record<string, unknown>; accepted: boolean }>[];
  graphSubmissions: readonly Record<string, unknown>[];
  readonly deliverySubmissions: number;
  resumeUntilPauseOrTerminal: (maxSteps?: number) => Promise<DeliveryAdvanceResult>;
  submitGraphApproval: (modelHash?: string) => Promise<boolean>;
  resolveRisk: (riskClass: "standard" | "sensitive") => Promise<boolean>;
  authorizeSensitiveDeploy: () => Promise<boolean>;
  requestCancellation: () => Promise<boolean>;
  cancelChildrenAsOwner: () => Promise<boolean>;
  setStagingAvailable: (available: boolean) => void;
  openCorrectiveTask: () => Promise<boolean>;
  cleanup: () => Promise<void>;
}>;

const accepted = (result: { accepted: boolean; issues: readonly string[] }, label: string): void => {
  if (!result.accepted) throw new Error(`${label} rejected: ${result.issues.join("; ")}`);
};

const childSignal = (
  runId: string,
  type: string,
  source: "ai" | "tool" | "human" | "system",
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = [],
) => ({ runId, type, source, producer, occurredAt: new Date().toISOString(), payload, evidence });

const productSignal = (
  runId: string,
  type: string,
  source: "ai" | "tool" | "human" | "system",
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = [],
) => childSignal(runId, type, source, producer, payload, evidence);

export const createReferenceScenario = async (options: ReferenceScenarioOptions = {}): Promise<ReferenceScenario> => {
  const root = await mkdtemp(resolve(tmpdir(), "swarm-software-delivery-"));
  const productRoot = resolve(root, ".dao/product-loops");
  const graphRoot = resolve(root, ".dao/graph-runs");
  const deliveryRoot = resolve(root, "evidence/software-deliveries");
  const stageRoot = resolve(root, "evidence/software-delivery-stage");
  const productRunId = "product-reference";
  const deliveryRunId = "delivery-reference";
  const graphRunId = deriveGraphChildRunId(deliveryRunId);
  let clockTicks = 0;
  let failGraphCreation = options.failGraphCreationOnce === true;
  const clock = () => new Date(Date.UTC(2026, 8, 25, 12, 0, clockTicks++ * 60_000)).toISOString();
  const draft = {
    scope: "cache proposal digests to reduce repeat render work",
    category: options.riskClass === "sensitive" ? "security" : "performance",
    touchesSensitive: options.riskClass === "sensitive",
    dependencies: ["packages/core/src/models/proposal.machine.ts"],
    budgetAllocation: options.budgetAllocation ?? 20,
    rollbackArtifact: "evidence/software-delivery-stage/active.json",
    evidence: "reference:proposal-scope-and-budget",
  } as const;

  const stage = createLocalStagingTarget({
    stageRoot,
    snapshotSource: async () => artifact,
    clock,
  });
  await stage.initialize();

  const productRunner = await createProductRunner({ evidenceRoot: productRoot, runId: productRunId });
  const productSubmissions: Array<{ signal: Record<string, unknown>; accepted: boolean }> = [];
  const submitProduct = async (signal: Record<string, unknown>) => {
    const result = await productRunner.submit(signal);
    productSubmissions.push({ signal, accepted: result.accepted });
    return result;
  };
  const productPrefix = [
    productSignal(productRunId, "PROPOSAL_DRAFTED", "ai", "proposer", { draft }, [draft.evidence]),
    productSignal(productRunId, "OPEN_PROPOSITION", "tool", "proposition-gate", {}, ["proposition opened"]),
    productSignal(
      productRunId,
      "QUALIFICATION_RUN",
      "tool",
      "qualifier",
      { permissionCleared: true, permissionEvidence: "reference:permissions-cleared" },
      ["reference:permissions-cleared"],
    ),
    productSignal(
      productRunId,
      "VOTE_OPENED",
      "tool",
      "vote-tally",
      { config: { quorum: 3, kind: "standard", expiryHours: 72 } },
      ["reference:quorum-3"],
    ),
    productSignal(productRunId, "VOTE_CAST", "tool", "vote-tally", { favorable: 3 }, ["reference:3-votes"]),
    productSignal(productRunId, "VOTE_EVALUATE", "system", "product-runner", {}, ["reference:vote-evaluated"]),
  ];
  for (const signal of productPrefix) accepted(await submitProduct(signal), String(signal.type));
  if (productRunner.snapshot().state !== "execution") {
    throw new Error(`reference Product prefix ended in ${productRunner.snapshot().state}, expected execution`);
  }

  const scopeHash = sha256(draft.scope);
  const delivery = await createDeliveryRunner({
    evidenceRoot: deliveryRoot,
    runId: deliveryRunId,
    machineInput: {
      productRunId,
      graphRunId,
      proposalId: productRunner.snapshot().context.proposalId,
      scope: draft.scope,
      scopeHash,
      creditsPerGraphAttempt: options.creditsPerGraphAttempt ?? 1,
      observationWindowMs: 1,
      observationIntervalMs: 1,
      riskClass: options.riskClass ?? "standard",
    },
    clock,
  });

  const graphSubmissions: Array<Record<string, unknown>> = [];
  let graph: GraphRunner | null = null;
  let stagingAvailable = options.stagingAvailable ?? true;
  const submitGraph = async (signal: Record<string, unknown>) => {
    if (!graph) throw new Error("Graph child has not been created");
    graphSubmissions.push(signal);
    const result = await graph.submit(signal);
    return result;
  };

  const ports: DeliveryExecutorPorts = {
    readProductRun: async (runId) => {
      if (runId !== productRunId) return null;
      const child = await openProductChild({ evidenceRoot: productRoot, runId });
      return { snapshot: child.snapshot, acceptedSignals: child.acceptedSignals };
    },
    readGraphRun: async (runId) => {
      if (runId !== graphRunId || !graph) return null;
      const child = await openGraphChild({ evidenceRoot: graphRoot, runId });
      return { snapshot: child.snapshot, acceptedSignals: child.acceptedSignals };
    },
    createGraphRun: async (runId) => {
      if (failGraphCreation) {
        failGraphCreation = false;
        throw new Error("reference crash after delivery effect intent");
      }
      graph = await createGraphRunner({ evidenceRoot: graphRoot, runId, clock });
      return { evidence: `reference:graph-created:${runId}` };
    },
    draftGraphModel: async ({ runId }) => {
      accepted(
        await submitGraph(
          childSignal(runId, "MODEL_DRAFTED", "ai", "modeler", { modelHash: artifactHash }, [
            `reference:model-artifact:${artifactHash}`,
          ]),
        ),
        "MODEL_DRAFTED",
      );
      return { evidence: `reference:model-drafted:${artifactHash}`, value: { modelArtifactHash: artifactHash } };
    },
    validateGraphModel: async ({ runId }) => {
      accepted(
        await submitGraph(
          childSignal(runId, "MODEL_CONTRACT_VALID", "tool", "model-contract-validator", {}, [
            `reference:model-contract:${artifactHash}`,
          ]),
        ),
        "MODEL_CONTRACT_VALID",
      );
      return {
        evidence: `reference:model-contract:${artifactHash}`,
        value: { valid: true, modelHash: graph?.snapshot().context.modelHash ?? "" },
      };
    },
    startGraphImplementation: async ({ runId }) => {
      accepted(
        await submitGraph(
          childSignal(runId, "START_IMPLEMENTATION", "system", "graph-runner", {}, ["reference:start"]),
        ),
        "START_IMPLEMENTATION",
      );
      return { evidence: "reference:implementation-started" };
    },
    runGraphImplementation: async ({ runId }) => {
      accepted(
        await submitGraph(
          childSignal(runId, "IMPLEMENTATION_READY", "ai", "implementer", { implementationHash: artifactHash }, [
            "reference:implementation-built",
          ]),
        ),
        "IMPLEMENTATION_READY",
      );
      return { evidence: `reference:implementation-ready:${artifactHash}`, value: { state: graph?.snapshot().state } };
    },
    verifyGraphAnchors: async ({ runId }) => {
      for (const anchor of REQUIRED_GRAPH_ANCHORS.filter((name) => name !== "model-contract")) {
        const producer =
          anchor === "architecture-contract"
            ? "architecture-watcher"
            : anchor === "regression"
              ? "regression-watcher"
              : "runtime-verifier";
        accepted(
          await submitGraph(
            childSignal(runId, "ANCHOR_RECORDED", "tool", producer, { anchor, status: "passed" }, [
              `reference:graph-anchor:${anchor}`,
            ]),
          ),
          `ANCHOR_RECORDED:${anchor}`,
        );
      }
      accepted(
        await submitGraph(childSignal(runId, "EVALUATE", "system", "graph-runner", {}, ["reference:evaluate"])),
        "EVALUATE",
      );
      return { evidence: `reference:graph-anchors:${graph?.snapshot().state}` };
    },
    submitProductSignal: async (runId, signal) => {
      if (runId !== productRunId) throw new Error(`unexpected Product run ${runId}`);
      const submitted = await submitProduct(signal as Record<string, unknown>);
      return {
        evidence: submitted.accepted
          ? `product-journal:${runId}:${String(signal && typeof signal === "object" && "type" in signal ? signal.type : "signal")}`
          : `product-rejected:${submitted.issues.join("; ")}`,
        value: { accepted: submitted.accepted, state: submitted.snapshot.state },
      };
    },
    verifyProduct: async ({ runId }) => {
      const controls = [
        { name: "unit-tests", status: options.failedControl ? "failed" : "passed", evidence: "reference:unit-tests" },
        { name: "types", status: "passed", evidence: "reference:types" },
        { name: "lint", status: "passed", evidence: "reference:lint" },
      ];
      for (const control of controls) {
        accepted(
          await submitProduct(productSignal(runId, "VERIFY_RUN", "tool", "verifier", { control }, [control.evidence])),
          `VERIFY_RUN:${control.name}`,
        );
      }
      for (const anchor of ["frozen-set-intact", "regression"] as const) {
        accepted(
          await submitProduct(
            productSignal(runId, "ANCHOR_RECORDED", "tool", "verifier", { anchor, status: "passed" }, [
              `reference:product-anchor:${anchor}`,
            ]),
          ),
          `ANCHOR_RECORDED:${anchor}`,
        );
      }
      accepted(
        await submitProduct(
          productSignal(runId, "VERIFY_EVALUATE", "system", "product-runner", {}, ["reference:verify-evaluate"]),
        ),
        "VERIFY_EVALUATE",
      );
      const state = productRunner.snapshot().state;
      const decision = state === "ship" ? "ship" : state === "review" ? "review" : "blocked";
      return { evidence: `reference:product-verification:${state}`, value: { state: decision } };
    },
    verifyRollbackPath: async ({ runId }) => {
      const verification = await stage.verifyRollbackPath();
      return {
        evidence: `${verification.evidence}:product:${runId}`,
        value: { restorable: verification.restorable },
      };
    },
    hasReversibleStaging: async () => stagingAvailable,
    ship: async ({ implementationHash, artifactHash: expectedArtifactHash, effectId, runId }) => {
      if (implementationHash !== artifactHash || expectedArtifactHash !== artifactHash) {
        throw new Error("reference staging artifact differs from the accepted Graph implementation hash");
      }
      const snapshot = await stage.snapshot();
      const shipped = await stage.ship({ effectId, artifact: snapshot });
      return {
        evidence: `reference:staging-shipped:${shipped.artifactHash}:${runId}`,
        value: { artifactHash: shipped.artifactHash },
      };
    },
    rollback: async ({ artifactHash: expectedHash, effectId, runId }) => {
      const result = await stage.rollback({ effectId, expectedActiveHash: expectedHash });
      return { evidence: `reference:staging-rollback:${result.restoredHash ?? "baseline"}:${runId}` };
    },
    sampleObservation: async ({ runId, sampleIndex }) => {
      const inspection = await stage.inspect();
      const isDegraded = options.degradedObservations === true;
      const samples: ObservationSample[] = [
        {
          metric: "errors",
          value: isDegraded ? 1 : 0,
          threshold: 0,
          exceeded: isDegraded,
          evidence: `reference:observation:${sampleIndex}:errors:${inspection.activeHash ?? "baseline"}`,
        },
        {
          metric: "latency",
          value: 1,
          threshold: 1_000,
          exceeded: false,
          evidence: `reference:observation:${sampleIndex}:latency:${inspection.activeHash ?? "baseline"}`,
        },
      ];
      return {
        evidence: `reference:local-stage-measurements:${runId}:${sampleIndex}`,
        value: { samples, windowElapsed: true, observedAt: clock() },
      };
    },
    cancelChildren: async ({ productRunId: cancelProductId, graphRunId: cancelGraphId }) => {
      const [product, graphView] = await Promise.all([
        openProductChild({ evidenceRoot: productRoot, runId: cancelProductId }),
        graph ? openGraphChild({ evidenceRoot: graphRoot, runId: cancelGraphId }) : Promise.resolve(null),
      ]);
      const terminalProduct = ["validated", "rejected", "cancelled", "blocked", "budgetBlocked"].includes(
        product.snapshot.state,
      );
      const terminalGraph =
        !graphView || ["succeeded", "failed", "blocked", "cancelled"].includes(graphView.snapshot.state);
      if (!terminalProduct || !terminalGraph) {
        throw new Error("active child runs require explicit owner cancellation through ProductRunner and GraphRunner");
      }
      return {
        evidence: `reference:child-cancellation:settled:${cancelProductId}:${cancelGraphId}`,
      };
    },
    reconcileEffect: async (effect) => {
      if (effect.name === "create-graph-run" && options.recoverPendingGraphCreation && !graph) {
        graph = await createGraphRunner({ evidenceRoot: graphRoot, runId: graphRunId, clock });
        return {
          status: "completed",
          result: { evidence: `reference:reconciled-graph-created:${graphRunId}` },
          evidence: `reference:reconciled-graph-created:${graphRunId}`,
        };
      }
      return { status: "not-started" };
    },
    stageRoot,
    artifactBaseRoot: root,
    clock,
  };

  const submitGraphApproval = async (modelHash = delivery.snapshot().context.modelHash ?? ""): Promise<boolean> => {
    if (!graph) throw new Error("Graph child has not been created");
    const result = await submitGraph(
      childSignal(graphRunId, "MODEL_APPROVED", "human", "human-owner", { modelHash }, [
        `reference:human-approved:${modelHash}`,
      ]),
    );
    return result.accepted;
  };

  const resumeUntilPauseOrTerminal = async (maxSteps = 160): Promise<DeliveryAdvanceResult> => {
    for (let step = 0; step < maxSteps; step += 1) {
      const current = delivery.snapshot();
      if (["validated", "rolledBack", "failed", "blocked", "cancelled", "rejected"].includes(current.state)) {
        return { kind: "terminal", state: current.state, outcome: current.context.outcome };
      }
      if (current.state === "awaitingRiskReview") {
        return {
          kind: "waiting-human",
          state: current.state,
          reason: "reference scenario requires an explicit owner signal",
        };
      }
      if (current.state === "awaitingShipCapability" && !stagingAvailable) {
        return {
          kind: "waiting-capability",
          state: current.state,
          reason: "reference staging capability is unavailable",
        };
      }
      if (current.state === "awaitingGraphApproval") {
        const approvalMode = options.graphApproval ?? "exact";
        if (approvalMode === "manual" && !current.context.cancellationRequested) {
          return { kind: "waiting-human", state: current.state, reason: "Graph owner approval is pending" };
        }
        if (!current.context.cancellationRequested) {
          const result = await submitGraphApproval(
            approvalMode === "stale" ? "f".repeat(64) : (delivery.snapshot().context.modelHash ?? ""),
          );
          if (!result) {
            return {
              kind: "waiting-human",
              state: current.state,
              reason: "Graph owner approval does not match the drafted hash",
            };
          }
        }
      }
      const result = await advanceDeliveryOnce(delivery, ports);
      if (result.kind === "terminal" || result.kind === "waiting-capability") {
        return result;
      }
      if (result.kind === "waiting-human" && delivery.snapshot().state !== "awaitingGraphApproval") return result;
      if (result.kind === "waiting-observation" && result.reason.includes("interval has not elapsed")) return result;
    }
    throw new Error(`reference scenario exceeded ${maxSteps} delivery advances at ${delivery.snapshot().state}`);
  };

  return {
    root,
    delivery,
    productRunner,
    graphRunner: () => graph,
    productSubmissions,
    graphSubmissions,
    get deliverySubmissions() {
      return delivery.snapshot().sequence;
    },
    resumeUntilPauseOrTerminal,
    submitGraphApproval,
    resolveRisk: async (riskClass) => {
      const result = await delivery.submit({
        runId: deliveryRunId,
        type: "RISK_CLASSIFICATION_RESOLVED",
        source: "human",
        producer: "human-owner",
        occurredAt: clock(),
        payload: { riskClass },
        evidence: [`reference:owner-classified:${riskClass}`],
      });
      return result.accepted;
    },
    authorizeSensitiveDeploy: async () => {
      const result = await submitProduct(
        productSignal(productRunId, "REVIEW_RESOLVED", "human", "human-owner", { resolution: "deploy-authorized" }, [
          "reference:human-authorized-sensitive-deploy",
        ]),
      );
      return result.accepted;
    },
    requestCancellation: async () => {
      const result = await delivery.submit({
        runId: deliveryRunId,
        type: "CANCEL_REQUESTED",
        source: "human",
        producer: "human-owner",
        occurredAt: clock(),
        payload: {},
        evidence: ["reference:owner-requested-cancellation"],
      });
      return result.accepted;
    },
    cancelChildrenAsOwner: async () => {
      const productCancel = await submitProduct(
        productSignal(productRunId, "CANCEL", "human", "human-owner", { reason: "reference delivery cancellation" }, [
          "reference:owner-cancelled-product",
        ]),
      );
      const graphCancel = graph
        ? await submitGraph(
            childSignal(graphRunId, "CANCEL", "human", "human-owner", { reason: "reference delivery cancellation" }, [
              "reference:owner-cancelled-graph",
            ]),
          )
        : { accepted: true };
      return productCancel.accepted && graphCancel.accepted;
    },
    setStagingAvailable: (available) => {
      stagingAvailable = available;
    },
    openCorrectiveTask: async () => {
      const productResult = await submitProduct(
        productSignal(productRunId, "CORRECTIVE_PROPOSITION_OPENED", "tool", "rollback-opener", {}, [
          "reference:corrective-product-proposition-opened",
        ]),
      );
      if (!productResult.accepted) return false;
      const parentResult = await delivery.submit({
        runId: deliveryRunId,
        type: "CORRECTIVE_TASK_OPENED",
        source: "tool",
        producer: "product-child-adapter",
        occurredAt: clock(),
        payload: {},
        evidence: ["reference:corrective-product-proposition-opened"],
      });
      return parentResult.accepted;
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};
