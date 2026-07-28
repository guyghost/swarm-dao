import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeHealthScore,
  createInitialState,
  DEFAULT_HEALTH_WEIGHTS,
  formatHealthScore,
  formatHealthTrend,
  generateDashboard,
  getHealthSnapshots,
  getHealthTrend,
  getLatestHealthSnapshot,
  getState,
  initStorage,
  recordHealthSnapshot,
  setState,
} from "@guyghost/swarm-dao-core";

describe("health-score", () => {
  // ── Original tests ──────────────────────────────────────────

  it("returns insufficient data for empty proposals", () => {
    const score = computeHealthScore([], {}, DEFAULT_HEALTH_WEIGHTS);
    expect(score.insufficientData).toBe(true);
    expect(score.score).toBe(0);
  });

  it("computes health score", () => {
    const proposals = [
      {
        id: 1,
        title: "A",
        type: "product-feature" as const,
        description: "",
        proposedBy: "",
        status: "executed" as const,
        votes: [],
        agentOutputs: [{ agentId: "a", agentName: "A", role: "r", content: "", durationMs: 0 }],
        createdAt: "",
      },
      {
        id: 2,
        title: "B",
        type: "product-feature" as const,
        description: "",
        proposedBy: "",
        status: "rejected" as const,
        votes: [],
        agentOutputs: [],
        createdAt: "",
      },
      {
        id: 3,
        title: "C",
        type: "product-feature" as const,
        description: "",
        proposedBy: "",
        status: "executed" as const,
        votes: [],
        agentOutputs: [
          { agentId: "a", agentName: "A", role: "r", content: "", durationMs: 0 },
          { agentId: "b", agentName: "B", role: "r", content: "", durationMs: 0 },
        ],
        createdAt: "",
      },
    ];

    const outcomes = {
      1: {
        proposalId: 1,
        ratings: [{ proposalId: 1, rater: "user", score: 4, comment: "Good", ratedAt: "" }],
        metrics: [],
        overallScore: 4,
        status: "tracked" as const,
        createdAt: "",
        updatedAt: "",
      },
    };

    const score = computeHealthScore(proposals, outcomes, DEFAULT_HEALTH_WEIGHTS);
    expect(score.score).toBeGreaterThan(0);
    expect(score.label).toBeDefined();
    expect(score.metrics.length).toBe(4);
    expect(score.insufficientData).toBe(false);
  });

  it("formats health score", () => {
    const score = computeHealthScore([], {}, DEFAULT_HEALTH_WEIGHTS);
    const formatted = formatHealthScore(score);
    expect(formatted).toContain("Health Score");
  });

  it("generates dashboard", () => {
    const proposals = [
      {
        id: 1,
        title: "A",
        type: "product-feature" as const,
        description: "",
        proposedBy: "",
        status: "open" as const,
        votes: [],
        agentOutputs: [],
        createdAt: "",
      },
      {
        id: 2,
        title: "B",
        type: "product-feature" as const,
        description: "",
        proposedBy: "",
        status: "executed" as const,
        votes: [],
        agentOutputs: [],
        createdAt: "",
      },
    ];

    const dashboard = generateDashboard(proposals, {}, [{ id: "a", name: "Agent A", weight: 3 }]);

    expect(dashboard).toContain("DAO Dashboard");
    expect(dashboard).toContain("open: 1");
    expect(dashboard).toContain("executed: 1");
  });

  it("computes health trend", () => {
    const snapshots = [
      { weekKey: "W1", year: 2026, week: 1, score: 60, metrics: [], proposalCount: 5, createdAt: "" },
      { weekKey: "W2", year: 2026, week: 2, score: 75, metrics: [], proposalCount: 6, createdAt: "" },
    ];
    const trend = getHealthTrend(snapshots);
    expect(trend.improving).toBe(true);
    expect(trend.change).toBe(15);
  });

  it("formats health trend", () => {
    expect(formatHealthTrend({ improving: true, change: 10 })).toContain("📈");
    expect(formatHealthTrend({ improving: false, change: -5 })).toContain("📉");
  });

  // ── Health snapshot persistence tests ───────────────────────

  describe("health snapshot persistence", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-health-test-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("getHealthSnapshots returns empty array when none recorded", () => {
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      const snapshots = getHealthSnapshots();
      expect(snapshots).toEqual([]);
    });

    it("getLatestHealthSnapshot returns undefined when none recorded", () => {
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      const latest = getLatestHealthSnapshot();
      expect(latest).toBeUndefined();
    });

    it("recordHealthSnapshot captures current health and persists to state", async () => {
      await initStorage(testDir);
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      const snapshot = await recordHealthSnapshot();

      expect(snapshot).toBeDefined();
      expect(typeof snapshot.score).toBe("number");
      expect(snapshot.weekKey).toMatch(/W\d+/);
      expect(snapshot.year).toBeGreaterThan(0);
      expect(snapshot.week).toBeGreaterThan(0);
      expect(snapshot.proposalCount).toBe(0); // no proposals yet
      expect(snapshot.createdAt).toBeDefined();
      expect(snapshot.metrics).toBeDefined();

      // Verify persisted in state
      const currentState = getState();
      expect(currentState.healthSnapshots).toBeDefined();
      expect(currentState.healthSnapshots?.length).toBe(1);
      expect(currentState.healthSnapshots?.[0].weekKey).toBe(snapshot.weekKey);
    });

    it("getLatestHealthSnapshot returns the most recent snapshot", async () => {
      await initStorage(testDir);
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      // Record two snapshots
      const _first = await recordHealthSnapshot();

      // Manually tweak to simulate a different week
      const currentState = getState();
      const manualSnapshot = {
        weekKey: "W99",
        year: 2030,
        week: 99,
        score: 95,
        metrics: [],
        proposalCount: 10,
        createdAt: new Date().toISOString(),
      };
      currentState.healthSnapshots?.push(manualSnapshot);

      const latest = getLatestHealthSnapshot();
      expect(latest).toBeDefined();
      expect(latest?.weekKey).toBe("W99");
      expect(latest?.score).toBe(95);
    });

    it("snapshots are pruned to last 52 entries", async () => {
      await initStorage(testDir);
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      // Manually inject 60 snapshots
      const snapshots = [];
      for (let i = 1; i <= 60; i++) {
        snapshots.push({
          weekKey: `W${i}`,
          year: 2026,
          week: i,
          score: i,
          metrics: [],
          proposalCount: i,
          createdAt: new Date().toISOString(),
        });
      }
      state.healthSnapshots = snapshots;

      // Now record one more — should trigger pruning
      await recordHealthSnapshot();

      const currentSnapshots = getHealthSnapshots();
      // Should be at most 52 (the newest ones kept)
      expect(currentSnapshots.length).toBeLessThanOrEqual(52);
      // The oldest entries should have been pruned
      const weekKeys = currentSnapshots.map((s) => s.weekKey);
      expect(weekKeys).not.toContain("W1");
      expect(weekKeys).not.toContain("W2");
    });

    it("same-week dedup: calling recordHealthSnapshot twice replaces the existing snapshot", async () => {
      await initStorage(testDir);
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      // First call
      const first = await recordHealthSnapshot();
      const firstWeekKey = first.weekKey;

      // Second call — same week, should replace not append
      const second = await recordHealthSnapshot();
      const snapshots = getHealthSnapshots();

      // Should still have only 1 snapshot (same weekKey replaced)
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].weekKey).toBe(firstWeekKey);
      // The snapshot object should be the latest one (same weekKey)
      expect(snapshots[0].createdAt).toBe(second.createdAt);
    });

    it("different-week dedup: calling recordHealthSnapshot in different weeks appends", async () => {
      await initStorage(testDir);
      const state = createInitialState(testDir);
      state.initialized = true;
      setState(state);

      // First call
      await recordHealthSnapshot();
      const firstSnapshots = getHealthSnapshots();
      expect(firstSnapshots.length).toBe(1);
      const firstWeekKey = firstSnapshots[0].weekKey;

      // Manually inject a snapshot for a different week
      const currentState = getState();
      const differentWeekSnapshot = {
        weekKey: "W50",
        year: 2099,
        week: 50,
        score: 88,
        metrics: [],
        proposalCount: 5,
        createdAt: "2099-12-15T00:00:00Z",
      };
      currentState.healthSnapshots?.push(differentWeekSnapshot);

      // Third call — same week as first, should replace the original not append
      await recordHealthSnapshot();
      const snapshots = getHealthSnapshots();

      // Should have 2 snapshots: the replaced current-week entry + the manual W50 entry
      expect(snapshots.length).toBe(2);
      // The different week snapshot should still be present
      expect(snapshots.some((s) => s.weekKey === "W50")).toBe(true);
      // The current-week snapshot should still exist (replaced, not duplicated)
      expect(snapshots.some((s) => s.weekKey === firstWeekKey)).toBe(true);
    });

    it("generateDashboard includes trend when 2+ snapshots exist", async () => {
      await initStorage(testDir);
      const state = createInitialState(testDir);
      state.initialized = true;

      // Add two snapshots directly to state
      state.healthSnapshots = [
        {
          weekKey: "W1",
          year: 2026,
          week: 1,
          score: 50,
          metrics: [],
          proposalCount: 3,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          weekKey: "W2",
          year: 2026,
          week: 2,
          score: 75,
          metrics: [],
          proposalCount: 5,
          createdAt: "2026-01-08T00:00:00Z",
        },
      ];
      setState(state);

      const proposals = [
        {
          id: 1,
          title: "Trend Test",
          type: "product-feature" as const,
          description: "",
          proposedBy: "",
          status: "open" as const,
          votes: [],
          agentOutputs: [],
          createdAt: "",
        },
      ];

      const dashboard = generateDashboard(
        proposals,
        {},
        [{ id: "a", name: "Agent A", weight: 3 }],
        state.healthSnapshots,
      );

      // Dashboard should include trend info when snapshots exist
      expect(dashboard).toContain("Trend") || expect(dashboard).toContain("📈") || expect(dashboard).toContain("+");
    });
  });
});
