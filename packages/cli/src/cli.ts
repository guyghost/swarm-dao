#!/usr/bin/env bun

// ============================================================
// Swarm DAO — Standalone CLI
// ============================================================

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandRunnerPort, ProposalType, VotePosition } from "@guyghost/swarm-dao-core";
import {
  ATTENTION_SOURCES,
  type AttentionSource,
  addVote,
  CreateProposalUseCase,
  collectAttention,
  configureGitHub,
  createExecutionWorkspace,
  evaluateShipAuditChallenge,
  FileDaoStateRepository,
  FsAttentionStore,
  FsShipAuditStore,
  formatAttention,
  getAllAuditLog,
  getAuditLog,
  getDaoCommandsByPhase,
  getDaoRoot,
  getProposal,
  getState,
  ghBranchNameFor,
  ghCreateBranch,
  ghCreatePullRequest,
  initializeAgents,
  isGitHubEnabled,
  listProposals,
  loadConfig,
  PROPOSAL_TYPES,
  recordAudit,
  ShipProposalUseCase,
  saveState,
  setRepository,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { createGraphRunner } from "@guyghost/swarm-dao-graph";
import {
  assertNoActiveSeriesForScope,
  ensureSeriesWorktree,
  isHumanChannelEvent,
  loadProjectImprovementConfig,
  ORCHESTRATOR_MIN_COOLDOWN_MS,
  type OrchestratorOnceDeps,
  OrchestratorRunner,
  resolveAnchorCommands,
  resolveSandboxRunCommand,
  SAFE_HERDR_KIND,
  type SandboxMode,
} from "@guyghost/swarm-dao-improvement";
import { createProductRunner } from "@guyghost/swarm-dao-product";
import { cmdDoctor } from "./doctor.js";
import {
  cmdApprove,
  cmdImproveCancel,
  cmdImproveReference,
  cmdImproveRestart,
  cmdImproveRetry,
  cmdImproveRetryWorkers,
  cmdReject,
  GateError,
} from "./human-gates.js";
import { cmdNext } from "./next.js";
import {
  type CycleHistoryRow,
  type CycleStatusView,
  c,
  GLYPH,
  type GraphStatusView,
  renderCyclesTable,
  renderGraphStatus,
  renderSeriesStatus,
  type SeriesStatusView,
} from "./render.js";
import {
  CYCLE_ROOT_CANDIDATES,
  listCycleDirs,
  locateRoot,
  readJournalDurationMs,
  readJsonOrNull,
  SERIES_ROOT_CANDIDATES,
} from "./roots.js";

// ── Helpers ─────────────────────────────────────────────────

class CliError extends Error {}
function err(msg: string): never {
  throw new CliError(msg);
}
function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

const execAsync = promisify(exec);

/** CommandRunnerPort backed by the local shell, for git workspace effects. */
function cliRunner(): CommandRunnerPort {
  return {
    exec: async (command, options) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: options?.cwd,
          timeout: options?.timeout,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message ?? "command failed",
          exitCode: failure.code ?? 1,
        };
      }
    },
  };
}

