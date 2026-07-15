import { LegacyDaoStateRepository } from "../adapters/persistence/legacy-dao-state.repository.js";
import { InitializeDaoUseCase } from "../application/initialize-dao.use-case.js";
import { ControlProposalUseCase } from "../application/proposals/control-proposal.use-case.js";
import { CreateAmendmentProposalUseCase } from "../application/proposals/create-amendment-proposal.use-case.js";
import { CreateProposalUseCase } from "../application/proposals/create-proposal.use-case.js";
import { DeliberateProposalUseCase } from "../application/proposals/deliberate-proposal.use-case.js";
import { DryRunProposalUseCase } from "../application/proposals/dry-run-proposal.use-case.js";
import { ExecuteProposalUseCase } from "../application/proposals/execute-proposal.use-case.js";
import { RateProposalUseCase } from "../application/proposals/rate-proposal.use-case.js";
import { RecordDeliberationOutputsUseCase } from "../application/proposals/record-deliberation-outputs.use-case.js";
import { RollbackProposalUseCase } from "../application/proposals/rollback-proposal.use-case.js";
import { RoundTableUseCase } from "../application/proposals/round-table.use-case.js";
import { ShipProposalUseCase } from "../application/proposals/ship-proposal.use-case.js";
import { StartDeliberationUseCase } from "../application/proposals/start-deliberation.use-case.js";
import { UpdateProposalUseCase } from "../application/proposals/update-proposal.use-case.js";
import { loadConfig } from "../config.js";
import { formatAuditTrail } from "../control/audit.js";
import { formatAllArtefacts, generateAllArtefacts } from "../delivery/artefacts.js";
import { formatPlan, getPlan } from "../delivery/plans.js";
import { formatAgentsTable, initializeAgents, loadAgentDefinitions } from "../governance/agents.js";
import { computeHealthScore, formatHealthScore, generateDashboard } from "../health-score.js";
import { ghBranchNameFor, ghCreateBranch, ghCreatePullRequest, isGitHubEnabled } from "../integrations/github.js";
import { formatRoundTableResults } from "../intelligence/roundtable.js";
import { buildDispatchInstructions, createDispatchModelContext, formatDispatchPlan } from "../intelligence/swarm.js";
import { recordProposalExecuted } from "../observability/metrics.js";
import { getAllAuditLog, getOrCreateState, getProposal, getState, initStorage } from "../persistence.js";
import { systemClock } from "../ports/clock.js";
import type { DaoStateRepositoryPort } from "../ports/repository.js";
import {
  presentAmendment,
  presentControl,
  presentDeliberation,
  presentDryRun,
  presentExecution,
  presentInitialization,
  presentProposalCreated,
  presentProposalUpdated,
  presentRating,
  presentRollback,
  presentShip,
} from "../presenters/proposal.presenter.js";
import type { AmendmentPayload, HostAdapter, ProposalType } from "../types/index.js";
import { PROPOSAL_TYPES } from "../types/index.js";
import { loadGitHubConfigFromDaoRoot, saveGitHubConfigToDaoRoot } from "./github-config.js";
import { DAO_ONBOARDING_MESSAGE } from "./messages.js";
import { parseSafeJson } from "./utils.js";

export type DeliberationMode = "auto" | "manual";
export type ControlToolName = "dao_check" | "dao_control";

export interface DaoToolContext {
  adapter: HostAdapter;
  workDir: string;
  deliberationMode: DeliberationMode;
  controlToolName: ControlToolName;
  /** Pi transitions to fail on gate failure; OpenCode/MCP do not */
  failOnGateFailure?: boolean;
  getSessionModel?: () => string | undefined;
  hostDefaultModel?: string | undefined;
  repository?: DaoStateRepositoryPort;
  onDeliberationProgress?: (update: { agentName: string; phase: string }) => void;
}

export interface RecordOutputInput {
  agentId: string;
  content: string;
  durationMs?: number;
  error?: string;
}

function repositoryOrLegacy(repository?: DaoStateRepositoryPort): DaoStateRepositoryPort {
  return repository ?? new LegacyDaoStateRepository();
}

function requireInitialized(repository?: DaoStateRepositoryPort): string | null {
  const state = repository ? repository.get() : getState();
  if (!state.initialized) return DAO_ONBOARDING_MESSAGE;
  return null;
}

