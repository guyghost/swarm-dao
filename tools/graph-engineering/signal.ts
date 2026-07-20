import {
  type GraphEngineeringEvent,
  type GraphSignalSource,
  isRequiredGraphAnchor,
} from "../../packages/core/src/models/graph-engineering.machine.js";

export type GraphSignal = Readonly<{
  runId: string;
  type: string;
  source: GraphSignalSource;
  producer: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}>;

export type GraphSignalValidation =
  | Readonly<{ ok: true; signal: GraphSignal; event: GraphEngineeringEvent }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

const EVENT_SOURCES = {
  MODEL_DRAFTED: "ai",
  MODEL_CONTRACT_VALID: "tool",
  MODEL_CONTRACT_INVALID: "tool",
  MODEL_APPROVED: "human",
  MODEL_REJECTED: "human",
  START_IMPLEMENTATION: "system",
  IMPLEMENTATION_READY: "ai",
  IMPLEMENTATION_FAILED: "ai",
  ANCHOR_RECORDED: "tool",
  EVALUATE: "system",
  RETRY_AUTHORIZED: "human",
  PERMISSION_DENIED: "tool",
  CANCEL: "human",
} as const satisfies Record<GraphEngineeringEvent["type"], GraphSignalSource>;

type KnownEventType = keyof typeof EVENT_SOURCES;

const FORBIDDEN_TRANSITION_KEYS = new Set(["nextState", "targetState", "transition"]);
const FORBIDDEN_AI_AUTHORITY_KEYS = new Set([
  "command",
  "cmd",
  "shell",
  "approval",
  "approve",
  "retry",
  "cancel",
  "permission",
]);

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

const requiredPayloadString = (payload: Readonly<Record<string, unknown>>, key: string, issues: string[]): string => {
  const value = payload[key];
  if (!nonEmptyString(value)) {
    issues.push(`payload.${key} must be a non-empty string`);
    return "";
  }
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
  source: GraphSignalSource,
  payload: Readonly<Record<string, unknown>>,
  evidence: readonly string[],
  issues: string[],
): GraphEngineeringEvent => {
  switch (type) {
    case "MODEL_DRAFTED":
      firstEvidence(evidence, issues);
      return { type, source, modelHash: requiredPayloadString(payload, "modelHash", issues) };
    case "MODEL_CONTRACT_VALID":
      return { type, source, evidence: firstEvidence(evidence, issues) };
    case "MODEL_CONTRACT_INVALID":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
    case "MODEL_APPROVED":
      return { type, source, modelHash: requiredPayloadString(payload, "modelHash", issues) };
    case "MODEL_REJECTED":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
    case "START_IMPLEMENTATION":
      return { type, source };
    case "IMPLEMENTATION_READY":
      firstEvidence(evidence, issues);
      return { type, source, implementationHash: requiredPayloadString(payload, "implementationHash", issues) };
    case "IMPLEMENTATION_FAILED":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
    case "ANCHOR_RECORDED": {
      const anchor = payload.anchor;
      if (!isRequiredGraphAnchor(anchor) || anchor === "model-contract") {
        issues.push("payload.anchor must be a permitted implementation anchor");
      }
      const status = payload.status;
      if (status !== "passed" && status !== "failed") {
        issues.push('payload.status must be "passed" or "failed"');
      }
      return {
        type,
        source,
        anchor: isRequiredGraphAnchor(anchor) ? anchor : "graph-tests",
        status: status === "failed" ? "failed" : "passed",
        evidence: firstEvidence(evidence, issues),
      };
    }
    case "EVALUATE":
      return { type, source };
    case "RETRY_AUTHORIZED":
      return { type, source };
    case "PERMISSION_DENIED":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
    case "CANCEL":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
  }
};

export const validateGraphSignal = (input: unknown): GraphSignalValidation => {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["signal must be an object"] };

  if (!nonEmptyString(input.runId)) issues.push("runId must be a non-empty string");
  if (!nonEmptyString(input.producer)) issues.push("producer must be a non-empty string");
  if (!nonEmptyString(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt))) {
    issues.push("occurredAt must be a valid ISO timestamp");
  }
  if (!isRecord(input.payload)) issues.push("payload must be an object");
  if (!Array.isArray(input.evidence) || !input.evidence.every((entry) => typeof entry === "string")) {
    issues.push("evidence must be an array of strings");
  }

  const type = input.type;
  const knownType = typeof type === "string" && type in EVENT_SOURCES ? (type as KnownEventType) : null;
  if (!knownType) issues.push("type must be a known graph event");

  const source = input.source;
  const validSource = source === "ai" || source === "tool" || source === "human" || source === "system";
  if (!validSource) issues.push("source must be ai, tool, human, or system");
  if (knownType && validSource && EVENT_SOURCES[knownType] !== source) {
    issues.push(`source for ${knownType} must be ${EVENT_SOURCES[knownType]}`);
  }

  issues.push(...findForbiddenKeys(input, FORBIDDEN_TRANSITION_KEYS));
  if (source === "ai") issues.push(...findForbiddenKeys(input, FORBIDDEN_AI_AUTHORITY_KEYS));

  const payload = isRecord(input.payload) ? input.payload : {};
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.filter((entry): entry is string => typeof entry === "string")
    : [];
  const event = knownType && validSource ? buildEvent(knownType, source, payload, evidence, issues) : null;

  if (issues.length > 0 || !event) return { ok: false, issues };
  return {
    ok: true,
    signal: {
      runId: input.runId as string,
      type: knownType,
      source,
      producer: input.producer as string,
      occurredAt: input.occurredAt as string,
      payload,
      evidence,
    },
    event,
  };
};
