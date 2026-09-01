import path from "node:path";
import type {
  AttentionSource,
  DaoStateRepositoryPort,
  ProposalType,
  RecordOutputInput,
} from "@guyghost/swarm-dao-core";
import {
  ATTENTION_SOURCES,
  buildDaoHelpMessage,
  collectAttention,
  DAO_ONBOARDING_MESSAGE,
  FileDaoStateRepository,
  FsAttentionStore,
  formatAttention,
  getState,
  handleDaoAgents,
  handleDaoArtefacts,
  handleDaoAudit,
  handleDaoCheckEdit,
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
  PROPOSAL_TYPES,
  setRepository,
} from "@guyghost/swarm-dao-core";
import { createGraphRunner, GRAPH_AI_EVENT_TYPES, submitAiGraphSignal } from "@guyghost/swarm-dao-graph";
import { OrchestratorRunner } from "@guyghost/swarm-dao-improvement";
import { createProductRunner, PRODUCT_AI_EVENT_TYPES, submitAiProductSignal } from "@guyghost/swarm-dao-product";
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

function createToolContext(workDir: string, repository?: DaoStateRepositoryPort) {
  return {
    adapter: createMcpHostAdapter(workDir),
    workDir,
    deliberationMode: "manual" as const,
    controlToolName: "dao_control" as const,
    failOnGateFailure: false,
    repository,
  };
}

/** AI-source event types the MCP surface may submit to a graph run. Human
 * events (MODEL_APPROVED, MODEL_REJECTED, RETRY_AUTHORIZED, CANCEL) and
 * tool/system events never pass through MCP: the AI-channel helper inside the
 * graph package hardcodes source "ai", so an agent cannot forge another
 * channel's authority. */
const GRAPH_AI_EVENT_ENUM = [...GRAPH_AI_EVENT_TYPES] as const;

/** AI-source event types the MCP surface may submit to a product run. */
const PRODUCT_AI_EVENT_ENUM = [...PRODUCT_AI_EVENT_TYPES] as const;

interface RunSubmitArgs {
  runId: string;
  producer: string;
  payload: Record<string, unknown>;
  evidence: string[];
  evidenceRoot?: string;
}

function parseRunSubmitArgs(args: Record<string, unknown>): RunSubmitArgs {
  const runId = typeof args.runId === "string" && args.runId.trim().length > 0 ? args.runId : undefined;
  if (!runId) throw new Error("runId is required");
  const producer = typeof args.producer === "string" && args.producer.trim().length > 0 ? args.producer : undefined;
  if (!producer) throw new Error("producer is required");
  return {
    runId,
    producer,
    payload:
      typeof args.payload === "object" && args.payload !== null && !Array.isArray(args.payload)
        ? (args.payload as Record<string, unknown>)
        : {},
    evidence: Array.isArray(args.evidence) ? args.evidence.map(String).filter((e) => e.trim().length > 0) : [],
    evidenceRoot:
      typeof args.evidenceRoot === "string" && args.evidenceRoot.trim().length > 0 ? args.evidenceRoot : undefined,
  };
}

export async function ensureDaoStorage(workDir: string): Promise<DaoStateRepositoryPort> {
  const repository = await FileDaoStateRepository.open(workDir);
  setRepository(repository);
  return repository;
}

