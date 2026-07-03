import { loadConfig } from "../config.js";
import { formatAuditTrail } from "../control/audit.js";
import { formatControlResult, runGates } from "../control/gates.js";
import { formatAllArtefacts, generateAllArtefacts } from "../delivery/artefacts.js";
import { getUnexecutedDependencies } from "../delivery/dependencies.js";
import { formatDryRun, formatRollback, performDryRun, performRollback } from "../delivery/dry-run.js";
import { executeProposal } from "../delivery/execution.js";
import { formatPlan, generateDeliveryPlan, getPlan } from "../delivery/plans.js";
import { formatAgentsTable, initializeAgents, loadAgentDefinitions } from "../governance/agents.js";
import { validateAmendmentPayload } from "../governance/amendments.js";
import { classifyRiskZone, transitionProposal } from "../governance/lifecycle.js";
import { calculateCompositeScore, formatCompositeScore } from "../governance/scoring.js";
import { formatTallyResult, parseVoteFromOutput, tallyVotes } from "../governance/voting.js";
import { computeHealthScore, formatHealthScore, generateDashboard } from "../health-score.js";
import { ghBranchNameFor, ghCreateBranch, ghCreatePullRequest, isGitHubEnabled } from "../integrations/github.js";
import type { RoundTableSuggestion } from "../intelligence/roundtable.js";
import { formatRoundTableResults, runRoundTable } from "../intelligence/roundtable.js";
import {
  buildDispatchInstructions,
  createDispatchModelContext,
  dispatchSwarm,
  formatDispatchPlan,
} from "../intelligence/swarm.js";
import { synthesize } from "../intelligence/synthesis.js";
import {
  addRating,
  createProposal,
  createProposalsBatch,
  getAllAuditLog,
  getOrCreateState,
  getProposal,
  getState,
  initStorage,
  recordAudit,
  saveState,
  storeCompositeScore,
  storeDeliberationBatch,
  storeDeliveryPlan,
  storeSynthesis,
} from "../persistence.js";
import type { AgentOutput, AmendmentPayload, HostAdapter, ProposalType } from "../types/index.js";
import { PROPOSAL_TYPE_LABELS, PROPOSAL_TYPES } from "../types/index.js";
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
  onDeliberationProgress?: (update: { agentName: string; phase: string }) => void;
}

export interface RecordOutputInput {
  agentId: string;
  content: string;
  durationMs?: number;
  error?: string;
}

function requireInitialized(): string | null {
  const state = getState();
  if (!state.initialized) return DAO_ONBOARDING_MESSAGE;
  return null;
}

export async function handleDaoSetup(ctx: DaoToolContext, useDefaults = true): Promise<string> {
  await initStorage(ctx.workDir);
  const state = getOrCreateState(ctx.workDir);
  if (state.initialized) {
    return `DAO already initialized with ${state.agents.length} agents.`;
  }
  const agents = initializeAgents(useDefaults ? undefined : []);
  state.agents = agents;
  state.initialized = true;
  await saveState();
  return `# DAO Initialized\n\n${formatAgentsTable(agents)}\n\nRun \`dao_help\` to discover the workflow, then \`dao_propose\` to create proposals.`;
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

export async function handleDaoPropose(args: DaoProposeArgs): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const proposal = await createProposal(args.title, args.type, args.description, "user", args.context);
  if (args.problemStatement !== undefined) proposal.problemStatement = args.problemStatement;
  if (args.acceptanceCriteria !== undefined) proposal.acceptanceCriteria = args.acceptanceCriteria;
  if (args.successMetrics !== undefined) proposal.successMetrics = args.successMetrics;
  if (args.rollbackConditions !== undefined) proposal.rollbackConditions = args.rollbackConditions;
  if (args.affectedPaths !== undefined) proposal.affectedPaths = args.affectedPaths;
  proposal.riskZone = classifyRiskZone(proposal);
  await saveState();
  await recordAudit(proposal.id, "governance", "proposal_created", "user", `Proposal "${args.title}" created`);
  const typeLabel = PROPOSAL_TYPE_LABELS[args.type] ?? args.type;
  return `# 📋 Proposal Created — #${proposal.id}\n\n**Title:** ${args.title}\n**Type:** ${typeLabel}\n**Zone:** ${proposal.riskZone}\n\nRun \`dao_deliberate proposalId=${proposal.id}\``;
}

