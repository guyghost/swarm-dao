import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphRunner } from "../runner.js";

const signal = (
  type: string,
  source: "ai" | "tool" | "human" | "system",
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = [],
) => ({
  runId: "graph-runner-test",
  type,
  source,
  producer,
  occurredAt: "2026-07-20T12:00:00.000Z",
  payload,
  evidence,
});

describe("graph runner", () => {
  it("journals rejected events and deterministically replays accepted events", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "swarm-graph-"));
    try {
      const runner = await createGraphRunner({
        evidenceRoot,
        runId: "graph-runner-test",
        clock: () => "2026-07-20T12:00:01.000Z",
      });

      const forbidden = await runner.submit(
        signal("MODEL_DRAFTED", "ai", "modeler", { modelHash: "model-a", nextState: "succeeded" }, ["model"]),
      );
      expect(forbidden.accepted).toBe(false);

      await runner.submit(signal("MODEL_DRAFTED", "ai", "modeler", { modelHash: "model-a" }, ["model"]));
      await runner.submit(signal("MODEL_CONTRACT_VALID", "tool", "model-contract-validator", {}, ["contract passed"]));
      await runner.submit(signal("MODEL_APPROVED", "human", "human-owner", { modelHash: "model-a" }));

      const resumed = await createGraphRunner({ evidenceRoot, runId: "graph-runner-test" });
      expect(resumed.snapshot().state).toBe("ready");
      expect(resumed.snapshot().context.approvedModelHash).toBe("model-a");

      const journal = (await readFile(join(evidenceRoot, "graph-runner-test", "journal.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journal.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
      expect(journal[0].accepted).toBe(false);
      expect(journal[0].issues.join("\n")).toMatch(/nextState/);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});
