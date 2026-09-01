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

  it("lists pending human gates read-only with runnable suggestions", async () => {
    await fs.mkdir(path.join(workDir, ".dao/graph-runs", "gate-1"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, ".dao/graph-runs", "gate-1", "snapshot.json"),
      JSON.stringify({
        runId: "gate-1",
        state: "awaitingApproval",
        status: "active",
        context: { runId: "gate-1", modelHash: "deadbeef" },
      }),
      "utf8",
    );

    const text = textOf(await client.callTool({ name: "dao_attention", arguments: {} }));
    expect(text).toContain("1 pending human gate");
    expect(text).toContain("graph-engineering/gate-1");
    expect(text).toContain("deadbeef");
    expect(text).toContain("swarm-dao approve --run-id gate-1");

    // Source filtering and the empty case.
    const filtered = textOf(await client.callTool({ name: "dao_attention", arguments: { sources: ["product-loop"] } }));
    expect(filtered).toContain("no pending human gates");
  });

  it("rejects an unknown attention source", async () => {
    const result = await client.callTool({ name: "dao_attention", arguments: { sources: ["vibes"] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invalid source");
  });

  it("reads an improvement series snapshot read-only", async () => {
    const text = textOf(await client.callTool({ name: "dao_improve_status", arguments: { seriesId: "probe" } }));
    const snapshot = JSON.parse(text) as { seriesId: string; state: string };
    expect(snapshot.seriesId).toBe("probe");
    expect(snapshot.state).toBe("idle");
    // Read-only surface: the snapshot lands under the CLI default root.
    await fs.access(path.join(workDir, ".dao/improvement-series/probe/snapshot.json"));
  });

  it("advances a started series by one authorized effect via dao_improve_once", async () => {
    // Host-triggered advances carve a per-series worktree: the fixture must be
    // a git repository, and the series must already be started (START_SERIES
    // is a human decision — never available to AI hosts).
    await Bun.$`git init -q`.cwd(workDir);
    await Bun.$`git config user.email test@example.com`.cwd(workDir);
    await Bun.$`git config user.name test`.cwd(workDir);
    await Bun.$`git commit -q --allow-empty -m init`.cwd(workDir);
    const { OrchestratorRunner } = await import("@guyghost/swarm-dao-improvement");
    const runner = await OrchestratorRunner.create({
      seriesId: "once-1",
      evidenceRoot: path.join(workDir, ".dao/improvement-series"),
    });
    const started = await runner.submit({
      type: "START_SERIES",
      source: "human",
      scope: "mcp-test",
      referenceHash: "deadbeef",
      cooldownMs: 60_000,
    });
    expect(started.accepted).toBe(true);

    const text = textOf(await client.callTool({ name: "dao_improve_once", arguments: { seriesId: "once-1" } }));
    const result = JSON.parse(text) as { executed: boolean; event: string | null; stateAfter: string };
    expect(result.executed).toBe(true);
    expect(result.event).toBe("CYCLE_INITIALIZED");
    expect(result.stateAfter).toBe("sampling");
  });

  it("is a read-shape no-op for a fresh idle series", async () => {
    await Bun.$`git init -q`.cwd(workDir);
    await Bun.$`git config user.email test@example.com`.cwd(workDir);
    await Bun.$`git config user.name test`.cwd(workDir);
    await Bun.$`git commit -q --allow-empty -m init`.cwd(workDir);

    const text = textOf(await client.callTool({ name: "dao_improve_once", arguments: { seriesId: "idle-1" } }));
    const result = JSON.parse(text) as { executed: boolean; event: null; stateAfter: string; detail: string };
    expect(result.executed).toBe(false);
    expect(result.event).toBeNull();
    expect(result.stateAfter).toBe("idle");
    expect(result.detail).toContain("terminal");
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
