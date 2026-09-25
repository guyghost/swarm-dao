import { describe, expect, it } from "bun:test";
import { validateDeliverySignal } from "../src/signal.js";

const sha = "a".repeat(64);
const baseSignal = {
  runId: "delivery-signal-test",
  type: "INTAKE_ACCEPTED",
  source: "tool",
  producer: "intake-validator",
  occurredAt: "2026-09-25T10:00:00.000Z",
  payload: {},
  evidence: ["product-journal:8"],
};

describe("software delivery signal validation", () => {
  it("converts a producer-bound intake signal into a typed parent event", () => {
    const result = validateDeliverySignal(baseSignal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({ type: "INTAKE_ACCEPTED", source: "tool", evidence: "product-journal:8" });
    expect(result.signal.producer).toBe("intake-validator");
  });

  it("rejects an AI modeler attempting to cancel a delivery", () => {
    const result = validateDeliverySignal({
      ...baseSignal,
      type: "CANCEL_REQUESTED",
      source: "human",
      producer: "modeler",
      payload: { reason: "cancel from modeler" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toMatch(/producer|CANCEL_REQUESTED/);
  });

  it("rejects unknown events, wrong sources, and missing evidence", () => {
    expect(validateDeliverySignal({ ...baseSignal, type: "APPROVE" }).ok).toBe(false);
    expect(validateDeliverySignal({ ...baseSignal, source: "ai" }).ok).toBe(false);
    expect(validateDeliverySignal({ ...baseSignal, evidence: [] }).ok).toBe(false);
  });

  it("rejects nested transition targets and AI authority fields", () => {
    const transition = validateDeliverySignal({
      ...baseSignal,
      payload: { nested: { targetState: "shipReady" } },
    });
    expect(transition.ok).toBe(false);
    if (!transition.ok) expect(transition.issues.join("\n")).toMatch(/targetState/);

    const authority = validateDeliverySignal({
      ...baseSignal,
      type: "GRAPH_MODEL_DRAFTED",
      source: "ai",
      producer: "modeler",
      payload: { cancel: true, riskClass: "standard" },
    });
    expect(authority.ok).toBe(false);
    if (!authority.ok) expect(authority.issues.join("\n")).toMatch(/cancel|riskClass/);
  });

  it("rejects unknown risk classifications and human events from non-human producers", () => {
    const invalidRisk = validateDeliverySignal({
      ...baseSignal,
      type: "RISK_CLASSIFICATION_RESOLVED",
      source: "human",
      producer: "human-owner",
      payload: { riskClass: "unknown" },
    });
    expect(invalidRisk.ok).toBe(false);
    if (!invalidRisk.ok) expect(invalidRisk.issues.join("\n")).toMatch(/riskClass/);

    const forgedHuman = validateDeliverySignal({
      ...baseSignal,
      type: "RISK_CLASSIFICATION_RESOLVED",
      source: "human",
      producer: "intake-validator",
      payload: { riskClass: "standard" },
    });
    expect(forgedHuman.ok).toBe(false);
  });

  it("rejects stale run IDs and malformed exact model hashes", () => {
    expect(validateDeliverySignal(baseSignal, "another-run").ok).toBe(false);
    expect(
      validateDeliverySignal({
        ...baseSignal,
        type: "GRAPH_APPROVAL_CONFIRMED",
        producer: "graph-child-adapter",
        payload: { modelHash: "not-a-sha256" },
      }).ok,
    ).toBe(false);
  });

  it("rejects unsafe run IDs", () => {
    expect(validateDeliverySignal({ ...baseSignal, runId: "../outside" }).ok).toBe(false);
    expect(validateDeliverySignal({ ...baseSignal, runId: "__proto__" }).ok).toBe(false);
  });

  it("maps approval only from the Graph adapter and preserves the exact SHA-256", () => {
    const result = validateDeliverySignal({
      ...baseSignal,
      type: "GRAPH_APPROVAL_CONFIRMED",
      producer: "graph-child-adapter",
      payload: { modelHash: sha },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      type: "GRAPH_APPROVAL_CONFIRMED",
      source: "tool",
      modelHash: sha,
      evidence: "product-journal:8",
    });
  });
});
