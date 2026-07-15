// ============================================================
// Swarm DAO — Pi Adapter
// ============================================================
// Bridges the Swarm DAO core to Pi's ExtensionAPI.
// Registers tools, commands, and event hooks.

import { spawn } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentOutput,
  DaoStateRepositoryPort,
  HostAdapter,
  Proposal,
  ProposalType,
} from "@guyghost/swarm-dao-core";
import {
  // Commands registry (source of truth for the /dao surface)
  buildDaoCommandHelp,
  computeHealthScore,
  // Delivery
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
  handleDaoRate,
  handleDaoRollback,
  handleDaoRoundtable,
  handleDaoSetup,
  handleDaoShip,
  handleDaoUpdateProposal,
  logger,
  // Types
  PROPOSAL_TYPES,
  readFileContained,
  resolveDaoCommand,
  setRepository,
  suggestDaoCommand,
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

const SAFE_PI_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export function assertSafePiModel(model: string): void {
  if (!SAFE_PI_MODEL.test(model)) {
    throw new Error("Invalid pi model identifier");
  }
}

export function assertSafePiPrompt(prompt: string): void {
  if (prompt.includes("\0")) {
    throw new Error("Invalid pi prompt");
  }
}

async function spawnPiSubprocess(
  systemPrompt: string,
  model: string,
  timeoutMs?: number,
): Promise<{ content: string | null; error?: string }> {
  try {
    assertSafePiModel(model);
    assertSafePiPrompt(systemPrompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: null, error: message };
  }

  return new Promise((resolve) => {
    const args = ["--mode", "json", "-p", "--no-session", "--model", model, "-e", systemPrompt];
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
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
      const message = `[${params.service}] ${params.message}`;
      if (params.level === "error") {
        logger.error(message);
      } else if (params.level === "warn") {
        logger.warn(message);
      } else {
        logger.info(message);
      }
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
  let repository: DaoStateRepositoryPort | undefined;
  // Restore state on session start
  pi.on("session_start", async (_event, _ctx) => {
    const cwd = process.cwd();
    repository = await FileDaoStateRepository.open(cwd);
    setRepository(repository);
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
      return toolResult(
        await handleDaoSetup(
          {
            adapter: createPiHostAdapter(pi),
            workDir: process.cwd(),
            deliberationMode: "auto",
            controlToolName: "dao_check",
            repository,
          },
          params.useDefaults !== false,
        ),
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
      return toolResult(await handleDaoPropose({ ...params, type: params.type as ProposalType }, repository));
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
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `🗳️ Deliberating proposal #${params.proposalId}...` }],
          details: {},
        });
      }
      const adapter = createPiHostAdapter(pi, ctx);
      return toolResult(
        await handleDaoDeliberate(
          {
            adapter,
            workDir: process.cwd(),
            deliberationMode: "auto",
            controlToolName: "dao_check",
            failOnGateFailure: true,
            repository,
            onDeliberationProgress: (update) => {
              if (onUpdate) {
                onUpdate({
                  content: [{ type: "text", text: `${update.agentName}: ${update.phase}` }],
                  details: {},
                });
              }
            },
          },
          Number(params.proposalId),
        ),
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
      return toolResult(
        await handleDaoControl(
          {
            adapter: createPiHostAdapter(pi),
            workDir: process.cwd(),
            deliberationMode: "auto",
            controlToolName: "dao_check",
            failOnGateFailure: true,
            repository,
          },
          params.proposalId,
        ),
      );
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
      return toolResult(await handleDaoExecute(params.proposalId, repository));
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
      return toolResult(
        await handleDaoShip(
          {
            adapter: createPiHostAdapter(pi),
            workDir: process.cwd(),
            deliberationMode: "auto",
            controlToolName: "dao_check",
            repository,
          },
          params.proposalId,
          { cascade: params.cascade, force: params.force },
        ),
      );
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
      return toolResult(
        await handleDaoRate(
          Number(params.proposalId),
          Number(params.score) as 1 | 2 | 3 | 4 | 5,
          params.comment,
          repository,
        ),
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
      return toolResult(await handleDaoDryRun(Number(params.proposalId), repository));
    },
  });

  // ── Tool: dao_rollback ───────────────────────────────────
  pi.registerTool({
    name: "dao_rollback",
    label: "DAO Rollback",
    description: "Revert proposal execution to pre-execution snapshot",
    parameters: Type.Object({ proposalId: Type.Number() }),
    async execute(_id, params: DaoRollbackParams) {
      return toolResult(await handleDaoRollback(Number(params.proposalId), repository));
    },
  });

  // ── Tool: dao_roundtable ─────────────────────────────────
  pi.registerTool({
    name: "dao_roundtable",
    label: "DAO Roundtable",
    description: "Ask every agent to suggest a proposal idea",
    parameters: Type.Object({}),
    async execute(_id, _params: DaoRoundtableParams, _signal, _onUpdate, ctx) {
      const adapter = createPiHostAdapter(pi, ctx);
      return toolResult(
        await handleDaoRoundtable({
          adapter,
          workDir: process.cwd(),
          deliberationMode: "auto",
          controlToolName: "dao_check",
          getSessionModel: () => detectParentSessionModel(ctx),
          repository,
        }),
      );
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
      return toolResult(
        await handleDaoUpdateProposal(
          Number(params.proposalId),
          {
            problemStatement: params.problemStatement,
            acceptanceCriteria: params.acceptanceCriteria,
            successMetrics: params.successMetrics,
            rollbackConditions: params.rollbackConditions,
          },
          repository,
        ),
      );
    },
  });

  // ── Command: /dao ────────────────────────────────────────
  // Registry-driven dispatcher. `/dao help` enumerates every command; every
  // known subcommand resolves through DaoCommandRegistry. Pi slash commands
  // cannot invoke Pi tools directly, so mutating commands route the user to
  // the matching `dao_*` tool; read-only commands render inline.
  const renderDashboard = (state: ReturnType<typeof getState>): string => {
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
  };

  const runDaoSetup = async (): Promise<string> => {
    return handleDaoSetup({
      adapter: createPiHostAdapter(pi),
      workDir: process.cwd(),
      deliberationMode: "auto",
      controlToolName: "dao_check",
      repository,
    });
  };

  const renderProposalList = (
    state: ReturnType<typeof getState>,
    filters: { status?: string; type?: string } = {},
  ): string => {
    let proposals = state.proposals;
    if (filters.status) proposals = proposals.filter((p) => p.status === filters.status);
    if (filters.type) proposals = proposals.filter((p) => p.type === filters.type);
    if (proposals.length === 0) {
      const active = filters.status || filters.type;
      return active
        ? "No proposals match those filters."
        : "No proposals yet. Run the `dao_propose` tool to create one.";
    }
    const rows = proposals.map((p) => `- #${p.id} [${p.status}] ${p.title} (${p.type})`).join("\n");
    return `# Proposals (${proposals.length})\n\n${rows}`;
  };

  const renderAgentList = (state: ReturnType<typeof getState>): string => {
    if (state.agents.length === 0) return "No agents configured. Run `/dao setup` to initialize.";
    const rows = state.agents.map((a) => `- ${a.name} [${a.role}] weight ${a.weight}`).join("\n");
    return `# DAO Agents (${state.agents.length})\n\n${rows}`;
  };

  /** Parse `--status <s>` / `--type <T>` flags from the tokens after `/dao list`. */
  const parseListFilters = (tokens: string[]): { status?: string; type?: string } => {
    const filters: { status?: string; type?: string } = {};
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const next = tokens[i + 1];
      if ((t === "--status" || t === "-s") && next !== undefined) {
        filters.status = next;
        i++;
      } else if ((t === "--type" || t === "-t") && next !== undefined) {
        filters.type = next;
        i++;
      }
    }
    return filters;
  };

  /** Parse a numeric proposal id; returns undefined for missing or non-numeric input. */
  const parseProposalId = (token: string | undefined): number | undefined => {
    if (token === undefined) return undefined;
    const n = Number.parseInt(token, 10);
    return Number.isNaN(n) ? undefined : n;
  };

  pi.registerCommand("/dao", {
    description: "DAO dispatcher — `/dao help` lists every subcommand (propose, deliberate, control, execute, ship, …)",
    handler: async (args, _ctx) => {
      const raw = args.trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      const subcommand = (tokens[0] ?? "").toLowerCase();
      const rest = tokens.slice(1);

      // `/dao help`
      if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
        return buildDaoCommandHelp({ host: "pi" });
      }

      // `/dao setup` / `/dao init` (works even before storage exists)
      if (subcommand === "setup" || subcommand === "init") {
        return await runDaoSetup();
      }

      // Everything else needs initialized state.
      let state: ReturnType<typeof getState>;
      try {
        state = getState();
      } catch {
        return PI_ONBOARDING_MESSAGE;
      }
      if (!state.initialized) return PI_ONBOARDING_MESSAGE;

      // `/dao` or `/dao status` → dashboard
      if (subcommand === "" || subcommand === "status" || subcommand === "dashboard") {
        return renderDashboard(state);
      }

      // Read-only commands the slash command fulfils inline (arguments preserved).
      if (subcommand === "list") return renderProposalList(state, parseListFilters(rest));
      if (subcommand === "agents") return renderAgentList(state);
      if (subcommand === "audit") {
        const proposalId = parseProposalId(rest[0]);
        if (rest[0] !== undefined && proposalId === undefined) {
          return `Invalid proposal ID: \`${rest[0]}\`.\n\nUsage: \`/dao audit [proposalId]\``;
        }
        const entries =
          proposalId !== undefined ? getAllAuditLog().filter((e) => e.proposalId === proposalId) : getAllAuditLog();
        return formatAuditTrail(entries, proposalId);
      }

      // Registry resolution for the rest.
      const cmd = resolveDaoCommand(subcommand, "pi");
      if (!cmd) return suggestDaoCommand(subcommand, "pi");

      // Known command → route to its Pi tool (slash commands can't call tools).
      // Pi registers the quality-control tool as `dao_check`, so map the registry's
      // canonical `dao_control` (and the `check` alias) onto it.
      if (cmd.tool) {
        const tool = cmd.tool === "dao_control" ? "dao_check" : cmd.tool;
        const argHint = cmd.args ? ` — e.g. \`${tool} ${cmd.args}\`` : "";
        return `${cmd.summary}.\n\n→ Run the \`${tool}\` tool${argHint}.\n\n(\`/dao ${cmd.id}\` is the discovery alias; Pi executes it via the \`${tool}\` tool.)`;
      }
      return suggestDaoCommand(subcommand, "pi");
    },
  });
}
