// ============================================================
// Swarm DAO — OpenCode Adapter
// ============================================================

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import type {
  Proposal,
  AgentOutput,
  HostAdapter,
  DAOAgent,
  ProposalType,
} from "@guyghost/swarm-dao-core";
import {
  loadState,
  getState,
  setState,
  getOrCreateState,
  saveState,
  initStorage,
  createProposal,
  getProposal,
  addVote,
  storeAgentOutput,
  storeSynthesis,
  storeCompositeScore,
  updateProposalStatus,
  recordAudit,
  getAllAuditLog,
  getAuditLog,
  initializeAgents,
  parseVoteFromOutput,
  tallyVotes,
  formatTallyResult,
  calculateCompositeScore,
  formatCompositeScore,
  classifyRiskZone,
  transitionProposal,
  runGates,
  formatControlResult,
  formatAuditTrail,
  buildDispatchInstructions,
  synthesize,
  executeProposal,
  generateDeliveryPlan,
  formatPlan,
  getPlan,
  generateAllArtefacts,
  formatAllArtefacts,
  performDryRun,
  formatDryRun,
  performRollback,
  formatRollback,
  computeHealthScore,
  formatHealthScore,
  generateDashboard,
  runRoundTable,
  formatRoundTableResults,
  validateAmendmentPayload,
  previewAmendment,
  executeAmendment,
  PROPOSAL_TYPES,
  PROPOSAL_TYPE_LABELS,
} from "@guyghost/swarm-dao-core";

const schema = tool.schema;

function formatAgentsTable(agents: DAOAgent[]): string {
  let table = "| Agent | Weight | Role |\n|-------|--------|------|\n";
  for (const agent of agents) {
    table += `| ${agent.name} | ${agent.weight} | ${agent.role} |\n`;
  }
  return table;
}

function createOpenCodeHostAdapter(ctx: PluginInput): HostAdapter {
  return {
    hostId: "opencode",
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
    async spawnAgents(params) {
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
      const fs = await import("fs/promises");
      return fs.readFile(path, "utf-8");
    },
    async writeFile(path: string, content: string) {
      const fs = await import("fs/promises");
      await fs.writeFile(path, content, "utf-8");
    },
    async exec(command, options) {
      const { exec } = await import("child_process");
      return new Promise((resolve) => {
        exec(command, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
          resolve({ stdout, stderr, exitCode: error ? (error.code as number ?? 1) : 0 });
        });
      });
    },
    hasCapability(capability) {
      return ["read_file", "write_file", "exec", "log"].includes(capability);
    },
  };
}

