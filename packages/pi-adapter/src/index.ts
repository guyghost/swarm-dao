// ============================================================
// Swarm DAO — Pi Adapter
// ============================================================
// Bridges the Swarm DAO core to Pi's ExtensionAPI.
// Registers tools, commands, and event hooks.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import type {
  Proposal,
  ProposalType,
  AgentOutput,
  HostAdapter,
  DAOAgent,
  SwarmProgressUpdate,
} from "@guyghost/swarm-dao-core";
import {
  // Persistence
  loadState,
  getState,
  setState,
  getOrCreateState,
  saveState,
  initStorage,
  getDaoRoot,
  // Governance
  initializeAgents,
  createProposal,
  getProposal,
  listProposals,
  addVote,
  storeAgentOutput,
  storeSynthesis,
  storeCompositeScore,
  updateProposalStatus,
  // Voting & Scoring
  parseVoteFromOutput,
  tallyVotes,
  formatTallyResult,
  calculateCompositeScore,
  formatCompositeScore,
  // Lifecycle
  classifyRiskZone,
  statusLabel,
  transitionProposal,
  // Control
  runGates,
  formatControlResult,
  recordAudit,
  getAllAuditLog,
  formatAuditTrail,
  // Intelligence
  buildDispatchInstructions,
  dispatchSwarm,
  synthesize,
  // Delivery
  executeProposal,
  verifyExecution,
  formatVerification,
  generateDeliveryPlan,
  formatPlan,
  getPlan,
  generateAllArtefacts,
  formatAllArtefacts,
  formatArtefactsSummary,
  performDryRun,
  formatDryRun,
  canRollback,
  performRollback,
  formatRollback,
  // Health Score
  computeHealthScore,
  formatHealthScore,
  generateDashboard,
  // Round Table
  runRoundTable,
  formatRoundTableResults,
  // Amendments
  validateAmendmentPayload,
  previewAmendment,
  executeAmendment,
  // Types
  PROPOSAL_TYPES,
  PROPOSAL_TYPE_LABELS,
} from "@guyghost/swarm-dao-core";

// ── Pi Host Adapter Implementation ───────────────────────────

function createPiHostAdapter(pi: ExtensionAPI, ctx?: ExtensionCommandContext): HostAdapter {
  return {
    hostId: "pi",

    async spawnAgent(params): Promise<AgentOutput> {
      const startTime = Date.now();
      // Pi-specific: spawn sub-agent via pi's agent runner
      // This is a simplified version — full implementation uses pi's subprocess API
      return {
        agentId: params.agent.id,
        agentName: params.agent.name,
        role: params.agent.role,
        content: "",
        durationMs: Date.now() - startTime,
        error: "Pi agent spawning not yet implemented in adapter — use manual deliberation",
      };
    },

    async spawnAgents(params): Promise<AgentOutput[]> {
      const outputs: AgentOutput[] = [];
      for (const agent of params.agents) {
        const output = await this.spawnAgent({ agent, proposal: params.proposal, systemPrompt: agent.systemPrompt });
        outputs.push(output);
      }
      return outputs;
    },

    async log(params): Promise<void> {
      console.log(`[${params.level}] ${params.service}: ${params.message}`);
    },

    getWorkingDirectory(): string {
      return process.cwd();
    },

    async readFile(path: string): Promise<string> {
      const fs = await import("fs/promises");
      return fs.readFile(path, "utf-8");
    },

    async writeFile(path: string, content: string): Promise<void> {
      const fs = await import("fs/promises");
      await fs.writeFile(path, content, "utf-8");
    },

    async exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const { exec } = await import("child_process");
      return new Promise((resolve) => {
        exec(command, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
          resolve({ stdout, stderr, exitCode: error ? (error.code as number ?? 1) : 0 });
        });
      });
    },

    hasCapability(capability: string): boolean {
      const caps = ["spawn_agent", "read_file", "write_file", "exec", "log"];
      return caps.includes(capability);
    },
  };
}

