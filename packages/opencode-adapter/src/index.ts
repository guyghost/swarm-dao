// ============================================================
// Swarm DAO — OpenCode Adapter
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AttentionSource, DAOAgent, DaoStateRepositoryPort, HostAdapter } from "@guyghost/swarm-dao-core";
import {
  ATTENTION_SOURCES,
  // Commands registry (source of truth for the /dao surface)
  buildDaoHelpMessage,
  collectAttention,
  computeHealthScore,
  execCommand,
  FileDaoStateRepository,
  FsAttentionStore,
  formatAllArtefacts,
  formatAttention,
  formatAuditTrail,
  formatHealthScore,
  formatPlan,
  generateAllArtefacts,
  generateDashboard,
  getAllAuditLog,
  getPlan,
  getProposal,
  getState,
  handleDaoCheckEdit,
  handleDaoConfigGithub,
  handleDaoControl,
  handleDaoDeliberate,
  handleDaoDryRun,
  handleDaoExecute,
  handleDaoGithubCreateBranch,
  handleDaoGithubOpenPr,
  handleDaoPropose,
  handleDaoProposeAmendment,
  handleDaoRecordOutputs,
  handleDaoReject,
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
import type { GraphAiEventType } from "@guyghost/swarm-dao-graph";
import { createGraphRunner, GRAPH_AI_EVENT_TYPES, submitAiGraphSignal } from "@guyghost/swarm-dao-graph";
import { advanceSeriesOnce, OrchestratorRunner } from "@guyghost/swarm-dao-improvement";
import type { ProductAiEventType } from "@guyghost/swarm-dao-product";
import { createProductRunner, PRODUCT_AI_EVENT_TYPES, submitAiProductSignal } from "@guyghost/swarm-dao-product";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const schema = tool.schema;

/** Normalise the JSON-encoded payload parameter of run-submit tools. */
function parsePayloadParam(raw: unknown): Record<string, unknown> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return "Payload must be a JSON-encoded object string.";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Payload must be a JSON object.";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "Invalid payload JSON.";
  }
}

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
          return handleDaoExecute(
            {
              adapter: createOpenCodeHostAdapter(ctx),
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            args.proposalId,
          );
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

      // ── dao_reject ────────────────────────────────────
      dao_reject: tool({
        description: "Reject (or discard) a proposal with an auditable human reason",
        args: {
          proposalId: schema.number(),
          reason: schema.string({ description: "Auditable rejection reason" }),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const adapter = createOpenCodeHostAdapter(ctx);
          return handleDaoReject(
            {
              adapter,
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            Number(args.proposalId),
            String(args.reason),
          );
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
          const dashboard = generateDashboard(
            state.proposals,
            state.outcomes,
            state.agents,
            state.healthSnapshots,
            state.config.healthWeights,
          );
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

      // ── dao_check_edit ─────────────────────────────────────
      dao_check_edit: tool({
        description: "Check whether paths may be edited under the configured mode (opt-in/suggest/enforce)",
        args: { paths: schema.array(schema.string()) },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const adapter = createOpenCodeHostAdapter(ctx);
          return handleDaoCheckEdit(
            {
              adapter,
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            Array.isArray(args.paths) ? args.paths.map(String) : [],
          );
        },
      }),

      // ── dao_config_github ─────────────────────────────────
      dao_config_github: tool({
        description:
          "Configure the GitHub integration (owner, repo, issue tracking). Authentication is delegated to the gh CLI (`gh auth login`).",
        args: {
          owner: schema.string({ description: "Repository owner (user or org)" }),
          repo: schema.string({ description: "Repository name" }),
          issues: schema.boolean({ description: "Track proposal modifications as GitHub issues" }).optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const adapter = createOpenCodeHostAdapter(ctx);
          return handleDaoConfigGithub(
            {
              adapter,
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            { owner: String(args.owner), repo: String(args.repo), issues: args.issues === true },
          );
        },
      }),

      // ── dao_github_create_branch ──────────────────────────
      dao_github_create_branch: tool({
        description: "Create a GitHub branch (dao/<id>-<slug>) for a proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const adapter = createOpenCodeHostAdapter(ctx);
          return handleDaoGithubCreateBranch(
            {
              adapter,
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            Number(args.proposalId),
          );
        },
      }),

      // ── dao_github_open_pr ────────────────────────────────
      dao_github_open_pr: tool({
        description: "Open a GitHub pull request for a proposal",
        args: {
          proposalId: schema.number(),
          headBranch: schema.string({ description: "Branch containing the work" }),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const adapter = createOpenCodeHostAdapter(ctx);
          return handleDaoGithubOpenPr(
            {
              adapter,
              workDir: directory,
              deliberationMode: "manual",
              controlToolName: "dao_control",
              repository,
            },
            Number(args.proposalId),
            String(args.headBranch),
          );
        },
      }),

      // ── dao_attention ─────────────────────────────────────
      dao_attention: tool({
        description:
          "List pending human gates across Graph Engineering runs, improvement cycles and series, and product loops (read-only projection of persisted snapshots)",
        args: {
          sources: schema.array(schema.string()).describe("Optional source filter").optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          let sources: readonly AttentionSource[] | undefined;
          if (Array.isArray(args.sources)) {
            const invalid = args.sources.filter(
              (source: string) => !ATTENTION_SOURCES.includes(source as AttentionSource),
            );
            if (invalid.length > 0) {
              return `Invalid source '${invalid.join(", ")}'. Allowed: ${ATTENTION_SOURCES.join(", ")}`;
            }
            sources = args.sources as AttentionSource[];
          }
          const items = await collectAttention(new FsAttentionStore(context.directory), sources);
          const lines = [formatAttention(items)];
          for (const item of items) {
            if (item.command) lines.push(`  ${item.source}/${item.runId}: ${item.command}`);
          }
          return lines.join("\n");
        },
      }),

      // ── dao_graph_status ──────────────────────────────────
      dao_graph_status: tool({
        description: "Read a Graph Engineering run snapshot (read-only)",
        args: {
          runId: schema.string(),
          evidenceRoot: schema.string().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const runner = await createGraphRunner({
            evidenceRoot: path.resolve(context.directory, args.evidenceRoot ?? ".dao/graph-runs"),
            runId: String(args.runId),
          });
          return JSON.stringify(runner.snapshot(), null, 2);
        },
      }),

      // ── dao_graph_submit ──────────────────────────────────
      dao_graph_submit: tool({
        description:
          "Submit an AI-source signal (MODEL_DRAFTED, IMPLEMENTATION_READY, IMPLEMENTATION_FAILED) to a Graph Engineering run. Human events (MODEL_APPROVED, MODEL_REJECTED, RETRY_AUTHORIZED, CANCEL) go through the swarm-dao CLI, never through AI-facing tools.",
        args: {
          runId: schema.string(),
          type: schema.enum([...GRAPH_AI_EVENT_TYPES]),
          producer: schema.string(),
          payload: schema.string({ description: "JSON-encoded payload object" }).optional(),
          evidence: schema.array(schema.string()).optional(),
          evidenceRoot: schema.string().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const payload = parsePayloadParam(args.payload);
          if (typeof payload === "string") return payload;
          const result = await submitAiGraphSignal(
            {
              evidenceRoot: path.resolve(context.directory, args.evidenceRoot ?? ".dao/graph-runs"),
            },
            {
              runId: String(args.runId),
              type: args.type as GraphAiEventType,
              producer: String(args.producer),
              payload,
              evidence: Array.isArray(args.evidence) ? args.evidence.map(String) : [],
            },
          );
          return JSON.stringify(result, null, 2);
        },
      }),

      // ── dao_product_status ────────────────────────────────
      dao_product_status: tool({
        description: "Read a product-loop run snapshot (read-only)",
        args: {
          runId: schema.string(),
          evidenceRoot: schema.string().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const runner = await createProductRunner({
            evidenceRoot: path.resolve(context.directory, args.evidenceRoot ?? ".dao/product-loops"),
            runId: String(args.runId),
          });
          return JSON.stringify(runner.snapshot(), null, 2);
        },
      }),

      // ── dao_product_submit ────────────────────────────────
      dao_product_submit: tool({
        description:
          "Submit an AI-source signal (AGENT_SIGNAL, FEEDBACK_AGGREGATED, PROPOSAL_DRAFTED) to a product-loop run. Human events (REVIEW_RESOLVED, RETRY_VERIFICATION_AUTHORIZED, CONTACT_RELAY_AUTHORIZED, CANCEL) go through the swarm-dao CLI, never through AI-facing tools.",
        args: {
          runId: schema.string(),
          type: schema.enum([...PRODUCT_AI_EVENT_TYPES]),
          producer: schema.string(),
          payload: schema.string({ description: "JSON-encoded payload object" }).optional(),
          evidence: schema.array(schema.string()).optional(),
          evidenceRoot: schema.string().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const payload = parsePayloadParam(args.payload);
          if (typeof payload === "string") return payload;
          const result = await submitAiProductSignal(
            {
              evidenceRoot: path.resolve(context.directory, args.evidenceRoot ?? ".dao/product-loops"),
            },
            {
              runId: String(args.runId),
              type: args.type as ProductAiEventType,
              producer: String(args.producer),
              payload,
              evidence: Array.isArray(args.evidence) ? args.evidence.map(String) : [],
            },
          );
          return JSON.stringify(result, null, 2);
        },
      }),

      // ── dao_improve_status ────────────────────────────────
      dao_improve_status: tool({
        description:
          "Read an improvement series snapshot (read-only): state, scope, cooldown, pending reason. Evidence root defaults to .dao/improvement-series under the workspace.",
        args: {
          seriesId: schema.string(),
          evidenceRoot: schema.string().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const runner = await OrchestratorRunner.create({
            seriesId: String(args.seriesId),
            evidenceRoot: path.resolve(context.directory, args.evidenceRoot ?? ".dao/improvement-series"),
          });
          return JSON.stringify(runner.snapshot(), null, 2);
        },
      }),

      // ── dao_improve_once ──────────────────────────────────
      dao_improve_once: tool({
        description:
          "Advance an improvement series by exactly one state-authorized effect (deterministic executor). Runs workers/anchors from the persisted .dao/improvement.json configuration inside the per-series worktree — the caller supplies no execution options. No-op when the series waits on a human decision, has failed workers, is halted, or is terminal. Can be long-running (spawns worker agents): worker phases take minutes — raise the host request timeout accordingly.",
        args: {
          seriesId: schema.string(),
          evidenceRoot: schema.string().optional(),
          cycleRoot: schema.string().optional(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, context: any) {
          const result = await advanceSeriesOnce({
            seriesId: String(args.seriesId),
            workDir: context.directory,
            ...(typeof args.evidenceRoot === "string" ? { evidenceRoot: args.evidenceRoot } : {}),
            ...(typeof args.cycleRoot === "string" ? { cycleEvidenceRoot: args.cycleRoot } : {}),
          });
          return JSON.stringify(result, null, 2);
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
