import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setState } from "@guyghost/swarm-dao-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSwarmDaoMcpServer, ensureDaoStorage } from "../src/server.js";

describe("mcp-server", () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-mcp-"));
    process.env.DAO_ROOT = tmpDir;
    setState(null);
    await ensureDaoStorage(tmpDir);

    const server = createSwarmDaoMcpServer(tmpDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    setState(null);
    delete process.env.DAO_ROOT;
    await client.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists dao tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("dao_setup");
    expect(names).toContain("dao_propose");
    expect(names).toContain("dao_deliberate");
    expect(names).toContain("dao_record_outputs");
    expect(names).toContain("dao_config_github");
  });

  it("runs dao_setup and dao_propose workflow", async () => {
    const setup = await client.callTool({ name: "dao_setup", arguments: {} });
    expect(JSON.stringify(setup.content)).toContain("DAO Initialized");

    const propose = await client.callTool({
      name: "dao_propose",
      arguments: {
        title: "MCP test",
        type: "product-feature",
        description: "via MCP",
      },
    });
    expect(JSON.stringify(propose.content)).toContain("Proposal Created");
  });
});