function parseFlags(args: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function ensureLoaded(cwd: string): Promise<FileDaoStateRepository> {
  const repository = await FileDaoStateRepository.open(cwd);
  setRepository(repository);
  return repository;
}

// ── Commands ────────────────────────────────────────────────

/**
 * Commands the CLI actually implements, in the order they should appear in
 * `swarm-dao help`. The registry is the source of truth for each command's
 * summary and argument signature; this list only declares coverage so we never
 * advertise a command the CLI cannot run.
 */
const CLI_IMPLEMENTED = [
  "init",
  "setup",
  "propose",
  "list",
  "show",
  "vote",
  "ship",
  "github-config",
  "github-branch",
  "github-pr",
  "config",
  "audit",
  "attention",
  "next",
  "doctor",
  "approve",
  "reject",
  "status",
  "graph",
  "product",
  "improve",
  "help",
] as const;

/**
 * Rich, CLI-specific usage detail that the registry's one-line summary cannot
 * capture (flags, multi-line examples). Keyed by command id.
 */
const CLI_USAGE_DETAILS: Record<string, string> = {
  propose: "  propose --title <t> --type <T> --description <d> [--by <name>]\n        [--depends-on <id1,id2,...>]",
  list: "  list [--status <s>] [--type <T>]",
  show: "  show <id>",
  vote: "  vote <id> --position <for|against|abstain> --reasoning <text>\n        [--weight <n>] [--agent <name>]",
  ship: "  ship <id> [--cascade] [--force]",
  "github-config": "  github-config --token <t> --owner <o> --repo <r>",
  "github-branch": "  github-branch <proposal-id>",
  "github-pr": "  github-pr <proposal-id> --head-branch <b>",
  config: "  config",
  audit: "  audit [--proposal <id>]",
  attention: "  attention [--source <graph-engineering|improvement-loop|improvement-series|product-loop>,...]",
  next: "  next              what needs you now (human gates + live workflows)",
  doctor: "  doctor            environment & configuration diagnostic (runtime, agents, gates)",
  approve:
    "  approve --run-id <id> [--evidence-root <path>] [--yes]\n        approve the exact model hash of a graph run awaiting approval",
  reject: "  reject --run-id <id> --reason <text> [--yes]\n        send an awaiting model back to draft",
  graph:
    "  graph <init|status|submit> --run-id <id> [--evidence-root <path>]\n        graph submit --run-id <id> --signal <file.json>",
  product:
    "  product <init|status|submit> --run-id <id> [--evidence-root <path>]\n        product submit --run-id <id> --signal <file.json>",
  improve: `  improve init --series-id <id> --scope <s> --reference-hash <hash> [--cooldown-ms <ms>]
        improve status --series-id <id>
        improve once --series-id <id> [--sandbox <docker|container|auto|none>] [--image <img>]
        improve submit --series-id <id> --event <file>`,
};

/** All commands in the registry, grouped by phase, for lookup by id. */
const CLI_BY_PHASE = getDaoCommandsByPhase("cli");
const CLI_REGISTRY_INDEX = new Map(
  Object.values(CLI_BY_PHASE)
    .flat()
    .map((c) => [c.id, c]),
);

function buildCliHelp(): string {
  const lines: string[] = [
    "swarm-dao — DAO governance CLI",
    "",
    "Usage:",
    "  swarm-dao <command> [options]",
    "",
    "Commands:",
  ];
  for (const id of CLI_IMPLEMENTED) {
    const cmd = CLI_REGISTRY_INDEX.get(id);
    const summary = cmd?.summary ?? "";
    const detail = CLI_USAGE_DETAILS[id];
    if (detail) {
      lines.push(detail);
      if (summary) lines.push(`        ${summary}`);
    } else {
      const arg = cmd?.args ? ` ${cmd.args}` : "";
      lines.push(`  ${id}${arg}`);
      if (summary) lines.push(`        ${summary}`);
    }
  }
  lines.push(`\nProposal types: ${PROPOSAL_TYPES.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

const HELP = buildCliHelp();

async function cmdInit(cwd: string): Promise<void> {
  const root = getDaoRoot(cwd);
  setRepository(await FileDaoStateRepository.open(cwd));
  await saveState();
  info(`✓ DAO storage initialized at ${root}`);
}

async function cmdSetup(cwd: string): Promise<void> {
  await ensureLoaded(cwd);
  const state = getState();
  if (state.initialized) {
    info(`DAO already initialized with ${state.agents.length} agents.`);
    return;
  }
  const agents = initializeAgents();
  state.agents = agents;
  state.initialized = true;
  await saveState();
  info(`✓ DAO initialized with ${agents.length} agents`);
  for (const a of agents) {
    info(`  - ${a.name} (w=${a.weight}) — ${a.role}`);
  }
}

async function cmdPropose(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const title = typeof flags.title === "string" ? flags.title : "";
  const type = typeof flags.type === "string" ? flags.type : "";
  const description = typeof flags.description === "string" ? flags.description : "";
  const by = typeof flags.by === "string" ? flags.by : "cli";

  if (!title) err("--title is required");
  if (!type) err("--type is required");
  if (!description) err("--description is required");
  if (!PROPOSAL_TYPES.includes(type as ProposalType)) {
    err(`invalid --type '${type}'. Allowed: ${PROPOSAL_TYPES.join(", ")}`);
  }

  // Parse optional --depends-on flag (comma-separated proposal IDs)
  let dependsOn: number[] | undefined;
  if (typeof flags["depends-on"] === "string") {
    const raw = flags["depends-on"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    dependsOn = raw.map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) err(`invalid proposal id '${s}' in --depends-on`);
      return n;
    });
  }

  const repository = await ensureLoaded(cwd);
  const result = await new CreateProposalUseCase({
    repository,
    clock: systemClock,
  }).execute({
    title,
    type: type as ProposalType,
    description,
    proposedBy: by,
    dependsOn,
    auditAction: "proposal-created",
    auditDetails: `via cli: ${title}`,
  });
  if (!result.ok) {
    if (result.error.startsWith("Unknown proposal dependency #")) {
      err(`--depends-on references unknown proposal #${result.error.match(/#(\d+)/)?.[1] ?? "?"}`);
    }
    err(result.error);
  }
  const p = result.proposal;
  info(`✓ Proposal #${p.id} created (${p.status})`);
  info(`  ${p.title} | ${p.type}`);
  info(
    c.dim(
      `  → next: swarm-dao show ${p.id} · agents vote with: swarm-dao vote ${p.id} --position <for|against|abstain> --reasoning <text>`,
    ),
  );
  if (p.dependsOn && p.dependsOn.length > 0) {
    info(`  depends-on: #${p.dependsOn.join(", #")}`);
  }
}

async function cmdList(cwd: string, flags: Record<string, string | true>): Promise<void> {
  await ensureLoaded(cwd);
  let items = listProposals();
  if (typeof flags.status === "string") {
    items = items.filter((p) => p.status === flags.status);
  }
  if (typeof flags.type === "string") {
    items = items.filter((p) => p.type === flags.type);
  }
  if (items.length === 0) {
    info("(no proposals)");
    return;
  }
  for (const p of items) {
    const risk = p.riskZone ? ` [${p.riskZone}]` : "";
    info(`#${String(p.id).padStart(3)} [${p.status.padEnd(12)}] ${p.type.padEnd(18)}${risk}  ${p.title}`);
  }
}

