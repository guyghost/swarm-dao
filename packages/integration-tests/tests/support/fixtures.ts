import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetAgentDefinitionCache,
  type DaoProposeArgs,
  type DaoToolContext,
  FileDaoStateRepository,
  type HostAdapter,
} from "@guyghost/swarm-dao-core";

export interface AgentReply {
  vote: "for" | "against" | "abstain";
  riskScore?: number;
  reasoning?: string;
}

/** Deliberation output in the exact shape the core vote/score parsers expect. */
export function agentContent(agentId: string, reply: AgentReply): string {
  return [
    "## Analysis",
    `Analysis from ${agentId}.`,
    "",
    "## Vote",
    reply.vote,
    "",
    "## Reasoning",
    reply.reasoning ?? `${agentId} reasoning`,
    "",
    "## Risk Score (1-10)",
    String(reply.riskScore ?? 2),
    "",
  ].join("\n");
}

/**
 * Host that spawns sub-agents in-process (Pi/OpenCode class hosts).
 * `replyFor` decides what each agent answers, so a suite can model an
 * approving swarm, a dissenting swarm, or a partially failing swarm.
 */
export function createSpawningHost(
  hostId: string,
  options: { replyFor?: (agentId: string) => AgentReply | { error: string }; workDir?: string } = {},
): HostAdapter {
  const replyFor = options.replyFor ?? (() => ({ vote: "for" as const }));
  const workDir = options.workDir ?? tmpdir();
  const outputFor = (agent: { id: string; name: string; role: string }) => {
    const reply = replyFor(agent.id);
    if ("error" in reply) {
      return { agentId: agent.id, agentName: agent.name, role: agent.role, content: "", durationMs: 1, ...reply };
    }
    return {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: agentContent(agent.id, reply),
      durationMs: 1,
    };
  };

  return {
    hostId,
    spawnAgent: async ({ agent }) => outputFor(agent),
    spawnAgents: async ({ agents }) => agents.map(outputFor),
    log: async () => {},
    getWorkingDirectory: () => workDir,
    readFile: async (filePath) => fs.readFile(path.join(workDir, filePath), "utf8"),
    writeFile: async (filePath, content) => fs.writeFile(path.join(workDir, filePath), content, "utf8"),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    hasCapability: (capability) => ["spawn_agent", "read_file", "write_file", "exec", "log"].includes(capability),
  };
}

export interface Workspace {
  dir: string;
  repository: FileDaoStateRepository;
  /** Re-open the on-disk state, proving what was actually persisted. */
  reload: () => Promise<FileDaoStateRepository>;
  context: (adapter: HostAdapter, overrides?: Partial<DaoToolContext>) => DaoToolContext;
  cleanup: () => Promise<void>;
}

/** Isolated on-disk DAO workspace backed by a real `FileDaoStateRepository`. */
export async function createWorkspace(name: string): Promise<Workspace> {
  __resetAgentDefinitionCache();
  const dir = await fs.mkdtemp(path.join(tmpdir(), `swarm-dao-${name}-`));
  const repository = await FileDaoStateRepository.open(dir);
  return {
    dir,
    repository,
    reload: () => FileDaoStateRepository.open(dir),
    context: (adapter, overrides = {}) => ({
      adapter,
      workDir: dir,
      deliberationMode: "auto",
      controlToolName: "dao_control",
      repository,
      ...overrides,
    }),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Proposal payload that satisfies every non-blocking control gate. */
export function proposalArgs(overrides: Partial<DaoProposeArgs> = {}): DaoProposeArgs {
  return {
    title: "Add cross-host deliberation",
    type: "product-feature",
    description: "Let any host drive the same governance flow.",
    problemStatement: "Hosts diverge on deliberation semantics.",
    acceptanceCriteria: ["Same tally on every host"],
    successMetrics: ["Zero host-specific governance bugs"],
    rollbackConditions: ["Revert the adapter change"],
    ...overrides,
  };
}