// ── Tool Result Helper ───────────────────────────────────────

function toolResult(content: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text" as const, text: content }],
    details: {},
  };
}

// ── Main Extension Export ────────────────────────────────────

export default function swarmDaoExtension(pi: ExtensionAPI) {
  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    const cwd = process.cwd();
    await initStorage(cwd);
    const loaded = await loadState(cwd);
    if (!loaded) {
      setState(getOrCreateState(cwd));
    }
  });

  // System prompt injection
  pi.on("before_agent_start", async (event, _ctx) => {
    const state = getState();
    if (!state.initialized) {
      return {
        systemPrompt: event.systemPrompt +
          "\n\n## Swarm DAO\nThe swarm-dao extension is loaded (4-layer architecture: Governance → Intelligence → Control → Delivery). Use `dao_setup` to initialize the DAO with default agents, or run `/dao` for the dashboard.",
      };
    }

    const agents = state.agents;
    const totalWeight = agents.reduce((s, a) => s + a.weight, 0);
    const agentList = agents.map((a) => `${a.name}[${a.weight}]`).join(", ");
    const openProposals = state.proposals.filter((p) => p.status === "open" || p.status === "deliberating");

    let daoContext = `\n\n## Swarm DAO Status (4-Layer: Governance → Intelligence → Control → Delivery)`;
    daoContext += `\n- Active agents: ${agents.length} (${agentList}) — Total weight: ${totalWeight}`;
    daoContext += `\n- Open proposals: ${openProposals.length}`;
    if (openProposals.length > 0) {
      for (const p of openProposals) {
        daoContext += `\n  - #${p.id} \"${p.title}\" (${p.type}) (${p.status})`;
      }
    }
    daoContext += `\n- Config: quorum=${state.config.quorumPercent}%, approval=${state.config.approvalThreshold}%, risk=${state.config.riskThreshold}/10`;
    daoContext += `\n\nAvailable tools: dao_setup, dao_propose, dao_deliberate, dao_check, dao_plan, dao_execute, dao_audit, dao_artefacts, dao_verify, dao_rate, dao_dashboard, dao_dry_run, dao_rollback`;

    return { systemPrompt: event.systemPrompt + daoContext };
  });

  // ── Tool: dao_setup ──────────────────────────────────────
  pi.registerTool({
    name: "dao_setup",
    label: "DAO Setup",
    description: "Initialize the DAO with 7 default agents",
    parameters: Type.Object({
      useDefaults: Type.Optional(Type.Boolean({ description: "Use default agents (default: true)" })),
    }),
    async execute(_id, params: any) {
      const state = getState();
      if (state.initialized) {
        return toolResult(`DAO already initialized with ${state.agents.length} agents.`);
      }

      const agents = initializeAgents(params.useDefaults !== false ? undefined : []);
      state.agents = agents;
      state.initialized = true;
      await saveState();

      const table = agents.map((a) => `| ${a.name} | ${a.weight} | ${a.role} |`).join("\n");
      return toolResult(`# DAO Initialized\n\n| Agent | Weight | Role |\n|-------|--------|------|\n${table}\n\nRun \`dao_propose\` to create proposals.`);
    },
  });

  // ── Tool: dao_propose ────────────────────────────────────
  pi.registerTool({
    name: "dao_propose",
    label: "DAO Propose",
    description: "Create a new proposal",
    parameters: Type.Object({
      title: Type.String(),
      type: StringEnum(PROPOSAL_TYPES),
      description: Type.String(),
      context: Type.Optional(Type.String()),
      problemStatement: Type.Optional(Type.String()),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      successMetrics: Type.Optional(Type.Array(Type.String())),
      rollbackConditions: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params: any) {
      const state = getState();
      if (!state.initialized) return toolResult("DAO not initialized. Run `dao_setup` first.");

      const proposal = createProposal(params.title, params.type, params.description, "user", params.context);
      proposal.problemStatement = params.problemStatement;
      if (params.acceptanceCriteria) proposal.acceptanceCriteria = params.acceptanceCriteria;
      if (params.successMetrics) proposal.successMetrics = params.successMetrics;
      if (params.rollbackConditions) proposal.rollbackConditions = params.rollbackConditions;

      const zone = classifyRiskZone(proposal);
      proposal.riskZone = zone;
      await saveState();

      recordAudit(proposal.id, "governance", "proposal_created", "user", `Proposal "${params.title}" created`);
      await saveState();

      return toolResult(`# 📋 Proposal Created — #${proposal.id}\n\n**Title:** ${params.title}\n**Type:** ${PROPOSAL_TYPE_LABELS[params.type as ProposalType]}\n**Zone:** ${zone}\n\nRun \`dao_deliberate proposalId=${proposal.id}\` to deliberate.`);
    },
  });

  // ── Tool: dao_deliberate ─────────────────────────────────
  pi.registerTool({
    name: "dao_deliberate",
    label: "DAO Deliberate",
    description: "Run swarm deliberation on a proposal",
    parameters: Type.Object({
      proposalId: Type.Number(),
    }),
    async execute(_id, params: any, _signal, onUpdate, ctx) {
      const state = getState();
      if (!state.initialized) return toolResult("DAO not initialized.");

      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "open") return toolResult(`Proposal #${proposal.id} is ${proposal.status}, must be open.`);

      // Transition
      const transition = transitionProposal(proposal, "deliberate");
      if (!transition.success) return toolResult(`Cannot deliberate: ${transition.error}`);

      recordAudit(proposal.id, "governance", "deliberation_started", "system", `Deliberation on #${proposal.id}`);
      await saveState();

      if (onUpdate) {
        onUpdate({ content: [{ type: "text", text: `🗳️ Deliberating proposal #${proposal.id}...` }], details: {} });
      }

      const startTime = Date.now();
      const adapter = createPiHostAdapter(pi, ctx);

      // For Pi, we build instructions but let the host spawn agents
      const instructions = buildDispatchInstructions(proposal, state.agents);

      // Attempt automatic dispatch if Pi supports it
      const outputs = await dispatchSwarm(proposal, state.agents, adapter, state.config.maxConcurrent, (update) => {
        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: `${update.agentName}: ${update.phase}` }],
            details: {},
          });
        }
      });

      // Parse votes
      const votes = [];
      for (const output of outputs) {
        if (output.content) {
          const vote = parseVoteFromOutput(output.agentId, output.agentName, state.agents.find((a) => a.id === output.agentId)?.weight ?? 1, output.content);
          if (vote) {
            vote.weight = state.agents.find((a) => a.id === output.agentId)?.weight ?? 1;
            votes.push(vote);
            addVote(proposal.id, vote);
          }
        }
        storeAgentOutput(proposal.id, output);
      }
      proposal.votes = votes;

      // Composite score
      const compositeScore = calculateCompositeScore(outputs);
      proposal.compositeScore = compositeScore;
      storeCompositeScore(proposal.id, compositeScore);

      // Synthesis
      const tally = tallyVotes(proposal, state.config);
      const synthesisText = synthesize(proposal, state.agents, outputs, tally);
      proposal.synthesis = synthesisText;
      storeSynthesis(proposal.id, synthesisText);

      // Final transition
      if (tally.approved) {
        transitionProposal(proposal, "approve");
        recordAudit(proposal.id, "intelligence", "deliberation_approved", "system", `Approved: ${tally.approvalScore}%`);
      } else {
        transitionProposal(proposal, "reject");
        recordAudit(proposal.id, "intelligence", "deliberation_rejected", "system", `Rejected: ${tally.approvalScore}%`);
      }

      await saveState();

      const duration = Date.now() - startTime;
      return toolResult(`# 🗳️ Deliberation Complete — #${proposal.id} (${duration}ms)\n\n${formatTallyResult(tally)}\n\n${formatCompositeScore(compositeScore)}\n\n${synthesisText}\n\n> Next: \`dao_check proposalId=${proposal.id}\``);
    },
  });

  // ── Tool: dao_check ──────────────────────────────────────
  pi.registerTool({
    name: "dao_check",
    label: "DAO Check",
    description: "Run quality control gates",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: any) {
      const state = getState();
      if (!state.initialized) return toolResult("DAO not initialized.");

      const proposal = getProposal(params.proposalId);
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "approved") return toolResult(`Must be approved (current: ${proposal.status})`);

      const result = runGates(proposal, state.config);

      if (result.allGatesPassed) {
        transitionProposal(proposal, "control");
        recordAudit(proposal.id, "control", "gates_passed", "system", "All gates passed");
      } else {
        transitionProposal(proposal, "fail");
        recordAudit(proposal.id, "control", "gates_failed", "system", `${result.blockerCount} blockers`);
      }

      await saveState();
      return toolResult(formatControlResult(result));
    },
  });

  // ── Tool: dao_plan ───────────────────────────────────────
  pi.registerTool({
    name: "dao_plan",
    label: "DAO Plan",
    description: "Get delivery plan",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: any) {
      const plan = getPlan(params.proposalId);
      if (!plan) return toolResult("No plan yet. Run deliberation first.");
      return toolResult(formatPlan(plan));
    },
  });

  // ── Tool: dao_execute ────────────────────────────────────
  pi.registerTool({
    name: "dao_execute",
    label: "DAO Execute",
    description: "Execute a controlled proposal",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: any) {
      const state = getState();
      const proposal = getProposal(params.proposalId);
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "approved" && proposal.status !== "controlled") {
        return toolResult(`Must be approved or controlled (current: ${proposal.status})`);
      }

      const result = executeProposal(proposal);
      await saveState();

      recordAudit(proposal.id, "delivery", "proposal_executed", "user", `Executed #${proposal.id}`);
      await saveState();

      return toolResult(result.result);
    },
  });

  // ── Tool: dao_audit ──────────────────────────────────────
  pi.registerTool({
    name: "dao_audit",
    label: "DAO Audit",
    description: "View audit trail",
    parameters: Type.Object({ proposalId: Type.Optional(Type.Number()) }),
    async execute(_id, params: any) {
      const entries = params.proposalId !== undefined ? getAllAuditLog().filter((e) => e.proposalId === params.proposalId) : getAllAuditLog();
      return toolResult(formatAuditTrail(entries, params.proposalId));
    },
  });

  // ── Tool: dao_artefacts ─────────────────────────────────
  pi.registerTool({
    name: "dao_artefacts",
    label: "DAO Artefacts",
    description: "View auto-generated artefacts for a proposal",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: any) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      const artefacts = generateAllArtefacts(proposal);
      return toolResult(formatAllArtefacts(artefacts));
    },
  });

  // ── Tool: dao_rate ───────────────────────────────────────
  pi.registerTool({
    name: "dao_rate",
    label: "DAO Rate",
    description: "Rate a proposal outcome post-execution (1-5 stars)",
    parameters: Type.Object({
      proposalId: Type.Number(),
      score: Type.Number({ minimum: 1, maximum: 5 }),
      comment: Type.String(),
    }),
    async execute(_id, params: any) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "executed") return toolResult(`Proposal #${proposal.id} is ${proposal.status}, must be executed.`);

      const { addRating } = await import("@guyghost/swarm-dao-core");
      addRating(proposal.id, { proposalId: proposal.id, rater: "user", score: Number(params.score) as 1 | 2 | 3 | 4 | 5, comment: params.comment, ratedAt: new Date().toISOString() });
      await saveState();
      return toolResult(`# ⭐ Rating Recorded — #${proposal.id}\n\n**Score:** ${params.score}/5\n**Comment:** ${params.comment}`);
    },
  });

  // ── Tool: dao_dashboard ──────────────────────────────────
  pi.registerTool({
    name: "dao_dashboard",
    label: "DAO Dashboard",
    description: "View outcome tracking dashboard",
    parameters: Type.Object({}),
    async execute(_id, _params: any) {
      const state = getState();
      if (!state.initialized) return toolResult("DAO not initialized.");
      const dashboard = generateDashboard(state.proposals, state.outcomes, state.agents);
      const health = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
      return toolResult(dashboard + "\n\n" + formatHealthScore(health));
    },
  });

  // ── Tool: dao_dry_run ────────────────────────────────────
  pi.registerTool({
    name: "dao_dry_run",
    label: "DAO Dry Run",
    description: "Preview execution without applying changes",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: any) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      const result = performDryRun(proposal);
      proposal.dryRunAt = new Date().toISOString();
      proposal.dryRunCanProceed = result.canProceed;
      await saveState();
      return toolResult(formatDryRun(result));
    },
  });

  // ── Tool: dao_rollback ───────────────────────────────────
  pi.registerTool({
    name: "dao_rollback",
    label: "DAO Rollback",
    description: "Revert proposal execution to pre-execution snapshot",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: any) {
      const result = performRollback(Number(params.proposalId));
      await saveState();
      return toolResult(formatRollback(result));
    },
  });

  // ── Tool: dao_roundtable ─────────────────────────────────
  pi.registerTool({
    name: "dao_roundtable",
    label: "DAO Roundtable",
    description: "Ask every agent to suggest a proposal idea",
    parameters: Type.Object({}),
    async execute(_id, _params: any, _signal, onUpdate, ctx) {
      const state = getState();
      if (!state.initialized) return toolResult("DAO not initialized.");

      const adapter = createPiHostAdapter(pi, ctx);
      const suggestions = await runRoundTable(adapter, state.agents, state.config.maxConcurrent);

      // Create proposals from valid suggestions
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
      return toolResult(formatRoundTableResults(suggestions, proposalIds));
    },
  });

  // ── Tool: dao_update_proposal ────────────────────────────
  pi.registerTool({
    name: "dao_update_proposal",
    label: "DAO Update Proposal",
    description: "Update structured fields on an open proposal",
    parameters: Type.Object({
      proposalId: Type.Number(),
      problemStatement: Type.Optional(Type.String()),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      successMetrics: Type.Optional(Type.Array(Type.String())),
      rollbackConditions: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params: any) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "open") return toolResult(`Must be open (current: ${proposal.status})`);

      if (params.problemStatement) proposal.problemStatement = params.problemStatement;
      if (params.acceptanceCriteria) proposal.acceptanceCriteria = params.acceptanceCriteria;
      if (params.successMetrics) proposal.successMetrics = params.successMetrics;
      if (params.rollbackConditions) proposal.rollbackConditions = params.rollbackConditions;

      await saveState();
      return toolResult(`# 📝 Proposal Updated — #${proposal.id}\n\nUpdated fields applied.`);
    },
  });

  // ── Command: /dao ────────────────────────────────────────
  pi.registerCommand("/dao", {
    description: "Show DAO dashboard",
    handler: async (_args, _ctx) => {
      const state = getState();
      if (!state.initialized) {
        console.log("DAO not initialized. Run `dao_setup`.");
        return;
      }

      const byStatus: Record<string, number> = {};
      for (const p of state.proposals) {
        byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      }

      console.log(`# Swarm DAO Dashboard`);
      console.log(`Agents: ${state.agents.length} | Proposals: ${state.proposals.length}`);
      for (const [status, count] of Object.entries(byStatus)) {
        console.log(`  ${status}: ${count}`);
      }
    },
  });
}