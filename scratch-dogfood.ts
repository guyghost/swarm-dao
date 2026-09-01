// Scratch dogfood client — advances dogfood-003 through the real MCP surface.
// Usage: bun scratch-dogfood.ts [advances=1]  (NOT committed)
import { createSwarmDaoMcpServer } from "./packages/mcp-server/src/server.ts";
import { Client } from "./packages/integration-tests/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "./packages/integration-tests/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";

const advances = Number(process.argv[2] ?? 1);
const server = createSwarmDaoMcpServer(process.cwd());
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "dogfood-host", version: "0.1.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const args = {
  seriesId: "dogfood-003",
  evidenceRoot: "evidence/improvement-series",
  cycleRoot: "evidence/improvement-cycles",
};

for (let i = 0; i < advances; i++) {
  const result = await client.callTool({ name: "dao_improve_once", arguments: args }, undefined, {
    timeout: 15 * 60_000,
  });
  const text = (result.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
  const parsed = JSON.parse(text) as {
    stateBefore: string;
    stateAfter: string;
    executed: boolean;
    event: string | null;
    detail: string;
  };
  console.log(
    `${parsed.stateBefore} → ${parsed.stateAfter} | ${parsed.event} | executed=${parsed.executed} | ${parsed.detail}`,
  );
  if (!parsed.executed) break;
}

await client.close();
