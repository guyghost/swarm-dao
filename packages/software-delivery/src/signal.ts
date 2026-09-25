import type { DeliverySignalSource, SoftwareDeliveryEvent } from "@guyghost/swarm-dao-core";

export type DeliverySignal = Readonly<{
  runId: string;
  type: string;
  source: DeliverySignalSource;
  producer: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}>;

export type DeliverySignalValidation =
  | Readonly<{ ok: true; signal: DeliverySignal; event: SoftwareDeliveryEvent }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

type EventAuthority = Readonly<{ source: DeliverySignalSource; producers: readonly string[] }>;

/** Authority table frozen with the approved delivery model. */
export const DELIVERY_EVENT_PRODUCERS = {
  INTAKE_ACCEPTED: { source: "tool", producers: ["intake-validator"] },
  INTAKE_REJECTED: { source: "tool", producers: ["intake-validator"] },
  RISK_CLASSIFICATION_RESOLVED: { source: "human", producers: ["human-owner"] },
  GRAPH_MODEL_DRAFTED: { source: "ai", producers: ["modeler"] },
  MODEL_CONTRACT_VALID: { source: "tool", producers: ["model-contract-validator"] },
  MODEL_CONTRACT_INVALID: { source: "tool", producers: ["model-contract-validator"] },
  GRAPH_APPROVAL_CONFIRMED: { source: "tool", producers: ["graph-child-adapter"] },
  GRAPH_APPROVAL_REJECTED: { source: "tool", producers: ["graph-child-adapter"] },
  GRAPH_IMPLEMENTATION_STARTED: { source: "tool", producers: ["graph-child-adapter"] },
  GRAPH_IMPLEMENTATION_SUCCEEDED: { source: "tool", producers: ["graph-child-adapter"] },
  CHILD_FAILED: { source: "tool", producers: ["graph-child-adapter", "product-child-adapter"] },
  CHILD_BLOCKED: { source: "tool", producers: ["graph-child-adapter", "product-child-adapter"] },
  CHILD_CANCELLED: { source: "tool", producers: ["graph-child-adapter", "product-child-adapter"] },
  PRODUCT_REVIEW_REQUIRED: { source: "tool", producers: ["product-child-adapter"] },
  PRODUCT_REVIEW_BLOCKED: { source: "tool", producers: ["product-child-adapter"] },
  PRODUCT_SHIP_READY: { source: "tool", producers: ["product-child-adapter"] },
  PRODUCT_SHIP_AUTHORIZED: { source: "tool", producers: ["product-child-adapter"] },
  SHIP_CAPABILITY_MISSING: { source: "tool", producers: ["staging-target"] },
  SHIP_CAPABILITY_CONFIRMED: { source: "tool", producers: ["staging-target"] },
  SHIP_CONFIRMED: { source: "tool", producers: ["effect-executor"] },
  OBSERVATION_SAMPLE_RECORDED: { source: "tool", producers: ["observer"] },
  OBSERVATION_VALIDATED: { source: "tool", producers: ["product-child-adapter"] },
  ROLLBACK_REQUIRED: { source: "tool", producers: ["product-child-adapter"] },
  ROLLBACK_CONFIRMED: { source: "tool", producers: ["staging-target"] },
  CORRECTIVE_TASK_OPENED: { source: "tool", producers: ["product-child-adapter"] },
  CANCEL_REQUESTED: { source: "human", producers: ["human-owner"] },
  CANCEL_SETTLED: { source: "tool", producers: ["effect-executor"] },
} as const satisfies Record<SoftwareDeliveryEvent["type"], EventAuthority>;

type KnownEventType = keyof typeof DELIVERY_EVENT_PRODUCERS;

const FORBIDDEN_TRANSITION_KEYS = new Set(["nextState", "targetState", "transition", "target"]);
const FORBIDDEN_AI_AUTHORITY_KEYS = new Set([
  "approval",
  "approve",
  "approvedModelHash",
  "cancel",
  "cancellationRequested",
  "command",
  "cmd",
  "modelHash",
  "permission",
  "risk",
  "riskClass",
  "retry",
  "shell",
]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const findForbiddenKeys = (value: unknown, forbidden: ReadonlySet<string>, path = "signal"): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenKeys(entry, forbidden, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(forbidden.has(key) ? [`${path}.${key} is forbidden`] : []),
    ...findForbiddenKeys(entry, forbidden, `${path}.${key}`),
  ]);
};

const requiredString = (payload: Readonly<Record<string, unknown>>, key: string, issues: string[]): string => {
  const value = payload[key];
  if (!nonEmptyString(value)) {
    issues.push(`payload.${key} must be a non-empty string`);
    return "";
  }
  return value;
};

const requiredHash = (payload: Readonly<Record<string, unknown>>, key: string, issues: string[]): string => {
  const value = requiredString(payload, key, issues);
  if (value !== "" && !SHA256_PATTERN.test(value)) issues.push(`payload.${key} must be a lowercase SHA-256 hash`);
  return value;
};

const firstEvidence = (evidence: readonly string[], issues: string[]): string => {
  const value = evidence.find(nonEmptyString);
  if (!value) {
    issues.push("evidence must contain at least one non-empty entry");
    return "";
  }
  return value;
};

