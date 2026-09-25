import { describe, expect, it } from "bun:test";
import { createStagingObservationSamples, evaluateStagingObservation } from "../src/observations.js";

const inspect = async (overrides: Partial<{ intact: boolean; errorCount: number; checkLatencyMs: number }> = {}) => ({
  intact: true,
  errorCount: 0,
  checkLatencyMs: 3,
  ...overrides,
  evidence: "stage:inspection",
});

describe("staging observation measurements", () => {
  it("omits unavailable provider cost and records measured staging checks", async () => {
    const samples = await createStagingObservationSamples({
      inspect,
      providerCost: { available: false },
    });

    expect(samples.map((sample) => sample.metric)).toEqual(["errors", "latency"]);
    expect(samples.some((sample) => sample.metric === "aiCost")).toBe(false);
    expect(samples.every((sample) => sample.evidence === "stage:inspection")).toBe(true);
  });

  it("includes only explicitly measured customer and provider signals", async () => {
    const samples = await createStagingObservationSamples({
      inspect: async () => ({ intact: true, errorCount: 0, checkLatencyMs: 3, evidence: "stage:measured" }),
      providerCost: { available: true, value: 0.02, threshold: 0.1, evidence: "host:cost-measurement" },
      customerSignal: { available: true, value: 4.7, threshold: 4, evidence: "survey:aggregate" },
    });

    expect(samples.map((sample) => sample.metric)).toEqual(["errors", "latency", "aiCost", "satisfaction"]);
    expect(samples.find((sample) => sample.metric === "aiCost")?.value).toBe(0.02);
    expect(samples.find((sample) => sample.metric === "satisfaction")?.value).toBe(4.7);
  });

  it("requires three clean staging measurements and elapsed time before evaluation", async () => {
    const sample = await createStagingObservationSamples({ inspect });
    const two = [...sample, ...sample];
    const three = [...sample, ...sample, ...sample];

    expect(evaluateStagingObservation(two, { windowElapsed: true }).status).toBe("collecting");
    expect(evaluateStagingObservation(three, { windowElapsed: false }).status).toBe("collecting");
    expect(evaluateStagingObservation(three, { windowElapsed: true }).status).toBe("ready");
  });

  it("does not hold required staging checks open for an intermittently unavailable optional cost metric", async () => {
    const required = await createStagingObservationSamples({ inspect });
    const cost = {
      metric: "aiCost" as const,
      value: 0.02,
      threshold: 0.1,
      exceeded: false,
      evidence: "host:cost-once",
    };
    const samples = [...required, ...required, ...required, cost];

    expect(evaluateStagingObservation(samples, { windowElapsed: true }).status).toBe("ready");
  });

  it("reports three consecutive threshold failures as degraded", async () => {
    const sample = await createStagingObservationSamples({
      inspect: () => inspect({ errorCount: 1 }),
    });
    const result = evaluateStagingObservation([...sample, ...sample, ...sample], { windowElapsed: false });

    expect(result).toEqual({ status: "degraded", metric: "errors" });
  });
});
