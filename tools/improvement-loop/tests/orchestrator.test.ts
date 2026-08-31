import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ORCHESTRATOR_HUMAN_GATED_STATES,
  ORCHESTRATOR_MAX_WORKER_RETRIES,
  ORCHESTRATOR_MIN_COOLDOWN_MS,
  ORCHESTRATOR_TERMINAL_STATES,
} from "../../../packages/core/src/models/improvement-orchestrator.machine.js";
import {
  assertNoActiveSeriesForScope,
  isHumanChannelEvent,
  mapCycleStateToObservation,
  OrchestratorRunner,
} from "../orchestrator.js";
import { createImprovementRunner } from "../runner.js";
import type { WorkerHarvest } from "../workers.js";

const answer = (payload: unknown): WorkerHarvest => ({
  ok: true,
  content: `worker transcript preamble\n${JSON.stringify(payload)}\npostamble`,
});

const sensorAnswer = answer({ sample: { value: "rose", evidence: "reference metric improved" } });
const counterAnswer = answer({ sample: { value: "held", evidence: "counter-metric held" } });
const driftAnswer = answer({ driftClass: "none", evidence: "no drift from the reference" });

const fakeWorker =
  (overrides: Partial<Record<string, WorkerHarvest>> = {}) =>
  async (_phase: string, worker: string): Promise<WorkerHarvest> => {
    const override = overrides[worker];
    if (override) return override;
    if (worker === "sensor") return sensorAnswer;
    if (worker === "counter-sensor") return counterAnswer;
    return driftAnswer;
  };

const okCommand = async () => ({ ok: true, detail: "exit 0" });

const startSeries = async (runner: OrchestratorRunner) => {
  const result = await runner.submit({
    type: "START_SERIES",
    source: "human",
    scope: "wiring",
    referenceHash: "a".repeat(64),
    cooldownMs: ORCHESTRATOR_MIN_COOLDOWN_MS,
  });
  expect(result.accepted).toBe(true);
  return result.snapshot;
};