export async function handleDaoSetup(ctx: DaoToolContext, useDefaults = true): Promise<string> {
  await initStorage(ctx.workDir);
  if (!ctx.repository) getOrCreateState(ctx.workDir);
  const agents = initializeAgents(useDefaults ? undefined : []);
  const result = await new InitializeDaoUseCase({ repository: repositoryOrLegacy(ctx.repository) }).execute({ agents });
  return presentInitialization(result);
}

export interface DaoProposeArgs {
  title: string;
  type: ProposalType;
  description: string;
  context?: string;
  problemStatement?: string;
  acceptanceCriteria?: string[];
  successMetrics?: string[];
  rollbackConditions?: string[];
  affectedPaths?: string[];
}

export async function handleDaoPropose(args: DaoProposeArgs, repository?: DaoStateRepositoryPort): Promise<string> {
  const useCase = new CreateProposalUseCase({ repository: repositoryOrLegacy(repository), clock: systemClock });
  const result = await useCase.execute({ ...args, proposedBy: "user" });
  if (!result.ok)
    return result.error === "DAO not initialized. Run dao_setup first." ? DAO_ONBOARDING_MESSAGE : result.error;
  return presentProposalCreated(result.proposal);
}

export async function handleDaoDeliberate(ctx: DaoToolContext, proposalId: number): Promise<string> {
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;
  const state = repositoryOrLegacy(ctx.repository).get();
  const proposal = state.proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "open") return `Proposal #${proposal.id} is ${proposal.status}, must be open.`;
  const projectConfig = await loadConfig(state.daoRoot);
  const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
  if (ctx.deliberationMode === "manual") {
    const deliberation = await new StartDeliberationUseCase({
      repository: repositoryOrLegacy(ctx.repository),
      clock: systemClock,
    }).execute({ proposalId });
    if (!deliberation.ok) return `Cannot deliberate: ${deliberation.error}`;
    const modelContext = createDispatchModelContext(state.config.defaultModel, ctx.adapter, {
      parentSessionModel: ctx.getSessionModel?.(),
      hostDefaultModel: ctx.hostDefaultModel,
    });
    const instructions = buildDispatchInstructions(proposal, agents, modelContext);
    const plan = formatDispatchPlan(proposal, instructions);
    const parentModel = ctx.getSessionModel?.() ?? ctx.hostDefaultModel;
    const parentNote = parentModel ? `\n\n**Parent session model:** ${parentModel}` : "";
    return `${plan}${parentNote}`;
  }
  const startTime = Date.now();
  const useCase = new DeliberateProposalUseCase({
    repository: repositoryOrLegacy(ctx.repository),
    worker: ctx.adapter,
    clock: systemClock,
  });
  const result = await useCase.execute({
    proposalId,
    agents,
    parentSessionModel: ctx.getSessionModel?.(),
    hostDefaultModel: ctx.hostDefaultModel,
    onUpdate: (update) => ctx.onDeliberationProgress?.(update),
  });
  if (!result.ok) return `Cannot deliberate: ${result.error}`;
  const duration = Date.now() - startTime;
  return presentDeliberation(proposal.id, result, { durationMs: duration, controlToolName: ctx.controlToolName });
}

export async function handleDaoRecordOutputs(
  ctx: DaoToolContext,
  proposalId: number,
  outputs: RecordOutputInput[],
): Promise<string> {
  const useCase = new RecordDeliberationOutputsUseCase({
    repository: repositoryOrLegacy(ctx.repository),
    clock: systemClock,
  });
  const result = await useCase.execute({ proposalId, outputs });
  if (!result.ok) return result.error;
  return presentDeliberation(proposalId, result, { controlToolName: ctx.controlToolName });
}

export async function handleDaoControl(ctx: DaoToolContext, proposalId: number): Promise<string> {
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;
  const useCase = new ControlProposalUseCase({ repository: repositoryOrLegacy(ctx.repository), clock: systemClock });
  const result = await useCase.execute({ proposalId, failOnGateFailure: ctx.failOnGateFailure });
  if (!result.ok) return result.error;
  return presentControl(result.control);
}

export async function handleDaoExecute(proposalId: number, repository?: DaoStateRepositoryPort): Promise<string> {
  const useCase = new ExecuteProposalUseCase({ repository: repositoryOrLegacy(repository), clock: systemClock });
  const result = await useCase.execute({ proposalId, actor: "user" });
  if (!result.ok) return result.error;
  recordProposalExecuted(result.proposal.id, result.proposal.type);
  return presentExecution(result);
}