export async function handleDaoDeliberate(ctx: DaoToolContext, proposalId: number): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "open") return `Proposal #${proposal.id} is ${proposal.status}, must be open.`;
  const transition = transitionProposal(proposal, "deliberate");
  if (!transition.success) return `Cannot deliberate: ${transition.error}`;
  await recordAudit(proposal.id, "governance", "deliberation_started", "system", `Deliberation on #${proposal.id}`);
  await saveState();
  const projectConfig = await loadConfig(state.daoRoot);
  const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
  const modelContext = createDispatchModelContext(state.config.defaultModel, ctx.adapter, {
    parentSessionModel: ctx.getSessionModel?.(),
    hostDefaultModel: ctx.hostDefaultModel,
  });
  if (ctx.deliberationMode === "manual") {
    const instructions = buildDispatchInstructions(proposal, agents, modelContext);
    const plan = formatDispatchPlan(proposal, instructions);
    const parentModel = ctx.getSessionModel?.() ?? ctx.hostDefaultModel;
    const parentNote = parentModel ? `\n\n**Parent session model:** ${parentModel}` : "";
    return `${plan}${parentNote}`;
  }
  const startTime = Date.now();
  const outputs = await dispatchSwarm(
    proposal,
    agents,
    ctx.adapter,
    state.config.maxConcurrent,
    modelContext,
    (update) => ctx.onDeliberationProgress?.(update),
  );
  const votes = [];
  const persistedOutputs = [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  for (const output of outputs) {
    if (output.content) {
      const weight = agentById.get(output.agentId)?.weight ?? 1;
      const vote = parseVoteFromOutput(output.agentId, output.agentName, weight, output.content);
      if (vote) {
        vote.weight = weight;
        votes.push(vote);
      }
    }
    persistedOutputs.push(output);
  }
  if (votes.length > 0 || persistedOutputs.length > 0) {
    await storeDeliberationBatch(proposal.id, votes, persistedOutputs);
  }
  proposal.votes = votes;
  const compositeScore = calculateCompositeScore(outputs);
  proposal.compositeScore = compositeScore;
  await storeCompositeScore(proposal.id, compositeScore);
  const tally = tallyVotes(proposal, state.config);
  const synthesisText = synthesize(proposal, agents, outputs, tally);
  proposal.synthesis = synthesisText;
  await storeSynthesis(proposal.id, synthesisText);
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
  return `# 🗳️ Deliberation Complete — #${proposal.id} (${duration}ms)\n\n${formatTallyResult(tally)}\n\n${formatCompositeScore(compositeScore)}\n\n${synthesisText}\n\n> Next: \`${ctx.controlToolName} proposalId=${proposal.id}\``;
}

export async function handleDaoRecordOutputs(
  ctx: DaoToolContext,
  proposalId: number,
  outputs: RecordOutputInput[],
): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "deliberating") return `Expected deliberating (current: ${proposal.status})`;
  const votes = [];
  const enrichedOutputs = [];
  for (const raw of outputs) {
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
  return `# 🗳️ Deliberation Complete — #${proposal.id}\n\n${formatTallyResult(tally)}\n\n${formatCompositeScore(compositeScore)}\n\n${synthesisText}\n\n> Next: \`${ctx.controlToolName} proposalId=${proposal.id}\``;
}