describe("improvement-orchestrator wiring — nominal series", () => {
  it("drives a full cycle through the real improvement runner and schedules the next", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-wiring-"));
    const cycleRoot = await mkdtemp(join(tmpdir(), "orchestrator-cycles-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-wiring", evidenceRoot });
      await startSeries(runner);
      expect(runner.snapshot().state).toBe("preparing");

      const deps = { cycleEvidenceRoot: cycleRoot, runWorker: fakeWorker(), runCommand: okCommand };

      // preparing -> sampling: the improvement cycle exists on disk with the
      // series-derived id and immutable correlation inputs.
      let step = await runner.once(deps);
      expect(step.event).toBe("CYCLE_INITIALIZED");
      expect(runner.snapshot().state).toBe("sampling");
      expect(runner.snapshot().context.improvementCycleId).toBe("series-wiring-c1");
      const cycleSnapshot = JSON.parse(await readFile(join(cycleRoot, "series-wiring-c1", "snapshot.json"), "utf8"));
      expect(cycleSnapshot.context.scope).toBe("wiring");

      // sampling -> sealing: sensor answers harvested to the work directory.
      step = await runner.once(deps);
      expect(step.event).toBe("WORKERS_HARVESTED");
      expect(runner.snapshot().state).toBe("sealing");
      const sensorWork = JSON.parse(
        await readFile(join(evidenceRoot, "series-wiring", "work", "c1", "worker-sensor.json"), "utf8"),
      );
      expect(sensorWork.sample.value).toBe("rose");

      // sealing -> auditing: paired signals land in the real cycle.
      step = await runner.once(deps);
      expect(step.event).toBe("SAMPLES_SUBMITTED");
      expect(runner.snapshot().state).toBe("auditing");
      const afterSeal = JSON.parse(await readFile(join(cycleRoot, "series-wiring-c1", "snapshot.json"), "utf8"));
      expect(afterSeal.state).toBe("auditing");
      expect(afterSeal.context.metric.value).toBe("rose");

      // auditing -> arbitrating: drift worker harvested.
      step = await runner.once(deps);
      expect(step.event).toBe("WORKERS_HARVESTED");
      expect(runner.snapshot().state).toBe("arbitrating");

      // arbitrating -> grounding: drift + deterministic arbitration submitted.
      step = await runner.once(deps);
      expect(step.event).toBe("ARBITRATION_SUBMITTED");
      expect(runner.snapshot().state).toBe("grounding");
      const afterArbitration = JSON.parse(await readFile(join(cycleRoot, "series-wiring-c1", "snapshot.json"), "utf8"));
      expect(afterArbitration.state).toBe("grounding");
      expect(afterArbitration.context.arbitrationOutcome).toBe("balanced");

      // grounding -> evaluating: the four non-auto frozen anchor commands run
      // and their honest outcomes are recorded.
      const commands: string[] = [];
      step = await runner.once({
        ...deps,
        runCommand: async (command) => {
          commands.push(command);
          return okCommand();
        },
      });
      expect(step.event).toBe("ANCHORS_SUBMITTED");
      expect(runner.snapshot().state).toBe("evaluating");
      expect(commands.length).toBe(4);
      expect(commands).toContain("bun run improvement:regression");
      const afterAnchors = JSON.parse(await readFile(join(cycleRoot, "series-wiring-c1", "snapshot.json"), "utf8"));
      expect(Object.keys(afterAnchors.context.anchors).length).toBe(6);

      // evaluating -> observing: EVALUATE lands the cycle on succeeded.
      step = await runner.once(deps);
      expect(step.event).toBe("EVALUATE_SUBMITTED");
      expect(runner.snapshot().state).toBe("observing");
      const finalCycle = JSON.parse(await readFile(join(cycleRoot, "series-wiring-c1", "snapshot.json"), "utf8"));
      expect(finalCycle.state).toBe("succeeded");

      // observing -> cooldown: success observation stamps the cooldown timer.
      step = await runner.once(deps);
      expect(step.event).toBe("CYCLE_SUCCEEDED");
      const cooldownSnapshot = runner.snapshot();
      expect(cooldownSnapshot.state).toBe("cooldown");
      expect(cooldownSnapshot.context.improvementCycleId).toBeNull();
      expect(cooldownSnapshot.cooldownEnteredAt).not.toBeNull();

      // cooldown is a real wait: before the cooldown elapses nothing happens.
      const cooldownStart = Date.parse(cooldownSnapshot.cooldownEnteredAt as string);
      step = await runner.once({ ...deps, nowMs: () => cooldownStart + 1000 });
      expect(step.executed).toBe(false);
      expect(runner.snapshot().state).toBe("cooldown");

      // ...and after it elapses the series prepares cycle 2.
      step = await runner.once({ ...deps, nowMs: () => cooldownStart + ORCHESTRATOR_MIN_COOLDOWN_MS + 1 });
      expect(step.event).toBe("COOLDOWN_ELAPSED");
      expect(runner.snapshot().state).toBe("preparing");
      step = await runner.once(deps);
      expect(runner.snapshot().context.cycleSequence).toBe(2);
      expect(runner.snapshot().context.improvementCycleId).toBe("series-wiring-c2");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(cycleRoot, { recursive: true, force: true });
    }
  });
});

describe("improvement-orchestrator wiring — cooldown persistence", () => {
  it("persists cooldownEnteredAt so a fresh runner resumes the timer instead of restarting it", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-cooldown-"));
    const cycleRoot = await mkdtemp(join(tmpdir(), "orchestrator-cooldown-cycles-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-cooldown", evidenceRoot });
      await startSeries(runner);
      const deps = { cycleEvidenceRoot: cycleRoot, runWorker: fakeWorker(), runCommand: okCommand };
      for (let phase = 0; phase < 8; phase++) await runner.once(deps); // preparing..observing -> cooldown
      expect(runner.snapshot().state).toBe("cooldown");

      // A fresh runner (as every CLI invocation is) must restore the stamped
      // timer from disk and expire the cooldown on schedule.
      const fresh = await OrchestratorRunner.create({ seriesId: "series-cooldown", evidenceRoot });
      expect(fresh.snapshot().cooldownEnteredAt).not.toBeNull();
      const cooldownStart = Date.parse(fresh.snapshot().cooldownEnteredAt as string);
      const step = await fresh.once({ ...deps, nowMs: () => cooldownStart + ORCHESTRATOR_MIN_COOLDOWN_MS + 1 });
      expect(step.event).toBe("COOLDOWN_ELAPSED");
      expect(fresh.snapshot().state).toBe("preparing");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(cycleRoot, { recursive: true, force: true });
    }
  });
});

