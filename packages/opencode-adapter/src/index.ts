// ============================================================
// Swarm DAO — OpenCode Adapter
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { HostAdapter } from "@guyghost/swarm-dao-core";
import {
  buildDaoHelpMessage,
  DAO_ONBOARDING_MESSAGE,
  type DaoToolContext,
  execCommand,
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
  readFileContained,
  setState,
  writeFileContained,
} from "@guyghost/swarm-dao-core";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const schema = tool.schema;

const sessionModels = new Map<string, string>();
const hostDefaultModels = new Map<string, string | undefined>();

async function loadOpenCodeHostDefaultModel(directory: string): Promise<string | undefined> {
  const cached = hostDefaultModels.get(directory);
  if (cached !== undefined || hostDefaultModels.has(directory)) {
    return cached;
  }

  const candidates = [
    path.join(directory, ".opencode", "config.json"),
    path.join(process.env.HOME ?? "", ".config", "opencode", "config.json"),
  ];

  for (const configPath of candidates) {
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const model =
        typeof parsed.model === "string"
          ? parsed.model
          : typeof parsed.defaultModel === "string"
            ? parsed.defaultModel
            : undefined;
      if (model) {
        hostDefaultModels.set(directory, model);
        return model;
      }
    } catch {
      // try next candidate
    }
  }

  hostDefaultModels.set(directory, undefined);
  return undefined;
}

function detectParentModel(context: { sessionID?: string } | undefined, directory: string): string | undefined {
  if (context?.sessionID) {
    const sessionModel = sessionModels.get(context.sessionID);
    if (sessionModel) return sessionModel;
  }
  return hostDefaultModels.get(directory) ?? process.env.OPENCODE_MODEL;
}

function createOpenCodeHostAdapter(
  ctx: PluginInput,
  options?: { getSessionModel?: () => string | undefined },
): HostAdapter {
  return {
    hostId: "opencode",
    getSessionModel: options?.getSessionModel,
    async spawnAgent(params) {
      return {
        agentId: params.agent.id,
        agentName: params.agent.name,
        role: params.agent.role,
        content: "",
        durationMs: 0,
        error: "OpenCode agent spawning requires manual dispatch via task tool",
      };
    },
    async spawnAgents() {
      return [];
    },
    async log(params) {
      try {
        await ctx.client.app.log({
          service: params.service,
          level: params.level,
          message: params.message,
        });
      } catch {
        console.log(`[${params.level}] ${params.service}: ${params.message}`);
      }
    },
    getWorkingDirectory() {
      return ctx.directory;
    },
    async readFile(filePath: string) {
      return readFileContained(filePath, this.getWorkingDirectory());
    },
    async writeFile(filePath: string, content: string) {
      return writeFileContained(filePath, content, this.getWorkingDirectory());
    },
    async exec(command, options) {
      return execCommand(command, options);
    },
    hasCapability(capability) {
      return ["read_file", "write_file", "exec", "log"].includes(capability);
    },
  };
}

function createOpenCodeToolContext(ctx: PluginInput, context: { sessionID?: string } | undefined): DaoToolContext {
  return {
    adapter: createOpenCodeHostAdapter(ctx, {
      getSessionModel: () => detectParentModel(context, ctx.directory),
    }),
    workDir: ctx.directory,
    deliberationMode: "manual",
    controlToolName: "dao_control",
    failOnGateFailure: false,
    getSessionModel: () => detectParentModel(context, ctx.directory),
    hostDefaultModel: hostDefaultModels.get(ctx.directory),
  };
}

