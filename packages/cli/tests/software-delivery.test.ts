import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeliveryRunner } from "@guyghost/swarm-dao-software-delivery";
import { main } from "../src/cli.js";

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "swarm-cli-delivery-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("swarm-dao delivery CLI route", () => {
  it("routes delivery help and the operator usage text", async () => {
    expect(await main(["delivery", "--help"], process.cwd())).toBe(0);
  });

  it("rejects init before creating a delivery when the referenced Product run is missing", async () => {
    const cwd = await tempRoot();
    const evidenceRoot = path.join(cwd, "deliveries");
    const code = await main(
      [
        "delivery",
        "init",
        "--delivery-id",
        "delivery-1",
        "--product-run-id",
        "missing-product",
        "--evidence-root",
        evidenceRoot,
        "--product-root",
        path.join(cwd, "products"),
        "--graph-root",
        path.join(cwd, "graphs"),
        "--stage-root",
        path.join(cwd, "stage"),
      ],
      cwd,
    );

    expect(code).toBe(2);
    expect(await Bun.file(evidenceRoot).exists()).toBe(false);
  });

  it("returns an execution error for malformed signal JSON", async () => {
    const cwd = await tempRoot();
    const evidenceRoot = path.join(cwd, "deliveries");
    await createDeliveryRunner({
      evidenceRoot,
      runId: "delivery-1",
      machineInput: {
        productRunId: "product-1",
        graphRunId: "delivery-1-graph",
        proposalId: "proposal-1",
        scope: "scope",
        scopeHash: "a".repeat(64),
        riskClass: "standard",
        creditsPerGraphAttempt: 1,
        observationWindowMs: 180_000,
        observationIntervalMs: 60_000,
      },
    });
    await writeFile(path.join(cwd, "bad-signal.json"), "{broken", "utf8");

    expect(
      await main(
        [
          "delivery",
          "submit",
          "--delivery-id",
          "delivery-1",
          "--signal",
          "bad-signal.json",
          "--evidence-root",
          evidenceRoot,
        ],
        cwd,
      ),
    ).toBe(1);
  });

  it("replays a run after its initial unknown risk was resolved by a human", async () => {
    const cwd = await tempRoot();
    const evidenceRoot = path.join(cwd, "deliveries");
    const runner = await createDeliveryRunner({
      evidenceRoot,
      runId: "delivery-unknown",
      machineInput: {
        productRunId: "product-1",
        graphRunId: "delivery-unknown-graph",
        proposalId: "proposal-1",
        scope: "scope",
        scopeHash: "b".repeat(64),
        riskClass: "unknown",
        creditsPerGraphAttempt: 1,
        observationWindowMs: 180_000,
        observationIntervalMs: 60_000,
      },
    });
    const signalBase = {
      runId: "delivery-unknown",
      occurredAt: "2026-09-25T12:00:00.000Z",
      payload: {},
      evidence: ["owner-reviewed-risk"],
    };
    expect(
      (await runner.submit({ ...signalBase, type: "INTAKE_ACCEPTED", source: "tool", producer: "intake-validator" }))
        .accepted,
    ).toBe(true);
    expect(
      (
        await runner.submit({
          ...signalBase,
          type: "RISK_CLASSIFICATION_RESOLVED",
          source: "human",
          producer: "human-owner",
          payload: { riskClass: "standard" },
        })
      ).accepted,
    ).toBe(true);

    expect(
      await main(["delivery", "status", "--delivery-id", "delivery-unknown", "--evidence-root", evidenceRoot], cwd),
    ).toBe(0);
  });
});
