import type { HostAdapter } from "@guyghost/swarm-dao-core";
import { createStdioHostAdapter, resolveDaoRoot, startSwarmDaoMcpServer } from "@guyghost/swarm-dao-mcp";

export { resolveDaoRoot };

/** Host adapter specialized for OpenAI Codex (`hostId = "codex"`). */
export function createCodexHostAdapter(workDir = resolveDaoRoot()): HostAdapter {
  return createStdioHostAdapter("codex", workDir);
}

/** Boot the Swarm DAO MCP server with Codex defaults. */
export async function startCodexServer(workDir = resolveDaoRoot()): Promise<void> {
  await startSwarmDaoMcpServer(workDir);
}
