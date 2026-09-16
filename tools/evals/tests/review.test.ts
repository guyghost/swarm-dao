import { describe, expect, it } from "bun:test";
import { buildReviewPrompt, gradeReviewAnswer } from "../review.js";

describe("buildReviewPrompt", () => {
  it("pins the merge-base, the review method, and the verdict vocabulary", () => {
    const prompt = buildReviewPrompt("abc1234");
    expect(prompt).toContain("abc1234");
    expect(prompt).toContain("ADR-002");
    expect(prompt).toContain("models/README.md");
    expect(prompt).toContain('"approve" or "changes-requested"');
    expect(prompt).toContain("Do not modify any files");
  });
});

describe("gradeReviewAnswer", () => {
  it("fails closed when no answer object was harvested", () => {
    const graded = gradeReviewAnswer(null);
    expect(graded.verdict).toBeUndefined();
    expect(graded.results.every((result) => !result.passed)).toBe(true);
  });

  it("accepts an approve verdict", () => {
    const graded = gradeReviewAnswer({
      driftClass: "none",
      evidence: "thin shell change with tests",
      verdict: "approve",
      risks: "none",
    });
    expect(graded.verdict).toBe("approve");
    expect(graded.results.every((result) => result.passed)).toBe(true);
  });

  it("fails the verdict gate on changes-requested, carrying the evidence", () => {
    const graded = gradeReviewAnswer({
      driftClass: "none",
      evidence: "adapter calls dispatchProposalEvent directly",
      verdict: "changes-requested",
      risks: "boundary",
    });
    expect(graded.verdict).toBe("changes-requested");
    const shape = graded.results.find((result) => result.id === "agent-review.verdict-shape");
    const gate = graded.results.find((result) => result.id === "agent-review.verdict");
    expect(shape?.passed).toBe(true);
    expect(gate?.passed).toBe(false);
    expect(gate?.detail).toContain("dispatchProposalEvent");
  });

  it("rejects reworded verdicts — the vocabulary is closed", () => {
    const graded = gradeReviewAnswer({
      driftClass: "none",
      evidence: "looks fine to me, approved!",
      verdict: "approved",
      risks: "none",
    });
    expect(graded.verdict).toBeUndefined();
    expect(graded.results.every((result) => !result.passed)).toBe(true);
  });
});
