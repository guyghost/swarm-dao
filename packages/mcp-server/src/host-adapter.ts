import type { HostAdapter } from "@guyghost/swarm-dao-core";
import { execCommand, readFileContained, writeFileContained } from "@guyghost/swarm-dao-core";

export function resolveDaoRoot(): string {
  return process.env.DAO_ROOT?.trim() || process.cwd();
}

export function createMcpHostAdapter(workDir = resolveDaoRoot()): HostAdapter {
  return {
    hostId: "mcp",
    async spawnAgent(params) {
      return {
        agentId: params.agent.id,
        agentName: params.agent.name,
        role: params.agent.role,
        content: "",
        durationMs: 0,
        error: "MCP hosts require manual sub-agent dispatch. Use dao_deliberate then dao_record_outputs.",
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
    async readFile(filePath: string) {
      return readFileContained(filePath, workDir);
    },
    async writeFile(filePath: string, content: string) {
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