export function createSwarmDaoMcpServer(workDir = resolveDaoRoot(), repository?: DaoStateRepositoryPort): Server {
  const server = new Server({ name: "swarm-dao", version: "0.1.0" }, { capabilities: { tools: {} } });
  const ctx = createToolContext(workDir, repository);
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
        name: "dao_check_edit",
        description:
          "Check whether paths may be edited under the configured mode (opt-in/suggest/enforce) before touching files",
        inputSchema: {
          type: "object",
          required: ["paths"],
          properties: { paths: { type: "array", items: { type: "string" } } },
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
      {
        name: "dao_attention",
        description:
          "List pending human gates across Graph Engineering runs, improvement cycles and series, and product loops (read-only projection of persisted snapshots)",
        inputSchema: {
          type: "object",
          properties: {
            sources: { type: "array", items: { type: "string", enum: [...ATTENTION_SOURCES] } },
          },
        },
      },
      {
        name: "dao_improve_status",
        description:
          "Read an improvement series snapshot (read-only): state, scope, cooldown, pending reason. Evidence root defaults to .dao/improvement-series under the workspace.",
        inputSchema: {
          type: "object",
          required: ["seriesId"],
          properties: { seriesId: { type: "string" }, evidenceRoot: { type: "string" } },
        },
      },
      {
        name: "dao_graph_status",
        description:
          "Read a Graph Engineering run snapshot (read-only). Evidence root defaults to .dao/graph-runs under the workspace.",
        inputSchema: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string" }, evidenceRoot: { type: "string" } },
        },
      },
      {
        name: "dao_graph_submit",
        description:
          "Submit an AI-source signal to a Graph Engineering run (MODEL_DRAFTED, IMPLEMENTATION_READY, IMPLEMENTATION_FAILED). " +
          "The host sets source=ai; human events (MODEL_APPROVED, MODEL_REJECTED, RETRY_AUTHORIZED, CANCEL) belong to the swarm-dao CLI human channel.",
        inputSchema: {
          type: "object",
          required: ["runId", "type", "producer", "payload", "evidence"],
          properties: {
            runId: { type: "string" },
            type: { type: "string", enum: [...GRAPH_AI_EVENT_ENUM] },
            producer: { type: "string" },
            payload: { type: "object" },
            evidence: { type: "array", items: { type: "string" } },
            evidenceRoot: { type: "string" },
          },
        },
      },
      {
        name: "dao_product_status",
        description:
          "Read a product-loop run snapshot (read-only). Evidence root defaults to .dao/product-loops under the workspace.",
        inputSchema: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string" }, evidenceRoot: { type: "string" } },
        },
      },
      {
        name: "dao_product_submit",
        description:
          "Submit an AI-source signal to a product-loop run (AGENT_SIGNAL, FEEDBACK_AGGREGATED, PROPOSAL_DRAFTED from a declared AI producer). " +
          "The host sets source=ai; human events (REVIEW_RESOLVED, RETRY_VERIFICATION_AUTHORIZED, CONTACT_RELAY_AUTHORIZED, CANCEL) belong to the swarm-dao CLI human channel.",
        inputSchema: {
          type: "object",
          required: ["runId", "type", "producer", "payload", "evidence"],
          properties: {
            runId: { type: "string" },
            type: { type: "string", enum: [...PRODUCT_AI_EVENT_ENUM] },
            producer: { type: "string" },
            payload: { type: "object" },
            evidence: { type: "array", items: { type: "string" } },
            evidenceRoot: { type: "string" },
          },
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
            await handleDaoPropose(
              {
                title: String(args.title),
                type: parseProposalType(args.type),
                description: String(args.description),
                context: args.context !== undefined ? String(args.context) : undefined,
                problemStatement: args.problemStatement !== undefined ? String(args.problemStatement) : undefined,
                acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
                successMetrics: args.successMetrics as string[] | undefined,
                rollbackConditions: args.rollbackConditions as string[] | undefined,
                affectedPaths: args.affectedPaths as string[] | undefined,
              },
              repository,
            ),
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
          return textResult(await handleDaoExecute(ctx, Number(args.proposalId)));
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
          return textResult(await handleDaoDryRun(Number(args.proposalId), repository));
        case "dao_rollback":
          return textResult(await handleDaoRollback(Number(args.proposalId), repository));
        case "dao_dashboard":
          return textResult(await handleDaoDashboard());
        case "dao_roundtable":
          return textResult(await handleDaoRoundtable(ctx));
        case "dao_audit":
          return textResult(await handleDaoAudit(args.proposalId !== undefined ? Number(args.proposalId) : undefined));
        case "dao_rate":
          return textResult(
            await handleDaoRate(
              Number(args.proposalId),
              Number(args.score) as 1 | 2 | 3 | 4 | 5,
              String(args.comment),
              repository,
            ),
          );
        case "dao_update_proposal":
          return textResult(
            await handleDaoUpdateProposal(
              Number(args.proposalId),
              {
                problemStatement: args.problemStatement !== undefined ? String(args.problemStatement) : undefined,
                acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
                successMetrics: args.successMetrics as string[] | undefined,
                rollbackConditions: args.rollbackConditions as string[] | undefined,
              },
              repository,
            ),
          );
        case "dao_propose_amendment":
          return textResult(
            await handleDaoProposeAmendment(
              {
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
              },
              repository,
            ),
          );
        case "dao_check_edit":
          return textResult(await handleDaoCheckEdit(ctx, Array.isArray(args.paths) ? args.paths.map(String) : []));
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
        case "dao_attention": {
          let sources: readonly AttentionSource[] | undefined;
          if (Array.isArray(args.sources)) {
            const requested = args.sources.map(String);
            const invalid = requested.filter((source) => !ATTENTION_SOURCES.includes(source as AttentionSource));
            if (invalid.length > 0) {
              throw new Error(`invalid source '${invalid.join(", ")}'. Allowed: ${ATTENTION_SOURCES.join(", ")}`);
            }
            sources = requested as AttentionSource[];
          }
          const items = await collectAttention(new FsAttentionStore(ctx.workDir), sources);
          const lines = [formatAttention(items)];
          for (const item of items) {
            if (item.command) lines.push(`  ${item.source}/${item.runId}: ${item.command}`);
          }
          return textResult(lines.join("\n"));
        }
        case "dao_improve_status": {
          const seriesId = String(args.seriesId ?? "").trim();
          if (!seriesId) throw new Error("seriesId is required");
          const runner = await OrchestratorRunner.create({
            seriesId,
            evidenceRoot: path.resolve(
              ctx.workDir,
              typeof args.evidenceRoot === "string" ? args.evidenceRoot : ".dao/improvement-series",
            ),
          });
          return textResult(JSON.stringify(runner.snapshot(), null, 2));
        }
        case "dao_graph_status": {
          const runId = String(args.runId ?? "").trim();
          if (!runId) throw new Error("runId is required");
          const runner = await createGraphRunner({
            evidenceRoot: path.resolve(
              ctx.workDir,
              typeof args.evidenceRoot === "string" ? args.evidenceRoot : ".dao/graph-runs",
            ),
            runId,
          });
          return textResult(JSON.stringify(runner.snapshot(), null, 2));
        }
        case "dao_graph_submit": {
          const parsed = parseRunSubmitArgs(args);
          // The package-level AI channel owns the source: AI artifacts only.
          const result = await submitAiGraphSignal(
            { evidenceRoot: path.resolve(ctx.workDir, parsed.evidenceRoot ?? ".dao/graph-runs") },
            {
              runId: parsed.runId,
              type: args.type as (typeof GRAPH_AI_EVENT_TYPES)[number],
              producer: parsed.producer,
              payload: parsed.payload,
              evidence: parsed.evidence,
            },
          );
          const text = JSON.stringify(result, null, 2);
          return result.accepted ? textResult(text) : errorResult(text);
        }
        case "dao_product_status": {
          const runId = String(args.runId ?? "").trim();
          if (!runId) throw new Error("runId is required");
          const runner = await createProductRunner({
            evidenceRoot: path.resolve(
              ctx.workDir,
              typeof args.evidenceRoot === "string" ? args.evidenceRoot : ".dao/product-loops",
            ),
            runId,
          });
          return textResult(JSON.stringify(runner.snapshot(), null, 2));
        }
        case "dao_product_submit": {
          const parsed = parseRunSubmitArgs(args);
          const result = await submitAiProductSignal(
            { evidenceRoot: path.resolve(ctx.workDir, parsed.evidenceRoot ?? ".dao/product-loops") },
            {
              runId: parsed.runId,
              type: args.type as (typeof PRODUCT_AI_EVENT_TYPES)[number],
              producer: parsed.producer,
              payload: parsed.payload,
              evidence: parsed.evidence,
            },
          );
          const text = JSON.stringify(result, null, 2);
          return result.accepted ? textResult(text) : errorResult(text);
        }
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
  const repository = await ensureDaoStorage(workDir);
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createSwarmDaoMcpServer(workDir, repository);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