async function cmdShow(cwd: string, positional: string[]): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao show <id>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid id '${idStr}'`);

  await ensureLoaded(cwd);
  const p = getProposal(id);
  if (!p) err(`proposal #${id} not found`);

  info(`Proposal #${p.id}: ${p.title}`);
  info(`  type:        ${p.type}`);
  info(`  status:      ${p.status}`);
  info(`  proposedBy:  ${p.proposedBy}`);
  info(`  riskZone:    ${p.riskZone ?? "(none)"}`);
  info(`  createdAt:   ${p.createdAt}`);
  if (p.resolvedAt) info(`  resolvedAt:  ${p.resolvedAt}`);
  info("");
  info("description:");
  info(`  ${p.description.replace(/\n/g, "\n  ")}`);
  if (p.problemStatement) {
    info("");
    info("problem statement:");
    info(`  ${p.problemStatement.replace(/\n/g, "\n  ")}`);
  }
  if (Array.isArray(p.acceptanceCriteria) && p.acceptanceCriteria.length > 0) {
    info("");
    info("acceptance criteria:");
    for (const ac of p.acceptanceCriteria) {
      info(`  - ${typeof ac === "string" ? ac : ac.id}`);
    }
  }
  if (p.votes.length) {
    info("");
    info(`votes (${p.votes.length}):`);
    for (const v of p.votes) {
      info(`  - ${v.agentName.padEnd(20)} ${v.position.padEnd(8)} (w=${v.weight})`);
    }
  }
}

async function cmdConfig(cwd: string): Promise<void> {
  await ensureLoaded(cwd);
  info(JSON.stringify(getState().config, null, 2));
}

async function cmdAudit(cwd: string, flags: Record<string, string | true>): Promise<void> {
  await ensureLoaded(cwd);
  const entries = typeof flags.proposal === "string" ? getAuditLog(Number(flags.proposal)) : getAllAuditLog();
  if (entries.length === 0) {
    info("(no audit entries)");
    return;
  }
  for (const e of entries) {
    info(`[${e.timestamp}] #${e.proposalId} ${e.layer.padEnd(12)} ${e.action.padEnd(20)} by ${e.actor}`);
    if (e.details) info(`    ${e.details}`);
  }
}

async function cmdAttention(cwd: string, flags: Record<string, string | true>): Promise<void> {
  let sources: readonly AttentionSource[] | undefined;
  if (typeof flags.source === "string") {
    const requested = flags.source
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = requested.filter((s) => !ATTENTION_SOURCES.includes(s as AttentionSource));
    if (invalid.length > 0) err(`invalid --source '${invalid.join(", ")}'. Allowed: ${ATTENTION_SOURCES.join(", ")}`);
    sources = requested as AttentionSource[];
  }

  const items = await collectAttention(new FsAttentionStore(cwd), sources);
  info(formatAttention(items));
  for (const item of items) {
    if (item.command) info(`  ${item.source}/${item.runId}: ${item.command}`);
  }
}

async function cmdStatus(cwd: string): Promise<void> {
  await ensureLoaded(cwd);
  const s = getState();
  const byStatus: Record<string, number> = {};
  for (const p of s.proposals) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  }
  info(`DAO root:        ${s.daoRoot}`);
  info(`initialized:     ${s.initialized}`);
  info(`agents:          ${s.agents.length}`);
  info(`proposals:       ${s.proposals.length}`);
  for (const [k, v] of Object.entries(byStatus)) {
    info(`  ${k.padEnd(14)} ${v}`);
  }
  info(`audit entries:   ${s.auditLog.length}`);
  info(`next proposal:   #${s.nextProposalId}`);
}

const POSITION_MAP: Record<string, VotePosition> = {
  approve: "for",
  reject: "against",
  for: "for",
  against: "against",
  abstain: "abstain",
};

async function cmdVote(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao vote <id> --position <for|against|abstain> --reasoning <text>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const positionRaw = typeof flags.position === "string" ? flags.position : "";
  if (!positionRaw) err("--position is required");

  const position = POSITION_MAP[positionRaw];
  if (!position) err(`invalid --position '${positionRaw}'`);

  const reasoning = typeof flags.reasoning === "string" ? flags.reasoning : "";
  if (!reasoning) err("--reasoning is required");

  const weight = typeof flags.weight === "string" ? Number(flags.weight) : 1;
  if (!Number.isFinite(weight) || weight <= 0) {
    err("--weight must be a positive number");
  }
  const agent = typeof flags.agent === "string" ? flags.agent : "cli-user";

  await ensureLoaded(cwd);
  const p = getProposal(id);
  if (!p) err(`proposal #${id} not found`);

  await addVote(id, { agentId: agent, agentName: agent, position, reasoning, weight });
  await recordAudit(id, "governance", "vote-cast", agent, `${position} (w=${weight}): ${reasoning}`);
  await saveState();
  info(`✓ Vote recorded for #${id}: ${positionRaw} by ${agent}`);
  info(c.dim(`  → next: swarm-dao show ${id} · ship when votes settle: swarm-dao ship ${id}`));
}

async function cmdShip(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao ship <id> [--cascade] [--force]");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const cascade = flags.cascade === true;
  const force = flags.force === true;

  const repository = await ensureLoaded(cwd);
  const projectConfig = await loadConfig(getDaoRoot(cwd));

  // Ship audit challenge (opt-in): first call challenges, unchanged second
  // call proceeds (models/ship-audit.md).
  let auditConsume: (() => Promise<void>) | undefined;
  if (projectConfig.ship?.auditChallenge === true) {
    const proposal = getProposal(id);
    if (!proposal) err(`proposal #${id} not found`);
    const gate = await evaluateShipAuditChallenge({
      proposal,
      store: new FsShipAuditStore(cwd),
      challengeEnabled: true,
      force,
      forceReason: force ? "swarm-dao ship --force" : undefined,
      options: { cascade },
    });
    if (!gate.proceed) {
      info(`🛑 Ship audit — do not proceed yet:\n\n${gate.message}`);
      info("\nRe-run the same command unchanged to confirm, or use --force (recorded bypass).");
      return;
    }
    auditConsume = gate.consume;
  }

  const workspace = createExecutionWorkspace(projectConfig.execution, cliRunner(), cwd);
  const result = await new ShipProposalUseCase({
    repository,
    clock: systemClock,
    workspace,
    // With the challenge enabled, force bypasses the audit ONLY —
    // dependency checks still run.
  }).execute({ proposalId: id, actor: "cli", cascade, force: auditConsume ? undefined : force });
  await auditConsume?.();
  if (!result.ok) {
    if (result.error.includes("unexecuted dependencies found")) {
      info(`Run with --cascade to ship all dependencies first:`);
      info(`  swarm-dao ship ${id} --cascade`);
      err("Dependencies not yet executed — use --cascade to ship in order");
    }
    err(result.error.replace("Cannot cascade ship:", "Cannot cascade:"));
  }
  for (const shippedId of result.shipped) {
    const proposal = getProposal(shippedId);
    info(`✓ Shipped #${shippedId}: ${proposal?.title ?? "proposal"}`);
  }
}

