// ============================================================
// Swarm DAO — OpenCode Adapter
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentOutput, DAOAgent, HostAdapter, Vote } from "@guyghost/swarm-dao-core";
import {
  buildDispatchInstructions,
  calculateCompositeScore,
  classifyRiskZone,
  computeHealthScore,
  createDispatchModelContext,
  createProposal,
  createProposalsBatch,
  execCommand,
  executeProposal,
  formatAllArtefacts,
  formatAuditTrail,
  formatCompositeScore,
  formatControlResult,
  formatDispatchPlan,
  formatDryRun,
  formatHealthScore,
  formatPlan,
  formatRollback,
  formatRoundTableResults,
  formatTallyResult,
  generateAllArtefacts,
  generateDashboard,
  generateDeliveryPlan,
  getAllAuditLog,
  getOrCreateState,
  getPlan,
  getProposal,
  getState,
  initializeAgents,
  initStorage,
  loadAgentDefinitions,
  loadConfig,
  loadState,
  PROPOSAL_TYPES,
  parseVoteFromOutput,
  performDryRun,
  performRollback,
  readFileContained,
  recordAudit,
  runGates,
  runRoundTable,
  saveState,
  setState,
  storeCompositeScore,
  storeDeliberationBatch,
  storeDeliveryPlan,
  storeSynthesis,
  synthesize,
  tallyVotes,
  transitionProposal,
  validateAmendmentPayload,
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

const OPENCODE_HELP_MESSAGE = [
  "# DAO Help",
  "",
  "Recommended flow:",
  "1. `dao_setup`",
  '2. `dao_propose title="..." type="product-feature" description="..."`',
  "3. `dao_deliberate proposalId=1`",
  "4. Spawn sub-agents via `task` using the resolved models from the dispatch plan",
  "5. `dao_record_outputs proposalId=1 outputs='[...]'`",
  "6. `dao_control proposalId=1`",
  "7. `dao_execute proposalId=1`",
  "",
  "Discovery tools:",
  "- `dao_list` — proposals overview",
  "- `dao_agents` — configured agents",
  "- `dao_dashboard` — governance health summary",
  "- `dao_audit` — audit trail",
].join("\n");

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
        console.log(`[${params.level}] ${params.service}: ${params.message}`);
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
        async execute(_args: any, context: any) {
          const workDir = context.directory;
          await initStorage(workDir);
          const state = getOrCreateState(workDir);

          if (state.initialized) {
            return `DAO already initialized with ${state.agents.length} agents.`;
          }

          const agents = initializeAgents();
          state.agents = agents;
          state.initialized = true;
          await saveState();

          return `# DAO Initialized\n\n${formatAgentsTable(agents)}\n\nRun \`dao_help\` to discover the workflow, then \`dao_propose\` to create proposals.`;
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
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;

          const proposal = await createProposal(args.title, args.type, args.description, "user", args.context);
          if (args.problemStatement !== undefined) proposal.problemStatement = args.problemStatement;
          if (args.acceptanceCriteria !== undefined) proposal.acceptanceCriteria = args.acceptanceCriteria;
          if (args.successMetrics !== undefined) proposal.successMetrics = args.successMetrics;
          if (args.rollbackConditions !== undefined) proposal.rollbackConditions = args.rollbackConditions;
          if (args.affectedPaths !== undefined) proposal.affectedPaths = args.affectedPaths;

          const zone = classifyRiskZone(proposal);
          proposal.riskZone = zone;
          await saveState();

          await recordAudit(proposal.id, "governance", "proposal_created", "user", `Proposal "${args.title}" created`);
          await saveState();

          return `# 📋 Proposal Created — #${proposal.id}\n\n**Title:** ${args.title}\n**Type:** ${args.type}\n**Zone:** ${zone}\n\nRun \`dao_deliberate proposalId=${proposal.id}\``;
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
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;

          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "open") {
            return `Proposal #${proposal.id} is ${proposal.status}, must be open.`;
          }

          const transition = transitionProposal(proposal, "deliberate");
          if (!transition.success) return `Cannot deliberate: ${transition.error}`;

          await recordAudit(
            proposal.id,
            "governance",
            "deliberation_started",
            "system",
            `Deliberation plan generated for #${proposal.id}`,
          );
          await saveState();

          const parentSessionModel = detectParentModel(context, directory);
          const hostDefaultModel = await loadOpenCodeHostDefaultModel(directory);
          const adapter = createOpenCodeHostAdapter(ctx, {
            getSessionModel: () => detectParentModel(context, directory),
          });
          const projectConfig = await loadConfig(state.daoRoot);
          const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
          const modelContext = createDispatchModelContext(state.config.defaultModel, adapter, {
            parentSessionModel,
            hostDefaultModel,
          });
          const instructions = buildDispatchInstructions(proposal, agents, modelContext);
          const plan = formatDispatchPlan(proposal, instructions);

          const parentNote = parentSessionModel
            ? `\n\n**Parent session model:** ${parentSessionModel}`
            : hostDefaultModel
              ? `\n\n**Host default model:** ${hostDefaultModel}`
              : "";

          return `${plan}${parentNote}`;
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
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;

          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "deliberating") return `Expected deliberating (current: ${proposal.status})`;

          const votes: Vote[] = [];
          const enrichedOutputs: AgentOutput[] = [];

          for (const raw of args.outputs) {
            const agent = state.agents.find((a) => a.id === raw.agentId);
            if (!agent) continue;

            const output: AgentOutput = {
              agentId: agent.id,
              agentName: agent.name,
              role: agent.role,
              content: raw.content || "",
              durationMs: raw.durationMs ?? 0,
              error: raw.error,
            };

            const vote = parseVoteFromOutput(agent.id, agent.name, agent.weight, output.content);
            if (vote) {
              output.vote = vote;
              votes.push(vote);
            }

            enrichedOutputs.push(output);
          }
          await storeDeliberationBatch(proposal.id, votes, enrichedOutputs);

          proposal.votes = votes;

          const compositeScore = calculateCompositeScore(enrichedOutputs);
          proposal.compositeScore = compositeScore;
          await storeCompositeScore(proposal.id, compositeScore);

          const synthesisText = synthesize(proposal, state.agents, enrichedOutputs);
          proposal.synthesis = synthesisText;
          await storeSynthesis(proposal.id, synthesisText);

          const tally = tallyVotes(proposal, state.config);

          if (tally.approved) {
            transitionProposal(proposal, "approve");
            await recordAudit(
              proposal.id,
              "intelligence",
              "deliberation_approved",
              "system",
              `Approved: ${tally.approvalScore}%`,
            );
          } else {
            transitionProposal(proposal, "reject");
            await recordAudit(
              proposal.id,
              "intelligence",
              "deliberation_rejected",
              "system",
              `Rejected: ${tally.approvalScore}%`,
            );
          }

          await saveState();

          return `# 🗳️ Deliberation Complete — #${proposal.id}\n\n${formatTallyResult(tally)}\n\n${formatCompositeScore(compositeScore)}\n\n${synthesisText}\n\n> Next: \`dao_control proposalId=${proposal.id}\``;
        },
      }),

      // ── dao_control ──────────────────────────────────────
      dao_control: tool({
        description: "Run quality control gates",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;

          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "approved") return `Must be approved (current: ${proposal.status})`;

          const result = runGates(proposal, state.config);

          if (result.allGatesPassed) {
            transitionProposal(proposal, "control");
            await recordAudit(proposal.id, "control", "gates_passed", "system", "All gates passed");
            // Generate delivery plan after gates pass, making it available before execution
            if (!state.deliveryPlans[proposal.id]) {
              const plan = generateDeliveryPlan(proposal);
              await storeDeliveryPlan(proposal.id, plan);
            }
          } else {
            await recordAudit(proposal.id, "control", "gates_failed", "system", `${result.blockerCount} blockers`);
          }

          await saveState();
          return formatControlResult(result);
        },
      }),

      // ── dao_execute ──────────────────────────────────────
      dao_execute: tool({
        description: "Execute an approved or controlled proposal",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const _state = getState();
          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "controlled") {
            return `Must be controlled (current: ${proposal.status}). Run dao_control first.`;
          }

          const result = await executeProposal(proposal);
          await saveState();

          await recordAudit(proposal.id, "delivery", "proposal_executed", "user", `Executed #${proposal.id}`);
          await saveState();

          return result.result;
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
          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          const result = await performDryRun(proposal);
          proposal.dryRunAt = new Date().toISOString();
          proposal.dryRunCanProceed = result.canProceed;
          await saveState();
          return formatDryRun(result);
        },
      }),

      // ── dao_rollback ─────────────────────────────────────
      dao_rollback: tool({
        description: "Revert proposal execution to pre-execution snapshot",
        args: { proposalId: schema.number() },
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature
        async execute(args: any, _context: any) {
          const result = await performRollback(args.proposalId);
          return formatRollback(result);
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
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;

          const adapter = createOpenCodeHostAdapter(ctx, {
            getSessionModel: () => detectParentModel(context, directory),
          });
          const projectConfig = await loadConfig(state.daoRoot);
          const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
          const hostDefaultModel = await loadOpenCodeHostDefaultModel(directory);
          const modelContext = createDispatchModelContext(state.config.defaultModel, adapter, {
            parentSessionModel: detectParentModel(context, directory),
            hostDefaultModel,
          });
          const suggestions = await runRoundTable(adapter, agents, state.config.maxConcurrent, modelContext);

          const proposalIds = new Map<string, number>();
          const parsedSuggestions = suggestions
            .map((suggestion) => ({ suggestion, parsed: suggestion.parsed }))
            .filter(
              (
                entry,
              ): entry is {
                suggestion: (typeof suggestions)[number];
                parsed: NonNullable<(typeof suggestions)[number]["parsed"]>;
              } => Boolean(entry.parsed),
            );
          try {
            const proposals = await createProposalsBatch(
              parsedSuggestions.map(({ suggestion, parsed }) => ({
                title: parsed.title,
                type: parsed.type,
                description: parsed.description,
                proposedBy: suggestion.agentId,
              })),
            );
            for (const [index, { suggestion }] of parsedSuggestions.entries()) {
              const proposal = proposals[index];
              if (!proposal) continue;
              proposal.riskZone = classifyRiskZone(proposal);
              suggestion.proposalId = proposal.id;
              proposalIds.set(suggestion.agentId, proposal.id);
              await recordAudit(
                proposal.id,
                "intelligence",
                "roundtable_proposal_created",
                suggestion.agentId,
                `Auto-created from round table`,
              );
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            for (const { suggestion } of parsedSuggestions) {
              suggestion.error = `Failed to create proposal: ${message}`;
            }
          }

          await saveState();
          return formatRoundTableResults(suggestions, proposalIds);
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
          const state = getState();
          if (!state.initialized) return OPENCODE_ONBOARDING_MESSAGE;

          let payload: import("@guyghost/swarm-dao-core").AmendmentPayload;
          try {
            switch (args.amendmentType) {
              case "agent-update":
                payload = {
                  type: "agent-update",
                  agentId: args.agentId,
                  changes: parseSafeJson(args.agentChanges, "agentChanges"),
                };
                break;
              case "agent-add":
                payload = {
                  type: "agent-add",
                  agent: {
                    id: args.newAgentId,
                    name: args.newAgentName,
                    role: args.newAgentRole,
                    weight: args.newAgentWeight,
                    description: "Custom agent",
                    systemPrompt: "",
                  },
                };
                break;
              case "agent-remove":
                payload = { type: "agent-remove", agentId: args.agentId };
                break;
              case "config-update":
                payload = { type: "config-update", changes: parseSafeJson(args.configChanges, "configChanges") };
                break;
              case "quorum-update":
                payload = { type: "quorum-update", typeQuorum: parseSafeJson(args.quorumChanges, "quorumChanges") };
                break;
              case "gate-update":
                payload = { type: "gate-update", addGates: args.addGates, removeGates: args.removeGates };
                break;
              default:
                return `Error: Unknown amendment type "${args.amendmentType}"`;
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error: ${message}`;
          }

          const validation = validateAmendmentPayload(payload);
          if (!validation.valid) return `❌ Validation failed:\n${validation.errors.join("\n")}`;

          const proposal = await createProposal(args.title, "governance-change", args.description, "user");
          proposal.amendmentPayload = payload;
          proposal.amendmentOrigin = { source: "human" };
          proposal.amendmentState = "pending-vote";
          proposal.riskZone = classifyRiskZone(proposal);
          await saveState();

          await recordAudit(proposal.id, "governance", "amendment_proposed", "user", `Amendment: ${payload.type}`);
          await saveState();

          return `# 📜 Amendment Proposed — #${proposal.id}\n\nType: ${payload.type}\n\nRun \`dao_deliberate proposalId=${proposal.id}\``;
        },
      }),
    },
  };
};

export { OpenCodeDAO as default };
