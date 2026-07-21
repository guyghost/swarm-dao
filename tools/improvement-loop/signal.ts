import {
  type ImprovementEvent,
  type ImprovementSignalSource,
  isRequiredImprovementAnchor,
} from "../../packages/core/src/models/improvement-loop.machine.js";

export type ImprovementSignal = Readonly<{
  cycleId: string;
  type: string;
  source: ImprovementSignalSource;
  producer: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}>;

export type ImprovementSignalValidation =
  | Readonly<{ ok: true; signal: ImprovementSignal; event: ImprovementEvent }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

const EVENT_SOURCES = {
  METRIC_SAMPLED: "ai",
  COUNTER_SAMPLED: "ai",
  SAMPLES_SEALED: "tool",
  DRIFT_ESTIMATE: "ai",
  ARBITRATION: "tool",
  ANCHOR_RECORDED: "tool",
  EVALUATE: "system",
  REFERENCE_CHANGE_APPROVED: "human",
  REFERENCE_CHANGE_REJECTED: "human",
  RETRY_AUTHORIZED: "human",
  PERMISSION_DENIED: "tool",
  CANCEL: "human",
} as const satisfies Record<ImprovementEvent["type"], ImprovementSignalSource>;

type KnownEventType = keyof typeof EVENT_SOURCES;

const FORBIDDEN_TRANSITION_KEYS = new Set(["nextState", "targetState", "transition"]);
const FORBIDDEN_AI_AUTHORITY_KEYS = new Set([
  "command",
  "cmd",
  "shell",
  "approval",
  "approve",
  "referenceHash",
  "reference",
  "target",
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

const requireSample = (
  payload: Readonly<Record<string, unknown>>,
  issues: string[],
): { value: string; evidence: string } => {
  const sample = payload.sample;
  if (!isRecord(sample) || !nonEmptyString(sample.value) || !nonEmptyString(sample.evidence)) {
    issues.push("payload.sample must be { value: string, evidence: string }");
    return { value: "", evidence: "" };
  }
  return { value: sample.value as string, evidence: sample.evidence as string };
};

const buildEvent = (
  type: KnownEventType,
  source: ImprovementSignalSource,
  payload: Readonly<Record<string, unknown>>,
  evidence: readonly string[],
  issues: string[],
): ImprovementEvent => {
  switch (type) {
    case "METRIC_SAMPLED": {
      const sample = requireSample(payload, issues);
      firstEvidence(evidence, issues);
      return { type, source, sample };
    }
    case "COUNTER_SAMPLED": {
      const sample = requireSample(payload, issues);
      firstEvidence(evidence, issues);
      return { type, source, sample };
    }
    case "SAMPLES_SEALED":
      return { type, source };
    case "DRIFT_ESTIMATE": {
      const driftClass = payload.driftClass;
      if (driftClass !== "none" && driftClass !== "partial" && driftClass !== "detached") {
        issues.push("payload.driftClass must be none, partial, or detached");
      }
      return {
        type,
        source,
        driftClass: driftClass === "detached" ? "detached" : driftClass === "partial" ? "partial" : "none",
      };
    }
    case "ARBITRATION":
      return { type, source, outcome: requiredPayloadString(payload, "outcome", issues) };
    case "ANCHOR_RECORDED": {
      const anchor = payload.anchor;
      if (!isRequiredImprovementAnchor(anchor)) {
        issues.push("payload.anchor must be a required improvement anchor");
      }
      const status = payload.status;
      if (status !== "passed" && status !== "failed") {
        issues.push('payload.status must be "passed" or "failed"');
      }
      return {
        type,
        source,
        anchor: isRequiredImprovementAnchor(anchor) ? anchor : "regression",
        status: status === "failed" ? "failed" : "passed",
        evidence: firstEvidence(evidence, issues),
      };
    }
    case "EVALUATE":
      return { type, source };
    case "REFERENCE_CHANGE_APPROVED":
      return { type, source, referenceHash: requiredPayloadString(payload, "referenceHash", issues) };
    case "REFERENCE_CHANGE_REJECTED":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
    case "RETRY_AUTHORIZED":
      return { type, source };
    case "PERMISSION_DENIED":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
    case "CANCEL":
      return { type, source, reason: requiredPayloadString(payload, "reason", issues) };
  }
};

export const validateImprovementSignal = (input: unknown): ImprovementSignalValidation => {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["signal must be an object"] };

  if (!nonEmptyString(input.cycleId)) issues.push("cycleId must be a non-empty string");
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
  if (!knownType) issues.push("type must be a known improvement event");

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
      cycleId: input.cycleId as string,
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
