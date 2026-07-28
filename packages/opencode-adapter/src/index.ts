// ============================================================
// Swarm DAO — OpenCode Adapter
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DAOAgent, DaoStateRepositoryPort, HostAdapter } from "@guyghost/swarm-dao-core";
import {
  // Commands registry (source of truth for the /dao surface)
  buildDaoHelpMessage,
  computeHealthScore,
  execCommand,
  FileDaoStateRepository,
  formatAllArtefacts,
  formatAuditTrail,
  formatHealthScore,
  formatPlan,
  generateAllArtefacts,
  generateDashboard,
  getAllAuditLog,
  getPlan,
  getProposal,
  getState,
  handleDaoControl,
  handleDaoDeliberate,
  handleDaoDryRun,
  handleDaoExecute,
  handleDaoPropose,
  handleDaoProposeAmendment,
  handleDaoRecordOutputs,
  handleDaoRollback,
  handleDaoRoundtable,
  handleDaoSetup,
  logger,
  migrateFromLegacy,
  PROPOSAL_TYPES,
  readFileContained,
  setRepository,
  writeFileContained,
} from "@guyghost/swarm-dao-core";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const schema = tool.schema;

const OPENCODE_ONBOARDING_MESSAGE = [
  "# DAO not initialized",
  "",
  "1. Run `dao_setup` to create the default governance agents.",
  "2. Run `dao_help` to see the full workflow and available tools.",
  '3. Start your first proposal with `dao_propose title="..." type="product-feature" description="..."`.',
].join("\n");

const sessionModels = new Map<string, string>();
const hostDefaultModels = new Map<string, string | undefined>();

const OPENCODE_HELP_MESSAGE = buildDaoHelpMessage({
  host: "opencode",
  manualDeliberation: true,
  controlTool: "dao_control",
});

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeJsonValue(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeJsonValue(item, context);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) {
      throw new Error(`Unsafe key "${key}" in ${context}`);
    }
    assertSafeJsonValue(nested, context);
  }
}

function parseSafeJson<T>(input: string, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid JSON in ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSafeJsonValue(parsed, context);
  return parsed as T;
}