export const OpenCodeDAO: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;

  await initStorage(directory);
  const loaded = await loadState(directory);
  if (!loaded) {
    setState(getOrCreateState(directory));
  }

  return {
    tool: {
      // ── dao_setup ────────────────────────────────────────
      dao_setup: tool({
        description: "Initialize the DAO with default 7 product agents",
        args: {
          useDefaults: schema.boolean({ description: "Use default agents (default: true)" }),
        },
        async execute(args: any, context: any) {
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

          return `# DAO Initialized\n\n${formatAgentsTable(agents)}\n\nRun \`dao_propose\` to create proposals.`;
        },
      }),

      // ── dao_propose ──────────────────────────────────────
      dao_propose: tool({
        description: "Create a new DAO proposal",
        args: {
          title: schema.string(),
          type: schema.enum(PROPOSAL_TYPES, { description: "Proposal type" }),
          description: schema.string(),
          context: schema.string({ description: "Additional context" }),
          problemStatement: schema.string({ description: "What problem does this solve?" }),
          acceptanceCriteria: schema.array(schema.string(), { description: "Acceptance criteria" }),
          successMetrics: schema.array(schema.string(), { description: "Success metrics" }),
          affectedPaths: schema.array(schema.string(), { description: "File paths authorized for editing" }),
        },
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized. Run dao_setup first.";

          const proposal = createProposal(args.title, args.type, args.description, "user", args.context);
          proposal.problemStatement = args.problemStatement;
          if (args.acceptanceCriteria) proposal.acceptanceCriteria = args.acceptanceCriteria;
          if (args.successMetrics) proposal.successMetrics = args.successMetrics;
          if (args.affectedPaths) proposal.affectedPaths = args.affectedPaths;

          proposal.riskZone = classifyRiskZone(proposal);
          await saveState();

          recordAudit(proposal.id, "governance", "proposal_created", "user", `Proposal "${args.title}" created`);
          await saveState();

          return `# 📋 Proposal Created — #${proposal.id}\n\n**Title:** ${args.title}\n**Type:** ${PROPOSAL_TYPE_LABELS[args.type as ProposalType]}\n**Zone:** ${proposal.riskZone ?? "unknown"}\n\nRun \`dao_deliberate proposalId=${proposal.id}\` to deliberate.`;
        },
      }),

      // ── dao_deliberate ───────────────────────────────────
      dao_deliberate: tool({
        description: "Plan swarm deliberation. Returns dispatch plan for sub-agents.",
        args: {
          proposalId: schema.number(),
        },
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";

          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "open") return `Proposal #${proposal.id} is ${proposal.status}, must be open.`;

          transitionProposal(proposal, "deliberate");

          const instructions = buildDispatchInstructions(proposal, state.agents);
          const plan = `## 🐝 Dispatch Plan — Proposal #${proposal.id}\n\n${instructions.map((inst) => `### @${inst.agentId}\n${inst.prompt.slice(0, 300)}...\n`).join("\n")}\n\nAfter collecting outputs, run \`dao_record_outputs proposalId=${proposal.id} outputs=[...]\``;

          recordAudit(proposal.id, "intelligence", "deliberation_dispatched", "system", `${instructions.length} agents`);
          await saveState();

          return plan;
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
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";

          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "deliberating") return `Expected deliberating (current: ${proposal.status})`;

          const votes: any[] = [];
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
              addVote(proposal.id, vote);
            }

            storeAgentOutput(proposal.id, output);
            enrichedOutputs.push(output);
          }

          proposal.votes = votes;

          const compositeScore = calculateCompositeScore(enrichedOutputs);
          proposal.compositeScore = compositeScore;
          storeCompositeScore(proposal.id, compositeScore);

          const synthesisText = synthesize(proposal, state.agents, enrichedOutputs);
          proposal.synthesis = synthesisText;
          storeSynthesis(proposal.id, synthesisText);

          const tally = tallyVotes(proposal, state.config);

          if (tally.approved) {
            transitionProposal(proposal, "approve");
            recordAudit(proposal.id, "intelligence", "deliberation_approved", "system", `Approved: ${tally.approvalScore}%`);
          } else {
            transitionProposal(proposal, "reject");
            recordAudit(proposal.id, "intelligence", "deliberation_rejected", "system", `Rejected: ${tally.approvalScore}%`);
          }

          await saveState();

          return `# 🗳️ Deliberation Complete — #${proposal.id}\n\n${formatTallyResult(tally)}\n\n${formatCompositeScore(compositeScore)}\n\n${synthesisText}\n\n> Next: \`dao_control proposalId=${proposal.id}\``;
        },
      }),

      // ── dao_control ──────────────────────────────────────
      dao_control: tool({
        description: "Run quality control gates",
        args: { proposalId: schema.number() },
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";

          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "approved") return `Must be approved (current: ${proposal.status})`;

          const result = runGates(proposal, state.config);

          if (result.allGatesPassed) {
            transitionProposal(proposal, "control");
            recordAudit(proposal.id, "control", "gates_passed", "system", "All gates passed");
          } else {
            recordAudit(proposal.id, "control", "gates_failed", "system", `${result.blockerCount} blockers`);
          }

          await saveState();
          return formatControlResult(result);
        },
      }),

      // ── dao_execute ──────────────────────────────────────
      dao_execute: tool({
        description: "Execute an approved or controlled proposal",
        args: { proposalId: schema.number() },
        async execute(args: any, context: any) {
          const state = getState();
          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          if (proposal.status !== "approved" && proposal.status !== "controlled") {
            return `Must be approved or controlled (current: ${proposal.status})`;
          }

          const result = executeProposal(proposal);
          await saveState();

          recordAudit(proposal.id, "delivery", "proposal_executed", "user", `Executed #${proposal.id}`);
          await saveState();

          return result.result;
        },
      }),

      // ── dao_list ─────────────────────────────────────────
      dao_list: tool({
        description: "List all DAO proposals",
        args: {},
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";
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
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";
          return `# DAO Agents\n\n${formatAgentsTable(state.agents)}`;
        },
      }),

      // ── dao_plan ─────────────────────────────────────────
      dao_plan: tool({
        description: "Get delivery plan",
        args: { proposalId: schema.number() },
        async execute(args: any, context: any) {
          const plan = getPlan(args.proposalId);
          if (!plan) return "No plan yet. Run deliberation first.";
          return formatPlan(plan);
        },
      }),

      // ── dao_artefacts ────────────────────────────────────
      dao_artefacts: tool({
        description: "View auto-generated artefacts for a proposal",
        args: { proposalId: schema.number() },
        async execute(args: any, context: any) {
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
        async execute(args: any, context: any) {
          const proposal = getProposal(args.proposalId);
          if (!proposal) return `Proposal #${args.proposalId} not found.`;
          const result = performDryRun(proposal);
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
        async execute(args: any, context: any) {
          const result = performRollback(args.proposalId);
          await saveState();
          return formatRollback(result);
        },
      }),

      // ── dao_dashboard ────────────────────────────────────
      dao_dashboard: tool({
        description: "View outcome tracking dashboard",
        args: {},
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";
          const dashboard = generateDashboard(state.proposals, state.outcomes, state.agents);
          const health = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
          return dashboard + "\n\n" + formatHealthScore(health);
        },
      }),

      // ── dao_roundtable ───────────────────────────────────
      dao_roundtable: tool({
        description: "Ask every agent to suggest a proposal idea",
        args: {},
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";

          const adapter = createOpenCodeHostAdapter(ctx);
          const suggestions = await runRoundTable(adapter, state.agents, state.config.maxConcurrent);

          const proposalIds = new Map<string, number>();
          for (const s of suggestions) {
            if (!s.parsed) continue;
            try {
              const proposal = createProposal(s.parsed.title, s.parsed.type, s.parsed.description, s.agentId);
              proposal.riskZone = classifyRiskZone(proposal);
              s.proposalId = proposal.id;
              proposalIds.set(s.agentId, proposal.id);
              recordAudit(proposal.id, "intelligence", "roundtable_proposal_created", s.agentId, `Auto-created from round table`);
            } catch (err: any) {
              s.error = `Failed to create proposal: ${err?.message ?? err}`;
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
        async execute(args: any, context: any) {
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
          amendmentType: schema.enum(["agent-update", "agent-add", "agent-remove", "config-update", "quorum-update", "gate-update"]),
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
        async execute(args: any, context: any) {
          const state = getState();
          if (!state.initialized) return "DAO not initialized.";

          let payload: any;
          try {
            switch (args.amendmentType) {
              case "agent-update":
                payload = { type: "agent-update", agentId: args.agentId, changes: JSON.parse(args.agentChanges) };
                break;
              case "agent-add":
                payload = {
                  type: "agent-add",
                  agent: { id: args.newAgentId, name: args.newAgentName, role: args.newAgentRole, weight: args.newAgentWeight, description: "Custom agent", systemPrompt: "" },
                };
                break;
              case "agent-remove":
                payload = { type: "agent-remove", agentId: args.agentId };
                break;
              case "config-update":
                payload = { type: "config-update", changes: JSON.parse(args.configChanges) };
                break;
              case "quorum-update":
                payload = { type: "quorum-update", typeQuorum: JSON.parse(args.quorumChanges) };
                break;
              case "gate-update":
                payload = { type: "gate-update", addGates: args.addGates, removeGates: args.removeGates };
                break;
            }
          } catch (err: any) {
            return `Error: ${err.message}`;
          }

          const validation = validateAmendmentPayload(payload);
          if (!validation.valid) return `❌ Validation failed:\n${validation.errors.join("\n")}`;

          const proposal = createProposal(args.title, "governance-change", args.description, "user");
          proposal.amendmentPayload = payload;
          proposal.amendmentOrigin = { source: "human" };
          proposal.amendmentState = "pending-vote";
          proposal.riskZone = classifyRiskZone(proposal);
          await saveState();

          recordAudit(proposal.id, "governance", "amendment_proposed", "user", `Amendment: ${payload.type}`);
          await saveState();

          return `# 📜 Amendment Proposed — #${proposal.id}\n\nType: ${payload.type}\n\nRun \`dao_deliberate proposalId=${proposal.id}\``;
        },
      }),
    },
  };
};

export { OpenCodeDAO as default };