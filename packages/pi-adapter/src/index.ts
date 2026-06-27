// ============================================================
// Swarm DAO — Pi Adapter
// ============================================================
// Bridges the Swarm DAO core to Pi's ExtensionAPI.
// Registers tools, commands, and event hooks.

import { spawn } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentOutput, HostAdapter, Proposal, ProposalType, Vote } from "@guyghost/swarm-dao-core";
import {
  addRating,
  calculateCompositeScore,
  classifyRiskZone,
  computeHealthScore,
  createDispatchModelContext,
  createProposal,
  createProposalsBatch,
  dispatchSwarm,
  filterEnabledAgents,
  loadAgentDefinitions,
  loadConfig,
  // Delivery
  execCommand,
  executeProposal,
  formatAllArtefacts,
  formatAuditTrail,
  formatCompositeScore,
  formatControlResult,
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
  getUnexecutedDependencies,
  // Governance
  initializeAgents,
  initStorage,
  // Persistence
  loadState,
  PROPOSAL_TYPE_LABELS,
  // Types
  PROPOSAL_TYPES,
  // Voting & Scoring
  parseVoteFromOutput,
  performDryRun,
  performRollback,
  readFileContained,
  recordAudit,
  // Control
  runGates,
  // Round Table
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
  writeFileContained,
} from "@guyghost/swarm-dao-core";
import { Type } from "typebox";

// ── Pi Host Adapter Implementation ───────────────────────────

type SpawnAgentParams = Parameters<HostAdapter["spawnAgent"]>[0];

let currentSessionModel: string | undefined = process.env.PI_MODEL;

function detectParentSessionModel(ctx?: ExtensionCommandContext): string | undefined {
  return ctx?.session?.model ?? currentSessionModel ?? process.env.PI_MODEL;
}

function extractPiJsonContent(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.content === "string") return record.content;
      if (typeof record.text === "string") return record.text;
      if (typeof record.output === "string") return record.output;
      if (Array.isArray(record.content)) {
        const text = record.content
          .filter((block): block is { type: string; text: string } => {
            return (
              typeof block === "object" &&
              block !== null &&
              (block as { type?: string }).type === "text" &&
              typeof (block as { text?: string }).text === "string"
            );
          })
          .map((block) => block.text)
          .join("\n");
        return text.length > 0 ? text : null;
      }
    }
  } catch {
    // stdout is not JSON
  }
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function spawnPiSubprocess(
  systemPrompt: string,
  model: string,
  timeoutMs?: number,
): Promise<{ content: string | null; error?: string }> {
  return new Promise((resolve) => {
    const args = ["--mode", "json", "-p", "--no-session", "--model", model, "-e", systemPrompt];
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({ content: null, error: error.message });
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        resolve({ content: null, error: `Pi subprocess timed out after ${timeoutMs}ms` });
        return;
      }
      if (code !== 0) {
        resolve({ content: null, error: stderr.trim() || `Pi subprocess exited with code ${code ?? 1}` });
        return;
      }
      resolve({ content: extractPiJsonContent(stdout), error: undefined });
    });
  });
}

function stableHash(input: string): number {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function scoreFromSeed(seed: string, key: string, min: number, max: number): number {
  const spread = max - min + 1;
  return min + (stableHash(`${seed}:${key}`) % spread);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(10, value));
}

function pickRoundTableType(agentId: string): ProposalType {
  switch (agentId) {
    case "architect":
      return "technical-change";
    case "critic":
      return "security-change";
    case "delivery":
      return "release-change";
    case "prioritizer":
      return "governance-change";
    default:
      return "product-feature";
  }
}

function generateRoundTableSuggestion(params: SpawnAgentParams): string {
  const suggestionType = pickRoundTableType(params.agent.id);
  const title = `${params.agent.name}: ${params.proposal.type === "governance-change" ? "Tighten proposal quality gates" : "Improve developer workflow"}`;
  const description =
    suggestionType === "security-change"
      ? "Introduce mandatory risk checks before execution to reduce regressions. This adds explicit guardrails while preserving delivery speed."
      : "Standardize proposal intake with clearer acceptance criteria and measurable outcomes. This improves review quality and helps the swarm converge faster.";

  return `## Suggested Proposal
**Title:** ${title}
**Type:** ${suggestionType}
**Description:** ${description}`;
}

