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

import {
  assertNoActiveSeriesForScope,
  isHumanChannelEvent,
  loadProjectImprovementConfig,
  ORCHESTRATOR_MIN_COOLDOWN_MS,
  type OrchestratorOnceDeps,
  OrchestratorRunner,
  resolveAnchorCommands,
  resolveSandboxRunCommand,
  type SandboxMode,
} from "@guyghost/swarm-dao-improvement";

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
  "status",
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
  attention: "  attention [--source <graph-engineering|improvement-loop|product-loop>,...]",
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

// ── Improve (continuous improvement series in any project) ──

const IMPROVE_SERIES_ROOT = ".dao/improvement-series";
const IMPROVE_CYCLE_ROOT = ".dao/improvement-cycles";

const IMPROVE_USAGE = `usage: swarm-dao improve <init|status|once|submit> [options]

  init   --series-id <id> --scope <s> --reference-hash <hash> [--cooldown-ms <ms>]
  status --series-id <id>
  once   --series-id <id> [--sandbox <docker|container|auto|none>] [--image <ref>]
                      [--cpus <n>] [--memory-mb <mb>]
  submit --series-id <id> --event <file.json>

Anchor commands come from .dao/improvement.json in the project (create it with
an 'anchorCommands' object binding the four command-backed anchors). Evidence
defaults to .dao/improvement-series and .dao/improvement-cycles.`;

const SANDBOX_MODES = new Set(["none", "docker", "container", "auto"]);

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

async function cmdImprove(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  const sub = positional[0];
  if (sub !== "init" && sub !== "status" && sub !== "once" && sub !== "submit") err(IMPROVE_USAGE);

  const seriesId = typeof flags["series-id"] === "string" ? flags["series-id"] : undefined;
  if (!seriesId) err(`--series-id is required\n${IMPROVE_USAGE}`);
  const evidenceRoot = path.resolve(
    cwd,
    typeof flags["evidence-root"] === "string" ? flags["evidence-root"] : IMPROVE_SERIES_ROOT,
  );

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
    return result.accepted ? 0 : 2;
  }

  if (sub === "status") {
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    info(JSON.stringify(runner.snapshot(), null, 2));
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

  // once — one authorized effect; anchor commands may run in a bounded sandbox.
  const config = await loadProjectImprovementConfig(cwd);
  const runCommand = await resolveSandboxRunCommand(sandboxRequestFrom(flags, config), cwd);
  const deps: OrchestratorOnceDeps = {
    workDir: cwd,
    cycleEvidenceRoot: path.resolve(cwd, IMPROVE_CYCLE_ROOT),
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
      case "status":
        await cmdStatus(cwd);
        return 0;
      case "improve":
        return await cmdImprove(cwd, positional, flags);
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
