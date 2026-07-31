import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDaoCommands } from "@guyghost/swarm-dao-core";
import { createSwarmDaoMcpServer } from "@guyghost/swarm-dao-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentContent, createWorkspace, type Workspace } from "../support/fixtures.js";

/** Text payload of a `tools/call` response. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

describe("Compatibility: MCP server tool surface", () => {
  let workspace: Workspace;
  let client: Client;

  beforeEach(async () => {
    workspace = await createWorkspace("mcp");
    const server = createSwarmDaoMcpServer(workspace.dir, workspace.repository);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "integration-tests", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await workspace.cleanup();
  });

  it("exposes exactly the tools the command registry maps to the mcp host", async () => {
    const exposed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const expected = [
      ...new Set(
        getDaoCommands("mcp")
          .map((command) => command.tool)
          .filter((tool): tool is string => tool !== undefined),
      ),
    ].sort();

    expect(exposed).toEqual(expected);
  });

  it("runs the manual governance flow over the MCP protocol", async () => {
    expect(textOf(await client.callTool({ name: "dao_setup", arguments: {} }))).toContain("DAO Initialized");

    const proposed = textOf(
      await client.callTool({
        name: "dao_propose",
        arguments: {
          title: "Ship MCP integration coverage",
          type: "product-feature",
          description: "Prove the MCP surface drives the same core flow.",
          acceptanceCriteria: ["Proposal reaches executed"],
          successMetrics: ["No host-specific regressions"],
        },
      }),
    );
    expect(proposed).toContain("Proposal Created");

    expect(textOf(await client.callTool({ name: "dao_deliberate", arguments: { proposalId: 1 } }))).toContain(
      "Dispatch",
    );

    const outputs = workspace.repository.get().agents.map((agent) => ({
      agentId: agent.id,
      content: agentContent(agent.id, { vote: "for" }),
    }));
    expect(
      textOf(await client.callTool({ name: "dao_record_outputs", arguments: { proposalId: 1, outputs } })),
    ).toContain("Deliberation Complete");

    expect(textOf(await client.callTool({ name: "dao_control", arguments: { proposalId: 1 } }))).toContain(
      "ALL GATES PASSED",
    );
    expect(textOf(await client.callTool({ name: "dao_execute", arguments: { proposalId: 1 } }))).toContain(
      "Proposal Executed",
    );

    const persisted = await workspace.reload();
    expect(persisted.get().proposals[0]?.status).toBe("executed");
  });

  it("reports unknown tools as a tool error instead of crashing the session", async () => {
    const result = await client.callTool({ name: "dao_teleport", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown tool");
  });
});