export async function handleDaoControl(ctx: DaoToolContext, proposalId: number): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "approved") return `Must be approved (current: ${proposal.status})`;
  const result = runGates(proposal, state.config);
  if (result.allGatesPassed) {
    transitionProposal(proposal, "control");
    await recordAudit(proposal.id, "control", "gates_passed", "system", "All gates passed");
    if (!state.deliveryPlans[proposal.id]) {
      const plan = generateDeliveryPlan(proposal);
      await storeDeliveryPlan(proposal.id, plan);
    }
  } else {
    if (ctx.failOnGateFailure) {
      transitionProposal(proposal, "fail");
    }
    await recordAudit(proposal.id, "control", "gates_failed", "system", `${result.blockerCount} blockers`);
  }
  await saveState();
  return formatControlResult(result);
}

export async function handleDaoExecute(proposalId: number): Promise<string> {
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "controlled") {
    return `Must be controlled (current: ${proposal.status}). Run dao_control first.`;
  }
  const result = await executeProposal(proposal);
  await saveState();
  await recordAudit(proposal.id, "delivery", "proposal_executed", "user", `Executed #${proposal.id}`);
  return result.result;
}

export async function handleDaoShip(
  ctx: DaoToolContext,
  proposalId: number,
  options?: { cascade?: boolean; force?: boolean },
): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  const cascade = options?.cascade === true;
  const force = options?.force === true;
  const shipped: number[] = [];
  const shipOne = async (id: number): Promise<string | null> => {
    const target = getProposal(id);
    if (!target) return `Proposal #${id} not found.`;
    if (target.status !== "controlled") {
      return `Proposal #${target.id} must be in 'controlled' state to ship (current: ${target.status})`;
    }
    const result = await executeProposal(target);
    if (!result.success) return result.result;
    await recordAudit(target.id, "delivery", "proposal-shipped", ctx.adapter.hostId, "shipped via dao_ship");
    return null;
  };
  if (!force) {
    const depsResolution = getUnexecutedDependencies(proposal.id, state.proposals);
    if (depsResolution.error) return depsResolution.error;
    const pendingDeps = depsResolution.order ?? [];
    if (pendingDeps.length > 0 && !cascade) {
      const lines = pendingDeps.map((depId) => {
        const dep = getProposal(depId);
        return dep ? `- #${dep.id} [${dep.status}] ${dep.title}` : `- #${depId} [missing]`;
      });
      return `Cannot ship proposal #${proposal.id}: unexecuted dependencies found.\n\n${lines.join("\n")}\n\nRetry with \`dao_ship proposalId=${proposal.id} cascade=true\` or \`force=true\`.`;
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
        return `Cannot cascade ship: dependencies not in 'controlled' state: ${details}`;
      }
      for (const depId of pendingDeps) {
        const dep = getProposal(depId);
        if (!dep || dep.status === "executed") continue;
        const depError = await shipOne(depId);
        if (depError) return depError;
        shipped.push(depId);
      }
    }
  }
  const targetError = await shipOne(proposal.id);
  if (targetError) return targetError;
  shipped.push(proposal.id);
  await saveState();
  const summary = shipped.map((id) => `- #${id}`).join("\n");
  return `# 🚀 Ship Complete\n\nShipped proposals:\n${summary}`;
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

export async function handleDaoDryRun(proposalId: number): Promise<string> {
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  const result = await performDryRun(proposal);
  proposal.dryRunAt = new Date().toISOString();
  proposal.dryRunCanProceed = result.canProceed;
  await saveState();
  return formatDryRun(result);
}

export async function handleDaoRollback(proposalId: number): Promise<string> {
  return formatRollback(await performRollback(proposalId));
}

export async function handleDaoDashboard(): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  const dashboard = generateDashboard(state.proposals, state.outcomes, state.agents, state.healthSnapshots);
  const health = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
  return `${dashboard}\n\n${formatHealthScore(health)}`;
}

