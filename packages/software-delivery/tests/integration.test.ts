import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createReferenceScenario } from "../src/testing/reference-scenario.js";

const scenarios: Array<{ cleanup: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.cleanup()));
});

describe("repository-native software delivery integration", () => {
  it("validates a standard run through the public ProductRunner and GraphRunner APIs", async () => {
    const run = await createReferenceScenario({ riskClass: "standard" });
    scenarios.push(run);

    const result = await run.resumeUntilPauseOrTerminal();

    expect(result.state).toBe("validated");
    expect(run.delivery.snapshot().state).toBe("validated");
    expect(run.graphRunner()?.snapshot().state).toBe("succeeded");
    expect(run.productRunner.snapshot().state).toBe("validated");
    const ownerApproval = run.graphSubmissions.find(
      (signal) => signal.type === "MODEL_APPROVED" && signal.source === "human",
    );
    expect(ownerApproval?.payload).toEqual({ modelHash: run.delivery.snapshot().context.modelHash });
    expect(run.productSubmissions.every((entry) => entry.accepted)).toBe(true);
    expect(run.deliverySubmissions).toBeGreaterThan(0);
    expect(run.productRunner.snapshot().context.observationSamples.some((sample) => sample.metric === "aiCost")).toBe(
      false,
    );
  });

  it("pauses on an unknown risk, then proceeds only after an owner classification", async () => {
    const run = await createReferenceScenario({ riskClass: "unknown" });
    scenarios.push(run);

    const paused = await run.resumeUntilPauseOrTerminal();
    expect(paused).toMatchObject({ kind: "waiting-human", state: "awaitingRiskReview" });
    expect(await run.resolveRisk("standard")).toBe(true);
    expect((await run.resumeUntilPauseOrTerminal()).state).toBe("validated");
  });

  it("keeps Graph implementation stopped when the owner submits a stale model hash", async () => {
    const run = await createReferenceScenario({ graphApproval: "stale" });
    scenarios.push(run);

    const result = await run.resumeUntilPauseOrTerminal();

    expect(result).toMatchObject({ kind: "waiting-human", state: "awaitingGraphApproval" });
    expect(run.graphRunner()?.snapshot().state).toBe("awaitingApproval");
    expect(run.graphSubmissions.some((signal) => signal.type === "IMPLEMENTATION_READY")).toBe(false);
  });

  it("requires Product's human deploy authorization for sensitive changes", async () => {
    const run = await createReferenceScenario({ riskClass: "sensitive" });
    scenarios.push(run);

    expect((await run.resumeUntilPauseOrTerminal()).state).toBe("awaitingShipReview");
    expect(run.productRunner.snapshot().state).toBe("review");
    expect(await run.authorizeSensitiveDeploy()).toBe(true);
    expect((await run.resumeUntilPauseOrTerminal()).state).toBe("validated");
  });

  it("does not start the worker when Product sends the attempt charge to budget review", async () => {
    const run = await createReferenceScenario({ budgetAllocation: 1, creditsPerGraphAttempt: 1 });
    scenarios.push(run);

    const result = await run.resumeUntilPauseOrTerminal();

    expect(result.kind).toBe("waiting-human");
    expect(run.productRunner.snapshot().state).toBe("review");
    expect(run.graphSubmissions.some((signal) => signal.type === "IMPLEMENTATION_READY")).toBe(false);
  });

  it("blocks a delivery after a Product control fails", async () => {
    const run = await createReferenceScenario({ failedControl: true });
    scenarios.push(run);

    expect((await run.resumeUntilPauseOrTerminal()).state).toBe("blocked");
    expect(run.productRunner.snapshot().state).toBe("review");
    expect(run.productSubmissions.some((entry) => entry.signal.type === "VERIFY_RUN" && entry.accepted)).toBe(true);
  });

  it("waits for reversible staging capability, then validates after it is restored", async () => {
    const run = await createReferenceScenario({ stagingAvailable: false });
    scenarios.push(run);

    expect((await run.resumeUntilPauseOrTerminal()).state).toBe("awaitingShipCapability");
    run.setStagingAvailable(true);
    expect((await run.resumeUntilPauseOrTerminal()).state).toBe("validated");
  });

  it("reconciles a pending graph creation effect and rolls back after three degraded measurements", async () => {
    const recovery = await createReferenceScenario({ failGraphCreationOnce: true, recoverPendingGraphCreation: true });
    scenarios.push(recovery);
    await expect(recovery.resumeUntilPauseOrTerminal()).rejects.toThrow("reference crash after delivery effect intent");
    expect((await recovery.resumeUntilPauseOrTerminal()).state).toBe("validated");

    const rollback = await createReferenceScenario({ degradedObservations: true });
    scenarios.push(rollback);
    expect((await rollback.resumeUntilPauseOrTerminal()).state).toBe("observing");
    expect(rollback.delivery.snapshot().context.rollbackConfirmed).toBe(true);
    expect(
      rollback.productRunner.snapshot().context.observationSamples.filter((sample) => sample.metric === "errors"),
    ).toHaveLength(3);
    expect(await rollback.openCorrectiveTask()).toBe(true);
    expect((await rollback.resumeUntilPauseOrTerminal()).state).toBe("rolledBack");
  });

  it("settles cancellation through the child runners and rejects a corrupt child journal", async () => {
    const cancelled = await createReferenceScenario({ graphApproval: "manual" });
    scenarios.push(cancelled);
    expect((await cancelled.resumeUntilPauseOrTerminal()).state).toBe("awaitingGraphApproval");
    expect(await cancelled.requestCancellation()).toBe(true);
    await expect(cancelled.resumeUntilPauseOrTerminal()).rejects.toThrow(
      "active child runs require explicit owner cancellation",
    );
    expect(await cancelled.cancelChildrenAsOwner()).toBe(true);
    expect((await cancelled.resumeUntilPauseOrTerminal()).state).toBe("cancelled");
    expect(cancelled.productRunner.snapshot().state).toBe("rejected");
    expect(cancelled.graphRunner()?.snapshot().state).toBe("cancelled");

    const corrupt = await createReferenceScenario();
    scenarios.push(corrupt);
    await writeFile(resolve(corrupt.root, ".dao/product-loops/product-reference/journal.ndjson"), "not-json\n");
    await expect(corrupt.resumeUntilPauseOrTerminal()).rejects.toThrow("journal line 1 is not valid JSON");
  });
});
