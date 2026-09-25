import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type GraphAnchorName,
  type GraphAnchorResult,
  type GraphEngineeringContext,
  PRODUCT_ALLOWED_CATEGORIES,
  PRODUCT_SHIP_GATE_ANCHORS,
  type ProductContext,
  type ProductSignalSource,
  REQUIRED_GRAPH_ANCHORS,
} from "@guyghost/swarm-dao-core";
import {
  createGraphRunner,
  type GraphRunner,
  type GraphSubmissionResult,
  type PersistedGraphSnapshot,
} from "@guyghost/swarm-dao-graph";
import {
  createProductRunner,
  type PersistedProductSnapshot,
  type ProductRunner,
  type ProductSubmissionResult,
} from "@guyghost/swarm-dao-product";

export type AcceptedChildSignal = Readonly<{
  sequence: number;
  eventType: string;
  source: ProductSignalSource;
  producer: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}>;

export type ProductChildRun = Readonly<{
  runner: ProductRunner;
  snapshot: PersistedProductSnapshot;
  acceptedSignals: readonly AcceptedChildSignal[];
}>;

export type GraphChildRun = Readonly<{
  runner: GraphRunner;
  snapshot: PersistedGraphSnapshot;
  acceptedSignals: readonly AcceptedChildSignal[];
}>;

export type ProductChildInspection =
  | Readonly<{
      kind: "ready";
      productRunId: string;
      proposalId: string | null;
      scope: string;
      scopeHash: string;
      riskClass: "standard" | "sensitive";
      category: string;
      touchesSensitive: boolean;
      budgetRemaining: number;
      rollbackArtifact: string;
      scopeEvidence: string;
      reviewReason: string | null;
      shipGateReady: boolean;
    }>
  | Readonly<{ kind: "rejected"; issues: readonly string[] }>;

export type GraphChildInspection =
  | Readonly<{ kind: "waiting"; state: string }>
  | Readonly<{ kind: "ready"; modelHash: string; evidence: string }>
  | Readonly<{ kind: "implementing"; modelHash: string }>
  | Readonly<{ kind: "verifying"; modelHash: string; implementationHash: string | null }>
  | Readonly<{ kind: "succeeded"; modelHash: string; implementationHash: string; evidence: string }>
  | Readonly<{ kind: "failed" | "blocked" | "cancelled" | "rejected"; evidence: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

export type ProductChildOptions = Readonly<{
  evidenceRoot: string;
  runId: string;
}>;

export type ProductInspectionOptions = Readonly<{
  stageRoot?: string;
  /** Base directory for repo-relative rollback artifacts, usually the checkout root. */
  artifactBaseRoot?: string;
  allowedStates?: readonly string[];
  expectedRollbackArtifact?: string;
}>;

export type GraphChildOptions = Readonly<{
  evidenceRoot: string;
  runId: string;
}>;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export const deriveGraphChildRunId = (deliveryRunId: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deliveryRunId) || deliveryRunId.includes("..")) {
    throw new Error("delivery run ID must be safe before deriving its Graph child ID");
  }
  const suffix = "-graph";
  if (deliveryRunId.length + suffix.length <= 128) return `${deliveryRunId}${suffix}`;
  const digest = createHash("sha256").update(deliveryRunId).digest("hex").slice(0, 12);
  return `${deliveryRunId.slice(0, 109)}-${digest}${suffix}`;
};

