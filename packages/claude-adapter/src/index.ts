import type { HostAdapter } from "@guyghost/swarm-dao-core";
import { createStdioHostAdapter, resolveDaoRoot, startSwarmDaoMcpServer } from "@guyghost/swarm-dao-mcp";

export { resolveDaoRoot };

/** Host adapter specialized for Claude Code (`hostId = "claude"`). */
export function createClaudeHostAdapter(workDir = resolveDaoRoot()): HostAdapter {
  return createStdioHostAdapter("claude", workDir);
}

/** Boot the Swarm DAO MCP server with Claude defaults. */
export async function startClaudeServer(workDir = resolveDaoRoot()): Promise<void> {
  await startSwarmDaoMcpServer(workDir);
}
