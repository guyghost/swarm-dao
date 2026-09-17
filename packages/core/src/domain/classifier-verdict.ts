/**
 * Classifier Verdict — cheap typed decision layer (TypeSafe / System One).
 *
 * Generation produces artifacts. This module consumes a closed-vocabulary JSON
 * signal and composes it with tool evidence. The harness routes on the
 * structured result; it never parses free-form prose. Validation is pure,
 * read-only, and never throws for control flow — same contract as
 * `dao_check_edit` / `evaluateGraphAttempt`.
 *
 * The model does not pick a machine state. `done` requests evaluation;
 * tools and `evaluateAttempt` decide whether to continue, escalate, or
 * hand the attempt to Graph Engineering EVALUATE.
 */

import { MAX_EDIT_PATHS, normalizeEditPath } from "../governance/edit-gate.js";

export const VERDICT_STATUSES = ["done", "retry", "escalate"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export const FAILURE_TYPES = [
  "none",
  "type_error",
  "test_failure",
  "lint_error",
  "build_error",
  "runtime_error",
  "unknown",
] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

export const NEXT_ACTIONS = ["edit_file", "run_tests", "finish", "handoff_human"] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const TOOL_CHECK_STATUSES = ["passed", "failed", "blocked", "not_run"] as const;
export type ToolCheckStatus = (typeof TOOL_CHECK_STATUSES)[number];

export interface ClassifierVerdict {
  readonly status: VerdictStatus;
  readonly confidence: number;
  readonly failureType: FailureType;
  readonly nextAction: NextAction;
  readonly affectedPaths: readonly string[];
  readonly reason: string;
}

export interface ToolEvidence {
  readonly tests: ToolCheckStatus;
  readonly types: ToolCheckStatus;
  readonly lint: ToolCheckStatus;
}

export interface AttemptState {
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly minConfidence: number;
}

export type VerdictValidation =
  | { readonly ok: true; readonly verdict: ClassifierVerdict }
  | { readonly ok: false; readonly errors: readonly string[] };

export type AttemptDecision =
  | { readonly kind: "re_prompt"; readonly errors: readonly string[] }
  | {
      readonly kind: "continue";
      readonly nextAction: NextAction;
      readonly affectedPaths: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: "request_evaluation"; readonly reason: string }
  | { readonly kind: "escalate"; readonly reason: string }
  | { readonly kind: "block"; readonly reason: string };

const MAX_REASON = 500;
const ALLOWED_KEYS = new Set(["status", "confidence", "failureType", "nextAction", "affectedPaths", "reason"]);

const isVerdictStatus = (value: unknown): value is VerdictStatus =>
  typeof value === "string" && (VERDICT_STATUSES as readonly string[]).includes(value);

const isFailureType = (value: unknown): value is FailureType =>
  typeof value === "string" && (FAILURE_TYPES as readonly string[]).includes(value);

const isNextAction = (value: unknown): value is NextAction =>
  typeof value === "string" && (NEXT_ACTIONS as readonly string[]).includes(value);

/**
 * Prompt contract for coding-loop agents. Layers onto a role prompt; it does
 * not replace AGENT_CHARTER (deliberation votes stay markdown).
 */
export const CLASSIFIER_CHARTER = `You are a coding-loop worker. The harness routes on a typed JSON verdict, never on prose. After each turn, emit ONLY a JSON object with these keys (no markdown fences, no extra keys):

{
  "status": "done" | "retry" | "escalate",
  "confidence": 0.0,
  "failureType": "none" | "type_error" | "test_failure" | "lint_error" | "build_error" | "runtime_error" | "unknown",
  "nextAction": "edit_file" | "run_tests" | "finish" | "handoff_human",
  "affectedPaths": ["path/relative/to/repo.ts"],
  "reason": "one sentence, <= 500 chars"
}

Rules:
- status "done" requires failureType "none" and nextAction "finish". It requests evaluation; tools still decide.
- status "retry" requires a real failureType and nextAction "edit_file" or "run_tests".
- status "escalate" requires nextAction "handoff_human".
- nextAction "edit_file" requires a non-empty affectedPaths list (repository-relative, forward slashes).
- Do not claim tests passed. The harness runs tools. Low confidence escalates.`;

export function validateVerdict(input: unknown): VerdictValidation {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["verdict must be a JSON object"] };
  }

  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown key: "${key}"`);
  }

  if (!isVerdictStatus(obj.status)) {
    errors.push(`status must be one of ${VERDICT_STATUSES.join(" | ")}`);
  }

  const confidence = obj.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("confidence must be a number in [0, 1]");
  }

  if (!isFailureType(obj.failureType)) {
    errors.push(`failureType must be one of ${FAILURE_TYPES.join(" | ")}`);
  }

  if (!isNextAction(obj.nextAction)) {
    errors.push(`nextAction must be one of ${NEXT_ACTIONS.join(" | ")}`);
  }

  const paths = obj.affectedPaths;
  const normalized: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(paths)) {
    errors.push("affectedPaths must be an array");
  } else if (paths.length > MAX_EDIT_PATHS) {
    errors.push(`affectedPaths exceeds ${MAX_EDIT_PATHS} entries`);
  } else {
    for (const raw of paths) {
      if (typeof raw !== "string") {
        errors.push(`unmatchable path refused: ${JSON.stringify(raw)}`);
        continue;
      }
      const result = normalizeEditPath(raw.trim());
      if (!result.ok) {
        errors.push(`unmatchable path refused: ${JSON.stringify(raw)} (${result.reason})`);
        continue;
      }
      if (seen.has(result.path)) continue;
      seen.add(result.path);
      normalized.push(result.path);
    }
  }

  const reason = obj.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    errors.push("reason must be a non-empty string");
  } else if (reason.length > MAX_REASON) {
    errors.push(`reason exceeds ${MAX_REASON} chars`);
  }

  if (obj.status === "done" && obj.failureType !== "none") {
    errors.push('status "done" requires failureType "none"');
  }
  if (obj.status === "done" && obj.nextAction !== "finish") {
    errors.push('status "done" requires nextAction "finish"');
  }
  if (obj.status === "retry" && obj.failureType === "none") {
    errors.push('status "retry" requires a failureType other than "none"');
  }
  if (obj.status === "retry" && obj.nextAction === "finish") {
    errors.push('status "retry" cannot use nextAction "finish"');
  }
  if (obj.status === "escalate" && obj.nextAction !== "handoff_human") {
    errors.push('status "escalate" requires nextAction "handoff_human"');
  }
  if (obj.nextAction === "edit_file" && normalized.length === 0 && errors.length === 0) {
    errors.push('nextAction "edit_file" requires at least one affectedPaths entry');
  }
  if (obj.nextAction === "finish" && normalized.length > 0) {
    errors.push('nextAction "finish" requires an empty affectedPaths list');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    verdict: {
      status: obj.status as VerdictStatus,
      confidence: confidence as number,
      failureType: obj.failureType as FailureType,
      nextAction: obj.nextAction as NextAction,
      affectedPaths: normalized,
      reason: (reason as string).trim(),
    },
  };
}

export function parseAndValidateVerdict(raw: string): VerdictValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["output is not valid JSON"] };
  }
  return validateVerdict(parsed);
}

const hasStatus = (evidence: ToolEvidence, status: ToolCheckStatus): boolean =>
  evidence.tests === status || evidence.types === status || evidence.lint === status;

const hasAnyPassed = (evidence: ToolEvidence): boolean => hasStatus(evidence, "passed");

/**
 * Compose atomic classifier fields with tool evidence. Ordered, total, never
 * throws. Tools override a lying `done`. Low confidence escalates. `done` with
 * passing tools requests outer evaluation — it does not succeed the run.
 */
export function evaluateAttempt(
  validation: VerdictValidation,
  tools: ToolEvidence,
  state: AttemptState,
): AttemptDecision {
  if (!validation.ok) return { kind: "re_prompt", errors: validation.errors };

  const { verdict } = validation;

  if (hasStatus(tools, "blocked")) {
    return { kind: "block", reason: "a required tool check could not run" };
  }

  if (verdict.status === "escalate" || verdict.confidence < state.minConfidence) {
    return {
      kind: "escalate",
      reason:
        verdict.status === "escalate"
          ? verdict.reason
          : `confidence ${verdict.confidence} is below ${state.minConfidence}`,
    };
  }

  if (hasStatus(tools, "failed")) {
    if (state.retryCount >= state.maxRetries) {
      return { kind: "escalate", reason: "tool checks failed and the inner retry budget is exhausted" };
    }
    const nextAction: NextAction = verdict.nextAction === "run_tests" ? "edit_file" : verdict.nextAction;
    const action: NextAction = nextAction === "finish" || nextAction === "handoff_human" ? "edit_file" : nextAction;
    return {
      kind: "continue",
      nextAction: action === "edit_file" && verdict.affectedPaths.length === 0 ? "run_tests" : action,
      affectedPaths: verdict.affectedPaths,
      reason: verdict.status === "done" ? "tool evidence overrode status done" : verdict.reason,
    };
  }

  if (verdict.status === "done") {
    if (!hasAnyPassed(tools)) {
      if (state.retryCount >= state.maxRetries) {
        return {
          kind: "escalate",
          reason: "status done without tool evidence and the inner retry budget is exhausted",
        };
      }
      return {
        kind: "continue",
        nextAction: "run_tests",
        affectedPaths: [],
        reason: "status done requires tool evidence before evaluation",
      };
    }
    return { kind: "request_evaluation", reason: verdict.reason };
  }

  if (state.retryCount >= state.maxRetries) {
    return { kind: "escalate", reason: "inner retry budget is exhausted" };
  }

  return {
    kind: "continue",
    nextAction: verdict.nextAction === "finish" ? "run_tests" : verdict.nextAction,
    affectedPaths: verdict.affectedPaths,
    reason: verdict.reason,
  };
}

export const DEFAULT_ATTEMPT_STATE: AttemptState = {
  retryCount: 0,
  maxRetries: 5,
  minConfidence: 0.5,
};
