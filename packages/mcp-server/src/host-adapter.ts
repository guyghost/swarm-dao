import type { HostAdapter } from "@guyghost/swarm-dao-core";
import { execCommand, readFileContained, writeFileContained } from "@guyghost/swarm-dao-core";

export function resolveDaoRoot(): string {
  return process.env.DAO_ROOT?.trim() || process.cwd();
}

/**
 * Build a {@link HostAdapter} for a stdio MCP host. Such hosts cannot spawn
 * sub-agents themselves, so `spawnAgent` returns an error directing the caller
 * to the manual `dao_deliberate` → `dao_record_outputs` workflow.
 */
export function createStdioHostAdapter(hostId: string, workDir = resolveDaoRoot()): HostAdapter {
  return {
    hostId,
    async spawnAgent(params) {
      return {
        agentId: params.agent.id,
        agentName: params.agent.name,
        role: params.agent.role,
        content: "",
        durationMs: 0,
        error: `${hostId} hosts require manual sub-agent dispatch. Use dao_deliberate then dao_record_outputs.`,
      };
    },
    async spawnAgents() {
      return [];
    },
    async log(params) {
      const prefix = `[${params.level}] ${params.service}:`;
      if (params.level === "error") {
        console.error(prefix, params.message);
      } else {
        console.error(prefix, params.message);
      }
    },
    getWorkingDirectory() {
      return workDir;
    },
    async readFile(filePath) {
      return readFileContained(filePath, workDir);
    },
    async writeFile(filePath, content) {
      return writeFileContained(filePath, content, workDir);
    },
    async exec(command, options) {
      return execCommand(command, options);
    },
    hasCapability(capability) {
      return ["read_file", "write_file", "exec", "log"].includes(capability);
    },
  };
}

/** Default host adapter (hostId = "mcp") for the standalone MCP server. */
export function createMcpHostAdapter(workDir = resolveDaoRoot()): HostAdapter {
  return createStdioHostAdapter("mcp", workDir);
}