export async function handleDaoShip(
  ctx: DaoToolContext,
  proposalId: number,
  options?: { cascade?: boolean; force?: boolean },
): Promise<string> {
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;
  const useCase = new ShipProposalUseCase({ repository: repositoryOrLegacy(ctx.repository), clock: systemClock });
  const result = await useCase.execute({
    proposalId,
    actor: ctx.adapter.hostId,
    cascade: options?.cascade,
    force: options?.force,
  });
  if (!result.ok) return result.error;
  for (const id of result.shipped) {
    const proposal = repositoryOrLegacy(ctx.repository)
      .get()
      .proposals.find((candidate) => candidate.id === id);
    if (proposal) recordProposalExecuted(proposal.id, proposal.type);
  }
  return presentShip(result);
}

export async function handleDaoList(): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  if (state.proposals.length === 0) return "No proposals yet.";
  let output = "# DAO Proposals\n\n";
  for (const p of state.proposals) {
    output += `## #${p.id}: ${p.title}\n${p.status} · ${p.type}\n\n`;
  }
  return output;
}

export async function handleDaoAgents(): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  return `# DAO Agents\n\n${formatAgentsTable(getState().agents)}`;
}

export async function handleDaoPlan(proposalId: number, controlToolName: ControlToolName): Promise<string> {
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  const plan = getPlan(proposalId);
  if (!plan) {
    if (proposal.status === "open") {
      return `Plan not available yet. Run \`dao_record_outputs\` (after starting deliberation with \`dao_propose\` and running deliberation), then \`${controlToolName}\`, to generate the plan.`;
    }
    if (proposal.status === "deliberating") {
      return "Plan not available yet. Deliberation is still running. Run `dao_record_outputs` to completion first.";
    }
    if (proposal.status === "approved") {
      return `Plan not available yet. Proposal must pass gates first. Run \`${controlToolName}\` to proceed.`;
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
}

export async function handleDaoArtefacts(proposalId: number): Promise<string> {
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  return formatAllArtefacts(generateAllArtefacts(proposal));
}

export async function handleDaoDryRun(proposalId: number, repository?: DaoStateRepositoryPort): Promise<string> {
  const result = await new DryRunProposalUseCase({
    repository: repositoryOrLegacy(repository),
    clock: systemClock,
  }).execute({ proposalId });
  return result.ok ? presentDryRun(result.analysis) : result.error;
}

export async function handleDaoRollback(proposalId: number, repository?: DaoStateRepositoryPort): Promise<string> {
  const result = await new RollbackProposalUseCase({ repository: repositoryOrLegacy(repository) }).execute({
    proposalId,
  });
  return presentRollback(result);
}

export async function handleDaoDashboard(repository?: DaoStateRepositoryPort): Promise<string> {
  const notReady = requireInitialized(repository);
  if (notReady) return notReady;
  const state = repositoryOrLegacy(repository).get();
  const dashboard = generateDashboard(state.proposals, state.outcomes, state.agents, state.healthSnapshots);
  const health = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
  return `${dashboard}\n\n${formatHealthScore(health)}`;
}

export async function handleDaoRoundtable(ctx: DaoToolContext): Promise<string> {
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;
  const state = getState();
  const projectConfig = await loadConfig(state.daoRoot);
  const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
  const result = await new RoundTableUseCase({
    repository: repositoryOrLegacy(ctx.repository),
    worker: ctx.adapter,
    clock: systemClock,
  }).execute({
    agents,
    parentSessionModel: ctx.getSessionModel?.(),
    hostDefaultModel: ctx.hostDefaultModel,
  });
  return result.ok ? formatRoundTableResults(result.suggestions, result.proposalIds) : result.error;
}

export async function handleDaoAudit(proposalId?: number): Promise<string> {
  const entries = proposalId ? getAllAuditLog().filter((e) => e.proposalId === proposalId) : getAllAuditLog();
  return formatAuditTrail(entries, proposalId);
}

export async function handleDaoRate(
  proposalId: number,
  score: 1 | 2 | 3 | 4 | 5,
  comment: string,
  repository?: DaoStateRepositoryPort,
): Promise<string> {
  const result = await new RateProposalUseCase({
    repository: repositoryOrLegacy(repository),
    clock: systemClock,
  }).execute({
    proposalId,
    rater: "user",
    score,
    comment,
  });
  return result.ok ? presentRating(result.rating) : result.error;
}

export async function handleDaoUpdateProposal(
  proposalId: number,
  fields: {
    problemStatement?: string;
    acceptanceCriteria?: string[];
    successMetrics?: string[];
    rollbackConditions?: string[];
  },
  repository?: DaoStateRepositoryPort,
): Promise<string> {
  const result = await new UpdateProposalUseCase({ repository: repositoryOrLegacy(repository) }).execute({
    proposalId,
    fields,
  });
  return result.ok ? presentProposalUpdated(result.proposal) : result.error;
}

export interface DaoAmendmentArgs {
  title: string;
  description: string;
  amendmentType: AmendmentPayload["type"] extends infer T ? T : never;
  agentId?: string;
  agentChanges?: string;
  newAgentId?: string;
  newAgentName?: string;
  newAgentRole?: string;
  newAgentWeight?: number;
  configChanges?: string;
  quorumChanges?: string;
  addGates?: string[];
  removeGates?: string[];
}

export async function handleDaoProposeAmendment(
  args: DaoAmendmentArgs,
  repository?: DaoStateRepositoryPort,
): Promise<string> {
  const notReady = requireInitialized(repository);
  if (notReady) return notReady;
  let payload: AmendmentPayload | undefined;
  try {
    switch (args.amendmentType) {
      case "agent-update":
        payload = {
          type: "agent-update",
          agentId: args.agentId ?? "",
          changes: parseSafeJson(args.agentChanges ?? "{}", "agentChanges"),
        };
        break;
      case "agent-add":
        payload = {
          type: "agent-add",
          agent: {
            id: args.newAgentId ?? "",
            name: args.newAgentName ?? "",
            role: args.newAgentRole ?? "",
            weight: args.newAgentWeight ?? 1,
            description: "Custom agent",
            systemPrompt: "",
          },
        };
        break;
      case "agent-remove":
        payload = { type: "agent-remove", agentId: args.agentId ?? "" };
        break;
      case "config-update":
        payload = { type: "config-update", changes: parseSafeJson(args.configChanges ?? "{}", "configChanges") };
        break;
      case "quorum-update":
        payload = { type: "quorum-update", typeQuorum: parseSafeJson(args.quorumChanges ?? "{}", "quorumChanges") };
        break;
      case "gate-update":
        payload = { type: "gate-update", addGates: args.addGates, removeGates: args.removeGates };
        break;
      default:
        return `Error: Unknown amendment type "${String(args.amendmentType)}"`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!payload) return "Error: amendment payload could not be constructed";
  const result = await new CreateAmendmentProposalUseCase({
    repository: repositoryOrLegacy(repository),
    clock: systemClock,
  }).execute({ title: args.title, description: args.description, payload, proposedBy: "user" });
  if (!result.ok) return `❌ ${result.error}`;
  return presentAmendment(result);
}

export async function handleDaoConfigGithub(
  _ctx: DaoToolContext,
  args: { token: string; owner: string; repo: string },
): Promise<string> {
  const state = getState();
  await saveGitHubConfigToDaoRoot(state.daoRoot, args);
  return [
    `# GitHub Configured`,
    "",
    `**Repository:** ${args.owner}/${args.repo}`,
    "",
    "Token redacted in `.dao/config.json`. Set `DAO_GITHUB_TOKEN` env var to avoid re-entering it.",
    "",
    "Available: `dao_github_create_branch`, `dao_github_open_pr`",
  ].join("\n");
}

export async function handleDaoGithubCreateBranch(_ctx: DaoToolContext, proposalId: number): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  const configured = await loadGitHubConfigFromDaoRoot(getState().daoRoot);
  if (!configured || !isGitHubEnabled()) {
    return "GitHub not configured. Run `dao_config_github` with token, owner, and repo.";
  }
  const branchName = ghBranchNameFor(proposal);
  const result = await ghCreateBranch(branchName);
  if (!result) return "Failed to create branch (GitHub API returned null)";
  return `# Branch Created\n\n**Branch:** ${branchName}\n**SHA:** ${result.sha.slice(0, 7)}`;
}

export async function handleDaoGithubOpenPr(
  _ctx: DaoToolContext,
  proposalId: number,
  headBranch: string,
): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (!headBranch) return "headBranch is required";
  const configured = await loadGitHubConfigFromDaoRoot(getState().daoRoot);
  if (!configured || !isGitHubEnabled()) {
    return "GitHub not configured. Run `dao_config_github` with token, owner, and repo.";
  }
  const result = await ghCreatePullRequest(proposal, { headBranch });
  if (!result) return "Failed to create PR (GitHub API returned null)";
  return `# PR Created\n\n**Number:** #${result.number}\n**URL:** ${result.url}`;
}

export { DAO_ONBOARDING_MESSAGE, PROPOSAL_TYPES };
