import { describe, expect, it } from "bun:test";
import { validateGraphSignal } from "../signal.js";

const validModelSignal = {
  runId: "graph-signal",
  type: "MODEL_DRAFTED",
  source: "ai",
  producer: "modeler",
  occurredAt: "2026-07-20T12:00:00.000Z",
  payload: { modelHash: "model-sha256" },
  evidence: ["models/graph-engineering.md"],
};

describe("graph signal validation", () => {
  it("converts a valid AI artifact signal into a typed machine event", () => {
    const result = validateGraphSignal(validModelSignal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({ type: "MODEL_DRAFTED", source: "ai", modelHash: "model-sha256" });
  });

  it("rejects AI attempts to choose state or provide shell commands", () => {
    for (const payload of [
      { modelHash: "model-sha256", nextState: "succeeded" },
      { modelHash: "model-sha256", command: "bun run ci" },
    ]) {
      const result = validateGraphSignal({ ...validModelSignal, payload });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.join("\n")).toMatch(/nextState|command/);
    }
  });

  it("rejects wrong sources, unknown anchors, and evidence-free anchors", () => {
    const wrongSource = validateGraphSignal({ ...validModelSignal, source: "human" });
    expect(wrongSource.ok).toBe(false);

    const unknownAnchor = validateGraphSignal({
      ...validModelSignal,
      type: "ANCHOR_RECORDED",
      source: "tool",
      producer: "runtime-verifier",
      payload: { anchor: "self-report", status: "passed" },
      evidence: ["agent says it passed"],
    });
    expect(unknownAnchor.ok).toBe(false);

    const noEvidence = validateGraphSignal({
      ...validModelSignal,
      type: "ANCHOR_RECORDED",
      source: "tool",
      producer: "runtime-verifier",
      payload: { anchor: "graph-tests", status: "passed" },
      evidence: [],
    });
    expect(noEvidence.ok).toBe(false);
  });
});
