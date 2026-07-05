import type { ProposalType, RecordOutputInput } from "@guyghost/swarm-dao-core";
import {
  buildDaoHelpMessage,
  DAO_ONBOARDING_MESSAGE,
  getOrCreateState,
  getState,
  handleDaoAgents,
  handleDaoArtefacts,
  handleDaoAudit,
  handleDaoConfigGithub,
  handleDaoControl,
  handleDaoDashboard,
  handleDaoDeliberate,
  handleDaoDryRun,
  handleDaoExecute,
  handleDaoGithubCreateBranch,
  handleDaoGithubOpenPr,
  handleDaoList,
  handleDaoPlan,
  handleDaoPropose,
  handleDaoProposeAmendment,
  handleDaoRate,
  handleDaoRecordOutputs,
  handleDaoRollback,
  handleDaoRoundtable,
  handleDaoSetup,
  handleDaoShip,
  handleDaoUpdateProposal,
  initStorage,
  loadState,
  PROPOSAL_TYPES,
  setState,
} from "@guyghost/swarm-dao-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHostAdapter, resolveDaoRoot } from "./host-adapter.js";

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): TextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function parseProposalType(value: unknown): ProposalType {
  if (typeof value === "string" && (PROPOSAL_TYPES as string[]).includes(value)) {
    return value as ProposalType;
  }
  throw new Error(`Invalid proposal type: ${String(value)}. Valid types: ${PROPOSAL_TYPES.join(", ")}`);
}

function createToolContext(workDir: string) {
  return {
    adapter: createMcpHostAdapter(workDir),
    workDir,
    deliberationMode: "manual" as const,
    controlToolName: "dao_control" as const,
    failOnGateFailure: false,
  };
}

export async function ensureDaoStorage(workDir: string): Promise<void> {
  await initStorage(workDir);
  const loaded = await loadState(workDir);
  if (!loaded) {
    setState(getOrCreateState(workDir));
  }
}