function decideFallbackVote(agentId: string, proposal: Proposal): "for" | "against" | "abstain" {
  if (agentId === "critic" && (proposal.type === "security-change" || proposal.riskZone === "red")) {
    return "against";
  }
  if (agentId === "delivery" && proposal.type === "security-change") {
    return "abstain";
  }
  return "for";
}

function generateDeliberationOutput(params: SpawnAgentParams): string {
  const proposal = params.proposal;
  const vote = decideFallbackVote(params.agent.id, proposal);
  const seed = `${proposal.id}:${params.agent.id}:${proposal.title}:${proposal.type}`;

  const userImpactBase: Record<ProposalType, number> = {
    "product-feature": 8,
    "technical-change": 6,
    "security-change": 7,
    "release-change": 5,
    "governance-change": 6,
  };
  const effortBase: Record<ProposalType, number> = {
    "product-feature": 6,
    "technical-change": 7,
    "security-change": 8,
    "release-change": 4,
    "governance-change": 5,
  };
  const securityRiskBase: Record<ProposalType, number> = {
    "product-feature": 3,
    "technical-change": 4,
    "security-change": 7,
    "release-change": 2,
    "governance-change": 4,
  };

  const userImpact = clampScore(userImpactBase[proposal.type] + scoreFromSeed(seed, "ui", -1, 1));
  const businessImpact = clampScore(6 + scoreFromSeed(seed, "bi", -1, 2));
  const effort = clampScore(effortBase[proposal.type] + scoreFromSeed(seed, "effort", -1, 1));
  const securityRisk = clampScore(securityRiskBase[proposal.type] + scoreFromSeed(seed, "risk", -1, 1));
  const confidence = clampScore(7 + scoreFromSeed(seed, "conf", -2, 1));
  const riskScore = clampScore(Math.round((securityRisk + effort) / 2));

  const voteReasoning =
    vote === "for"
      ? "The proposal is actionable and aligns with expected project outcomes."
      : vote === "against"
        ? "Risk exposure is too high for the current safeguards."
        : "The direction is promising, but execution details need clarification first.";

  return `## Analysis
${params.agent.name} reviewed proposal #${proposal.id} (${proposal.type}) and assessed implementation tradeoffs, risk profile, and expected impact.

## Vote
${vote}

## Reasoning
${voteReasoning}

## Composite Score Inputs (0-10)
- userImpact: ${userImpact}
- businessImpact: ${businessImpact}
- effort: ${effort}
- securityRisk: ${securityRisk}
- confidence: ${confidence}

## Risk Score (1-10)
${riskScore}`;
}

function createPiHostAdapter(_pi: ExtensionAPI, ctx?: ExtensionCommandContext): HostAdapter {
  const parentSessionModel = detectParentSessionModel(ctx);

  return {
    hostId: "pi",

    getSessionModel() {
      return parentSessionModel;
    },

    async spawnAgent(params): Promise<AgentOutput> {
      const startTime = Date.now();
      const model = params.model;
      const isRoundTable = params.proposal.id === 0 && params.proposal.title === "Round Table Suggestions";

      const piSpawnEnabled = process.env.SWARM_DAO_ENABLE_PI_SPAWN === "1";
      if (piSpawnEnabled && model && model !== "default") {
        const subprocess = await spawnPiSubprocess(params.systemPrompt, model, params.timeoutMs);
        if (subprocess.content) {
          return {
            agentId: params.agent.id,
            agentName: params.agent.name,
            role: params.agent.role,
            content: subprocess.content,
            durationMs: Date.now() - startTime,
          };
        }
        await this.log({
          level: "warn",
          service: "pi-adapter",
          message: `Pi subprocess spawn failed for ${params.agent.id} (${model}): ${subprocess.error ?? "empty output"}; using fallback output`,
        });
      }

      const content = isRoundTable ? generateRoundTableSuggestion(params) : generateDeliberationOutput(params);
      return {
        agentId: params.agent.id,
        agentName: params.agent.name,
        role: params.agent.role,
        content,
        durationMs: Date.now() - startTime,
      };
    },

    async spawnAgents(params): Promise<AgentOutput[]> {
      return Promise.all(
        params.agents.map((agent) =>
          this.spawnAgent({ agent, proposal: params.proposal, systemPrompt: agent.systemPrompt }),
        ),
      );
    },

    async log(params): Promise<void> {
      console.log(`[${params.level}] ${params.service}: ${params.message}`);
    },

    getWorkingDirectory(): string {
      return process.cwd();
    },

    async readFile(path: string): Promise<string> {
      return readFileContained(path, this.getWorkingDirectory());
    },

    async writeFile(path: string, content: string): Promise<void> {
      return writeFileContained(path, content, this.getWorkingDirectory());
    },

    async exec(
      command: string,
      options?: { cwd?: string; timeout?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return execCommand(command, options);
    },

    hasCapability(capability: string): boolean {
      const caps = ["read_file", "write_file", "exec", "log", "spawn_agent"];
      return caps.includes(capability);
    },
  };
}

// ── Tool Result Helper ───────────────────────────────────────

function toolResult(content: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: content }],
    details: {},
  };
}