export const OpenCodeDAO: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;

  await initStorage(directory);
  const loaded = await loadState(directory, { legacyDirectories: [".opencode-dao"] });
  if (!loaded) {
    setState(getOrCreateState(directory));
  }
  await loadOpenCodeHostDefaultModel(directory);

  return {
    // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
    "chat.params": async (input: any, output: any) => {
      const sessionID = input?.sessionID ?? input?.sessionId;
      const model = output?.model ?? input?.model ?? input?.params?.model;
      if (typeof sessionID === "string" && typeof model === "string" && model.length > 0) {
        sessionModels.set(sessionID, model);
      }
    },
    tool: {
      dao_help: tool({
        description: "Show onboarding and available DAO tools",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          const state = getState();
          if (!state.initialized) return DAO_ONBOARDING_MESSAGE;
          return buildDaoHelpMessage({ manualDeliberation: true, controlTool: "dao_control" });
        },
      }),

      dao_setup: tool({
        description: "Initialize the DAO with default 7 product agents",
        args: {
          useDefaults: schema.boolean({ description: "Use default agents (default: true)" }),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, context: any) {
          return handleDaoSetup(createOpenCodeToolContext(ctx, context), _args.useDefaults !== false);
        },
      }),

      dao_propose: tool({
        description: "Create a new DAO proposal",
        args: {
          title: schema.string(),
          type: schema.enum(PROPOSAL_TYPES, { description: "Proposal type" }),
          description: schema.string(),
          context: schema.string().describe("Additional context").optional(),
          problemStatement: schema.string().describe("What problem does this solve?").optional(),
          acceptanceCriteria: schema.array(schema.string()).describe("Acceptance criteria").optional(),
          successMetrics: schema.array(schema.string()).describe("Success metrics").optional(),
          rollbackConditions: schema.array(schema.string()).describe("Rollback conditions").optional(),
          affectedPaths: schema.array(schema.string()).describe("File paths authorized for editing").optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoPropose(args);
        },
      }),

      dao_deliberate: tool({
        description: "Build a swarm dispatch plan with resolved models for manual sub-agent execution",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const toolCtx = createOpenCodeToolContext(ctx, context);
          toolCtx.hostDefaultModel = await loadOpenCodeHostDefaultModel(directory);
          return handleDaoDeliberate(toolCtx, args.proposalId);
        },
      }),

      dao_record_outputs: tool({
        description: "Record sub-agent outputs and finalize deliberation",
        args: {
          proposalId: schema.number(),
          outputs: schema.array(
            schema.object({
              agentId: schema.string(),
              content: schema.string(),
              durationMs: schema.number(),
              error: schema.string(),
            }),
            { description: "Outputs from each sub-agent" },
          ),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoRecordOutputs(createOpenCodeToolContext(ctx, context), args.proposalId, args.outputs);
        },
      }),

      dao_control: tool({
        description: "Run quality control gates",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoControl(createOpenCodeToolContext(ctx, context), args.proposalId);
        },
      }),

      dao_execute: tool({
        description: "Execute an approved or controlled proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoExecute(args.proposalId);
        },
      }),

      dao_ship: tool({
        description: "Ship a controlled proposal (optionally cascade dependencies)",
        args: {
          proposalId: schema.number(),
          cascade: schema.boolean().optional(),
          force: schema.boolean().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoShip(createOpenCodeToolContext(ctx, context), args.proposalId, {
            cascade: args.cascade,
            force: args.force,
          });
        },
      }),

      dao_list: tool({
        description: "List all DAO proposals",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          return handleDaoList();
        },
      }),

      dao_agents: tool({
        description: "List all DAO agents",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          return handleDaoAgents();
        },
      }),

      dao_plan: tool({
        description: "Get delivery plan",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoPlan(args.proposalId, "dao_control");
        },
      }),

      dao_artefacts: tool({
        description: "View auto-generated artefacts for a proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoArtefacts(args.proposalId);
        },
      }),

      dao_dry_run: tool({
        description: "Preview execution without applying changes",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoDryRun(args.proposalId);
        },
      }),

      dao_rollback: tool({
        description: "Revert proposal execution to pre-execution snapshot",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoRollback(args.proposalId);
        },
      }),

      dao_dashboard: tool({
        description: "View outcome tracking dashboard",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          return handleDaoDashboard();
        },
      }),

      dao_roundtable: tool({
        description: "Ask every agent to suggest a proposal idea",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, context: any) {
          const toolCtx = createOpenCodeToolContext(ctx, context);
          toolCtx.hostDefaultModel = await loadOpenCodeHostDefaultModel(directory);
          return handleDaoRoundtable(toolCtx);
        },
      }),

      dao_audit: tool({
        description: "View audit trail",
        args: { proposalId: schema.number({ description: "Optional proposal ID" }) },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoAudit(args.proposalId);
        },
      }),

      dao_rate: tool({
        description: "Rate a proposal outcome post-execution (1-5 stars)",
        args: {
          proposalId: schema.number(),
          score: schema.number(),
          comment: schema.string(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoRate(args.proposalId, args.score as 1 | 2 | 3 | 4 | 5, args.comment);
        },
      }),

      dao_update_proposal: tool({
        description: "Update structured fields on an open proposal",
        args: {
          proposalId: schema.number(),
          problemStatement: schema.string().optional(),
          acceptanceCriteria: schema.array(schema.string()).optional(),
          successMetrics: schema.array(schema.string()).optional(),
          rollbackConditions: schema.array(schema.string()).optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoUpdateProposal(args.proposalId, args);
        },
      }),

      dao_propose_amendment: tool({
        description: "Propose an amendment to the DAO",
        args: {
          title: schema.string(),
          description: schema.string(),
          amendmentType: schema.enum([
            "agent-update",
            "agent-add",
            "agent-remove",
            "config-update",
            "quorum-update",
            "gate-update",
          ]),
          agentId: schema.string(),
          agentChanges: schema.string(),
          newAgentId: schema.string(),
          newAgentName: schema.string(),
          newAgentRole: schema.string(),
          newAgentWeight: schema.number(),
          configChanges: schema.string(),
          quorumChanges: schema.string(),
          addGates: schema.array(schema.string()),
          removeGates: schema.array(schema.string()),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoProposeAmendment(args);
        },
      }),

      dao_config_github: tool({
        description: "Configure GitHub integration for branch/PR tools",
        args: {
          token: schema.string(),
          owner: schema.string(),
          repo: schema.string(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoConfigGithub(createOpenCodeToolContext(ctx, context), args);
        },
      }),

      dao_github_create_branch: tool({
        description: "Create a GitHub branch for a proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoGithubCreateBranch(createOpenCodeToolContext(ctx, context), args.proposalId);
        },
      }),

      dao_github_open_pr: tool({
        description: "Open a GitHub pull request for a proposal",
        args: {
          proposalId: schema.number(),
          headBranch: schema.string(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoGithubOpenPr(createOpenCodeToolContext(ctx, context), args.proposalId, args.headBranch);
        },
      }),
    },
  };
};

export { OpenCodeDAO as default };
