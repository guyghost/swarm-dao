import { describe, expect, test } from "bun:test";
import {
  ATTENTION_EVIDENCE_DIRS,
  type AttentionSnapshot,
  type AttentionSource,
  type AttentionStorePort,
  classifyAttention,
  collectAttention,
  formatAttention,
} from "../src/observability/attention.js";

function snapshot(state: string, extra: Record<string, unknown> = {}, runId = "r1"): AttentionSnapshot {
  return { runId, state, status: "active", context: extra };
}

/** In-memory store: source -> runId -> snapshot (or null = unreadable). */
function memoryStore(
  data: Partial<Record<AttentionSource, Record<string, AttentionSnapshot | null>>>,
): AttentionStorePort {
  return {
    listRuns: async (source) => Object.keys(data[source] ?? {}).sort(),
    readSnapshot: async (source, runId) => data[source]?.[runId] ?? null,
  };
}

describe("attention: human-gate classification", () => {
  test("graph-engineering awaitingApproval is a human gate carrying the model hash", () => {
    const item = classifyAttention(
      "graph-engineering",
      snapshot("awaitingApproval", { modelHash: "abc123" }, "run-42"),
    );
    expect(item).not.toBeNull();
    expect(item?.state).toBe("awaitingApproval");
    expect(item?.detail).toBe("abc123");
    expect(item?.action).toContain("model");
    // The suggested command targets the actual run, not a placeholder.
    expect(item?.command).toContain("--run-id run-42");
    expect(item?.command).not.toContain("<id>");
  });

  test("graph-engineering retrying awaits a human retry or cancellation", () => {
    const item = classifyAttention("graph-engineering", snapshot("retrying"));
    expect(item).not.toBeNull();
    expect(item?.state).toBe("retrying");
  });

  test("graph-engineering terminal states are not attention", () => {
    for (const state of ["succeeded", "failed", "blocked", "cancelled"]) {
      expect(classifyAttention("graph-engineering", snapshot(state))).toBeNull();
    }
  });

  test("graph-engineering AI/tool states are not attention", () => {
    for (const state of ["draft", "modelReview", "ready", "implementing", "verifying"]) {
      expect(classifyAttention("graph-engineering", snapshot(state))).toBeNull();
    }
  });

  test("improvement-loop adjusting carries the reference hash", () => {
    const item = classifyAttention("improvement-loop", snapshot("adjusting", { referenceHash: "ref9" }, "cyc-7"));
    expect(item).not.toBeNull();
    expect(item?.detail).toBe("ref9");
    expect(item?.command).toContain("--cycle-id cyc-7");
  });

  test("improvement-loop retrying is a human gate; working states are not", () => {
    expect(classifyAttention("improvement-loop", snapshot("retrying"))).not.toBeNull();
    for (const state of ["sampling", "auditing", "arbitrating", "grounding", "evaluating", "succeeded"]) {
      expect(classifyAttention("improvement-loop", snapshot(state))).toBeNull();
    }
  });

  test("improvement-series workerFailed carries the pending reason and the series submit command", () => {
    const item = classifyAttention(
      "improvement-series",
      snapshot("workerFailed", { pendingReason: "sensor failed after 3 attempts" }, "ser-4"),
    );
    expect(item).not.toBeNull();
    expect(item?.detail).toBe("sensor failed after 3 attempts");
    expect(item?.command).toBe("swarm-dao improve submit --series-id ser-4 --event <event.json>");
  });

  test("improvement-series halted is a human gate; progressing states are not", () => {
    expect(
      classifyAttention("improvement-series", snapshot("halted", { pendingReason: "cycle failed" })),
    ).not.toBeNull();
    // awaitingHumanCycleDecision is deliberately NOT a series gate: the human
    // decision lives on the cycle (adjusting/retrying), already surfaced by
    // the improvement-loop source.
    for (const state of [
      "preparing",
      "sampling",
      "cooldown",
      "observing",
      "awaitingHumanCycleDecision",
      "succeeded",
      "cancelled",
    ]) {
      expect(classifyAttention("improvement-series", snapshot(state))).toBeNull();
    }
  });

  test("product-loop review is a human gate carrying the review reason", () => {
    const item = classifyAttention("product-loop", snapshot("review", { reviewReason: "budget-exhausted" }));
    expect(item).not.toBeNull();
    expect(item?.detail).toBe("budget-exhausted");
  });

  test("product-loop transient and terminal states are not attention", () => {
    for (const state of ["budgetBlocked", "validated", "rejected", "exploration", "execution", "observation"]) {
      expect(classifyAttention("product-loop", snapshot(state))).toBeNull();
    }
  });

  test("unknown states are never attention (fail closed)", () => {
    expect(classifyAttention("graph-engineering", snapshot("totally-unknown"))).toBeNull();
  });
});

describe("attention: collection", () => {
  test("collects only human gates across sources, sorted by source then run id", async () => {
    const store = memoryStore({
      "product-loop": {
        "run-b": snapshot("review", { reviewReason: "budget-exhausted" }, "run-b"),
        "run-a": snapshot("validated", {}, "run-a"),
      },
      "graph-engineering": {
        "g-2": snapshot("awaitingApproval", { modelHash: "h2" }, "g-2"),
        "g-1": snapshot("implementing", {}, "g-1"),
        "g-3": snapshot("retrying", {}, "g-3"),
      },
      "improvement-loop": {
        "i-1": snapshot("adjusting", { referenceHash: "r1" }, "i-1"),
      },
    });

    const items = await collectAttention(store);
    expect(items.map((i) => `${i.source}/${i.runId}`)).toEqual([
      "graph-engineering/g-2",
      "graph-engineering/g-3",
      "improvement-loop/i-1",
      "product-loop/run-b",
    ]);
  });

  test("can filter to a single source", async () => {
    const store = memoryStore({
      "graph-engineering": { "g-1": snapshot("awaitingApproval", { modelHash: "h" }, "g-1") },
      "product-loop": { "p-1": snapshot("review", {}, "p-1") },
    });
    const items = await collectAttention(store, ["graph-engineering"]);
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe("graph-engineering");
  });

  test("unreadable snapshots are skipped without failing the sweep", async () => {
    const store = memoryStore({
      "graph-engineering": {
        broken: null,
        ok: snapshot("awaitingApproval", { modelHash: "h" }, "ok"),
      },
    });
    const items = await collectAttention(store);
    expect(items).toHaveLength(1);
    expect(items[0]?.runId).toBe("ok");
  });

  test("evidence directories map to the documented roots", () => {
    expect(ATTENTION_EVIDENCE_DIRS["graph-engineering"]).toBe("evidence/graph-runs");
    expect(ATTENTION_EVIDENCE_DIRS["improvement-loop"]).toBe("evidence/improvement-cycles");
    expect(ATTENTION_EVIDENCE_DIRS["product-loop"]).toBe("evidence/product-loops");
  });
});

describe("attention: presentation", () => {
  test("formats a table with one row per gate", () => {
    const out = formatAttention([
      {
        source: "graph-engineering",
        runId: "g-2",
        state: "awaitingApproval",
        action: "Approve or reject the exact model hash",
        detail: "h2",
      },
      {
        source: "product-loop",
        runId: "p-1",
        state: "review",
        action: "Resolve the review",
        detail: null,
      },
    ]);
    expect(out).toContain("graph-engineering");
    expect(out).toContain("g-2");
    expect(out).toContain("awaitingApproval");
    expect(out).toContain("h2");
    expect(out).toContain("review");
  });

  test("empty attention renders an explicit empty state", () => {
    expect(formatAttention([])).toContain("no pending human gates");
  });
});