const PI_ONBOARDING_MESSAGE = [
  "# DAO not initialized",
  "",
  "1. Run `dao_setup` to create the default governance agents.",
  "2. Run `/dao` to confirm the dashboard is available.",
  '3. Start your first proposal with `dao_propose title="..." type="product-feature" description="..."`.',
].join("\n");

const DAO_COMMAND_HELP = [
  "# /dao Help",
  "",
  "Use `/dao` with one of these subcommands:",
  "- `/dao` or `/dao status` — show dashboard summary.",
  "- `/dao help` — show this help.",
  "- `/dao setup` — initialize DAO with default agents.",
  "",
  "Main tools you can run next:",
  "- `dao_setup`",
  '- `dao_propose title="..." type="product-feature" description="..."`',
  "- `dao_deliberate proposalId=1`",
  "- `dao_check proposalId=1`",
  "- `dao_ship proposalId=1`",
].join("\n");

// ── Parameter Interfaces ─────────────────────────────────────

interface DaoSetupParams {
  useDefaults?: boolean;
}

interface DaoProposeParams {
  title: string;
  type: string;
  description: string;
  context?: string;
  problemStatement?: string;
  acceptanceCriteria?: string[];
  successMetrics?: string[];
  rollbackConditions?: string[];
  affectedPaths?: string[];
}

interface DaoDeliberateParams {
  proposalId: number;
}

interface DaoCheckParams {
  proposalId: number;
}

interface DaoPlanParams {
  proposalId: number;
}

interface DaoExecuteParams {
  proposalId: number;
}

interface DaoShipParams {
  proposalId: number;
  cascade?: boolean;
  force?: boolean;
}

interface DaoAuditParams {
  proposalId?: number;
}

interface DaoArtefactsParams {
  proposalId: number;
}

interface DaoRateParams {
  proposalId: number;
  score: number;
  comment: string;
}

type DaoDashboardParams = Record<string, never>;

interface DaoDryRunParams {
  proposalId: number;
}

interface DaoRollbackParams {
  proposalId: number;
}

type DaoRoundtableParams = Record<string, never>;

interface DaoUpdateProposalParams {
  proposalId: number;
  problemStatement?: string;
  acceptanceCriteria?: string[];
  successMetrics?: string[];
  rollbackConditions?: string[];
}

// ── Main Extension Export ────────────────────────────────────

