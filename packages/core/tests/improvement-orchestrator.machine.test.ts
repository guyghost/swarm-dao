import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import {
  ORCHESTRATOR_MIN_COOLDOWN_MS,
  ORCHESTRATOR_TERMINAL_STATES,
  orchestratorMachine,
} from "../src/models/improvement-orchestrator.machine.js";

type AnyActor = ReturnType<typeof createActor<typeof orchestratorMachine>>;

const startActor = (seriesId = "series-test") => {
  const actor = createActor(orchestratorMachine, { input: { seriesId } });
  actor.start();
  return actor;
};

const startSeries = (actor: AnyActor, cooldownMs = ORCHESTRATOR_MIN_COOLDOWN_MS) =>
  actor.send({ type: "START_SERIES", source: "human", scope: "test-scope", referenceHash: "ref-a", cooldownMs });

/** Drive one full nominal cycle: sampling -> ... -> observing. */
const reachObserving = () => {
  const actor = startActor();
  startSeries(actor);
  actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "series-test-c1" });
  actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
  actor.send({ type: "SAMPLES_SUBMITTED", source: "tool" });
  actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
  actor.send({ type: "ARBITRATION_SUBMITTED", source: "tool" });
  actor.send({ type: "ANCHORS_SUBMITTED", source: "tool" });
  actor.send({ type: "EVALUATE_SUBMITTED", source: "tool" });
  return actor;
};

describe("improvement-orchestrator machine — nominal continuity", () => {
  it("runs the full cycle sequence and loops on success", () => {
    const actor = reachObserving();
    actor.send({ type: "CYCLE_SUCCEEDED", source: "system" });
    expect(actor.getSnapshot().value).toBe("cooldown");

    actor.send({ type: "COOLDOWN_ELAPSED", source: "system" });
    expect(actor.getSnapshot().value).toBe("preparing");

    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "series-test-c2" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("sampling");
    expect(snapshot.context.cycleSequence).toBe(2);
    expect(snapshot.context.improvementCycleId).toBe("series-test-c2");
  });

  it("starts only from idle with a valid human START_SERIES", () => {
    const actor = startActor();
    expect(actor.getSnapshot().value).toBe("idle");

    startSeries(actor);
    expect(actor.getSnapshot().value).toBe("preparing");
    expect(actor.getSnapshot().context.scope).toBe("test-scope");
    expect(actor.getSnapshot().context.referenceHash).toBe("ref-a");
    expect(actor.getSnapshot().context.started).toBe(true);
  });

  it("rejects START_SERIES with missing identity or a too-short cooldown", () => {
    const tooShort = startActor("short");
    tooShort.send({
      type: "START_SERIES",
      source: "human",
      scope: "s",
      referenceHash: "r",
      cooldownMs: ORCHESTRATOR_MIN_COOLDOWN_MS - 1,
    });
    expect(tooShort.getSnapshot().value).toBe("idle");

    const noScope = startActor("noscope");
    noScope.send({ type: "START_SERIES", source: "human", scope: "", referenceHash: "r", cooldownMs: 60000 });
    expect(noScope.getSnapshot().value).toBe("idle");

    const noHash = startActor("nohash");
    noHash.send({ type: "START_SERIES", source: "human", scope: "s", referenceHash: "", cooldownMs: 60000 });
    expect(noHash.getSnapshot().value).toBe("idle");
  });
});

describe("improvement-orchestrator machine — human gates", () => {
  it("pauses on awaitingHumanCycleDecision and resumes into sampling", () => {
    const actor = reachObserving();
    actor.send({ type: "CYCLE_AWAITING_HUMAN", source: "system" });
    expect(actor.getSnapshot().value).toBe("awaitingHumanCycleDecision");

    // Only CYCLE_RESUMED leaves the gate; tool/system events are ignored.
    actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
    actor.send({ type: "COOLDOWN_ELAPSED", source: "system" });
    expect(actor.getSnapshot().value).toBe("awaitingHumanCycleDecision");

    actor.send({ type: "CYCLE_RESUMED", source: "system" });
    expect(actor.getSnapshot().value).toBe("sampling");
  });

  it("halts on cycle failure and restarts only through a human event", () => {
    const actor = reachObserving();
    actor.send({ type: "CYCLE_FAILED", source: "system", reason: "anchors exhausted" });
    const halted = actor.getSnapshot();
    expect(halted.value).toBe("halted");
    expect(halted.context.pendingReason).toBe("anchors exhausted");

    actor.send({ type: "COOLDOWN_ELAPSED", source: "system" });
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "x" });
    expect(actor.getSnapshot().value).toBe("halted");

    actor.send({ type: "RESTART_SERIES", source: "human" });
    expect(actor.getSnapshot().value).toBe("preparing");
  });

  it("halts on blocked and cancelled cycles too", () => {
    for (const event of [
      { type: "CYCLE_BLOCKED", source: "system", reason: "permission denied" },
      { type: "CYCLE_CANCELLED", source: "system", reason: "owner cancelled cycle" },
    ] as const) {
      const actor = reachObserving();
      actor.send(event);
      expect(actor.getSnapshot().value).toBe("halted");
    }
  });
});