describe("improvement-orchestrator wiring — human gates", () => {
  it("routes worker failures to workerFailed and retries only through a human event", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-fail-"));
    const cycleRoot = await mkdtemp(join(tmpdir(), "orchestrator-fail-cycles-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-fail", evidenceRoot });
      await startSeries(runner);
      await runner.once({ cycleEvidenceRoot: cycleRoot });

      const step = await runner.once({
        cycleEvidenceRoot: cycleRoot,
        runWorker: fakeWorker({ sensor: { ok: false, error: "herdr agent blocked (approval/question UI)" } }),
      });
      expect(step.event).toBe("WORKERS_FAILED");
      const snapshot = runner.snapshot();
      expect(snapshot.state).toBe("workerFailed");
      expect(snapshot.context.workerPhase).toBe("sampling");
      expect(snapshot.context.pendingReason).toContain("blocked");

      // The gate is inert for the executor...
      const stalled = await runner.once({ cycleEvidenceRoot: cycleRoot, runWorker: fakeWorker() });
      expect(stalled.executed).toBe(false);
      expect(runner.snapshot().state).toBe("workerFailed");

      // ...and only a human event reruns the failed phase.
      await runner.submit({ type: "RETRY_WORKERS", source: "human" });
      expect(runner.snapshot().state).toBe("sampling");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(cycleRoot, { recursive: true, force: true });
    }
  });

  it("routes a runner-rejected sample signal to the sampling phase with the runner's issues", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-reject-"));
    const cycleRoot = await mkdtemp(join(tmpdir(), "orchestrator-reject-cycles-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-reject", evidenceRoot });
      await startSeries(runner);
      const deps = { cycleEvidenceRoot: cycleRoot, runWorker: fakeWorker() };
      await runner.once(deps);

      // The bad sensor answer is harvested at the sampling step; the sealing
      // step then submits it and the cycle runner honestly rejects it.
      const step = await runner.once({
        ...deps,
        runWorker: fakeWorker({ sensor: answer({ nonsense: true }) }),
      });
      expect(step.event).toBe("WORKERS_HARVESTED");

      const rejected = await runner.once(deps);
      expect(rejected.event).toBe("SIGNAL_REJECTED");
      const snapshot = runner.snapshot();
      expect(snapshot.state).toBe("workerFailed");
      expect(snapshot.context.workerPhase).toBe("sampling");
      expect(snapshot.context.pendingReason).toContain("payload.sample");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(cycleRoot, { recursive: true, force: true });
    }
  });

  it("pauses on a retrying cycle and resumes only once the human authorized the retry", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-retry-"));
    const cycleRoot = await mkdtemp(join(tmpdir(), "orchestrator-retry-cycles-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-retry", evidenceRoot });
      await startSeries(runner);
      // Every anchor command fails honestly; the cycle evaluates into
      // `retrying` (attempt 0 of 2), so the series must pause for the human.
      const deps = {
        cycleEvidenceRoot: cycleRoot,
        runWorker: fakeWorker(),
        runCommand: async () => ({ ok: false, detail: "regression failed" }),
      };
      for (let index = 0; index < 8; index++) await runner.once(deps);
      expect(runner.snapshot().state).toBe("awaitingHumanCycleDecision");

      // While the human gate is open, polling is inert.
      const stalled = await runner.once(deps);
      expect(stalled.executed).toBe(false);
      expect(runner.snapshot().state).toBe("awaitingHumanCycleDecision");

      // The human owner authorizes the retry directly on the cycle (through
      // improvementctl in production); the orchestrator only observes it.
      const cycleRunner = await createImprovementRunner({
        evidenceRoot: cycleRoot,
        cycleId: "series-retry-c1",
        scope: "wiring",
        referenceHash: "a".repeat(64),
      });
      const retry = await cycleRunner.submit({
        cycleId: "series-retry-c1",
        type: "RETRY_AUTHORIZED",
        source: "human",
        producer: "human-owner",
        occurredAt: new Date().toISOString(),
        payload: {},
        evidence: ["owner authorized retry"],
      });
      expect(retry.accepted).toBe(true);
      expect(cycleRunner.snapshot().state).toBe("sampling");

      const step = await runner.once(deps);
      expect(step.event).toBe("CYCLE_RESUMED");
      expect(runner.snapshot().state).toBe("sampling");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(cycleRoot, { recursive: true, force: true });
    }
  });
});

