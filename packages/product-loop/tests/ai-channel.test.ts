// ============================================================
// Swarm DAO Product Loop — AI-channel submission tests
// ============================================================
import { beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type PRODUCT_AI_EVENT_TYPES, submitAiProductSignal } from "../src/index.js";

async function tmpRoot(label: string): Promise<string> {
  const root = path.join(import.meta.dir, `.tmp-ai-channel-${label}-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
}

describe("submitAiProductSignal", () => {
  let root: string;
  beforeEach(async () => {
    root = await tmpRoot("product");
  });

  it("stamps source ai and binds authority to the producer's declared node", async () => {
    const result = await submitAiProductSignal(
      { evidenceRoot: root },
      {
        runId: "run-1",
        type: "AGENT_SIGNAL",
        producer: "explorer",
        payload: { note: "first exploratory signal" },
        evidence: ["evidence/run-1/exploration.md"],
      },
    );
    expect(result.accepted).toBe(true);

    const journal = (await fs.readFile(path.join(root, "run-1", "journal.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal).toHaveLength(1);
    expect(journal[0].signal).toMatchObject({ type: "AGENT_SIGNAL", source: "ai", producer: "explorer" });
  });

  it("rejects a producer node that does not own the event", async () => {
    // "proposer" only emits PROPOSAL_DRAFTED; an AGENT_SIGNAL from it has no
    // authority in models/product-loop.graph.json.
    const result = await submitAiProductSignal(
      { evidenceRoot: root },
      {
        runId: "run-2",
        type: "AGENT_SIGNAL",
        producer: "proposer",
        payload: { note: "not my lane" },
        evidence: [],
      },
    );
    expect(result.accepted).toBe(false);
  });

  it("never lets the AI channel carry a human event", async () => {
    const result = await submitAiProductSignal(
      { evidenceRoot: root },
      {
        runId: "run-3",
        type: "REVIEW_RESOLVED" as unknown as (typeof PRODUCT_AI_EVENT_TYPES)[number],
        producer: "explorer",
        payload: {},
        evidence: [],
      },
    );
    expect(result.accepted).toBe(false);
  });
});