async function loadOpenCodeHostDefaultModel(directory: string): Promise<string | undefined> {
  const cached = hostDefaultModels.get(directory);
  if (cached !== undefined || hostDefaultModels.has(directory)) {
    return cached;
  }

  const candidates = [
    path.join(directory, ".opencode", "config.json"),
    path.join(process.env.HOME ?? "", ".config", "opencode", "config.json"),
  ];

  const reads = await Promise.all(
    candidates.map(async (configPath) => {
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = parseSafeJson<Record<string, unknown>>(raw, configPath);
        const model =
          typeof parsed.model === "string"
            ? parsed.model
            : typeof parsed.defaultModel === "string"
              ? parsed.defaultModel
              : undefined;
        return model ?? null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          logger.warn(
            `Failed to load OpenCode config file "${configPath}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }
    }),
  );

  for (const model of reads) {
    if (model) {
      hostDefaultModels.set(directory, model);
      return model;
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

function formatAgentsTable(agents: DAOAgent[]): string {
  let table = "| Agent | Weight | Role |\n|-------|--------|------|\n";
  for (const agent of agents) {
    table += `| ${agent.name} | ${agent.weight} | ${agent.role} |\n`;
  }
  return table;
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
    async spawnAgents(_params) {
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
        const message = `[${params.service}] ${params.message}`;
        if (params.level === "error") {
          logger.error(message);
        } else if (params.level === "warn") {
          logger.warn(message);
        } else {
          logger.info(message);
        }
      }
    },
    getWorkingDirectory() {
      return ctx.directory;
    },
    async readFile(path: string) {
      return readFileContained(path, this.getWorkingDirectory());
    },
    async writeFile(path: string, content: string) {
      return writeFileContained(path, content, this.getWorkingDirectory());
    },
    async exec(command, options) {
      return execCommand(command, options);
    },
    hasCapability(capability) {
      return ["read_file", "write_file", "exec", "log"].includes(capability);
    },
  };
}

export const OpenCodeDAO: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;

  await migrateFromLegacy(directory, [".opencode-dao"]);
  const repository: DaoStateRepositoryPort = await FileDaoStateRepository.open(directory);
  setRepository(repository);
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
      // ── dao_help ─────────────────────────────────────────
      dao_help: tool({
        description: "Show onboarding and available DAO tools",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;
          return OPENCODE_HELP_MESSAGE;
        },
      }),

      // ── dao_setup ────────────────────────────────────────
      dao_setup: tool({
        description: "Initialize the DAO with default 7 product agents",
        args: {
          useDefaults: schema.boolean({ description: "Use default agents (default: true)" }),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          return handleDaoSetup(
            {
              adapter: createOpenCodeHostAdapter(ctx),
              workDir: context.directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            args.useDefaults !== false,
          );
        },
      }),

      // ── dao_propose ──────────────────────────────────────
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
          return handleDaoPropose(args, repository);
        },
      }),

      // ── dao_deliberate ───────────────────────────────────
      dao_deliberate: tool({
        description: "Build a swarm dispatch plan with resolved models for manual sub-agent execution",
        args: {
          proposalId: schema.number(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const parentSessionModel = detectParentModel(context, directory);
          const hostDefaultModel = await loadOpenCodeHostDefaultModel(directory);
          const adapter = createOpenCodeHostAdapter(ctx, {
            getSessionModel: () => detectParentModel(context, directory),
          });
          return handleDaoDeliberate(
            {
              adapter,
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              failOnGateFailure: false,
              getSessionModel: () => parentSessionModel,
              hostDefaultModel,
              repository,
            },
            args.proposalId,
          );
        },
      }),

      // ── dao_record_outputs ───────────────────────────────
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
        async execute(args: any, _context: any) {
          return handleDaoRecordOutputs(
            {
              adapter: createOpenCodeHostAdapter(ctx),
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            args.proposalId,
            args.outputs,
          );
        },
      }),

      // ── dao_control ──────────────────────────────────────
      dao_control: tool({
        description: "Run quality control gates",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoControl(
            {
              adapter: createOpenCodeHostAdapter(ctx),
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              failOnGateFailure: false,
              repository,
            },
            args.proposalId,
          );
        },
      }),

      // ── dao_execute ──────────────────────────────────────
      dao_execute: tool({
        description: "Execute an approved or controlled proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoExecute(args.proposalId, repository);
        },
      }),

      // ── dao_list ─────────────────────────────────────────
      dao_list: tool({
        description: "List all DAO proposals",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;
          if (state.proposals.length === 0) return "No proposals yet.";

          let output = "# DAO Proposals\n\n";
          for (const p of state.proposals) {
            output += `## #${p.id}: ${p.title}\n${p.status} · ${p.type}\n\n`;
          }
          return output;
        },
      }),

      // ── dao_agents ───────────────────────────────────────
      dao_agents: tool({
        description: "List all DAO agents",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;
          return `# DAO Agents\n\n${formatAgentsTable(state.agents)}`;
        },
      }),

      // ── dao_plan ─────────────────────────────────────────
      dao_plan: tool({
        description: "Get delivery plan",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          const plan = getPlan(args.proposalId);
          if (!plan) {
            if (proposal.status === "open") {
              return "Plan not available yet. Run `dao_record_outputs` (after starting deliberation with `dao_propose` and running deliberation), then `dao_control`, to generate the plan.";
            }
            if (proposal.status === "deliberating") {
              return "Plan not available yet. Deliberation is still running. Run `dao_record_outputs` to completion first.";
            }
            if (proposal.status === "approved") {
              return "Plan not available yet. Proposal must pass gates first. Run `dao_control` to proceed.";
            }
            if (proposal.status === "controlled") {
              return "Plan should be available. If missing, run `dao_execute` to generate it.";
            }
            if (proposal.status === "rejected") {
              return "Proposal was rejected and cannot be executed.";
            }
            return "Plan not available for this proposal.";
          }
          return formatPlan(plan);
        },
      }),

      // ── dao_artefacts ────────────────────────────────────
      dao_artefacts: tool({
        description: "View auto-generated artefacts for a proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          const artefacts = generateAllArtefacts(proposal);
          return formatAllArtefacts(artefacts);
        },
      }),

      // ── dao_dry_run ──────────────────────────────────────
      dao_dry_run: tool({
        description: "Preview execution without applying changes",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoDryRun(args.proposalId, repository);
        },
      }),

      // ── dao_rollback ─────────────────────────────────────
      dao_rollback: tool({
        description: "Revert proposal execution to pre-execution snapshot",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          return handleDaoRollback(args.proposalId, repository);
        },
      }),

      // ── dao_dashboard ────────────────────────────────────
      dao_dashboard: tool({
        description: "View outcome tracking dashboard",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, _context: any) {
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;
          const dashboard = generateDashboard(state.proposals, state.outcomes, state.agents, state.healthSnapshots);
          const health = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
          return `${dashboard}\n\n${formatHealthScore(health)}`;
        },
      }),

      // ── dao_roundtable ───────────────────────────────────
      dao_roundtable: tool({
        description: "Ask every agent to suggest a proposal idea",
        args: {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(_args: any, context: any) {
          const adapter = createOpenCodeHostAdapter(ctx, {
            getSessionModel: () => detectParentModel(context, directory),
          });
          const hostDefaultModel = await loadOpenCodeHostDefaultModel(directory);
          return handleDaoRoundtable({
            adapter,
            workDir: directory,
            deliberationMode: "manual",
            controlToolName: "dao_control",
            getSessionModel: () => detectParentModel(context, directory),
            hostDefaultModel,
            repository,
          });
        },
      }),

      // ── dao_audit ────────────────────────────────────────
      dao_audit: tool({
        description: "View audit trail",
        args: { proposalId: schema.number({ description: "Optional proposal ID" }) },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const entries = args.proposalId
            ? getAllAuditLog().filter((e) => e.proposalId === args.proposalId)
            : getAllAuditLog();
          return formatAuditTrail(entries, args.proposalId);
        },
      }),

      // ── dao_propose_amendment ────────────────────────────
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
          return handleDaoProposeAmendment(args, repository);
        },
      }),
    },
  };
};

export { OpenCodeDAO as default };