export async function handleDaoRoundtable(ctx: DaoToolContext): Promise<string> {
  const notReady = requireInitialized();
  if (notReady) return notReady;
  const state = getState();
  const projectConfig = await loadConfig(state.daoRoot);
  const agents = await loadAgentDefinitions(state.daoRoot, projectConfig);
  const modelContext = createDispatchModelContext(state.config.defaultModel, ctx.adapter, {
    parentSessionModel: ctx.getSessionModel?.(),
    hostDefaultModel: ctx.hostDefaultModel,
  });
  const suggestions = await runRoundTable(ctx.adapter, agents, state.config.maxConcurrent, modelContext);
  const proposalIds = new Map<string, number>();
  const parsedSuggestions = suggestions
    .map((suggestion) => ({ suggestion, parsed: suggestion.parsed }))
    .filter(
      (entry): entry is { suggestion: RoundTableSuggestion; parsed: NonNullable<RoundTableSuggestion["parsed"]> } =>
        Boolean(entry.parsed),
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
      state.auditLog.push({
        id: state.nextAuditId++,
        timestamp: new Date().toISOString(),
        proposalId: proposal.id,
        layer: "intelligence",
        action: "roundtable_proposal_created",
        actor: suggestion.agentId,
        details: "Auto-created from round table",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const { suggestion } of parsedSuggestions) {
      suggestion.error = `Failed to create proposal: ${message}`;
    }
  }
  await saveState();
  return formatRoundTableResults(suggestions, proposalIds);
}

export async function handleDaoAudit(proposalId?: number): Promise<string> {
  const entries = proposalId ? getAllAuditLog().filter((e) => e.proposalId === proposalId) : getAllAuditLog();
  return formatAuditTrail(entries, proposalId);
}

export async function handleDaoRate(proposalId: number, score: 1 | 2 | 3 | 4 | 5, comment: string): Promise<string> {
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "executed") return `Proposal #${proposal.id} is ${proposal.status}, must be executed.`;
  await addRating(proposal.id, {
    proposalId: proposal.id,
    rater: "user",
    score,
    comment,
    ratedAt: new Date().toISOString(),
  });
  await saveState();
  return `# ⭐ Rating Recorded — #${proposal.id}\n\n**Score:** ${score}/5\n**Comment:** ${comment}`;
}

export async function handleDaoUpdateProposal(
  proposalId: number,
  fields: {
    problemStatement?: string;
    acceptanceCriteria?: string[];
    successMetrics?: string[];
    rollbackConditions?: string[];
  },
): Promise<string> {
  const proposal = getProposal(proposalId);
  if (!proposal) return `Proposal #${proposalId} not found.`;
  if (proposal.status !== "open") return `Must be open (current: ${proposal.status})`;
  if (fields.problemStatement !== undefined) proposal.problemStatement = fields.problemStatement;
  if (fields.acceptanceCriteria !== undefined) proposal.acceptanceCriteria = fields.acceptanceCriteria;
  if (fields.successMetrics !== undefined) proposal.successMetrics = fields.successMetrics;
  if (fields.rollbackConditions !== undefined) proposal.rollbackConditions = fields.rollbackConditions;
  await saveState();
  return `# 📝 Proposal Updated — #${proposal.id}\n\nUpdated fields applied.`;
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

export async function handleDaoProposeAmendment(args: DaoAmendmentArgs): Promise<string> {
  const notReady = requireInitialized();
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
  const validation = validateAmendmentPayload(payload);
  if (!validation.valid) return `❌ Validation failed:\n${validation.errors.join("\n")}`;
  const proposal = await createProposal(args.title, "governance-change", args.description, "user");
  proposal.amendmentPayload = payload;
  proposal.amendmentOrigin = { source: "human" };
  proposal.amendmentState = "pending-vote";
  proposal.riskZone = classifyRiskZone(proposal);
  await saveState();
  await recordAudit(proposal.id, "governance", "amendment_proposed", "user", `Amendment: ${payload.type}`);
  return `# 📜 Amendment Proposed — #${proposal.id}\n\nType: ${payload.type}\n\nRun \`dao_deliberate proposalId=${proposal.id}\``;
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