const buildEvent = (
  type: KnownEventType,
  source: DeliverySignalSource,
  payload: Readonly<Record<string, unknown>>,
  evidence: readonly string[],
  issues: string[],
): SoftwareDeliveryEvent => {
  const evidenceReference = firstEvidence(evidence, issues);
  switch (type) {
    case "INTAKE_ACCEPTED":
    case "INTAKE_REJECTED":
    case "MODEL_CONTRACT_INVALID":
    case "GRAPH_APPROVAL_REJECTED":
    case "GRAPH_IMPLEMENTATION_STARTED":
    case "CHILD_FAILED":
    case "CHILD_BLOCKED":
    case "CHILD_CANCELLED":
    case "PRODUCT_REVIEW_REQUIRED":
    case "PRODUCT_REVIEW_BLOCKED":
    case "PRODUCT_SHIP_READY":
    case "PRODUCT_SHIP_AUTHORIZED":
    case "SHIP_CAPABILITY_MISSING":
    case "SHIP_CAPABILITY_CONFIRMED":
    case "OBSERVATION_SAMPLE_RECORDED":
    case "OBSERVATION_VALIDATED":
    case "ROLLBACK_REQUIRED":
    case "ROLLBACK_CONFIRMED":
    case "CORRECTIVE_TASK_OPENED":
    case "CANCEL_REQUESTED":
    case "CANCEL_SETTLED":
      return { type, source, evidence: evidenceReference };
    case "RISK_CLASSIFICATION_RESOLVED": {
      const riskClass = payload.riskClass;
      if (riskClass !== "standard" && riskClass !== "sensitive") {
        issues.push('payload.riskClass must be "standard" or "sensitive"');
      }
      return {
        type,
        source,
        riskClass: riskClass === "sensitive" ? "sensitive" : "standard",
        evidence: evidenceReference,
      };
    }
    case "GRAPH_MODEL_DRAFTED":
      return {
        type,
        source,
        modelArtifactHash: requiredHash(payload, "modelArtifactHash", issues),
        evidence: evidenceReference,
      };
    case "MODEL_CONTRACT_VALID":
      return { type, source, modelHash: requiredHash(payload, "modelHash", issues), evidence: evidenceReference };
    case "GRAPH_APPROVAL_CONFIRMED":
      return { type, source, modelHash: requiredHash(payload, "modelHash", issues), evidence: evidenceReference };
    case "GRAPH_IMPLEMENTATION_SUCCEEDED":
      return {
        type,
        source,
        implementationHash: requiredHash(payload, "implementationHash", issues),
        artifactHash: requiredHash(payload, "artifactHash", issues),
        evidence: evidenceReference,
      };
    case "SHIP_CONFIRMED":
      return { type, source, artifactHash: requiredHash(payload, "artifactHash", issues), evidence: evidenceReference };
  }
};

export const validateDeliverySignal = (input: unknown, expectedRunId?: string): DeliverySignalValidation => {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["signal must be an object"] };

  const runId = input.runId;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || runId.includes("..")) {
    issues.push("runId must be a safe 1-128 character delivery ID");
  }
  if (expectedRunId !== undefined && runId !== expectedRunId) issues.push("runId does not match the active delivery");
  if (!nonEmptyString(input.producer)) issues.push("producer must be a non-empty string");
  if (!nonEmptyString(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt))) {
    issues.push("occurredAt must be a valid ISO timestamp");
  }
  if (!isRecord(input.payload)) issues.push("payload must be an object");
  if (!Array.isArray(input.evidence) || !input.evidence.every((entry) => typeof entry === "string")) {
    issues.push("evidence must be an array of strings");
  }

  const type = input.type;
  const knownType =
    typeof type === "string" && Object.hasOwn(DELIVERY_EVENT_PRODUCERS, type) ? (type as KnownEventType) : null;
  if (!knownType) issues.push("type must be a known software delivery event");

  const source = input.source;
  const validSource = source === "ai" || source === "tool" || source === "human" || source === "system";
  if (!validSource) issues.push("source must be ai, tool, human, or system");

  if (knownType && validSource) {
    const authority = DELIVERY_EVENT_PRODUCERS[knownType];
    if (authority.source !== source) issues.push(`source for ${knownType} must be ${authority.source}`);
    const producer = typeof input.producer === "string" ? input.producer : "";
    if (!authority.producers.some((allowedProducer) => allowedProducer === producer)) {
      issues.push(`producer ${producer || "?"} is not declared for ${knownType}`);
    }
  }

  issues.push(...findForbiddenKeys(input, FORBIDDEN_TRANSITION_KEYS));
  if (source === "ai") issues.push(...findForbiddenKeys(input, FORBIDDEN_AI_AUTHORITY_KEYS));

  const payload = isRecord(input.payload) ? input.payload : {};
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.filter((entry): entry is string => typeof entry === "string")
    : [];
  const event = knownType && validSource ? buildEvent(knownType, source, payload, evidence, issues) : null;

  if (
    issues.length > 0 ||
    !event ||
    !knownType ||
    typeof runId !== "string" ||
    typeof input.producer !== "string" ||
    typeof input.occurredAt !== "string"
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    signal: {
      runId,
      type: knownType,
      source: source as DeliverySignalSource,
      producer: input.producer,
      occurredAt: input.occurredAt,
      payload,
      evidence,
    },
    event,
  };
};
