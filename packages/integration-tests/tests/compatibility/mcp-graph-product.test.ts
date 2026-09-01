import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSwarmDaoMcpServer } from "@guyghost/swarm-dao-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** Text payload of a `tools/call` response. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

describe("Compatibility: MCP graph & product run surface", () => {
  let workDir: string;
  let client: Client;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-mcp-runs-"));
    const server = createSwarmDaoMcpServer(workDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "integration-tests", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("reads a fresh graph run snapshot and submits an AI model draft", async () => {
    const status = JSON.parse(
      textOf(await client.callTool({ name: "dao_graph_status", arguments: { runId: "mcp-g1" } })),
    );
    expect(status.state).toBe("draft");

    const submitted = JSON.parse(
      textOf(
        await client.callTool({
          name: "dao_graph_submit",
          arguments: {
            runId: "mcp-g1",
            type: "MODEL_DRAFTED",
            producer: "modeler",
            payload: { modelHash: "sha256-abc" },
            evidence: ["models/graph-engineering.md"],
          },
        }),
      ),
    );
    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot.state).toBe("modelReview");
    // The host owns the source: the journaled signal must carry source "ai".
    const journal = await fs.readFile(path.join(workDir, ".dao/graph-runs/mcp-g1/journal.ndjson"), "utf8");
    expect(journal).toContain('"source":"ai"');
  });

  it("rejects a schema-invalid event type at the protocol level (no human events over MCP)", async () => {
    const result = await client.callTool({
      name: "dao_graph_submit",
      arguments: {
        runId: "mcp-g2",
        // Human-authority event: not in the tool's enum, so the MCP layer
        // refuses it before any signal validation runs.
        type: "MODEL_APPROVED",
        producer: "human-owner",
        payload: { modelHash: "sha256-abc" },
        evidence: [],
      },
    });
    expect(result.isError).toBe(true);
  });

  it("surfaces machine rejections as tool errors", async () => {
    // IMPLEMENTATION_READY without an approved model: the machine must refuse.
    const result = await client.callTool({
      name: "dao_graph_submit",
      arguments: {
        runId: "mcp-g3",
        type: "IMPLEMENTATION_READY",
        producer: "implementer",
        payload: { implementationHash: "sha256-impl" },
        evidence: ["implementation diff"],
      },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.accepted).toBe(false);
  });

  it("submits an explorer agent signal to a product run (producer-bound)", async () => {
    const submitted = JSON.parse(
      textOf(
        await client.callTool({
          name: "dao_product_submit",
          arguments: {
            runId: "mcp-p1",
            type: "AGENT_SIGNAL",
            producer: "explorer",
            payload: { note: "explored the search relevance surface" },
            evidence: ["notes/search-relevance.md"],
          },
        }),
      ),
    );
    expect(submitted.accepted).toBe(true);
    // Signal-only event: the run stays in exploration, journaled with source ai.
    const journal = await fs.readFile(path.join(workDir, ".dao/product-loops/mcp-p1/journal.ndjson"), "utf8");
    expect(journal).toContain('"source":"ai"');

    const status = JSON.parse(
      textOf(await client.callTool({ name: "dao_product_status", arguments: { runId: "mcp-p1" } })),
    );
    expect(status.state).toBe("exploration");
  });

  it("rejects an undeclared producer through signal validation", async () => {
    const result = await client.callTool({
      name: "dao_product_submit",
      arguments: {
        runId: "mcp-p2",
        type: "AGENT_SIGNAL",
        producer: "vote-tally",
        payload: { note: "forged tool producer" },
        evidence: ["x"],
      },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.accepted).toBe(false);
    expect(parsed.issues.join("\n")).toMatch(/producer/);
  });
});
