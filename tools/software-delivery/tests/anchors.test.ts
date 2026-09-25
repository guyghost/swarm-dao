import { describe, expect, it } from "bun:test";
import { readDeliveryAnchorCommands, runDeliveryAnchors } from "../anchors.js";
import { APPROVED_DELIVERY_MODEL_HASH } from "../contract.js";

describe("software-delivery anchor runner", () => {
  it("loads its command plan from the hash-approved delivery graph", async () => {
    const plan = await readDeliveryAnchorCommands(process.cwd());

    expect(plan.modelHash).toBe(APPROVED_DELIVERY_MODEL_HASH);
    expect(plan.commands.map(({ anchor }) => anchor)).toEqual([
      "delivery-model-contract",
      "delivery-machine-tests",
      "delivery-architecture-contract",
      "rollback-path-exists",
      "delivery-runtime-scenario",
      "delivery-regression",
      "repository-ci",
    ]);
    expect(plan.commands.find(({ anchor }) => anchor === "rollback-path-exists")?.command).toBe(
      "bun run software-delivery:anchors",
    );
  });

  it("executes the recursive rollback anchor as a temporary local staging proof", async () => {
    const result = await runDeliveryAnchors(process.cwd(), ["rollback-path-exists"]);

    expect(result.modelHash).toBe(APPROVED_DELIVERY_MODEL_HASH);
    expect(result.results).toEqual([
      {
        anchor: "rollback-path-exists",
        command: "bun run software-delivery:anchors",
        passed: true,
        execution: "local-staging-check",
        exitCode: 0,
      },
    ]);
  });

  it("rejects a requested anchor that is absent from the frozen graph", async () => {
    await expect(runDeliveryAnchors(process.cwd(), ["shell-injection"])).rejects.toThrow(
      "unknown software-delivery anchor",
    );
  });
});