describe("improvement-orchestrator machine — worker failures", () => {
  it("records the failed phase and retries only through a human event", () => {
    const actor = startActor();
    startSeries(actor);
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c1" });
    actor.send({ type: "WORKERS_FAILED", source: "tool", reason: "herdr agent blocked", phase: "sampling" });
    let snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("workerFailed");
    expect(snapshot.context.workerPhase).toBe("sampling");
    expect(snapshot.context.pendingReason).toBe("herdr agent blocked");

    actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
    actor.send({ type: "COOLDOWN_ELAPSED", source: "system" });
    expect(actor.getSnapshot().value).toBe("workerFailed");

    actor.send({ type: "RETRY_WORKERS", source: "human" });
    expect(actor.getSnapshot().value).toBe("sampling");
    snapshot = actor.getSnapshot();
    expect(snapshot.context.workerPhase).toBeNull();
    expect(snapshot.context.pendingReason).toBeNull();
  });

  it("retries into the auditing phase when the drift worker failed there", () => {
    const actor = startActor();
    startSeries(actor);
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c1" });
    actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
    actor.send({ type: "SAMPLES_SUBMITTED", source: "tool" });
    actor.send({ type: "WORKERS_FAILED", source: "tool", reason: "timeout", phase: "auditing" });
    expect(actor.getSnapshot().value).toBe("workerFailed");

    actor.send({ type: "RETRY_WORKERS", source: "human" });
    expect(actor.getSnapshot().value).toBe("auditing");
  });

  it("routes runner-rejected sample signals to the sampling worker phase", () => {
    const actor = startActor();
    startSeries(actor);
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c1" });
    actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
    actor.send({ type: "SIGNAL_REJECTED", source: "tool", issues: ["payload.sample must be set"] });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("workerFailed");
    expect(snapshot.context.workerPhase).toBe("sampling");
    expect(snapshot.context.pendingReason).toContain("payload.sample");
  });

  it("routes runner-rejected drift signals to the auditing worker phase", () => {
    const actor = startActor();
    startSeries(actor);
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c1" });
    actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
    actor.send({ type: "SAMPLES_SUBMITTED", source: "tool" });
    actor.send({ type: "WORKERS_HARVESTED", source: "tool" });
    actor.send({ type: "SIGNAL_REJECTED", source: "tool", issues: ["driftClass must be none, partial, or detached"] });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("workerFailed");
    expect(snapshot.context.workerPhase).toBe("auditing");
  });

  it("rejects worker failures with an unknown phase", () => {
    const actor = startActor();
    startSeries(actor);
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c1" });
    actor.send({
      type: "WORKERS_FAILED",
      source: "tool",
      reason: "x",
      phase: "grounding",
    });
    expect(actor.getSnapshot().value).toBe("sampling");
  });
});

describe("improvement-orchestrator machine — cancellation and terminals", () => {
  it("cancels from any active state and never accepts events afterwards", () => {
    const actor = reachObserving();
    actor.send({ type: "CANCEL_SERIES", source: "human", reason: "owner stopped the series" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("cancelled");
    expect(snapshot.context.terminalReason).toBe("owner stopped the series");

    actor.send({ type: "CYCLE_SUCCEEDED", source: "system" });
    actor.send({ type: "RESTART_SERIES", source: "human" });
    actor.send({ type: "COOLDOWN_ELAPSED", source: "system" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });

  it("rejects cancellation before the series started", () => {
    const actor = startActor();
    actor.send({ type: "CANCEL_SERIES", source: "human", reason: "nope" });
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("keeps series identity immutable across every event", () => {
    const actor = reachObserving();
    const identity = {
      seriesId: actor.getSnapshot().context.seriesId,
      scope: actor.getSnapshot().context.scope,
      referenceHash: actor.getSnapshot().context.referenceHash,
      cooldownMs: actor.getSnapshot().context.cooldownMs,
    };
    actor.send({ type: "CYCLE_SUCCEEDED", source: "system" });
    actor.send({ type: "COOLDOWN_ELAPSED", source: "system" });
    actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c2" });
    const after = actor.getSnapshot().context;
    expect(after.seriesId).toBe(identity.seriesId);
    expect(after.scope).toBe(identity.scope);
    expect(after.referenceHash).toBe(identity.referenceHash);
    expect(after.cooldownMs).toBe(identity.cooldownMs);
  });
});

describe("improvement-orchestrator machine — authority boundaries", () => {
  it("rejects every wrong-source event", () => {
    const wrongSources: ReadonlyArray<{
      type:
        | "CYCLE_INITIALIZED"
        | "WORKERS_HARVESTED"
        | "SAMPLES_SUBMITTED"
        | "CYCLE_SUCCEEDED"
        | "COOLDOWN_ELAPSED"
        | "START_SERIES"
        | "RETRY_WORKERS"
        | "CANCEL_SERIES";
      source: "human" | "tool" | "system" | "ai";
    }> = [
      { type: "START_SERIES", source: "tool" },
      { type: "START_SERIES", source: "ai" },
      { type: "CYCLE_INITIALIZED", source: "human" },
      { type: "WORKERS_HARVESTED", source: "human" },
      { type: "SAMPLES_SUBMITTED", source: "system" },
      { type: "CYCLE_SUCCEEDED", source: "tool" },
      { type: "COOLDOWN_ELAPSED", source: "tool" },
      { type: "RETRY_WORKERS", source: "tool" },
      { type: "CANCEL_SERIES", source: "tool" },
    ];
    for (const event of wrongSources) {
      const actor = startActor("boundary");
      startSeries(actor);
      actor.send({ type: "CYCLE_INITIALIZED", source: "tool", cycleId: "c1" });
      const before = actor.getSnapshot().value;
      actor.send(event as never);
      expect(actor.getSnapshot().value).toBe(before);
    }
  });

  it("declares exactly the approved terminal states", () => {
    expect([...ORCHESTRATOR_TERMINAL_STATES].sort()).toEqual(["cancelled", "idle"]);
  });
});