async function cmdGithubConfig(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const token = typeof flags.token === "string" ? flags.token : "";
  const owner = typeof flags.owner === "string" ? flags.owner : "";
  const repo = typeof flags.repo === "string" ? flags.repo : "";

  if (!token) err("--token is required");
  if (!owner) err("--owner is required");
  if (!repo) err("--repo is required");

  const githubConfig = { token, owner, repo, enabled: true };

  // Persist to .dao/config.json with token redacted
  const daoRoot = getDaoRoot(cwd);
  await fs.mkdir(daoRoot, { recursive: true });
  const configPath = path.join(daoRoot, "config.json");
  let configData: Record<string, unknown> = {};
  try {
    configData = JSON.parse(await fs.readFile(configPath, "utf-8"));
  } catch {
    /* no existing config */
  }
  configData.github = { ...githubConfig, token: "[REDACTED]" };
  await fs.writeFile(configPath, JSON.stringify(configData, null, 2), "utf-8");

  // Also configure in-memory for current process
  configureGitHub(githubConfig);
  info(`✓ GitHub config set: ${owner}/${repo}`);
  info("⚠️  Note: The token has been redacted in .dao/config.json for security.");
  info("   To avoid re-entering it, set the DAO_GITHUB_TOKEN environment variable.");
}

/**
 * Read GitHub config from .dao/config.json and configure the in-memory module.
 * Returns true if GitHub is configured, false otherwise.
 */
async function loadGitHubConfigFromStorage(cwd: string): Promise<boolean> {
  const daoRoot = getDaoRoot(cwd);
  const configPath = path.join(daoRoot, "config.json");
  try {
    const configData = JSON.parse(await fs.readFile(configPath, "utf-8"));
    const github = configData.github;
    if (github?.token && github?.owner && github?.repo) {
      configureGitHub({ ...github, enabled: true });
      return true;
    }
  } catch {
    /* no config file */
  }
  return false;
}

async function cmdGithubBranch(cwd: string, positional: string[]): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao github-branch <proposal-id>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  await ensureLoaded(cwd);
  const p = getProposal(id);
  if (!p) err(`proposal #${id} not found`);

  const configured = await loadGitHubConfigFromStorage(cwd);
  if (!configured || !isGitHubEnabled()) {
    err("GitHub not configured. Run: swarm-dao github-config --token <t> --owner <o> --repo <r>");
  }

  const branchName = ghBranchNameFor(p);
  const result = await ghCreateBranch(branchName);
  if (!result) err("failed to create branch (GitHub API returned null)");

  info(`✓ Branch created: ${branchName} (sha: ${result.sha.slice(0, 7)})`);
}

async function cmdGithubPr(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao github-pr <proposal-id> --head-branch <b>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const headBranch = typeof flags["head-branch"] === "string" ? flags["head-branch"] : "";
  if (!headBranch) err("--head-branch is required");

  await ensureLoaded(cwd);
  const p = getProposal(id);
  if (!p) err(`proposal #${id} not found`);

  const configured = await loadGitHubConfigFromStorage(cwd);
  if (!configured || !isGitHubEnabled()) {
    err("GitHub not configured. Run: swarm-dao github-config --token <t> --owner <o> --repo <r>");
  }

  const result = await ghCreatePullRequest(p, { headBranch });
  if (!result) err("failed to create PR (GitHub API returned null)");

  info(`✓ PR created: #${result.number} — ${result.url}`);
}

// ── Graph Engineering and Product loop runs (in any project) ──

const GRAPH_RUN_ROOT = ".dao/graph-runs";
const PRODUCT_RUN_ROOT = ".dao/product-loops";

const GRAPH_USAGE = `usage: swarm-dao graph <init|status|submit> [options]

  init   --run-id <id> [--evidence-root <path>]
  status --run-id <id> [--evidence-root <path>]
  submit --run-id <id> --signal <file.json> [--evidence-root <path>]

Graph runs live under .dao/graph-runs by default; override with --evidence-root
(repos carrying the frozen graph use evidence/graph-runs). Signals are
validated against the frozen Graph Engineering machine; human-source events
require explicit owner authorization (see models/graph-engineering.md).`;

const PRODUCT_USAGE = `usage: swarm-dao product <init|status|submit> [options]

  init   --run-id <id> [--evidence-root <path>]
  status --run-id <id> [--evidence-root <path>]
  submit --run-id <id> --signal <file.json> [--evidence-root <path>]

Product runs live under .dao/product-loops by default; override with
--evidence-root. Signals are validated against the frozen product-loop
machine (producer-bound authority; see models/product-loop.md).`;