export function createSwarmDaoMcpServer(workDir = resolveDaoRoot()): Server {
  const server = new Server({ name: "swarm-dao", version: "0.1.0" }, { capabilities: { tools: {} } });
  const ctx = createToolContext(workDir);
  const controlTool = "dao_control";

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "dao_help",
        description: "Show onboarding and available DAO tools",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "dao_setup",
        description: "Initialize the DAO with default 7 product agents",
        inputSchema: { type: "object", properties: { useDefaults: { type: "boolean" } } },
      },
      {
        name: "dao_propose",
        description: "Create a new DAO proposal",
        inputSchema: {
          type: "object",
          required: ["title", "type", "description"],
          properties: {
            title: { type: "string" },
            type: { type: "string", enum: [...PROPOSAL_TYPES] },
            description: { type: "string" },
            context: { type: "string" },
            problemStatement: { type: "string" },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
            successMetrics: { type: "array", items: { type: "string" } },
            rollbackConditions: { type: "array", items: { type: "string" } },
            affectedPaths: { type: "array", items: { type: "string" } },
          },
        },
      },
      {
        name: "dao_deliberate",
        description: "Build a swarm dispatch plan for manual sub-agent execution",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_record_outputs",
        description: "Record sub-agent outputs and finalize deliberation",
        inputSchema: {
          type: "object",
          required: ["proposalId", "outputs"],
          properties: {
            proposalId: { type: "number" },
            outputs: {
              type: "array",
              items: {
                type: "object",
                required: ["agentId", "content"],
                properties: {
                  agentId: { type: "string" },
                  content: { type: "string" },
                  durationMs: { type: "number" },
                  error: { type: "string" },
                },
              },
            },
          },
        },
      },
      {
        name: "dao_control",
        description: "Run quality control gates",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_execute",
        description: "Execute an approved or controlled proposal",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_ship",
        description: "Ship a controlled proposal (optionally cascade dependencies)",
        inputSchema: {
          type: "object",
          required: ["proposalId"],
          properties: { proposalId: { type: "number" }, cascade: { type: "boolean" }, force: { type: "boolean" } },
        },
      },
      { name: "dao_list", description: "List all DAO proposals", inputSchema: { type: "object", properties: {} } },
      { name: "dao_agents", description: "List all DAO agents", inputSchema: { type: "object", properties: {} } },
      {
        name: "dao_plan",
        description: "Get delivery plan",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_artefacts",
        description: "View auto-generated artefacts for a proposal",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_dry_run",
        description: "Preview execution without applying changes",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_rollback",
        description: "Revert proposal execution to pre-execution snapshot",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_dashboard",
        description: "View outcome tracking dashboard",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "dao_roundtable",
        description: "Ask every agent to suggest a proposal idea",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "dao_audit",
        description: "View audit trail",
        inputSchema: { type: "object", properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_rate",
        description: "Rate a proposal outcome post-execution (1-5 stars)",
        inputSchema: {
          type: "object",
          required: ["proposalId", "score", "comment"],
          properties: {
            proposalId: { type: "number" },
            score: { type: "number", minimum: 1, maximum: 5 },
            comment: { type: "string" },
          },
        },
      },
      {
        name: "dao_update_proposal",
        description: "Update structured fields on an open proposal",
        inputSchema: {
          type: "object",
          required: ["proposalId"],
          properties: {
            proposalId: { type: "number" },
            problemStatement: { type: "string" },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
            successMetrics: { type: "array", items: { type: "string" } },
            rollbackConditions: { type: "array", items: { type: "string" } },
          },
        },
      },
      {
        name: "dao_propose_amendment",
        description: "Propose an amendment to the DAO",
        inputSchema: {
          type: "object",
          required: ["title", "description", "amendmentType"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            amendmentType: {
              type: "string",
              enum: ["agent-update", "agent-add", "agent-remove", "config-update", "quorum-update", "gate-update"],
            },
            agentId: { type: "string" },
            agentChanges: { type: "string" },
            newAgentId: { type: "string" },
            newAgentName: { type: "string" },
            newAgentRole: { type: "string" },
            newAgentWeight: { type: "number" },
            configChanges: { type: "string" },
            quorumChanges: { type: "string" },
            addGates: { type: "array", items: { type: "string" } },
            removeGates: { type: "array", items: { type: "string" } },
          },
        },
      },
      {
        name: "dao_config_github",
        description: "Configure GitHub integration for branch/PR tools",
        inputSchema: {
          type: "object",
          required: ["token", "owner", "repo"],
          properties: { token: { type: "string" }, owner: { type: "string" }, repo: { type: "string" } },
        },
      },
      {
        name: "dao_github_create_branch",
        description: "Create a GitHub branch for a proposal",
        inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: { type: "number" } } },
      },
      {
        name: "dao_github_open_pr",
        description: "Open a GitHub pull request for a proposal",
        inputSchema: {
          type: "object",
          required: ["proposalId", "headBranch"],
          properties: { proposalId: { type: "number" }, headBranch: { type: "string" } },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const name = request.params.name;
    try {
      switch (name) {
        case "dao_help": {
          const state = getState();
          if (!state.initialized) return textResult(DAO_ONBOARDING_MESSAGE);
          return textResult(buildDaoHelpMessage({ host: "mcp", manualDeliberation: true, controlTool }));
        }
        case "dao_setup":
          return textResult(await handleDaoSetup(ctx, args.useDefaults !== false));
        case "dao_propose":
          return textResult(
            await handleDaoPropose({
              title: String(args.title),
              type: parseProposalType(args.type),
              description: String(args.description),
              context: args.context !== undefined ? String(args.context) : undefined,
              problemStatement: args.problemStatement !== undefined ? String(args.problemStatement) : undefined,
              acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
              successMetrics: args.successMetrics as string[] | undefined,
              rollbackConditions: args.rollbackConditions as string[] | undefined,
              affectedPaths: args.affectedPaths as string[] | undefined,
            }),
          );
        case "dao_deliberate":
          return textResult(await handleDaoDeliberate(ctx, Number(args.proposalId)));
        case "dao_record_outputs":
          return textResult(
            await handleDaoRecordOutputs(
              ctx,
              Number(args.proposalId),
              (args.outputs as RecordOutputInput[] | undefined) ?? [],
            ),
          );
        case "dao_control":
          return textResult(await handleDaoControl(ctx, Number(args.proposalId)));
        case "dao_execute":
          return textResult(await handleDaoExecute(Number(args.proposalId)));
        case "dao_ship":
          return textResult(
            await handleDaoShip(ctx, Number(args.proposalId), {
              cascade: args.cascade === true,
              force: args.force === true,
            }),
          );
        case "dao_list":
          return textResult(await handleDaoList());
        case "dao_agents":
          return textResult(await handleDaoAgents());
        case "dao_plan":
          return textResult(await handleDaoPlan(Number(args.proposalId), controlTool));
        case "dao_artefacts":
          return textResult(await handleDaoArtefacts(Number(args.proposalId)));
        case "dao_dry_run":
          return textResult(await handleDaoDryRun(Number(args.proposalId)));
        case "dao_rollback":
          return textResult(await handleDaoRollback(Number(args.proposalId)));
        case "dao_dashboard":
          return textResult(await handleDaoDashboard());
        case "dao_roundtable":
          return textResult(await handleDaoRoundtable(ctx));
        case "dao_audit":
          return textResult(await handleDaoAudit(args.proposalId !== undefined ? Number(args.proposalId) : undefined));
        case "dao_rate":
          return textResult(
            await handleDaoRate(Number(args.proposalId), Number(args.score) as 1 | 2 | 3 | 4 | 5, String(args.comment)),
          );
        case "dao_update_proposal":
          return textResult(
            await handleDaoUpdateProposal(Number(args.proposalId), {
              problemStatement: args.problemStatement !== undefined ? String(args.problemStatement) : undefined,
              acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
              successMetrics: args.successMetrics as string[] | undefined,
              rollbackConditions: args.rollbackConditions as string[] | undefined,
            }),
          );
        case "dao_propose_amendment":
          return textResult(
            await handleDaoProposeAmendment({
              title: String(args.title),
              description: String(args.description),
              amendmentType: args.amendmentType as
                | "agent-update"
                | "agent-add"
                | "agent-remove"
                | "config-update"
                | "quorum-update"
                | "gate-update",
              agentId: args.agentId !== undefined ? String(args.agentId) : undefined,
              agentChanges: args.agentChanges !== undefined ? String(args.agentChanges) : undefined,
              newAgentId: args.newAgentId !== undefined ? String(args.newAgentId) : undefined,
              newAgentName: args.newAgentName !== undefined ? String(args.newAgentName) : undefined,
              newAgentRole: args.newAgentRole !== undefined ? String(args.newAgentRole) : undefined,
              newAgentWeight: args.newAgentWeight !== undefined ? Number(args.newAgentWeight) : undefined,
              configChanges: args.configChanges !== undefined ? String(args.configChanges) : undefined,
              quorumChanges: args.quorumChanges !== undefined ? String(args.quorumChanges) : undefined,
              addGates: args.addGates as string[] | undefined,
              removeGates: args.removeGates as string[] | undefined,
            }),
          );
        case "dao_config_github":
          return textResult(
            await handleDaoConfigGithub(ctx, {
              token: String(args.token),
              owner: String(args.owner),
              repo: String(args.repo),
            }),
          );
        case "dao_github_create_branch":
          return textResult(await handleDaoGithubCreateBranch(ctx, Number(args.proposalId)));
        case "dao_github_open_pr":
          return textResult(await handleDaoGithubOpenPr(ctx, Number(args.proposalId), String(args.headBranch)));
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Error: ${message}`);
    }
  });

  return server;
}

export async function startSwarmDaoMcpServer(workDir = resolveDaoRoot()): Promise<void> {
  await ensureDaoStorage(workDir);
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createSwarmDaoMcpServer(workDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
