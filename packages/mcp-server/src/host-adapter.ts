import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { HostAdapter } from "@guyghost/swarm-dao-core";
import { execCommand, readFileContained, writeFileContained } from "@guyghost/swarm-dao-core";

export function resolveDaoRoot(): string {
  const raw = process.env.DAO_ROOT;
  if (raw == null) {
    return process.cwd();
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("DAO_ROOT is empty");
  }
  if (trimmed.includes("\0")) {
    throw new Error("DAO_ROOT contains a null byte");
  }
  const resolved = path.resolve(trimmed);
  if (!path.isAbsolute(resolved)) {
    throw new Error("DAO_ROOT must resolve to an absolute path");
  }
  if (!existsSync(resolved)) {
    throw new Error(`DAO_ROOT does not exist: ${resolved}`);
  }
  const real = realpathSync(resolved);
  if (!path.isAbsolute(real)) {
    throw new Error("DAO_ROOT must resolve to an absolute real path");
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`DAO_ROOT is not a directory: ${real}`);
  }
  return real;
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
      const message = `[${params.service}] ${params.message}`;
      // Stdio MCP transports reserve stdout for JSON-RPC frames, so all host logs
      // must go to stderr regardless of level.
      console.error(message);
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