export default function swarmDaoExtension(pi: ExtensionAPI) {
  // Restore state on session start
  pi.on("session_start", async (_event, _ctx) => {
    const cwd = process.cwd();
    await initStorage(cwd);
    const loaded = await loadState(cwd);
    if (!loaded) {
      setState(getOrCreateState(cwd));
    }
    return undefined;
  });

  // System prompt injection
  pi.on("before_agent_start", async (event, _ctx) => {
    if (typeof event.model === "string" && event.model.length > 0) {
      currentSessionModel = event.model;
    }

    const state = getState();
    if (!state.initialized) {
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n## Swarm DAO\nThe swarm-dao extension is loaded (4-layer architecture: Governance → Intelligence → Control → Delivery). If this is your first run, execute `dao_setup` first, then `/dao` to verify setup.",
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
        daoContext += `\n  - #${p.id} "${p.title}" (${p.type}) (${p.status})`;
      }
    }
    daoContext += `\n- Config: quorum=${state.config.quorumPercent}%, approval=${state.config.approvalThreshold}%, risk=${state.config.riskThreshold}/10`;
    daoContext += `\n\nAvailable tools: dao_setup, dao_propose, dao_deliberate, dao_check, dao_plan, dao_execute, dao_ship, dao_audit, dao_artefacts, dao_verify, dao_rate, dao_dashboard, dao_dry_run, dao_rollback`;

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
    async execute(_id, params: DaoSetupParams) {
      const state = getState();
      if (state.initialized) {
        return toolResult(`DAO already initialized with ${state.agents.length} agents.`);
      }

      const agents = initializeAgents(params.useDefaults !== false ? undefined : []);
      state.agents = agents;
      state.initialized = true;
      await saveState();

      const table = agents.map((a) => `| ${a.name} | ${a.weight} | ${a.role} |`).join("\n");
      return toolResult(
        `# DAO Initialized\n\n| Agent | Weight | Role |\n|-------|--------|------|\n${table}\n\nRun \`dao_propose\` to create proposals.`,
      );
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
      affectedPaths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params: DaoProposeParams) {
      const state = getState();
      if (!state.initialized) return toolResult(PI_ONBOARDING_MESSAGE);

      const proposal = await createProposal(params.title, params.type, params.description, "user", params.context);
      if (params.problemStatement !== undefined) proposal.problemStatement = params.problemStatement;
      if (params.acceptanceCriteria !== undefined) proposal.acceptanceCriteria = params.acceptanceCriteria;
      if (params.successMetrics !== undefined) proposal.successMetrics = params.successMetrics;
      if (params.rollbackConditions !== undefined) proposal.rollbackConditions = params.rollbackConditions;
      if (params.affectedPaths !== undefined) proposal.affectedPaths = params.affectedPaths;

      const zone = classifyRiskZone(proposal);
      proposal.riskZone = zone;
      await saveState();

      await recordAudit(proposal.id, "governance", "proposal_created", "user", `Proposal "${params.title}" created`);
      await saveState();

      return toolResult(
        `# 📋 Proposal Created — #${proposal.id}\n\n**Title:** ${params.title}\n**Type:** ${PROPOSAL_TYPE_LABELS[params.type as ProposalType]}\n**Zone:** ${zone}\n\nRun \`dao_deliberate proposalId=${proposal.id}\` to deliberate.`,
      );
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
    async execute(_id, params: DaoDeliberateParams, _signal, onUpdate, ctx) {
      const state = getState();
      if (!state.initialized) return toolResult(PI_ONBOARDING_MESSAGE);

      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "open")
        return toolResult(`Proposal #${proposal.id} is ${proposal.status}, must be open.`);

      // Transition
      const transition = transitionProposal(proposal, "deliberate");
      if (!transition.success) return toolResult(`Cannot deliberate: ${transition.error}`);

      await recordAudit(proposal.id, "governance", "deliberation_started", "system", `Deliberation on #${proposal.id}`);
      await saveState();

      if (onUpdate) {
        onUpdate({ content: [{ type: "text", text: `🗳️ Deliberating proposal #${proposal.id}...` }], details: {} });
      }

      const startTime = Date.now();
      const adapter = createPiHostAdapter(pi, ctx);
      const projectConfig = await loadConfig(state.daoRoot);
      const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
      const modelContext = createDispatchModelContext(state.config.defaultModel, adapter);

      const outputs = await dispatchSwarm(
        proposal,
        agents,
        adapter,
        state.config.maxConcurrent,
        modelContext,
        (update) => {
          if (onUpdate) {
            onUpdate({
              content: [{ type: "text", text: `${update.agentName}: ${update.phase}` }],
              details: {},
            });
          }
        },
      );

      // Parse votes
      const votes: Vote[] = [];
      const persistedOutputs: AgentOutput[] = [];
      for (const output of outputs) {
        if (output.content) {
          const vote = parseVoteFromOutput(
            output.agentId,
            output.agentName,
            agents.find((a) => a.id === output.agentId)?.weight ?? 1,
            output.content,
          );
          if (vote) {
            vote.weight = agents.find((a) => a.id === output.agentId)?.weight ?? 1;
            votes.push(vote);
          }
        }
        persistedOutputs.push(output);
      }
      if (votes.length > 0 || persistedOutputs.length > 0) {
        await storeDeliberationBatch(proposal.id, votes, persistedOutputs);
      }
      proposal.votes = votes;

      // Composite score
      const compositeScore = calculateCompositeScore(outputs);
      proposal.compositeScore = compositeScore;
      await storeCompositeScore(proposal.id, compositeScore);

      // Synthesis
      const tally = tallyVotes(proposal, state.config);
      const synthesisText = synthesize(proposal, agents, outputs, tally);
      proposal.synthesis = synthesisText;
      await storeSynthesis(proposal.id, synthesisText);

      // Final transition
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

      const duration = Date.now() - startTime;
      return toolResult(
        `# 🗳️ Deliberation Complete — #${proposal.id} (${duration}ms)\n\n${formatTallyResult(tally)}\n\n${formatCompositeScore(compositeScore)}\n\n${synthesisText}\n\n> Next: \`dao_check proposalId=${proposal.id}\``,
      );
    },
  });

  // ── Tool: dao_check ──────────────────────────────────────
  pi.registerTool({
    name: "dao_check",
    label: "DAO Check",
    description: "Run quality control gates",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: DaoCheckParams) {
      const state = getState();
      if (!state.initialized) return toolResult(PI_ONBOARDING_MESSAGE);

      const proposal = getProposal(params.proposalId);
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "approved") return toolResult(`Must be approved (current: ${proposal.status})`);

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
        transitionProposal(proposal, "fail");
        await recordAudit(proposal.id, "control", "gates_failed", "system", `${result.blockerCount} blockers`);
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
    async execute(_id, params: DaoPlanParams) {
      const proposal = getProposal(params.proposalId);
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      const plan = getPlan(params.proposalId);
      if (!plan) {
        if (proposal.status === "open") {
          return toolResult(
            "Plan not available yet. Proposal must complete deliberation and gates first. Run `dao_deliberate` and `dao_check`.",
          );
        }
        if (proposal.status === "deliberating") {
          return toolResult(
            "Plan not available yet. Deliberation is still running. Run `dao_deliberate` to completion first.",
          );
        }
        if (proposal.status === "approved") {
          return toolResult("Plan not available yet. Proposal must pass gates first. Run `dao_check` to proceed.");
        }
        if (proposal.status === "controlled") {
          return toolResult("Plan should be available. If missing, run `dao_execute` to generate it.");
        }
        if (proposal.status === "rejected") {
          return toolResult("Proposal was rejected and cannot be executed.");
        }
        return toolResult("Plan not available for this proposal.");
      }
      return toolResult(formatPlan(plan));
    },
  });

  // ── Tool: dao_execute ────────────────────────────────────
  pi.registerTool({
    name: "dao_execute",
    label: "DAO Execute",
    description: "Execute a controlled proposal",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: DaoExecuteParams) {
      const _state = getState();
      const proposal = getProposal(params.proposalId);
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "controlled") {
        return toolResult(`Must be controlled (current: ${proposal.status}). Run dao_control first.`);
      }

      const result = await executeProposal(proposal);
      await saveState();

      await recordAudit(proposal.id, "delivery", "proposal_executed", "user", `Executed #${proposal.id}`);
      await saveState();

      return toolResult(result.result);
    },
  });

  // ── Tool: dao_ship ───────────────────────────────────────
  pi.registerTool({
    name: "dao_ship",
    label: "DAO Ship",
    description: "Ship a controlled proposal (optionally cascade dependencies)",
    parameters: Type.Object({
      proposalId: Type.Number(),
      cascade: Type.Optional(Type.Boolean()),
      force: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params: DaoShipParams) {
      const state = getState();
      if (!state.initialized) return toolResult(PI_ONBOARDING_MESSAGE);

      const proposal = getProposal(params.proposalId);
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);

      const cascade = params.cascade === true;
      const force = params.force === true;

      const shipOne = async (proposalId: number): Promise<string | null> => {
        const target = getProposal(proposalId);
        if (!target) return `Proposal #${proposalId} not found.`;
        if (target.status !== "controlled") {
          return `Proposal #${target.id} must be in 'controlled' state to ship (current: ${target.status})`;
        }

        const result = await executeProposal(target);
        if (!result.success) return result.result;

        await recordAudit(target.id, "delivery", "proposal-shipped", "pi", "shipped via dao_ship");
        return null;
      };

      const shipped: number[] = [];

      if (!force) {
        const depsResolution = getUnexecutedDependencies(proposal.id, state.proposals);
        if (depsResolution.error) return toolResult(depsResolution.error);
        const pendingDeps = depsResolution.order ?? [];

        if (pendingDeps.length > 0 && !cascade) {
          const lines = pendingDeps.map((depId) => {
            const dep = getProposal(depId);
            return dep ? `- #${dep.id} [${dep.status}] ${dep.title}` : `- #${depId} [missing]`;
          });
          return toolResult(
            `Cannot ship proposal #${proposal.id}: unexecuted dependencies found.\n\n${lines.join("\n")}\n\nRetry with \`dao_ship proposalId=${proposal.id} cascade=true\` or \`force=true\`.`,
          );
        }

        if (cascade && pendingDeps.length > 0) {
          const notControlled = pendingDeps.filter((depId) => getProposal(depId)?.status !== "controlled");
          if (notControlled.length > 0) {
            const details = notControlled
              .map((depId) => {
                const dep = getProposal(depId);
                return dep ? `#${dep.id} (${dep.status})` : `#${depId} (missing)`;
              })
              .join(", ");
            return toolResult(`Cannot cascade ship: dependencies not in 'controlled' state: ${details}`);
          }

          for (const depId of pendingDeps) {
            const dep = getProposal(depId);
            if (!dep || dep.status === "executed") continue;
            const depError = await shipOne(depId);
            if (depError) return toolResult(depError);
            shipped.push(depId);
          }
        }
      }

      const targetError = await shipOne(proposal.id);
      if (targetError) return toolResult(targetError);
      shipped.push(proposal.id);

      await saveState();

      const summary = shipped.map((id) => `- #${id}`).join("\n");
      return toolResult(`# 🚀 Ship Complete\n\nShipped proposals:\n${summary}`);
    },
  });

  // ── Tool: dao_audit ──────────────────────────────────────
  pi.registerTool({
    name: "dao_audit",
    label: "DAO Audit",
    description: "View audit trail",
    parameters: Type.Object({ proposalId: Type.Optional(Type.Number()) }),
    async execute(_id, params: DaoAuditParams) {
      const entries =
        params.proposalId !== undefined
          ? getAllAuditLog().filter((e) => e.proposalId === params.proposalId)
          : getAllAuditLog();
      return toolResult(formatAuditTrail(entries, params.proposalId));
    },
  });

  // ── Tool: dao_artefacts ─────────────────────────────────
  pi.registerTool({
    name: "dao_artefacts",
    label: "DAO Artefacts",
    description: "View auto-generated artefacts for a proposal",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: DaoArtefactsParams) {
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
    async execute(_id, params: DaoRateParams) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "executed")
        return toolResult(`Proposal #${proposal.id} is ${proposal.status}, must be executed.`);

      await addRating(proposal.id, {
        proposalId: proposal.id,
        rater: "user",
        score: Number(params.score) as 1 | 2 | 3 | 4 | 5,
        comment: params.comment,
        ratedAt: new Date().toISOString(),
      });
      await saveState();
      return toolResult(
        `# ⭐ Rating Recorded — #${proposal.id}\n\n**Score:** ${params.score}/5\n**Comment:** ${params.comment}`,
      );
    },
  });

  // ── Tool: dao_dashboard ──────────────────────────────────
  pi.registerTool({
    name: "dao_dashboard",
    label: "DAO Dashboard",
    description: "View outcome tracking dashboard",
    parameters: Type.Object({}),
    async execute(_id, _params: DaoDashboardParams) {
      const state = getState();
      if (!state.initialized) return toolResult(PI_ONBOARDING_MESSAGE);
      const dashboard = generateDashboard(state.proposals, state.outcomes, state.agents, state.healthSnapshots);
      const health = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
      return toolResult(`${dashboard}\n\n${formatHealthScore(health)}`);
    },
  });

  // ── Tool: dao_dry_run ────────────────────────────────────
  pi.registerTool({
    name: "dao_dry_run",
    label: "DAO Dry Run",
    description: "Preview execution without applying changes",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: DaoDryRunParams) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      const result = await performDryRun(proposal);
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
    async execute(_id, params: DaoRollbackParams) {
      const result = await performRollback(Number(params.proposalId));
      return toolResult(formatRollback(result));
    },
  });

  // ── Tool: dao_roundtable ─────────────────────────────────
  pi.registerTool({
    name: "dao_roundtable",
    label: "DAO Roundtable",
    description: "Ask every agent to suggest a proposal idea",
    parameters: Type.Object({}),
    async execute(_id, _params: DaoRoundtableParams, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state.initialized) return toolResult(PI_ONBOARDING_MESSAGE);

      const adapter = createPiHostAdapter(pi, ctx);
      const projectConfig = await loadConfig(state.daoRoot);
      const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
      const modelContext = createDispatchModelContext(state.config.defaultModel, adapter);
      const suggestions = await runRoundTable(adapter, agents, state.config.maxConcurrent, modelContext);

      // Create proposals from valid suggestions
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
    async execute(_id, params: DaoUpdateProposalParams) {
      const proposal = getProposal(Number(params.proposalId));
      if (!proposal) return toolResult(`Proposal #${params.proposalId} not found.`);
      if (proposal.status !== "open") return toolResult(`Must be open (current: ${proposal.status})`);

      if (params.problemStatement !== undefined) proposal.problemStatement = params.problemStatement;
      if (params.acceptanceCriteria !== undefined) proposal.acceptanceCriteria = params.acceptanceCriteria;
      if (params.successMetrics !== undefined) proposal.successMetrics = params.successMetrics;
      if (params.rollbackConditions !== undefined) proposal.rollbackConditions = params.rollbackConditions;

      await saveState();
      return toolResult(`# 📝 Proposal Updated — #${proposal.id}\n\nUpdated fields applied.`);
    },
  });

  // ── Command: /dao ────────────────────────────────────────
  pi.registerCommand("/dao", {
    description: "DAO command: dashboard, help, setup",
    handler: async (args, _ctx) => {
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
        return DAO_COMMAND_HELP;
      }

      let state: ReturnType<typeof getState>;
      try {
        state = getState();
      } catch {
        if (subcommand === "setup" || subcommand === "init") {
          const newState = getOrCreateState(process.cwd());
          const agents = initializeAgents();
          newState.agents = agents;
          newState.initialized = true;
          setState(newState);
          await saveState();
          return `# DAO Initialized\n\nAgents: ${agents.length}\nRun \`/dao status\` to view the dashboard.`;
        }
        return PI_ONBOARDING_MESSAGE;
      }

      if (!state.initialized) {
        if (subcommand === "setup" || subcommand === "init") {
          const agents = initializeAgents();
          state.agents = agents;
          state.initialized = true;
          await saveState();
          return `# DAO Initialized\n\nAgents: ${agents.length}\nRun \`/dao status\` to view the dashboard.`;
        }
        return PI_ONBOARDING_MESSAGE;
      }

      if (subcommand !== "" && subcommand !== "status" && subcommand !== "dashboard") {
        return `Unknown /dao subcommand: "${subcommand}".\n\nTry \`/dao help\`.`;
      }

      const byStatus: Record<string, number> = {};
      for (const p of state.proposals) {
        byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      }

      let output = `# Swarm DAO Dashboard\n`;
      output += `Agents: ${state.agents.length} | Proposals: ${state.proposals.length}\n`;
      for (const [status, count] of Object.entries(byStatus)) {
        output += `  ${status}: ${count}\n`;
      }
      return output.trim();
    },
  });
}
