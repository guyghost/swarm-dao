import { createExecutionWorkspace } from "../adapters/git-workspace.js";
import { LegacyDaoStateRepository } from "../adapters/persistence/legacy-dao-state.repository.js";
import { FsShipAuditStore } from "../adapters/ship-audit/fs-ship-audit.store.js";
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
import { evaluateShipAuditChallenge } from "../delivery/ship-audit.js";
import { formatAgentsTable, initializeAgents, loadAgentDefinitions } from "../governance/agents.js";
import { evaluateEditGate, formatEditGate } from "../governance/edit-gate.js";
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
    const plan = formatDispatchPlan(proposal, instructions, {
      strategy: projectConfig.deliberation?.strategy,
      charsPerAgent: projectConfig.deliberation?.charsPerAgent,
    });
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
    strategy: projectConfig.deliberation?.strategy,
    charsPerAgent: projectConfig.deliberation?.charsPerAgent,
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

export async function handleDaoExecute(ctx: DaoToolContext, proposalId: number): Promise<string> {
  const repository = repositoryOrLegacy(ctx.repository);
  const projectConfig = await loadConfig(repository.get().daoRoot);
  const workspace = createExecutionWorkspace(projectConfig.execution, ctx.adapter, ctx.workDir);
  const useCase = new ExecuteProposalUseCase({ repository, clock: systemClock, workspace });
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
  const repository = repositoryOrLegacy(ctx.repository);
  // Ship audit challenge (opt-in): the first call challenges instead of
  // executing; only an unchanged second call proceeds (models/ship-audit.md).
  const shipConfig = await loadConfig(repository.get().daoRoot);
  if (shipConfig.ship?.auditChallenge === true) {
    const proposal = repository.get().proposals.find((candidate) => candidate.id === proposalId);
    if (!proposal) return `Proposal #${proposalId} not found.`;
    const gate = await evaluateShipAuditChallenge({
      proposal,
      store: new FsShipAuditStore(ctx.workDir),
      challengeEnabled: true,
      force: options?.force === true,
      forceReason: options?.force === true ? "dao_ship force" : undefined,
      options: { cascade: options?.cascade === true },
    });
    if (!gate.proceed)
      return `# 🛑 Ship Audit — Do Not Proceed

${gate.message}

Force with an explicit reason when genuinely required: re-run with \`force=true\` (recorded as a human bypass).`;
    // Shipping executes controlled proposals, so it must honour the same
    // execution isolation as dao_execute — otherwise host shipping would
    // bypass a configured worktree.
    const workspace = createExecutionWorkspace(shipConfig.execution, ctx.adapter, ctx.workDir);
    const auditedUseCase = new ShipProposalUseCase({ repository, clock: systemClock, workspace });
    // The audited path: force means "bypass the audit challenge" ONLY —
    // dependency checks still run inside the use-case (review resolution:
    // the bypass satisfies INV-1, nothing else).
    const auditedResult = await auditedUseCase.execute({
      proposalId,
      actor: ctx.adapter.hostId,
      cascade: options?.cascade,
    });
    await gate.consume?.();
    if (!auditedResult.ok) return auditedResult.error;
    for (const id of auditedResult.shipped) {
      const shipped = repository.get().proposals.find((candidate) => candidate.id === id);
      if (shipped) recordProposalExecuted(shipped.id, shipped.type);
    }
    return `${presentShip(auditedResult)}${gate.note ? `\n\n*${gate.note}*` : ""}`;
  }
  // Shipping executes controlled proposals, so it must honour the same
  // execution isolation as dao_execute — otherwise host shipping would
  // bypass a configured worktree.
  const workspace = createExecutionWorkspace(shipConfig.execution, ctx.adapter, ctx.workDir);
  const useCase = new ShipProposalUseCase({ repository, clock: systemClock, workspace });
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

export async function handleDaoCheckEdit(ctx: DaoToolContext, paths: readonly string[]): Promise<string> {
  const repository = repositoryOrLegacy(ctx.repository);
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;

  const cleaned = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  // Refuse oversized requests outright: silently truncating could let a
  // protected file ride just past the cutoff and come back as allowed.
  if (cleaned.length > 200) {
    return `Too many paths provided (${cleaned.length}). Pass at most 200 paths per edit check.`;
  }
  if (cleaned.length === 0) return "No paths provided. Pass the files you are about to edit.";

  const state = repository.get();
  const projectConfig = await loadConfig(state.daoRoot);
  const decision = evaluateEditGate({
    paths: cleaned,
    mode: projectConfig.mode,
    criticalPaths: projectConfig.criticalPaths ?? [],
    approved: state.proposals.map((proposal) => ({
      proposalId: proposal.id,
      affectedPaths: proposal.affectedPaths,
      status: proposal.status,
    })),
  });
  return formatEditGate(decision);
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
  const dashboard = generateDashboard(
    state.proposals,
    state.outcomes,
    state.agents,
    state.healthSnapshots,
    state.config.healthWeights,
  );
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
  ctx: DaoToolContext,
  args: { token: string; owner: string; repo: string },
): Promise<string> {
  const state = repositoryOrLegacy(ctx.repository).get();
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

export async function handleDaoGithubCreateBranch(ctx: DaoToolContext, proposalId: number): Promise<string> {
  const repository = repositoryOrLegacy(ctx.repository);
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;
  const proposal = repository.get().proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  const configured = await loadGitHubConfigFromDaoRoot(repository.get().daoRoot);
  if (!configured || !isGitHubEnabled()) {
    return "GitHub not configured. Run `dao_config_github` with token, owner, and repo.";
  }
  const branchName = ghBranchNameFor(proposal);
  const result = await ghCreateBranch(branchName);
  if (!result) return "Failed to create branch (GitHub API returned null)";
  return `# Branch Created\n\n**Branch:** ${branchName}\n**SHA:** ${result.sha.slice(0, 7)}`;
}

export async function handleDaoGithubOpenPr(
  ctx: DaoToolContext,
  proposalId: number,
  headBranch: string,
): Promise<string> {
  const repository = repositoryOrLegacy(ctx.repository);
  const notReady = requireInitialized(ctx.repository);
  if (notReady) return notReady;
  const proposal = repository.get().proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (!headBranch) return "headBranch is required";
  const configured = await loadGitHubConfigFromDaoRoot(repository.get().daoRoot);
  if (!configured || !isGitHubEnabled()) {
    return "GitHub not configured. Run `dao_config_github` with token, owner, and repo.";
  }
  const result = await ghCreatePullRequest(proposal, { headBranch });
  if (!result) return "Failed to create PR (GitHub API returned null)";
  return `# PR Created\n\n**Number:** #${result.number}\n**URL:** ${result.url}`;
}

export { DAO_ONBOARDING_MESSAGE, PROPOSAL_TYPES };
