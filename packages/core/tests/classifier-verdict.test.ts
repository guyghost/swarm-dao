import { describe, expect, test } from "bun:test";
import {
  CLASSIFIER_CHARTER,
  DEFAULT_ATTEMPT_STATE,
  evaluateAttempt,
  parseAndValidateVerdict,
  validateVerdict,
} from "../src/domain/classifier-verdict.js";
import { MAX_EDIT_PATHS } from "../src/governance/edit-gate.js";

const valid = {
  status: "retry",
  confidence: 0.82,
  failureType: "type_error",
  nextAction: "edit_file",
  affectedPaths: ["packages/core/src/foo.ts"],
  reason: "implicit cast in test X",
};

const tools = (overrides: Partial<{ tests: string; types: string; lint: string }> = {}) => ({
  tests: "not_run" as const,
  types: "not_run" as const,
  lint: "not_run" as const,
  ...overrides,
});

describe("validateVerdict", () => {
  test("accepts a well-formed verdict", () => {
    const result = validateVerdict(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.verdict.affectedPaths).toEqual(["packages/core/src/foo.ts"]);
    expect(result.verdict.reason).toBe("implicit cast in test X");
  });

  test("collapses spelling variants the same way the edit gate does", () => {
    const result = validateVerdict({
      ...valid,
      affectedPaths: ["packages/core/src/./foo.ts", "packages/core/src/foo.ts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.verdict.affectedPaths).toEqual(["packages/core/src/foo.ts"]);
  });

  test("rejects unknown keys", () => {
    const result = validateVerdict({ ...valid, hacked: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((error) => error.includes("unknown key"))).toBe(true);
  });

  test("rejects confidence that is non-finite or out of range", () => {
    expect(validateVerdict({ ...valid, confidence: 1.4 }).ok).toBe(false);
    expect(validateVerdict({ ...valid, confidence: Number.NaN }).ok).toBe(false);
    expect(validateVerdict({ ...valid, confidence: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  test("refuses paths that escape the repository root", () => {
    const result = validateVerdict({ ...valid, affectedPaths: ["../etc/passwd"] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join("\n")).toMatch(/unmatchable path/);
  });

  test("enforces cross-field coherence", () => {
    expect(validateVerdict({ ...valid, status: "done", failureType: "type_error" }).ok).toBe(false);
    expect(validateVerdict({ ...valid, status: "done", failureType: "none", nextAction: "edit_file" }).ok).toBe(false);
    expect(validateVerdict({ ...valid, status: "retry", nextAction: "finish", failureType: "type_error" }).ok).toBe(
      false,
    );
    expect(validateVerdict({ ...valid, status: "escalate", nextAction: "edit_file" }).ok).toBe(false);
  });

  test("edit_file requires at least one path; finish requires none", () => {
    expect(validateVerdict({ ...valid, nextAction: "edit_file", affectedPaths: [] }).ok).toBe(false);
    expect(
      validateVerdict({
        status: "done",
        confidence: 1,
        failureType: "none",
        nextAction: "finish",
        affectedPaths: ["packages/core/src/foo.ts"],
        reason: "done",
      }).ok,
    ).toBe(false);
  });

  test("caps affectedPaths at MAX_EDIT_PATHS", () => {
    const paths = Array.from({ length: MAX_EDIT_PATHS + 1 }, (_, index) => `src/file-${index}.ts`);
    const result = validateVerdict({ ...valid, affectedPaths: paths });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join("\n")).toContain(String(MAX_EDIT_PATHS));
  });

  test("invalid JSON is a validation failure, not a throw", () => {
    const result = parseAndValidateVerdict("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toEqual(["output is not valid JSON"]);
  });
});

describe("evaluateAttempt", () => {
  const state = DEFAULT_ATTEMPT_STATE;

  test("re-prompts on invalid output", () => {
    const decision = evaluateAttempt(parseAndValidateVerdict("{not json"), tools(), state);
    expect(decision.kind).toBe("re_prompt");
    if (decision.kind !== "re_prompt") throw new Error("expected re_prompt");
    expect(decision.errors.length).toBeGreaterThan(0);
  });

  test("blocks when a tool could not run", () => {
    const result = validateVerdict(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const decision = evaluateAttempt(result, tools({ tests: "blocked" }), state);
    expect(decision.kind).toBe("block");
  });

  test("escalates on explicit escalate or low confidence", () => {
    const escalated = validateVerdict({
      status: "escalate",
      confidence: 0.9,
      failureType: "unknown",
      nextAction: "handoff_human",
      affectedPaths: [],
      reason: "need a human",
    });
    expect(escalated.ok).toBe(true);
    if (!escalated.ok) throw new Error(escalated.errors.join("; "));
    expect(evaluateAttempt(escalated, tools(), state).kind).toBe("escalate");

    const retry = validateVerdict(valid);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.errors.join("; "));
    expect(evaluateAttempt(retry, tools(), { ...state, minConfidence: 0.9 }).kind).toBe("escalate");
  });

  test("tool failure overrides status done and continues", () => {
    const done = validateVerdict({
      status: "done",
      confidence: 0.95,
      failureType: "none",
      nextAction: "finish",
      affectedPaths: [],
      reason: "looks good",
    });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error(done.errors.join("; "));
    const decision = evaluateAttempt(done, tools({ tests: "failed" }), state);
    expect(decision).toMatchObject({ kind: "continue", reason: "tool evidence overrode status done" });
  });

  test("done without tool evidence forces run_tests", () => {
    const done = validateVerdict({
      status: "done",
      confidence: 0.95,
      failureType: "none",
      nextAction: "finish",
      affectedPaths: [],
      reason: "looks good",
    });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error(done.errors.join("; "));
    expect(evaluateAttempt(done, tools(), state)).toMatchObject({ kind: "continue", nextAction: "run_tests" });
  });

  test("done with passing tools requests outer evaluation, it does not finish", () => {
    const done = validateVerdict({
      status: "done",
      confidence: 0.95,
      failureType: "none",
      nextAction: "finish",
      affectedPaths: [],
      reason: "tests green",
    });
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error(done.errors.join("; "));
    expect(evaluateAttempt(done, tools({ tests: "passed", types: "passed" }), state)).toMatchObject({
      kind: "request_evaluation",
    });
  });

  test("continues a retry while budget remains, escalates when exhausted", () => {
    const retry = validateVerdict(valid);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.errors.join("; "));
    expect(evaluateAttempt(retry, tools(), { ...state, retryCount: 1 })).toMatchObject({
      kind: "continue",
      nextAction: "edit_file",
    });
    expect(evaluateAttempt(retry, tools(), { ...state, retryCount: 5, maxRetries: 5 }).kind).toBe("escalate");
  });
});

describe("CLASSIFIER_CHARTER", () => {
  test("binds the closed vocabularies the validator accepts", () => {
    expect(CLASSIFIER_CHARTER).toContain('"done" | "retry" | "escalate"');
    expect(CLASSIFIER_CHARTER).toContain("edit_file");
    expect(CLASSIFIER_CHARTER).toContain("Do not claim tests passed");
  });
});
