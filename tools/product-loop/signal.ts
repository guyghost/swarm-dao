import {
  isRequiredProductAnchor,
  PRODUCT_ALLOWED_CATEGORIES,
  type ProductCategory,
  type ProductEvent,
  type ProductSignalSource,
} from "../../packages/core/src/models/product-loop.machine.js";

export type ProductSignal = Readonly<{
  runId: string;
  type: string;
  source: ProductSignalSource;
  producer: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}>;

export type ProductSignalValidation =
  | Readonly<{ ok: true; signal: ProductSignal; event: ProductEvent }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

// Event type -> the sole permitted source kind. Mirrors the authority table in
// models/product-loop.md. A caller-supplied `source` label is rejected if it
// disagrees with this table.
const EVENT_SOURCES = {
  AGENT_SIGNAL: "ai",
  FEEDBACK_AGGREGATED: "ai",
  PROPOSAL_DRAFTED: "ai",
  OPEN_PROPOSITION: "tool",
  QUALIFICATION_RUN: "tool",
  VOTE_OPENED: "tool",
  VOTE_CAST: "tool",
  VOTE_EVALUATE: "system",
  VOTE_EXPIRED: "tool",
  BUDGET_CHARGE: "tool",
  EXECUTION_DONE: "tool",
  VERIFY_RUN: "tool",
  VERIFY_EVALUATE: "system",
  OBSERVATION_SAMPLE: "tool",
  OBSERVATION_EVALUATE: "system",
  ANCHOR_RECORDED: "tool",
  CORRECTIVE_PROPOSITION_OPENED: "tool",
  REVIEW_RESOLVED: "human",
  RETRY_VERIFICATION_AUTHORIZED: "human",
  CONTACT_VOTE_OPENED: "tool",
  CONTACT_VOTE_QUORUM: "tool",
  CONTACT_RELAY_AUTHORIZED: "human",
  PERMISSION_DENIED: "tool",
  CANCEL: "human",
} as const satisfies Record<ProductEvent["type"], ProductSignalSource>;

type KnownEventType = keyof typeof EVENT_SOURCES;

// System-emitted evaluation events have no graph producer node (the runner emits
// them after recording evidence). Every other event must come from a declared
// producer node whose authority is bound in models/product-loop.graph.json.
const SYSTEM_EVENTS = new Set<KnownEventType>(["VOTE_EVALUATE", "VERIFY_EVALUATE", "OBSERVATION_EVALUATE"]);

// Producer node -> { declared source, emitted event types }. Mirrors the frozen
// graph so a signal's authority is bound to its producer's declared node, not to
// a caller-supplied `source` label. An AI producer ("explorer") therefore can
// never emit a human-authority event (CANCEL / REVIEW_RESOLVED / CONTACT_RELAY).
const PRODUCER_EMISSIONS: Readonly<
  Record<string, Readonly<{ source: ProductSignalSource; emits: ReadonlySet<string> }>>
> = {
  explorer: { source: "ai", emits: new Set(["AGENT_SIGNAL", "FEEDBACK_AGGREGATED", "PROPOSAL_DRAFTED"]) },
  "feedback-aggregator": { source: "ai", emits: new Set(["FEEDBACK_AGGREGATED"]) },
  proposer: { source: "ai", emits: new Set(["PROPOSAL_DRAFTED"]) },
  "proposition-gate": { source: "tool", emits: new Set(["OPEN_PROPOSITION"]) },
  qualifier: { source: "tool", emits: new Set(["QUALIFICATION_RUN", "PERMISSION_DENIED"]) },
  "vote-tally": { source: "tool", emits: new Set(["VOTE_OPENED", "VOTE_CAST", "VOTE_EXPIRED"]) },
  "budget-ledger": { source: "tool", emits: new Set(["BUDGET_CHARGE", "EXECUTION_DONE"]) },
  verifier: { source: "tool", emits: new Set(["VERIFY_RUN", "ANCHOR_RECORDED", "PERMISSION_DENIED"]) },
  "observation-gate": { source: "tool", emits: new Set(["OBSERVATION_SAMPLE"]) },
  "rollback-opener": { source: "tool", emits: new Set(["CORRECTIVE_PROPOSITION_OPENED"]) },
  "contact-relay": { source: "tool", emits: new Set(["CONTACT_VOTE_OPENED", "CONTACT_VOTE_QUORUM"]) },
  "human-owner": {
    source: "human",
    emits: new Set([
      "REVIEW_RESOLVED",
      "RETRY_VERIFICATION_AUTHORIZED",
      "CONTACT_RELAY_AUTHORIZED",
      "CANCEL",
    ]),
  },
};

