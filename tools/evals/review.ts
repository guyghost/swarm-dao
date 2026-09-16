// ============================================================
// Swarm DAO — Automated PR review (pure parts)
// ============================================================
// First-pass review of a small PR: a real coding agent inspects the
// diff between the merge-base and HEAD and returns a typed verdict in
// the standard worker JSON envelope. Grading is deterministic — the
// verdict vocabulary is closed, so a reworded approval cannot change
// the outcome (same prompt-vocabulary independence rule as the
// improvement loop's counter-veto).

export type ReviewVerdict = "approve" | "changes-requested";

export interface ReviewAnswer {
  readonly verdict: ReviewVerdict | undefined;
  readonly risks: string | undefined;
  readonly evidence: string | undefined;
}

const REVIEW_METHOD =
  "Review method: " +
  "1) What changed and why — one paragraph. " +
  "2) Boundary discipline: hexagonal functional core rules (docs/ADR-002-hexagonal-core.md), " +
  "XState machine ownership and signal-only workers (models/README.md), " +
  "host adapters as thin shells (docs/EXTENSION-GUIDE.md). " +
  "3) Tests: does the diff carry or update tests for every behavior change? " +
  "4) Scope: is anything touched that the change does not need?";

export function buildReviewPrompt(mergeBase: string): string {
  return (
    `You are the automated first-pass reviewer for Swarm DAO (small-PR review). ` +
    `In this repository, inspect the change between merge-base ${mergeBase} and HEAD: ` +
    `run git diff ${mergeBase}...HEAD --stat first, then git diff ${mergeBase}...HEAD, ` +
    `and read files as needed. ${REVIEW_METHOD} ` +
    `End your reply with a single JSON object (last thing in your output) with ` +
    `"driftClass": "none" and a filled "evidence" string holding your one-paragraph review, ` +
    `plus "verdict" set to exactly "approve" or "changes-requested" and ` +
    `"risks" holding comma-separated risk tags or "none". ` +
    `Do not modify any files; reply with analysis only.`
  );
}

function filled(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Deterministically grade the review answer. `changes-requested` and any
 * malformed verdict fail; the evidence rides along as the failure detail. */
export function gradeReviewAnswer(answer: Record<string, unknown> | null): {
  verdict: ReviewVerdict | undefined;
  results: readonly { id: string; passed: boolean; detail: string }[];
} {
  if (answer === null) {
    return {
      verdict: undefined,
      results: [{ id: "agent-review.verdict", passed: false, detail: "no answer JSON object found in the transcript" }],
    };
  }
  const rawVerdict = answer.verdict;
  const verdict = rawVerdict === "approve" || rawVerdict === "changes-requested" ? rawVerdict : undefined;
  const evidence = filled(answer.evidence) ? answer.evidence : "reviewer returned no evidence";
  return {
    verdict,
    results: [
      {
        id: "agent-review.verdict-shape",
        passed: verdict !== undefined,
        detail:
          verdict === undefined
            ? `verdict must be exactly "approve" or "changes-requested", got "${String(rawVerdict)}"`
            : `verdict: ${verdict}`,
      },
      {
        id: "agent-review.verdict",
        passed: verdict === "approve",
        detail: verdict === "changes-requested" ? `changes requested: ${evidence}` : `verdict: ${String(verdict)}`,
      },
    ],
  };
}
