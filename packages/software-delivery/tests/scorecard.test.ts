import { describe, expect, it } from "bun:test";
import { buildDeliveryScorecard, type DeliveryScorecardEntry } from "../src/scorecard.js";

const NOW = "2026-09-25T12:00:00.000Z";

const entry = (
  deliveryRunId: string,
  journal: DeliveryScorecardEntry["journal"],
  fields: Partial<DeliveryScorecardEntry> = {},
): DeliveryScorecardEntry => ({ deliveryRunId, journal, receivedAt: NOW, ...fields });

const activeRunJournal = (): DeliveryScorecardEntry[] => [
  entry("active-1", "delivery", {
    kind: "snapshot",
    snapshot: {
      state: "observing",
      context: { initialRiskClass: "standard", outcome: null, observationEvidence: ["sample-1"] },
    },
  }),
  entry("active-1", "product", {
    kind: "signal",
    eventType: "OBSERVATION_SAMPLE",
    source: "tool",
    payload: { sample: { metric: "latency", value: 20, threshold: 100, exceeded: false } },
  }),
];

const approvedRun = (runId: string, outcome: string, humanAfterApproval: boolean): DeliveryScorecardEntry[] => {
  const approvalAt = "2026-09-25T10:00:00.000Z";
  const resultAt = "2026-09-25T11:00:00.000Z";
  return [
    entry(runId, "delivery", {
      kind: "snapshot",
      receivedAt: resultAt,
      snapshot: {
        state: outcome,
        context: {
          initialRiskClass: "standard",
          modelHash: "a".repeat(64),
          approvedModelHash: "a".repeat(64),
          outcome,
          observationEvidence: ["observation:complete"],
        },
      },
    }),
    entry(runId, "graph", {
      kind: "signal",
      eventType: "MODEL_APPROVED",
      source: "human",
      receivedAt: approvalAt,
      payload: { modelHash: "a".repeat(64) },
    }),
    ...(humanAfterApproval
      ? [
          entry(runId, "product", {
            kind: "signal",
            eventType: "REVIEW_RESOLVED",
            source: "human",
            receivedAt: "2026-09-25T10:30:00.000Z",
            payload: { resolution: "deploy-authorized" },
          }),
        ]
      : []),
    entry(runId, "product", {
      kind: "signal",
      eventType: "OBSERVATION_SAMPLE",
      source: "tool",
      receivedAt: resultAt,
      payload: { sample: { metric: "latency", value: 42, threshold: 100, exceeded: false } },
    }),
  ];
};

describe("buildDeliveryScorecard", () => {
  it("reports unavailable rates when no eligible terminal run exists", () => {
    const scorecard = buildDeliveryScorecard(activeRunJournal(), { now: NOW });

    expect(scorecard.completion.rate).toBeNull();
    expect(scorecard.completion.denominator).toBe(0);
    expect(scorecard.activeRuns).toBe(1);
    expect(scorecard.postApprovalAutonomy.rate).toBeNull();
    expect(scorecard.rollback.rate).toBeNull();
  });

  it("uses terminal outcomes and exact-hash approvals for delivery rates", () => {
    const entries = [
      ...approvedRun("validated-1", "validated", false),
      ...approvedRun("rollback-1", "rolledBack", true),
      ...[
        entry("failed-1", "delivery", {
          kind: "snapshot",
          snapshot: { state: "failed", context: { initialRiskClass: "unknown", outcome: "failed" } },
        }),
      ],
    ];
    const scorecard = buildDeliveryScorecard(entries, { now: NOW });

    expect(scorecard.completion).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
    expect(scorecard.postApprovalAutonomy).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(scorecard.rollback).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(scorecard.humanIntervention.count).toBe(1);
    expect(scorecard.unknownInitialRiskRuns).toBe(1);
    expect(JSON.stringify(scorecard)).not.toContain("validated-1");
    expect(JSON.stringify(scorecard)).not.toContain("deliveryRunId");
  });

  it("reports retry, failed control, incomplete observation, optional-cost availability, and nearest-rank p95", () => {
    const entries: DeliveryScorecardEntry[] = [
      ...activeRunJournal(),
      entry("active-1", "graph", {
        kind: "snapshot",
        snapshot: { state: "implementing", context: { attempt: 2 } },
      }),
      entry("active-1", "product", {
        kind: "signal",
        eventType: "VERIFY_RUN",
        source: "tool",
        payload: { control: { name: "tests", status: "failed", evidence: "failed tests" } },
      }),
      ...[10, 20, 30, 40, 50].map((value) =>
        entry("active-1", "product", {
          kind: "signal",
          eventType: "OBSERVATION_SAMPLE",
          source: "tool",
          payload: { sample: { metric: "latency", value, threshold: 100, exceeded: false } },
        }),
      ),
    ];
    const scorecard = buildDeliveryScorecard(entries, { now: NOW });

    expect(scorecard.retries).toEqual({ runs: 1, total: 2 });
    expect(scorecard.failedControls).toBe(1);
    expect(scorecard.incompleteObservationRuns).toBe(1);
    expect(scorecard.unavailableData.optionalCostRuns).toBe(1);
    expect(scorecard.latencyP95Ms).toBe(50);
  });

  it("does not treat a stale or mismatched approval as approved", () => {
    const entries = [
      ...approvedRun("mismatch-1", "validated", false).filter((row) => row.eventType !== "MODEL_APPROVED"),
      entry("mismatch-1", "graph", {
        kind: "signal",
        eventType: "MODEL_APPROVED",
        source: "human",
        payload: { modelHash: "b".repeat(64) },
      }),
    ];
    const scorecard = buildDeliveryScorecard(entries, { now: NOW });
    expect(scorecard.postApprovalAutonomy).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  it("reports optional cost as unavailable until three measured samples exist", () => {
    const entries = [
      ...approvedRun("cost-1", "validated", false),
      ...[1, 2].map((value) =>
        entry("cost-1", "product", {
          kind: "signal",
          eventType: "OBSERVATION_SAMPLE",
          source: "tool",
          payload: { sample: { metric: "aiCost", value, threshold: 10, exceeded: false } },
        }),
      ),
    ];
    expect(buildDeliveryScorecard(entries, { now: NOW }).unavailableData.optionalCostRuns).toBe(1);
    entries.push(
      entry("cost-1", "product", {
        kind: "signal",
        eventType: "OBSERVATION_SAMPLE",
        source: "tool",
        payload: { sample: { metric: "aiCost", value: 3, threshold: 10, exceeded: false } },
      }),
    );
    expect(buildDeliveryScorecard(entries, { now: NOW }).unavailableData.optionalCostRuns).toBe(0);
  });
});