const findAcceptedSignals = async (evidenceRoot: string, runId: string): Promise<readonly AcceptedChildSignal[]> => {
  const journalPath = resolve(evidenceRoot, runId, "journal.ndjson");
  let content: string;
  try {
    content = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const signals: AcceptedChildSignal[] = [];
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`child journal line ${index + 1} is invalid JSON`);
    }
    if (
      !isRecord(entry) ||
      entry.sequence !== index + 1 ||
      entry.runId !== runId ||
      typeof entry.accepted !== "boolean"
    ) {
      throw new Error(`child journal line ${index + 1} violates the sequence or run identity contract`);
    }
    if (!entry.accepted) continue;
    if (!isRecord(entry.signal)) throw new Error(`accepted child journal line ${index + 1} has no signal`);
    const signal = entry.signal;
    if (
      signal.runId !== runId ||
      typeof signal.type !== "string" ||
      signal.type !== entry.eventType ||
      typeof signal.producer !== "string" ||
      signal.producer !== entry.producer ||
      (signal.source !== "ai" && signal.source !== "tool" && signal.source !== "human" && signal.source !== "system") ||
      !isRecord(signal.payload) ||
      !Array.isArray(signal.evidence) ||
      !signal.evidence.every((evidence) => typeof evidence === "string" && evidence.trim().length > 0)
    ) {
      throw new Error(`accepted child journal line ${index + 1} has malformed signal evidence`);
    }
    signals.push({
      sequence: index + 1,
      eventType: signal.type,
      source: signal.source,
      producer: signal.producer,
      payload: signal.payload,
      evidence: signal.evidence,
    });
  }
  return signals;
};

export const openProductChild = async (options: ProductChildOptions): Promise<ProductChildRun> => {
  const runner = await createProductRunner({ evidenceRoot: options.evidenceRoot, runId: options.runId });
  const acceptedSignals = await findAcceptedSignals(options.evidenceRoot, options.runId);
  return { runner, snapshot: runner.snapshot(), acceptedSignals };
};

export const openGraphChild = async (options: GraphChildOptions): Promise<GraphChildRun> => {
  const runner = await createGraphRunner({ evidenceRoot: options.evidenceRoot, runId: options.runId });
  const acceptedSignals = await findAcceptedSignals(options.evidenceRoot, options.runId);
  return { runner, snapshot: runner.snapshot(), acceptedSignals };
};