interface RunCommandRunner {
  snapshot(): unknown;
  submit(input: unknown): Promise<{ accepted: boolean }>;
}

interface RunCommandSpec {
  defaultRoot: string;
  usage: string;
  create: (options: { evidenceRoot: string; runId: string }) => Promise<RunCommandRunner>;
  /** Extra effect on init (graph runs mark the active run). */
  onInit?: (evidenceRoot: string, runId: string) => Promise<void>;
  /** Human-readable status rendering; falls back to raw JSON when absent. */
  renderStatus?: (snapshot: Record<string, unknown>) => string[];
}

/** Shared init/status/submit body for graph and product runs: identical flag
 * handling, exit codes, and machine-only authority. */
async function cmdRunCommand(
  cwd: string,
  positional: string[],
  flags: Record<string, string | true>,
  spec: RunCommandSpec,
): Promise<number> {
  const sub = positional[0];
  if (sub !== "init" && sub !== "status" && sub !== "submit") err(spec.usage);

  const stringFlag = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const runId = stringFlag("run-id");
  if (!runId) err(`--run-id is required\n${spec.usage}`);
  const evidenceRoot = path.resolve(cwd, stringFlag("evidence-root") ?? spec.defaultRoot);

  const runner = await spec.create({ evidenceRoot, runId });

  if (sub === "init") {
    if (spec.onInit) await spec.onInit(evidenceRoot, runId);
    info(JSON.stringify(runner.snapshot(), null, 2));
    return 0;
  }
  if (sub === "status") {
    if (spec.renderStatus && flags.json !== true) {
      info(spec.renderStatus(runner.snapshot() as unknown as Record<string, unknown>).join("\n"));
    } else {
      info(JSON.stringify(runner.snapshot(), null, 2));
    }
    return 0;
  }

  const signalFile = stringFlag("signal");
  if (!signalFile) err(`--signal is required\n${spec.usage}`);
  const signal: unknown = JSON.parse(await fs.readFile(path.resolve(cwd, signalFile), "utf8"));
  const result = await runner.submit(signal);
  info(JSON.stringify(result, null, 2));
  return result.accepted ? 0 : 2;
}

const GRAPH_SPEC: RunCommandSpec = {
  defaultRoot: GRAPH_RUN_ROOT,
  usage: GRAPH_USAGE,
  create: createGraphRunner,
  onInit: async (evidenceRoot, runId) => {
    await fs.writeFile(path.join(evidenceRoot, "active-run.json"), `${JSON.stringify({ runId }, null, 2)}\n`, "utf8");
  },
  renderStatus: (snapshot) => {
    const context = (snapshot.context ?? {}) as Record<string, unknown>;
    const anchors = (context.anchors ?? {}) as Record<string, { status: string }>;
    const view: GraphStatusView = {
      runId: String(snapshot.runId ?? ""),
      state: String(snapshot.state ?? "unknown"),
      modelHash: typeof context.modelHash === "string" ? context.modelHash : null,
      approvedModelHash: typeof context.approvedModelHash === "string" ? context.approvedModelHash : null,
      implementationHash: typeof context.implementationHash === "string" ? context.implementationHash : null,
      anchors,
    };
    return renderGraphStatus(view);
  },
};

const PRODUCT_SPEC: RunCommandSpec = {
  defaultRoot: PRODUCT_RUN_ROOT,
  usage: PRODUCT_USAGE,
  create: createProductRunner,
};

function cmdGraph(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  return cmdRunCommand(cwd, positional, flags, GRAPH_SPEC);
}

function cmdProduct(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  return cmdRunCommand(cwd, positional, flags, PRODUCT_SPEC);
}

// ── Improve (continuous improvement series in any project) ──

const IMPROVE_SERIES_ROOT = ".dao/improvement-series";
const IMPROVE_CYCLE_ROOT = ".dao/improvement-cycles";

const IMPROVE_USAGE = `usage: swarm-dao improve <init|status|once|submit|cycles|retry|retry-workers|restart|cancel|reference> [options]

  init   --series-id <id> --scope <s> --reference-hash <hash> [--cooldown-ms <ms>]
  status --series-id <id> [--json]
  cycles --series-id <id> [--json]     cycle history for the series
  once   --series-id <id> [--exec <branch|worktree|container>]
                      [--sandbox <docker|container|auto|none>] [--image <ref>]
                      [--cpus <n>] [--memory-mb <mb>]
                      [--agent <kind>] [--agent-args "<args>"]
  submit --series-id <id> --event <file.json>
  human gates (--yes skips the prompt after review):
  retry          --cycle-id <id> | --series-id <id>    authorize a retrying cycle
  retry-workers  --series-id <id>                      after a worker failure
  restart        --series-id <id>                      restart a halted series
  cancel         --series-id <id> --reason <text>      terminal
  reference      --cycle-id <id> --decision approve|reject [--reason <text>]

Execution environments (--exec, default branch):
  branch    workers and anchors run in the current checkout
  worktree  idempotent git worktree per series (branch dao/loop/<series-id>,
            path .dao/worktrees/<series-id>); evidence stays in this repo
  container anchor commands run in a throwaway bounded container (workers are
            herdr agents on the host; --sandbox overrides the runtime choice)

Worker agents run in herdr: --agent selects the kind (pi, codex, claude, …;
  default pi or .dao/improvement.json "worker"). --agent-args overrides the
  kind's default extra arguments (pi defaults to "-ne").

Anchor commands come from .dao/improvement.json in the project (create it with
an 'anchorCommands' object binding the four command-backed anchors). Evidence
defaults to .dao/improvement-series and .dao/improvement-cycles; override with
--evidence-root and --cycle-root (repos carrying the frozen improvement graph
use evidence/ paths).`;

