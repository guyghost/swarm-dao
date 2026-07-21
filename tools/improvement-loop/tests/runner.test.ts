import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImprovementRunner } from "../runner.js";

const baseOptions = (evidenceRoot: string) => ({
  evidenceRoot,
  cycleId: "improvement-reinit",
  scope: "self-improvement-cycle",
  referenceHash: "a".repeat(64),
});

describe("improvement runner reinitialization", () => {
  it("rejects reopening an existing cycle with a different referenceHash", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "improvement-runner-"));
    try {
      await createImprovementRunner(baseOptions(evidenceRoot));
      const reopened = createImprovementRunner({
        ...baseOptions(evidenceRoot),
        referenceHash: "b".repeat(64),
      });
      await expect(reopened).rejects.toThrow(/different referenceHash/);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("rejects reopening an existing cycle with a different scope", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "improvement-runner-"));
    try {
      await createImprovementRunner(baseOptions(evidenceRoot));
      const reopened = createImprovementRunner({
        ...baseOptions(evidenceRoot),
        scope: "a-different-scope",
      });
      await expect(reopened).rejects.toThrow(/different scope/);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("allows reopening an existing cycle when immutable inputs match", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "improvement-runner-"));
    try {
      const first = await createImprovementRunner(baseOptions(evidenceRoot));
      await first.submit({
        cycleId: "improvement-reinit",
        type: "METRIC_SAMPLED",
        source: "ai",
        producer: "sensor",
        occurredAt: new Date().toISOString(),
        payload: { sample: { value: "rose", evidence: "throughput improved" } },
        evidence: ["throughput improved"],
      });
      const reopened = createImprovementRunner(baseOptions(evidenceRoot));
      await expect(reopened).resolves.toBeDefined();
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});
