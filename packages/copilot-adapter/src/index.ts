import type { HostAdapter } from "@guyghost/swarm-dao-core";
import { createStdioHostAdapter, resolveDaoRoot, startSwarmDaoMcpServer } from "@guyghost/swarm-dao-mcp";

export { resolveDaoRoot };

/** Host adapter specialized for GitHub Copilot (`hostId = "copilot"`). */
export function createCopilotHostAdapter(workDir = resolveDaoRoot()): HostAdapter {
  return createStdioHostAdapter("copilot", workDir);
}

/** Boot the Swarm DAO MCP server with Copilot defaults. */
export async function startCopilotServer(workDir = resolveDaoRoot()): Promise<void> {
  await startSwarmDaoMcpServer(workDir);
}