const SANDBOX_MODES = new Set(["none", "docker", "container", "auto"]);
const EXEC_MODES = new Set(["branch", "worktree", "container"]);

function sandboxRequestFrom(
  flags: Record<string, string | true>,
  config: { raw: Record<string, unknown> } | null,
): Parameters<typeof resolveSandboxRunCommand>[0] {
  // parseFlags yields boolean `true` for value-less flags; silently coercing
  // `--cpus` to Number(true) === 1 or `--sandbox` to auto-detection would hide
  // operator typos (Copilot review on #82). Every sandbox flag must carry an
  // explicit value.
  const stringFlag = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const numberFlag = (name: string): number | undefined => {
    const raw = stringFlag(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) err(`--${name} must be a number, got '${raw}'`);
    return parsed;
  };
  const configSandbox =
    config && typeof config.raw.sandbox === "object" && config.raw.sandbox !== null
      ? (config.raw.sandbox as Record<string, unknown>)
      : {};
  const configString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;

  const mode = stringFlag("sandbox") ?? configString(configSandbox.mode);
  if (mode !== undefined && !SANDBOX_MODES.has(mode)) {
    err(`--sandbox must be one of none|docker|container|auto, got '${mode}'`);
  }
  return {
    sandbox: mode as SandboxMode | undefined,
    image: stringFlag("image") ?? configString(configSandbox.image),
    cpus: numberFlag("cpus") ?? (typeof configSandbox.cpus === "number" ? configSandbox.cpus : undefined),
    memoryMb:
      numberFlag("memory-mb") ?? (typeof configSandbox.memoryMb === "number" ? configSandbox.memoryMb : undefined),
  };
}

/** herdr worker options (agent kind and extra args) from flags layered over
 * the optional `worker` section of .dao/improvement.json. Explicit flags win;
 * the kind must be a safe herdr identifier. */
function workerOptionsFrom(
  flags: Record<string, string | true>,
  config: { raw: Record<string, unknown> } | null,
): { kind?: string; agentArgs?: readonly string[] } {
  const stringFlag = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const configWorker =
    config && typeof config.raw.worker === "object" && config.raw.worker !== null
      ? (config.raw.worker as Record<string, unknown>)
      : {};
  const configKind =
    typeof configWorker.kind === "string" && configWorker.kind.trim().length > 0 ? configWorker.kind : undefined;
  const kind = stringFlag("agent") ?? configKind;
  if (kind !== undefined && !SAFE_HERDR_KIND.test(kind)) {
    err(`--agent must be a valid herdr agent kind (e.g. pi, codex, claude), got '${kind}'`);
  }
  const argsFlag = stringFlag("agent-args");
  const agentArgs =
    argsFlag !== undefined
      ? argsFlag.split(/\s+/).filter(Boolean)
      : Array.isArray(configWorker.agentArgs) && configWorker.agentArgs.every((a) => typeof a === "string")
        ? (configWorker.agentArgs as string[])
        : undefined;
  return { ...(kind !== undefined ? { kind } : {}), ...(agentArgs !== undefined ? { agentArgs } : {}) };
}

