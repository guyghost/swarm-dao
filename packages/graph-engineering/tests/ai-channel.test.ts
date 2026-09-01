// ============================================================
// Swarm DAO Graph Engineering — AI-channel submission tests
// ============================================================
import { beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GRAPH_AI_EVENT_TYPES, submitAiGraphSignal } from "../src/index.js";

async function tmpRoot(label: string): Promise<string> {
  const root = path.join(import.meta.dir, `.tmp-ai-channel-${label}-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
}

describe("submitAiGraphSignal", () => {
  let root: string;
  beforeEach(async () => {
    root = await tmpRoot("graph");
  });

  it("stamps source ai and routes through the frozen machine", async () => {
    const result = await submitAiGraphSignal(
      { evidenceRoot: root },
      {
        runId: "run-1",
        type: "MODEL_DRAFTED",
        producer: "claude",
        payload: { modelHash: "deadbeef", patch: "models/run-1.json" },
        evidence: ["evidence/run-1/model.md"],
      },
    );
    expect(result.accepted).toBe(true);
    expect(result.snapshot.state).toBe("modelReview");

    const journal = (await fs.readFile(path.join(root, "run-1", "journal.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal).toHaveLength(1);
    expect(journal[0].signal).toMatchObject({ type: "MODEL_DRAFTED", source: "ai", producer: "claude" });
  });

  it("exposes only the AI-artifact event types", () => {
    expect([...GRAPH_AI_EVENT_TYPES]).toEqual(["MODEL_DRAFTED", "IMPLEMENTATION_READY", "IMPLEMENTATION_FAILED"]);
  });

  it("never lets the AI channel carry a human event", async () => {
    const result = await submitAiGraphSignal(
      { evidenceRoot: root },
      {
        runId: "run-2",
        type: "MODEL_APPROVED" as unknown as (typeof GRAPH_AI_EVENT_TYPES)[number],
        producer: "claude",
        payload: {},
        evidence: [],
      },
    );
    expect(result.accepted).toBe(false);
  });
});
