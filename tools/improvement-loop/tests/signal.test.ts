import { describe, expect, it } from "bun:test";
import { validateImprovementSignal } from "../signal.js";

const baseAiSignal = {
  cycleId: "improvement-signal",
  type: "METRIC_SAMPLED",
  source: "ai",
  producer: "sensor",
  occurredAt: "2026-07-21T12:00:00.000Z",
  payload: { sample: { value: "rose", evidence: "throughput improved" } },
  evidence: ["throughput improved"],
};

describe("improvement signal validation", () => {
  it("converts a valid AI artifact signal into a typed machine event", () => {
    const result = validateImprovementSignal(baseAiSignal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      type: "METRIC_SAMPLED",
      source: "ai",
      sample: { value: "rose", evidence: "throughput improved" },
    });
  });

  it("rejects AI attempts to choose state, run commands, or claim authority", () => {
    for (const key of ["nextState", "command", "shell", "approval", "referenceHash", "retry", "cancel", "permission"]) {
      const result = validateImprovementSignal({
        ...baseAiSignal,
        payload: { sample: { value: "rose", evidence: "m" }, [key]: "forged" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.join("\n")).toMatch(new RegExp(key));
    }
  });

  it("rejects AI signals carrying reference or target values", () => {
    for (const key of ["reference", "target"]) {
      const result = validateImprovementSignal({
        ...baseAiSignal,
        payload: { sample: { value: "rose", evidence: "m" }, [key]: "model-or-state-value" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.join("\n")).toMatch(new RegExp(key));
    }
  });

  it("rejects a wrong source for a given event type", () => {
    const result = validateImprovementSignal({ ...baseAiSignal, source: "tool" });
    expect(result.ok).toBe(false);
  });

  it("binds event authority to the producer's declared graph node", () => {
    // An AI producer cannot emit a human-authority event by forging source: "human".
    const forged = validateImprovementSignal({
      cycleId: "improvement-signal",
      type: "CANCEL",
      source: "human",
      producer: "sensor",
      occurredAt: "2026-07-21T12:00:00.000Z",
      payload: { reason: "forged by an AI producer" },
      evidence: ["forged"],
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.issues.join("\n")).toMatch(/sensor is not declared to emit CANCEL/);

    // An AI producer cannot emit an event outside its declared emissions.
    const wrongEmit = validateImprovementSignal({
      ...baseAiSignal,
      type: "DRIFT_ESTIMATE",
      payload: { driftClass: "none" },
    });
    expect(wrongEmit.ok).toBe(false);

    // The human-owner producer can emit a human-authority event.
    const humanCancel = validateImprovementSignal({
      cycleId: "improvement-signal",
      type: "CANCEL",
      source: "human",
      producer: "human-owner",
      occurredAt: "2026-07-21T12:00:00.000Z",
      payload: { reason: "owner cancelled" },
      evidence: ["owner cancelled"],
    });
    expect(humanCancel.ok).toBe(true);
  });
});