async function cmdImprove(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  const sub = positional[0];
  // Human-gate subs take --cycle-id or --series-id themselves; dispatch before
  // the shared --series-id requirement so `improve retry --cycle-id X` works.
  if (sub === "retry") return cmdImproveRetry(cwd, flags);
  if (sub === "retry-workers") return cmdImproveRetryWorkers(cwd, flags);
  if (sub === "restart") return cmdImproveRestart(cwd, flags);
  if (sub === "cancel") return cmdImproveCancel(cwd, flags);
  if (sub === "reference") return cmdImproveReference(cwd, flags);
  if (sub !== "init" && sub !== "status" && sub !== "once" && sub !== "submit" && sub !== "cycles") err(IMPROVE_USAGE);

  const seriesId = typeof flags["series-id"] === "string" ? flags["series-id"] : undefined;
  if (!seriesId) err(`--series-id is required\n${IMPROVE_USAGE}`);
  // Value-less root flags (parseFlags yields boolean true) must fail fast —
  // silently writing to the default root would hide operator typos
  // (Copilot review on #83), mirroring the sandbox flag validation.
  const rootFlag = (name: string, fallback: string): string => {
    const value = flags[name];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const rootFlagValue = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const evidenceRoot = path.resolve(cwd, rootFlag("evidence-root", IMPROVE_SERIES_ROOT));
  const cycleRoot = path.resolve(cwd, rootFlag("cycle-root", IMPROVE_CYCLE_ROOT));

  if (sub === "init") {
    // Grounding needs gates: refuse a series whose project has no anchor config.
    await resolveAnchorCommands(cwd);
    const scope = typeof flags.scope === "string" ? flags.scope : undefined;
    if (!scope) err(`--scope is required\n${IMPROVE_USAGE}`);
    const referenceHash = typeof flags["reference-hash"] === "string" ? flags["reference-hash"] : undefined;
    if (!referenceHash) err(`--reference-hash is required\n${IMPROVE_USAGE}`);
    const cooldownMs = flags["cooldown-ms"] !== undefined ? Number(flags["cooldown-ms"]) : 60_000;
    if (!Number.isInteger(cooldownMs) || cooldownMs < ORCHESTRATOR_MIN_COOLDOWN_MS) {
      err(`--cooldown-ms must be an integer >= ${ORCHESTRATOR_MIN_COOLDOWN_MS}\n${IMPROVE_USAGE}`);
    }
    await assertNoActiveSeriesForScope(evidenceRoot, scope, seriesId);
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    const result = await runner.submit({ type: "START_SERIES", source: "human", scope, referenceHash, cooldownMs });
    info(JSON.stringify(result.snapshot, null, 2));
    if (result.accepted)
      info(c.dim(`  → next: swarm-dao improve once --series-id ${seriesId} (drives one authorized step)`));
    return result.accepted ? 0 : 2;
  }

  if (sub === "status") {
    const located = await locateRoot(cwd, seriesId, SERIES_ROOT_CANDIDATES, rootFlagValue("evidence-root"));
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot: located.root });
    const snapshot = runner.snapshot();
    if (flags.json === true) {
      info(JSON.stringify(snapshot, null, 2));
      return 0;
    }
    const seriesView: SeriesStatusView = {
      seriesId: snapshot.seriesId,
      state: snapshot.state,
      scope: snapshot.context.scope,
      cycleSequence: snapshot.context.cycleSequence,
      activeCycleId: snapshot.context.improvementCycleId,
      cooldownEnteredAt: snapshot.cooldownEnteredAt,
      cooldownMs: snapshot.context.cooldownMs,
      terminalReason: snapshot.context.terminalReason,
    };
    let cycleView: CycleStatusView | null = null;
    if (seriesView.activeCycleId) {
      const cycleLocated = await locateRoot(
        cwd,
        seriesView.activeCycleId,
        CYCLE_ROOT_CANDIDATES,
        rootFlagValue("cycle-root"),
      );
      const raw = (await readJsonOrNull(path.join(cycleLocated.root, seriesView.activeCycleId, "snapshot.json"))) as {
        state?: string;
        context?: Record<string, unknown>;
      } | null;
      if (raw?.context) {
        const anchors = (raw.context.anchors ?? {}) as Record<string, { status: string; attempt: number }>;
        const metric = (raw.context.metric ?? {}) as { value?: string };
        cycleView = {
          cycleId: seriesView.activeCycleId,
          state: raw.state ?? "unknown",
          attempt: Number(raw.context.attempt ?? 0),
          maxRetries: Number(raw.context.maxRetries ?? 0),
          metricValue: typeof metric.value === "string" ? metric.value : null,
          driftClass: typeof raw.context.driftClass === "string" ? raw.context.driftClass : null,
          arbitration: typeof raw.context.arbitrationOutcome === "string" ? raw.context.arbitrationOutcome : null,
          anchors,
          terminalReason: typeof raw.context.terminalReason === "string" ? raw.context.terminalReason : null,
        };
      }
    }
    info(
      renderSeriesStatus(seriesView, cycleView, {
        now: Date.now(),
        found: located.found,
        triedRoots: located.tried,
      }).join("\n"),
    );
    return 0;
  }

  if (sub === "cycles") {
    // Cycle history lives beside the series evidence: derive the default
    // cycle root from where the series was actually found.
    const seriesLocated = await locateRoot(cwd, seriesId, SERIES_ROOT_CANDIDATES, rootFlagValue("evidence-root"));
    const defaultCycleRoot = seriesLocated.root.endsWith("evidence/improvement-series")
      ? "evidence/improvement-cycles"
      : ".dao/improvement-cycles";
    const cycleRoot = path.resolve(cwd, rootFlag("cycle-root", defaultCycleRoot));
    const rows: CycleHistoryRow[] = [];
    for (const { number, dir } of await listCycleDirs(cycleRoot, seriesId)) {
      const raw = (await readJsonOrNull(path.join(dir, "snapshot.json"))) as {
        cycleId?: string;
        state?: string;
        context?: Record<string, unknown>;
      } | null;
      if (!raw?.context) continue;
      const metric = (raw.context.metric ?? {}) as { value?: string };
      rows.push({
        number,
        cycleId: raw.cycleId ?? path.basename(dir),
        state: raw.state ?? "unknown",
        attempt: Number(raw.context.attempt ?? 0),
        metricValue: typeof metric.value === "string" ? metric.value : null,
        driftClass: typeof raw.context.driftClass === "string" ? raw.context.driftClass : null,
        arbitration: typeof raw.context.arbitrationOutcome === "string" ? raw.context.arbitrationOutcome : null,
        durationMs: await readJournalDurationMs(dir),
      });
    }
    if (flags.json === true) info(JSON.stringify(rows, null, 2));
    else info(renderCyclesTable(rows).join("\n"));
    return 0;
  }

  if (sub === "submit") {
    const eventFile = typeof flags.event === "string" ? flags.event : undefined;
    if (!eventFile) err(`--event is required\n${IMPROVE_USAGE}`);
    const event: unknown = JSON.parse(await fs.readFile(path.resolve(cwd, eventFile), "utf8"));
    if (!isHumanChannelEvent(event)) {
      err("submit only forwards human events (RETRY_WORKERS, RESTART_SERIES, CANCEL_SERIES with a non-empty reason)");
    }
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    const result = await runner.submit(event);
    info(JSON.stringify(result.snapshot, null, 2));
    return result.accepted ? 0 : 2;
  }

  // once — one authorized effect; the execution environment chooses where
  // workers observe and where anchor commands run.
  const config = await loadProjectImprovementConfig(cwd);
  const execFlag = flags.exec;
  // Value-less --exec must fail fast — silently running on the branch (or
  // auto-detecting) would hide operator typos (same policy as sandbox flags).
  if (execFlag !== undefined && (typeof execFlag !== "string" || execFlag.trim().length === 0)) {
    err("--exec requires a value");
  }
  const execMode = execFlag === undefined ? "branch" : (execFlag as string);
  if (!EXEC_MODES.has(execMode)) err(`--exec must be one of branch|worktree|container, got '${execMode}'`);

  let workDir = cwd;
  if (execMode === "worktree") {
    const worktree = await ensureSeriesWorktree({ repoDir: cwd, seriesId });
    workDir = worktree.path;
  }

  const sandboxRequest = sandboxRequestFrom(flags, config);
  if (execMode === "container" && sandboxRequest.sandbox === undefined) {
    sandboxRequest.sandbox = "auto";
  }
  const runCommand = await resolveSandboxRunCommand(sandboxRequest, workDir);
  const deps: OrchestratorOnceDeps = {
    workDir,
    cycleEvidenceRoot: cycleRoot,
    worker: workerOptionsFrom(flags, config),
    ...(runCommand ? { runCommand } : {}),
  };
  const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
  const result = await runner.once(deps);
  info(JSON.stringify(result, null, 2));
  return result.event && !result.accepted ? 2 : 0;
}