// No signal may carry a state-transition target. AI signals additionally may
// not carry any owner-authority key — the LLM produces a signal, never a
// decision. The model decides every transition.
const FORBIDDEN_TRANSITION_KEYS = new Set(["nextState", "targetState", "transition", "target"]);
const FORBIDDEN_AI_AUTHORITY_KEYS = new Set([
  "approval",
  "approve",
  "expandedBudget",
  "resolution",
  "retry",
  "cancel",
  "permission",
  "relay",
  "quorum",
  "vote",
  "favorable",
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

const requiredString = (payload: Readonly<Record<string, unknown>>, key: string, issues: string[]): string => {
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

const asCategory = (value: unknown, issues: string[], path: string): ProductCategory => {
  if (typeof value !== "string" || !(PRODUCT_ALLOWED_CATEGORIES as readonly string[]).includes(value)) {
    issues.push(`${path} must be one of the allowed product categories`);
    return "performance";
  }
  return value as ProductCategory;
};

const buildEvent = (
  type: KnownEventType,
  source: ProductSignalSource,
  payload: Readonly<Record<string, unknown>>,
  evidence: readonly string[],
  issues: string[],
): ProductEvent => {
  switch (type) {
    case "AGENT_SIGNAL":
      return { type, source, note: requiredString(payload, "note", issues) };
    case "FEEDBACK_AGGREGATED":
      return { type, source, summary: requiredString(payload, "summary", issues) };
    case "PROPOSAL_DRAFTED": {
      const draft = payload.draft;
      if (!isRecord(draft)) {
        issues.push("payload.draft must be a ProposalDraft object");
        return { type, source, draft: emptyDraft() };
      }
      // touchesSensitive MUST be an explicit boolean. Defaulting silently to
      // false would let a malformed sensitive draft bypass human deploy review.
      const touchesSensitive = draft.touchesSensitive;
      if (typeof touchesSensitive !== "boolean") {
        issues.push("payload.draft.touchesSensitive must be an explicit boolean");
      }
      return {
        type,
        source,
        draft: {
          scope: requiredString(draft, "scope", issues),
          category: asCategory(draft.category, issues, "payload.draft.category"),
          touchesSensitive: typeof touchesSensitive === "boolean" ? touchesSensitive : false,
          dependencies: Array.isArray(draft.dependencies)
            ? draft.dependencies.filter((d): d is string => nonEmptyString(d))
            : [],
          budgetAllocation: typeof draft.budgetAllocation === "number" ? draft.budgetAllocation : 0,
          rollbackArtifact: requiredString(draft, "rollbackArtifact", issues),
          evidence: requiredString(draft, "evidence", issues),
        },
      };
    }
    case "OPEN_PROPOSITION":
      return { type, source };
    case "QUALIFICATION_RUN": {
      // Qualification carries an affirmative, evidence-backed permission
      // clearance. It never passes on the mere absence of a denial.
      const permissionCleared = payload.permissionCleared;
      const permissionEvidence = payload.permissionEvidence;
      if (typeof permissionCleared !== "boolean") {
        issues.push("payload.permissionCleared must be a boolean");
      }
      if (typeof permissionEvidence !== "string" || permissionEvidence.trim() === "") {
        issues.push("payload.permissionEvidence must be a non-empty string");
      }
      return {
        type,
        source,
        permissionCleared: permissionCleared === true,
        permissionEvidence: typeof permissionEvidence === "string" ? permissionEvidence : "",
      };
    }
    case "VOTE_OPENED": {
      const config = payload.config;
      if (!isRecord(config)) {
        issues.push("payload.config must be a VoteConfig object");
        return { type, source, config: { quorum: 1, kind: "standard", expiryHours: 72 } };
      }
      return {
        type,
        source,
        config: {
          quorum: typeof config.quorum === "number" ? config.quorum : 1,
          kind: config.kind === "criticalSecurity" ? "criticalSecurity" : "standard",
          expiryHours: typeof config.expiryHours === "number" ? config.expiryHours : 72,
        },
      };
    }
    case "VOTE_CAST":
      return { type, source, favorable: typeof payload.favorable === "number" ? payload.favorable : 0 };
    case "VOTE_EVALUATE":
      return { type, source };
    case "VOTE_EXPIRED":
      return { type, source };
    case "BUDGET_CHARGE": {
      const action = payload.action;
      if (!isRecord(action)) {
        issues.push("payload.action must be a BudgetAction object");
        return { type, source, action: { amount: 0, description: "", evidence: "" } };
      }
      return {
        type,
        source,
        action: {
          amount: typeof action.amount === "number" ? action.amount : 0,
          description: requiredString(action, "description", issues),
          evidence: requiredString(action, "evidence", issues),
        },
      };
    }
    case "EXECUTION_DONE":
      return { type, source };
    case "VERIFY_RUN": {
      const control = payload.control;
      if (!isRecord(control)) {
        issues.push("payload.control must be a ControlResult object");
        return { type, source, control: { name: "", status: "failed", evidence: "" } };
      }
      return {
        type,
        source,
        control: {
          name: requiredString(control, "name", issues),
          status: control.status === "passed" ? "passed" : "failed",
          evidence: requiredString(control, "evidence", issues),
        },
      };
    }
    case "VERIFY_EVALUATE":
      return { type, source };
    case "OBSERVATION_SAMPLE": {
      const sample = payload.sample;
      if (!isRecord(sample)) {
        issues.push("payload.sample must be an ObservationSample object");
        return { type, source, sample: { metric: "errors", value: 0, threshold: 0, exceeded: false, evidence: "" } };
      }
      const metric = ["errors", "aiCost", "latency", "satisfaction"].includes(String(sample.metric))
        ? (String(sample.metric) as "errors" | "aiCost" | "latency" | "satisfaction")
        : "errors";
      return {
        type,
        source,
        sample: {
          metric,
          value: typeof sample.value === "number" ? sample.value : 0,
          threshold: typeof sample.threshold === "number" ? sample.threshold : 0,
          exceeded: typeof sample.exceeded === "boolean" ? sample.exceeded : false,
          evidence: requiredString(sample, "evidence", issues),
        },
      };
    }
    case "OBSERVATION_EVALUATE":
      return { type, source, windowElapsed: payload.windowElapsed === true };
    case "ANCHOR_RECORDED": {
      const anchor = payload.anchor;
      if (!isRequiredProductAnchor(anchor)) {
        issues.push("payload.anchor must be a required product anchor");
      }
      const status = payload.status;
      if (status !== "passed" && status !== "failed") {
        issues.push('payload.status must be "passed" or "failed"');
      }
      return {
        type,
        source,
        anchor: isRequiredProductAnchor(anchor) ? anchor : "regression",
        status: status === "failed" ? "failed" : "passed",
        evidence: firstEvidence(evidence, issues),
      };
    }
    case "CORRECTIVE_PROPOSITION_OPENED":
      return { type, source };
    case "REVIEW_RESOLVED": {
      const resolution = payload.resolution;
      if (resolution !== "scope-reduced" && resolution !== "budget-expanded" && resolution !== "abandoned") {
        issues.push("payload.resolution must be scope-reduced, budget-expanded, or abandoned");
      }
      return {
        type,
        source,
        resolution:
          resolution === "budget-expanded"
            ? "budget-expanded"
            : resolution === "scope-reduced"
              ? "scope-reduced"
              : "abandoned",
        expandedBudget: typeof payload.expandedBudget === "number" ? payload.expandedBudget : undefined,
      };
    }
    case "RETRY_VERIFICATION_AUTHORIZED":
      return { type, source };
    case "CONTACT_VOTE_OPENED":
      return { type, source };
    case "CONTACT_VOTE_QUORUM":
      return { type, source, reached: payload.reached === true };
    case "CONTACT_RELAY_AUTHORIZED":
      return { type, source };
    case "PERMISSION_DENIED":
      return { type, source, reason: requiredString(payload, "reason", issues) };
    case "CANCEL":
      return { type, source, reason: requiredString(payload, "reason", issues) };
  }
};

const emptyDraft = () => ({
  scope: "",
  category: "performance" as ProductCategory,
  touchesSensitive: false,
  dependencies: [] as readonly string[],
  budgetAllocation: 0,
  rollbackArtifact: "",
  evidence: "",
});

export const validateProductSignal = (input: unknown): ProductSignalValidation => {
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
  // Use an own-property lookup so an unknown event whose type collides with an
  // inherited key (e.g. "toString", "__proto__") is never misclassified as known.
  const knownType = typeof type === "string" && Object.hasOwn(EVENT_SOURCES, type) ? (type as KnownEventType) : null;
  if (!knownType) issues.push("type must be a known product event");

  const source = input.source;
  const validSource = source === "ai" || source === "tool" || source === "human" || source === "system";
  if (!validSource) issues.push("source must be ai, tool, human, or system");
  if (knownType && validSource && EVENT_SOURCES[knownType] !== source) {
    issues.push(`source for ${knownType} must be ${EVENT_SOURCES[knownType]}`);
  }

  // Bind the event's authority to the producer's declared graph node. System
  // evaluation events are emitted by the runner and have no producer node.
  // Own-property lookup so a caller-supplied prototype key (e.g. "__proto__")
  // can never resolve to a real producer declaration.
  const producer = typeof input.producer === "string" ? input.producer : "";
  if (knownType && !SYSTEM_EVENTS.has(knownType)) {
    const declared = Object.hasOwn(PRODUCER_EMISSIONS, producer) ? PRODUCER_EMISSIONS[producer] : null;
    if (!declared) {
      issues.push(`producer ${producer || "?"} is not a declared graph producer for ${knownType}`);
    } else {
      if (!declared.emits.has(knownType)) {
        issues.push(`producer ${producer} is not declared to emit ${knownType}`);
      }
      if (validSource && declared.source !== source) {
        issues.push(`producer ${producer} must use source ${declared.source}, not ${source}`);
      }
    }
  }

  // No signal may carry a state target. AI signals may not carry any
  // owner-authority field. The model — never the signal — decides transitions.
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