export const readGraphChild = async (options: GraphChildOptions): Promise<GraphChildRun | null> => {
  try {
    await access(resolve(options.evidenceRoot, options.runId, "snapshot.json"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  return openGraphChild(options);
};

const anchorHasEvidence = (context: ProductContext, name: "vote-quorum" | "budget-envelope"): boolean => {
  const anchor = context.anchors[name];
  return anchor?.status === "passed" && nonEmptyString(anchor.evidence);
};

const isInsideStageRoot = (stageRoot: string, artifact: string, artifactBaseRoot = stageRoot): boolean => {
  const root = resolve(stageRoot);
  const resolvedArtifact = resolve(artifactBaseRoot, artifact);
  const artifactPath = relative(root, resolvedArtifact);
  return (
    artifactPath.length > 0 &&
    artifactPath !== ".." &&
    !artifactPath.startsWith(`..${sep}`) &&
    !isAbsolute(artifactPath)
  );
};

export const inspectProductChild = (
  expectedRunId: string,
  snapshot: PersistedProductSnapshot,
  options: ProductInspectionOptions = {},
): ProductChildInspection => {
  const issues: string[] = [];
  const context = snapshot.context;
  if (snapshot.runId !== expectedRunId || context.runId !== expectedRunId)
    issues.push("Product run ID does not match the delivery reference");
  const allowedStates = options.allowedStates ?? ["execution"];
  if (!allowedStates.includes(snapshot.state)) {
    issues.push(`Product run must be in ${allowedStates.join(" or ")}, found ${snapshot.state}`);
  }
  if (snapshot.status !== "active") issues.push(`Product run is not active (${snapshot.status})`);

  const draft = context.draft;
  if (!draft || !nonEmptyString(draft.scope)) issues.push("Product task scope is missing");
  if (!draft || !(PRODUCT_ALLOWED_CATEGORIES as readonly string[]).includes(draft.category)) {
    issues.push("Product task category is missing or invalid");
  }
  if (!draft || typeof draft.touchesSensitive !== "boolean")
    issues.push("Product touchesSensitive classification is missing");
  if (!draft || !nonEmptyString(draft.evidence)) issues.push("Product task evidence is missing");
  if (!anchorHasEvidence(context, "vote-quorum")) issues.push("sealed vote-quorum anchor is missing");
  if (!anchorHasEvidence(context, "budget-envelope")) issues.push("sealed budget-envelope anchor is missing");

  const budget = context.budget;
  const validBudget =
    budget !== null &&
    Number.isFinite(budget.initial) &&
    Number.isFinite(budget.consumed) &&
    budget.initial > 0 &&
    budget.consumed >= 0 &&
    Array.isArray(budget.history);
  const budgetRemaining = validBudget && budget ? budget.initial - budget.consumed : 0;
  if (!validBudget || (budgetRemaining <= 0 && snapshot.state !== "review")) {
    issues.push("Product budget envelope is invalid or exhausted");
  }

  const rollbackArtifact = draft?.rollbackArtifact ?? "";
  if (!nonEmptyString(rollbackArtifact)) issues.push("rollback artifact reference is missing");
  if (!options.stageRoot) issues.push("configured staging target root is missing");
  if (
    options.stageRoot &&
    nonEmptyString(rollbackArtifact) &&
    !isInsideStageRoot(options.stageRoot, rollbackArtifact, options.artifactBaseRoot)
  ) {
    issues.push("rollback artifact is outside the configured staging target");
  }
  if (
    options.stageRoot &&
    options.expectedRollbackArtifact &&
    nonEmptyString(rollbackArtifact) &&
    resolve(options.artifactBaseRoot ?? options.stageRoot, rollbackArtifact) !==
      resolve(options.stageRoot, options.expectedRollbackArtifact)
  ) {
    issues.push("rollback artifact does not resolve to the configured active staging pointer");
  }

  if (issues.length > 0 || !draft || !validBudget || !budget) return { kind: "rejected", issues };

  const category = draft.category;
  const riskClass: "standard" | "sensitive" =
    category === "security" || draft.touchesSensitive ? "sensitive" : "standard";
  const controls = Object.values(context.controls);
  const shipGateReady =
    budgetRemaining > 0 &&
    controls.length > 0 &&
    controls.every((control) => control.status === "passed" && nonEmptyString(control.evidence)) &&
    PRODUCT_SHIP_GATE_ANCHORS.every(
      (anchor) => context.anchors[anchor]?.status === "passed" && nonEmptyString(context.anchors[anchor]?.evidence),
    );
  return {
    kind: "ready",
    productRunId: expectedRunId,
    proposalId: context.proposalId,
    scope: draft.scope,
    scopeHash: createHash("sha256").update(draft.scope).digest("hex"),
    riskClass,
    category,
    touchesSensitive: draft.touchesSensitive,
    budgetRemaining,
    rollbackArtifact,
    scopeEvidence: draft.evidence,
    reviewReason: context.reviewReason,
    shipGateReady,
  };
};

const graphAnchorHasEvidence = (
  anchors: GraphEngineeringContext["anchors"],
  name: GraphAnchorName,
  attempt: number,
): anchors is GraphEngineeringContext["anchors"] => {
  const anchor: GraphAnchorResult | undefined = anchors[name];
  return (
    anchor?.status === "passed" &&
    nonEmptyString(anchor.evidence) &&
    (name === "model-contract" || anchor.attempt === attempt)
  );
};

export const inspectGraphChild = (
  expectedRunId: string,
  snapshot: PersistedGraphSnapshot,
  acceptedSignals: readonly AcceptedChildSignal[],
  expectedModelHash?: string,
): GraphChildInspection => {
  const context = snapshot.context;
  if (snapshot.runId !== expectedRunId || context.runId !== expectedRunId) {
    return { kind: "invalid", issues: ["Graph run ID does not match the delivery reference"] };
  }

  const matchingApproval = acceptedSignals.find(
    (signal) =>
      signal.eventType === "MODEL_APPROVED" &&
      signal.source === "human" &&
      signal.producer === "human-owner" &&
      typeof signal.payload.modelHash === "string" &&
      signal.payload.modelHash === context.modelHash &&
      (expectedModelHash === undefined || signal.payload.modelHash === expectedModelHash) &&
      signal.evidence.some(nonEmptyString),
  );
  const rejection = acceptedSignals.find(
    (signal) => signal.eventType === "MODEL_REJECTED" && signal.source === "human" && signal.producer === "human-owner",
  );

  if (rejection)
    return { kind: "rejected", evidence: rejection.evidence.find(nonEmptyString) ?? "Graph model rejected by owner" };
  if (["failed", "blocked", "cancelled"].includes(snapshot.state)) {
    return {
      kind: snapshot.state as "failed" | "blocked" | "cancelled",
      evidence: context.terminalReason ?? `Graph child ended in ${snapshot.state}`,
    };
  }
  if (snapshot.state === "ready") {
    if (!matchingApproval || !context.modelHash || context.approvedModelHash !== context.modelHash) {
      return { kind: "waiting", state: snapshot.state };
    }
    if (expectedModelHash !== undefined && context.modelHash !== expectedModelHash) {
      return { kind: "waiting", state: snapshot.state };
    }
    return {
      kind: "ready",
      modelHash: context.modelHash,
      evidence: matchingApproval.evidence.find(nonEmptyString) ?? "Graph approval confirmed",
    };
  }
  if (snapshot.state === "implementing") {
    if (
      !context.modelHash ||
      context.approvedModelHash !== context.modelHash ||
      !matchingApproval ||
      (expectedModelHash !== undefined && context.modelHash !== expectedModelHash)
    ) {
      return { kind: "invalid", issues: ["Graph implementation is missing exact accepted owner approval"] };
    }
    return { kind: "implementing", modelHash: context.modelHash };
  }
  if (snapshot.state === "verifying") {
    if (
      !context.modelHash ||
      context.approvedModelHash !== context.modelHash ||
      !matchingApproval ||
      (expectedModelHash !== undefined && context.modelHash !== expectedModelHash)
    ) {
      return { kind: "invalid", issues: ["Graph verification is missing exact accepted owner approval"] };
    }
    return { kind: "verifying", modelHash: context.modelHash, implementationHash: context.implementationHash };
  }
  if (snapshot.state === "succeeded") {
    const complete = REQUIRED_GRAPH_ANCHORS.every((anchor) =>
      graphAnchorHasEvidence(context.anchors, anchor, context.attempt),
    );
    if (
      !context.modelHash ||
      context.approvedModelHash !== context.modelHash ||
      !matchingApproval ||
      !context.implementationHash ||
      !complete
    ) {
      return {
        kind: "invalid",
        issues: ["Graph succeeded snapshot lacks exact approval, implementation hash, or current required anchors"],
      };
    }
    return {
      kind: "succeeded",
      modelHash: context.modelHash,
      implementationHash: context.implementationHash,
      evidence: context.terminalReason ?? "Graph child succeeded with required anchors",
    };
  }
  return { kind: "waiting", state: snapshot.state };
};

const assertNoHumanSignal = (input: unknown): void => {
  if (isRecord(input) && input.source === "human") {
    throw new Error("delivery child adapter cannot forward a human-source signal");
  }
};

export const submitProductChildSignal = async (
  runner: ProductRunner,
  input: unknown,
): Promise<ProductSubmissionResult> => {
  assertNoHumanSignal(input);
  if (isRecord(input) && input.runId !== runner.snapshot().runId)
    throw new Error("Product signal runId does not match the child runner");
  return runner.submit(input);
};

export const submitGraphChildSignal = async (runner: GraphRunner, input: unknown): Promise<GraphSubmissionResult> => {
  assertNoHumanSignal(input);
  if (isRecord(input) && input.runId !== runner.snapshot().runId)
    throw new Error("Graph signal runId does not match the child runner");
  return runner.submit(input);
};