describe("improvement-orchestrator wiring — journal replay", () => {
  it("restores an identical series snapshot by replaying the journal", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-replay-"));
    const cycleRoot = await mkdtemp(join(tmpdir(), "orchestrator-replay-cycles-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-replay", evidenceRoot });
      await startSeries(runner);
      const deps = { cycleEvidenceRoot: cycleRoot, runWorker: fakeWorker(), runCommand: okCommand };
      await runner.once(deps);
      await runner.once(deps);
      await runner.once(deps);
      const before = runner.snapshot();

      const restored = await OrchestratorRunner.create({ seriesId: "series-replay", evidenceRoot });
      const after = restored.snapshot();
      expect(after.state).toBe(before.state);
      expect(after.state).toBe("auditing");
      expect(JSON.stringify(after.context)).toBe(JSON.stringify(before.context));
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(cycleRoot, { recursive: true, force: true });
    }
  });
});

describe("improvement-orchestrator wiring — authority helpers", () => {
  it("maps cycle states to exactly one observation, or none", () => {
    expect(mapCycleStateToObservation("succeeded", null)?.type).toBe("CYCLE_SUCCEEDED");
    expect(mapCycleStateToObservation("adjusting", null)?.type).toBe("CYCLE_AWAITING_HUMAN");
    expect(mapCycleStateToObservation("retrying", null)?.type).toBe("CYCLE_AWAITING_HUMAN");
    expect(mapCycleStateToObservation("failed", "anchors exhausted")?.type).toBe("CYCLE_FAILED");
    expect(mapCycleStateToObservation("blocked", null)?.type).toBe("CYCLE_BLOCKED");
    expect(mapCycleStateToObservation("cancelled", null)?.type).toBe("CYCLE_CANCELLED");
    expect(mapCycleStateToObservation("sampling", null)).toBeNull();
    expect(mapCycleStateToObservation("grounding", null)).toBeNull();
  });

  it("restricts the CLI submit channel to human events", () => {
    expect(isHumanChannelEvent({ type: "RETRY_WORKERS", source: "human" })).toBe(true);
    expect(isHumanChannelEvent({ type: "RESTART_SERIES", source: "human" })).toBe(true);
    expect(isHumanChannelEvent({ type: "CANCEL_SERIES", source: "human", reason: "owner stopped the series" })).toBe(
      true,
    );
    expect(isHumanChannelEvent({ type: "START_SERIES", source: "human" })).toBe(false);
    expect(isHumanChannelEvent({ type: "WORKERS_HARVESTED", source: "tool" })).toBe(false);
    expect(isHumanChannelEvent({ type: "RETRY_WORKERS", source: "tool" })).toBe(false);
    expect(isHumanChannelEvent("cancel the series")).toBe(false);
    // CANCEL_SERIES requires a non-empty reason at the CLI boundary so the
    // failure is immediate and specific, not a generic machine rejection.
    expect(isHumanChannelEvent({ type: "CANCEL_SERIES", source: "human" })).toBe(false);
    expect(isHumanChannelEvent({ type: "CANCEL_SERIES", source: "human", reason: "   " })).toBe(false);
  });

  it("enforces one active series per scope", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "orchestrator-scope-"));
    try {
      const runner = await OrchestratorRunner.create({ seriesId: "series-a", evidenceRoot });
      await startSeries(runner);

      await expect(assertNoActiveSeriesForScope(evidenceRoot, "wiring", "series-a")).resolves.toBeUndefined();
      await expect(assertNoActiveSeriesForScope(evidenceRoot, "wiring", "series-b")).rejects.toThrow(
        /already has an active series 'series-a'/,
      );

      await runner.submit({ type: "CANCEL_SERIES", source: "human", reason: "owner stopped the series" });
      await expect(assertNoActiveSeriesForScope(evidenceRoot, "wiring", "series-b")).resolves.toBeUndefined();
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("keeps the frozen orchestrator graph in sync with the executable machine", async () => {
    const graph = JSON.parse(await readFile(resolve("models/improvement-orchestrator.graph.json"), "utf8"));
    expect(graph.states).toEqual([
      "idle",
      "preparing",
      "sampling",
      "sealing",
      "auditing",
      "arbitrating",
      "grounding",
      "evaluating",
      "observing",
      "cooldown",
      "awaitingHumanCycleDecision",
      "workerFailed",
      "halted",
      "cancelled",
    ]);
    expect([...graph.terminalStates].sort()).toEqual([...ORCHESTRATOR_TERMINAL_STATES].sort());
    expect([...graph.humanGatedStates].sort()).toEqual([...ORCHESTRATOR_HUMAN_GATED_STATES].sort());
    expect(graph.maxWorkerRetries).toBe(ORCHESTRATOR_MAX_WORKER_RETRIES);
    expect(graph.cooldownMs.minimum).toBe(ORCHESTRATOR_MIN_COOLDOWN_MS);
  });
});