// ── CLI-local command suggestion ───────────────────────────

/**
 * Calculate Levenshtein distance between two strings.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Previous and current row for space-optimized DP
  let prev = Array(n + 1)
    .fill(0)
    .map((_, i) => i);
  let curr = Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] ?? 0;
      } else {
        const deleteCost = (prev[j] ?? 0) + 1;
        const insertCost = (curr[j - 1] ?? 0) + 1;
        const replaceCost = (prev[j - 1] ?? 0) + 1;
        curr[j] = Math.min(deleteCost, insertCost, replaceCost);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Find the closest CLI-implemented command to the given unknown token.
 * Returns a suggestion string or empty string if no good match exists.
 */
function suggestCliCommand(token: string): string {
  const normalized = token.toLowerCase().trim();
  const candidates: Array<{ id: string; distance: number }> = [];

  for (const id of CLI_IMPLEMENTED) {
    const dist = editDistance(normalized, id);
    // Only consider suggestions with distance <= 2 to avoid bad matches
    if (dist <= 2) {
      candidates.push({ id, distance: dist });
    }
  }

  if (candidates.length === 0) return "";

  // Sort by distance (closest first)
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best) return "";

  const cmd = CLI_REGISTRY_INDEX.get(best.id);
  const summary = cmd?.summary ?? "";
  return `Did you mean '${best.id}'? ${summary}`;
}

// ── Entry Point ─────────────────────────────────────────────

export async function main(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  // Per-command help: `<cmd> --help` (or -h) prints that command's usage.
  if (
    cmd !== undefined &&
    cmd !== "help" &&
    (CLI_IMPLEMENTED as readonly string[]).includes(cmd) &&
    (flags.help === true || flags.h === true)
  ) {
    const detail =
      cmd === "improve"
        ? IMPROVE_USAGE
        : cmd === "graph"
          ? GRAPH_USAGE
          : cmd === "product"
            ? PRODUCT_USAGE
            : CLI_USAGE_DETAILS[cmd];
    const summary = CLI_REGISTRY_INDEX.get(cmd)?.summary ?? "";
    process.stdout.write(`${detail ?? `  ${cmd}`}\n${summary ? `        ${summary}\n` : ""}`);
    return 0;
  }

  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        return 0;
      case "init":
        await cmdInit(cwd);
        return 0;
      case "setup":
        await cmdSetup(cwd);
        return 0;
      case "propose":
        await cmdPropose(cwd, flags);
        return 0;
      case "list":
        await cmdList(cwd, flags);
        return 0;
      case "show":
        await cmdShow(cwd, positional);
        return 0;
      case "config":
        await cmdConfig(cwd);
        return 0;
      case "audit":
        await cmdAudit(cwd, flags);
        return 0;
      case "attention":
        await cmdAttention(cwd, flags);
        return 0;
      case "next":
        return await cmdNext(cwd);
      case "doctor":
        return await cmdDoctor(cwd);
      case "approve":
        return await cmdApprove(cwd, flags);
      case "reject":
        return await cmdReject(cwd, flags);
      case "status":
        await cmdStatus(cwd);
        return 0;
      case "improve":
        return await cmdImprove(cwd, positional, flags);
      case "graph":
        return await cmdGraph(cwd, positional, flags);
      case "product":
        return await cmdProduct(cwd, positional, flags);
      case "vote":
        await cmdVote(cwd, positional, flags);
        return 0;
      case "ship":
        await cmdShip(cwd, positional, flags);
        return 0;
      case "github-config":
        await cmdGithubConfig(cwd, flags);
        return 0;
      case "github-branch":
        await cmdGithubBranch(cwd, positional);
        return 0;
      case "github-pr":
        await cmdGithubPr(cwd, positional, flags);
        return 0;
      default: {
        const suggestion = suggestCliCommand(String(cmd ?? ""));
        const suggestionText = suggestion ? `\n${suggestion}\n` : "";
        process.stderr.write(`unknown command: ${cmd}${suggestionText}\n\n${HELP}`);
        return 1;
      }
    }
  } catch (e: unknown) {
    if (e instanceof GateError) {
      process.stderr.write(`${GLYPH.fail} ${e.message}\n`);
      return 1;
    }
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

// Run when invoked directly
const isDirect = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return entry.endsWith("cli.ts") || entry.endsWith("cli.js") || entry.endsWith("/swarm-dao");
  } catch {
    return false;
  }
})();

if (isDirect) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
