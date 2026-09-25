#!/usr/bin/env node

// ============================================================
// Swarm DAO — Standalone CLI
// ============================================================

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentOutput,
  CommandRunnerPort,
  DAOAgent,
  HostAdapter,
  Proposal,
  ProposalType,
  ToolCheckStatus,
  ToolEvidence,
  VotePosition,
} from "@guyghost/swarm-dao-core";
import {
  ATTENTION_SOURCES,
  type AttentionSource,
  addVoteOn,
  ControlProposalUseCase,
  CreateProposalUseCase,
  collectAttention,
  configureGitHub,
  createExecutionWorkspace,
  DryRunProposalUseCase,
  evaluateShipAuditChallenge,
  execCommand,
  FileDaoStateRepository,
  FsAttentionStore,
  FsShipAuditStore,
  formatAttention,
  formatControlResult,
  gcDaoHome,
  getAllAuditLogFrom,
  getAuditLogFrom,
  getDaoCommandsByPhase,
  getOutcomeFrom,
  getProposalFrom,
  ghBranchNameFor,
  ghCreateBranch,
  ghCreatePullRequest,
  handleDaoDeliberate,
  handleDaoRoundtable,
  initializeAgents,
  isGitHubEnabled,
  listProposalsFrom,
  loadAgentDefinitions,
  loadConfig,
  migrateDaoToHome,
  PROPOSAL_TYPES,
  presentDryRun,
  RateProposalUseCase,
  REQUIRED_GRAPH_ANCHORS,
  RejectProposalUseCase,
  recordAuditOn,
  resolveConfigFilePath,
  resolveDaoLayout,
  ShipProposalUseCase,
  systemClock,
  upgradeConfig,
} from "@guyghost/swarm-dao-core";
import { createGraphRunner, runGraphImplementing } from "@guyghost/swarm-dao-graph";
import { createHerdrHostAdapter, herdrAgentName } from "@guyghost/swarm-dao-herdr-adapter";
import {
  assertNoActiveSeriesForScope,
  ensureSeriesWorktree,
  isHumanChannelEvent,
  loadProjectImprovementConfig,
  ORCHESTRATOR_MIN_COOLDOWN_MS,
  type OrchestratorOnceDeps,
  OrchestratorRunner,
  type ProjectImprovementConfig,
  resolveAnchorCommands,
  type resolveSandboxRunCommand,
  SAFE_HERDR_KIND,
  type SandboxMode,
  sandboxAnchorRunner,
  type WorkerExecutionOptions,
  workerOptionsFromConfig,
} from "@guyghost/swarm-dao-improvement";
import { createProductRunner } from "@guyghost/swarm-dao-product";
import {
  advanceDeliveryOnce,
  createDeliveryRunner,
  createLocalStagingTarget,
  createStagingObservationSamples,
  type DeliveryCommandDependencies,
  type DeliveryCommandRoots,
  type DeliveryExecutorPorts,
  type DeliveryReconciliation,
  type DeliveryScorecardEntry,
  openGraphChild,
  openProductChild,
  runDeliveryCommand,
  submitGraphChildSignal,
  submitProductChildSignal,
} from "@guyghost/swarm-dao-software-delivery";
import { createTmuxHostAdapter } from "@guyghost/swarm-dao-tmux-adapter";
import { cmdDoctor } from "./doctor.js";
import { type ChildHost, childSessionName, detectHostSession, type HostSession } from "./environment.js";
import {
  cmdApprove,
  cmdImproveCancel,
  cmdImproveCancelCycle,
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
import { cmdWatch } from "./watch.js";

// ── Helpers ─────────────────────────────────────────────────

class CliError extends Error {}
function err(msg: string): never {
  throw new CliError(msg);
}
function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/** CommandRunnerPort backed by the core shell-free execCommand, for git
 * workspace effects. execCommand filters shell metacharacters and spawns
 * with shell: false, so the CLI host is no longer the injectable odd one
 * out (issue #165). */
function cliRunner(): CommandRunnerPort {
  return {
    exec: (command, options) => execCommand(command, { cwd: options?.cwd, timeout: options?.timeout }),
  };
}

function parseFlags(args: string[]): {
  flags: Record<string, string | true>;
  positional: string[];
  /** Every string-valued occurrence per flag, in order. `flags` keeps
   * last-wins for compatibility; repeatable flags (e.g. --acceptance-criteria)
   * read their full list from here. */
  repeated: Record<string, string[]>;
} {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const repeated: Record<string, string[]> = {};
  const record = (name: string, value: string): void => {
    const existing = repeated[name];
    if (existing === undefined) repeated[name] = [value];
    else existing.push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        record(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          record(a.slice(2), next);
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, repeated };
}

async function ensureLoaded(cwd: string): Promise<FileDaoStateRepository> {
  return FileDaoStateRepository.open(cwd);
}

// ── Child sessions (parent = this CLI, children = one workspace/session per agent) ──

/**
 * Every multi-agent CLI flow (deliberate, roundtable, implement) spawns its
 * agents as REAL coding agents in child sessions: this CLI process is the
 * parent session that pilots the children. The operator can attach to any
 * child live while it runs.
 *
 * The host follows the detected terminal multiplexer (--host auto, the
 * default): inside a herdr pane children are herdr workspaces, inside tmux
 * they are tmux sessions running the operator-owned tmux.command; a bare
 * shell falls back to herdr. Explicit --host wins.
 */
interface ChildSessionOptions {
  host: ChildHost;
  detected: HostSession;
  /** herdr only: agent kind (pi, claude, codex, …). */
  kind: string;
  /** herdr keepPanes / tmux keepSessions (the --keep-panes flag maps to both). */
  keepPanes: boolean;
  timeoutMs?: number;
  /** Operator-owned tmux agent command (required for the tmux host). */
  tmuxCommand?: string;
  /** tmux only: per-agent command overrides (tmux.agentCommands). */
  tmuxAgentCommands?: Record<string, string>;
  /** herdr only: per-harness model flag overrides (runtime.harnessModelFlag). */
  harnessModelFlag?: Record<string, string>;
}

function childSessionOptionsFrom(
  flags: Record<string, string | true>,
  projectConfig: {
    herdr?: { kind?: string; keepPanes?: boolean; timeoutMs?: number };
    tmux?: { command?: string; keepSessions?: boolean; timeoutMs?: number; agentCommands?: Record<string, string> };
    runtime?: { defaultHarness?: string; harnessModelFlag?: Record<string, string> };
  },
): ChildSessionOptions {
  const hostFlag = flags.host;
  if (hostFlag !== undefined && (typeof hostFlag !== "string" || hostFlag.trim().length === 0)) {
    err("--host requires a value (herdr, tmux or auto)");
  }
  const requested = typeof hostFlag === "string" ? hostFlag.trim() : "auto";
  if (requested !== "herdr" && requested !== "tmux" && requested !== "auto") {
    err(`--host must be herdr, tmux or auto, got '${requested}'`);
  }

  const detected = detectHostSession();
  const host: ChildHost = requested === "auto" ? (detected === "tmux" ? "tmux" : "herdr") : requested;
  const herdrConfig = projectConfig.herdr ?? {};
  const tmuxConfig = projectConfig.tmux ?? {};
  const timeoutMs = childTimeoutFrom(flags, host === "tmux" ? tmuxConfig.timeoutMs : herdrConfig.timeoutMs);
  const keepPanes = flags["keep-panes"] === true;

  if (host === "herdr") {
    const kindFlag = flags.kind;
    if (kindFlag !== undefined && (typeof kindFlag !== "string" || kindFlag.trim().length === 0)) {
      err("--kind requires a value (a herdr agent kind, e.g. pi, codex, claude)");
    }
    // Fallback chain: --kind flag → herdr.kind → runtime.defaultHarness → pi.
    const kind =
      (typeof kindFlag === "string" ? kindFlag.trim() : undefined) ??
      herdrConfig.kind ??
      projectConfig.runtime?.defaultHarness ??
      "pi";
    if (!SAFE_HERDR_KIND.test(kind)) {
      err(`herdr kind '${kind}' is invalid — use a supported herdr agent kind (e.g. pi, codex, claude)`);
    }
    return {
      host,
      detected,
      kind,
      keepPanes: keepPanes || herdrConfig.keepPanes === true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(projectConfig.runtime?.harnessModelFlag ? { harnessModelFlag: projectConfig.runtime.harnessModelFlag } : {}),
    };
  }

  if (flags.kind !== undefined) {
    err("--kind applies to the herdr host — tmux children run the configured tmux.command");
  }
  const tmuxCommand = typeof tmuxConfig.command === "string" ? tmuxConfig.command.trim() : "";
  if (tmuxCommand.length === 0) {
    err(
      'tmux children need an agent command: set { "tmux": { "command": "your-agent-cli \\"$PROMPT\\"" } } in .dao/config.json ($PROMPT carries the deliberation prompt), or run inside a herdr session / pass --host herdr.',
    );
  }
  return {
    host,
    detected,
    kind: "",
    keepPanes: keepPanes || tmuxConfig.keepSessions === true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    tmuxCommand,
    ...(tmuxConfig.agentCommands ? { tmuxAgentCommands: tmuxConfig.agentCommands } : {}),
  };
}

function childTimeoutFrom(flags: Record<string, string | true>, configTimeout: number | undefined): number | undefined {
  const timeoutFlag = flags["timeout-ms"];
  if (timeoutFlag !== undefined) {
    if (typeof timeoutFlag !== "string" || timeoutFlag.trim().length === 0) err("--timeout-ms requires a value");
    const timeoutMs = Number(timeoutFlag);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      err("--timeout-ms must be a positive number of milliseconds");
    }
    return timeoutMs;
  }
  return typeof configTimeout === "number" ? configTimeout : undefined;
}

/** A host adapter bound to `workDir` — the child agent's cwd (the repo, or
 *  the proposal's isolated worktree for parallel implement). */
function childAdapter(child: ChildSessionOptions, workDir: string): HostAdapter {
  if (child.host === "tmux") {
    return createTmuxHostAdapter({
      workDir,
      command: child.tmuxCommand ?? "",
      ...(child.tmuxAgentCommands ? { agentCommands: child.tmuxAgentCommands } : {}),
      keepSessions: child.keepPanes,
      ...(child.timeoutMs !== undefined ? { timeoutMs: child.timeoutMs } : {}),
    });
  }
  return createHerdrHostAdapter({
    workDir,
    kind: child.kind,
    keepPanes: child.keepPanes,
    prefix: "swarm-dao",
    ...(child.harnessModelFlag ? { harnessModelFlag: child.harnessModelFlag } : {}),
    ...(child.timeoutMs !== undefined ? { timeoutMs: child.timeoutMs } : {}),
  });
}

function childName(child: ChildSessionOptions, proposalId: number, agentId: string): string {
  return childSessionName(child.host, herdrAgentName, "swarm-dao", proposalId, agentId);
}

function announceChildren(header: string, child: ChildSessionOptions, names: string[]): void {
  const parent = child.host === "tmux" ? "tmux" : "herdr";
  const detectedSuffix = child.detected === "none" ? "bare shell → herdr default" : `detected: ${child.detected}`;
  info(`${parent} parent session: this shell (${detectedSuffix}) — ${header}:`);
  for (const name of names) info(`  ${name}`);
  info(
    child.host === "tmux"
      ? c.dim("  attach with `tmux attach -t <session>` to watch any child live")
      : c.dim("  attach with `herdr` to watch any child live"),
  );
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
  "gc",
  "migrate",
  "setup",
  "propose",
  "deliberate",
  "roundtable",
  "list",
  "show",
  "vote",
  "control",
  "dry-run",
  "reject-proposal",
  "ship",
  "implement",
  "rate",
  "github-config",
  "github-branch",
  "github-pr",
  "config",
  "audit",
  "attention",
  "next",
  "doctor",
  "watch",
  "approve",
  "reject",
  "status",
  "graph",
  "product",
  "delivery",
  "improve",
  "help",
] as const;

/**
 * Rich, CLI-specific usage detail that the registry's one-line summary cannot
 * capture (flags, multi-line examples). Keyed by command id.
 */
const CLI_USAGE_DETAILS: Record<string, string> = {
  propose:
    "  propose --title <t> --type <T> --description <d> [--by <name>]\n        [--acceptance-criteria <text>]… [--depends-on <id1,id2,...>]\n        --acceptance-criteria is repeatable; each occurrence adds one criterion",
  deliberate:
    "  deliberate <id> [--host <herdr|tmux|auto>] [--kind <pi|codex|claude|…>] [--keep-panes] [--timeout-ms <ms>]\n        every agent votes as a real coding agent in its own child session —\n        herdr by default; inside tmux, tmux sessions (--host overrides; herdr\n        kind default: .dao/config.json herdr.kind, else pi; tmux needs\n        .dao/config.json tmux.command)",
  roundtable:
    "  roundtable [--host <herdr|tmux|auto>] [--kind <pi|codex|claude|…>] [--keep-panes] [--timeout-ms <ms>]\n        every agent suggests a proposal idea in its own child session",
  implement:
    "  implement <id> [<id>…] [--host <herdr|tmux|auto>] [--kind <pi|codex|claude|…>] [--keep-panes] [--timeout-ms <ms>]\n        dispatch one child agent per proposal; multiple ids develop in\n        parallel, each in its own worktree (needs execution.isolation)",
  list: "  list [--status <s>] [--type <T>] [--unrated]",
  show: "  show <id>",
  vote: "  vote <id> --position <for|against|abstain> --reasoning <text>\n        [--weight <n>] [--agent <id>]\n        --weight defaults to the council agent's registry weight",
  control: "  control <id>\n        Run quality-control gates (alias: check)",
  "dry-run":
    "  dry-run <id>\n        Record the dry-run analysis a red-zone proposal needs before\n        `control` can pass (same analysis as the dao_dry_run host tool)",
  "reject-proposal": "  reject-proposal <id> --reason <text>",
  ship: "  ship <id> [--cascade] [--force]",
  rate: "  rate <id> --score <1-5> --comment <text> [--by <name>]\n        rate an executed proposal's outcome; every rating is recorded\n        with its author in the audit trail and feeds the overall score",
  "github-config": "  github-config --owner <o> --repo <r> [--issues]",
  "github-branch": "  github-branch <proposal-id>",
  "github-pr": "  github-pr <proposal-id> --head-branch <b>",
  config:
    "  config            show .dao/config.json\n  config upgrade    align .dao/config.json with the current schema version",
  audit: "  audit [--proposal <id>]",
  attention: "  attention [--source <graph-engineering|improvement-loop|improvement-series|product-loop>,...]",
  next: "  next              what needs you now (human gates + live workflows)",
  watch: "  watch [--interval <s>] [--once]   live pane of gates + workflows (Ctrl-C exits)",
  doctor: "  doctor            environment & configuration diagnostic (runtime, agents, gates)",
  migrate:
    "  migrate --to home\n        copy a legacy in-repo .dao into ~/.swarm-dao and rename the old directory\n        (idempotent; refuses when the destination already differs)",
  approve:
    "  approve --run-id <id> [--evidence-root <path>] [--yes]\n        approve the exact model hash of a graph run awaiting approval",
  reject: "  reject --run-id <id> --reason <text> [--yes]\n        send an awaiting model back to draft",
  graph:
    "  graph <init|status|submit|implement> --run-id <id> [--evidence-root <path>]\n        graph submit --run-id <id> --signal <file.json>\n        graph implement --run-id <id> --task <text>   classifier-routed implementer",
  product:
    "  product <init|status|submit> --run-id <id> [--evidence-root <path>]\n        product submit --run-id <id> --signal <file.json>",
  delivery:
    "  delivery <init|status|submit|once|resume|scorecard|stage-init> [options]\n        delivery init --delivery-id <id> --product-run-id <id> [--risk-class unknown]\n        delivery status|once|resume --delivery-id <id>\n        delivery submit --delivery-id <id> --signal <file.json>\n        delivery scorecard [--since <ISO timestamp>] | stage-init",
  improve: `  improve init --series-id <id> --scope <s> --reference-hash <hash> [--cooldown-ms <ms>]
        improve status --series-id <id>
        improve once --series-id <id> [--sandbox <docker|container|auto|none>] [--image <name>]
        improve submit --series-id <id> --event <file>
        improve cycles --series-id <id>
      cycle human gates (see: swarm-dao attention --source improvement-loop)
        improve retry --cycle-id <id> | --series-id <id>          cycle 'retrying' → RETRY_AUTHORIZED
        improve reference --cycle-id <id> --decision approve|reject   cycle 'adjusting'
        improve cancel-cycle --cycle-id <id> | --series-id <id> --reason "<text>"
      series human gates (see: swarm-dao attention --source improvement-series)
        improve retry-workers --series-id <id>                    series 'workerFailed'
        improve restart --series-id <id>                          series 'halted'
        improve cancel --series-id <id> --reason "<text>"`,
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
  const layout = await resolveDaoLayout(cwd);
  const repository = await FileDaoStateRepository.open(cwd);
  await repository.persist();
  info(`✓ DAO storage initialized at ${layout.stateRoot}`);
  if (layout.mode === "home") {
    info(`   External DAO home (ADR-007) — project root: ${layout.projectRoot}`);
  }
}

/** ADR-007: resolved DAO state root — legacy `<cwd>/.dao` or the home branch dir. */
async function daoStateRoot(cwd: string): Promise<string> {
  return (await resolveDaoLayout(cwd)).stateRoot;
}

async function cmdSetup(cwd: string): Promise<void> {
  const repository = await ensureLoaded(cwd);
  const state = repository.get();
  if (state.initialized) {
    info(`DAO already initialized with ${state.agents.length} agents.`);
    return;
  }
  const agents = initializeAgents();
  state.agents = agents;
  state.initialized = true;
  await repository.persist();
  info(`✓ DAO initialized with ${agents.length} agents`);
  for (const a of agents) {
    info(`  - ${a.name} (w=${a.weight}) — ${a.role}`);
  }
}

/** swarm-dao gc — remove DAO state of deleted branches/worktrees (ADR-007 §5). */
async function cmdMigrate(cwd: string, flags: Record<string, string | true>): Promise<void> {
  if (flags.to !== "home") err("migrate requires --to home");
  const result = await migrateDaoToHome(cwd);
  if (result.status === "nothing-to-migrate") {
    info("Nothing to migrate (no legacy .dao with DAO state).");
    return;
  }
  if (result.status === "already-home") {
    info(`DAO storage is already in the external home${result.stateRoot ? `: ${result.stateRoot}` : ""}.`);
    return;
  }
  info(`Migrated legacy .dao to ${result.stateRoot}`);
  if (result.legacyBackup) info(`Legacy directory renamed to ${result.legacyBackup}`);
}

async function cmdGc(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const dryRun = flags["dry-run"] === true;
  const result = await gcDaoHome(cwd, { dryRun });
  if (result.mode !== "home") {
    info("DAO home GC: legacy .dao storage in use — nothing to collect.");
    return;
  }
  if (result.removed.length === 0) {
    info(`DAO home GC: nothing stale under ${result.projectRoot}`);
    return;
  }
  for (const dir of result.removed) {
    info(`${dryRun ? "[dry-run] would remove" : "removed"} ${dir}`);
  }
}

async function cmdPropose(
  cwd: string,
  flags: Record<string, string | true>,
  repeated: Record<string, string[]> = {},
): Promise<void> {
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

  // Repeatable: --acceptance-criteria "…" --acceptance-criteria "…".
  // The acceptance-criteria control gate reads these; without them the gate
  // can only warn.
  const acceptanceCriteria = (repeated["acceptance-criteria"] ?? [])
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);

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
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
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

/** swarm-dao deliberate <id> — every agent votes as a real coding agent in
 *  its own herdr child session; outputs feed the same deterministic tally. */
async function cmdDeliberate(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr)
    err(
      "usage: swarm-dao deliberate <id> [--host <herdr|tmux|auto>] [--kind <pi|codex|claude|…>] [--keep-panes] [--timeout-ms <ms>]",
    );
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const projectConfig = await loadConfig(await daoStateRoot(cwd));
  const child = childSessionOptionsFrom(flags, projectConfig);
  const repository = await ensureLoaded(cwd);
  if (!getProposalFrom(repository, id)) err(`proposal #${id} not found`);

  const agents = await loadAgentDefinitions(await daoStateRoot(cwd), projectConfig);
  announceChildren(
    `${agents.length} child sessions vote on proposal #${id}`,
    child,
    agents.map((a) => childName(child, id, a.id)),
  );

  const presented = await handleDaoDeliberate(
    {
      adapter: childAdapter(child, cwd),
      workDir: cwd,
      deliberationMode: "auto",
      controlToolName: "dao_check",
      hostDefaultHarness: child.host === "herdr" ? child.kind : undefined,
      repository,
      onDeliberationProgress: ({ agentName, phase }) => info(c.dim(`  [${phase}] ${agentName}`)),
    },
    id,
  );
  info(presented);
}

/** swarm-dao roundtable — every agent suggests a proposal idea from its own
 *  herdr child session (children are named swarm-dao-p0-<agent>-<hash>:
 *  roundtable runs on the synthetic proposal #0). */
async function cmdRoundtable(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const projectConfig = await loadConfig(await daoStateRoot(cwd));
  const child = childSessionOptionsFrom(flags, projectConfig);
  const repository = await ensureLoaded(cwd);
  if (!repository.get().initialized) err("DAO not initialized. Run: swarm-dao setup");

  const agents = await loadAgentDefinitions(await daoStateRoot(cwd), projectConfig);
  announceChildren(
    `${agents.length} child sessions suggest proposal ideas`,
    child,
    agents.map((a) => childName(child, 0, a.id)),
  );

  const presented = await handleDaoRoundtable({
    adapter: childAdapter(child, cwd),
    workDir: cwd,
    deliberationMode: "auto",
    controlToolName: "dao_check",
    repository,
  });
  info(presented);
}

async function cmdList(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const repository = await ensureLoaded(cwd);
  let items = listProposalsFrom(repository);
  if (typeof flags.status === "string") {
    items = items.filter((p) => p.status === flags.status);
  }
  if (flags.unrated === true) {
    const outcomes = repository.get().outcomes;
    items = items.filter((p) => p.status === "executed" && (outcomes[p.id]?.ratings.length ?? 0) === 0);
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
  if (flags.unrated === true) {
    info(c.dim(`  → close the loop: swarm-dao rate <id> --score <1-5> --comment "<what worked / what didn't>"`));
  }
}

async function cmdShow(cwd: string, positional: string[]): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao show <id>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid id '${idStr}'`);

  const repository = await ensureLoaded(cwd);
  const p = getProposalFrom(repository, id);
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

async function cmdConfig(cwd: string, positional: string[]): Promise<number> {
  const [sub] = positional;
  if (sub === "upgrade") {
    const stateRoot = await daoStateRoot(cwd);
    const result = await upgradeConfig(stateRoot);
    if (result.from === result.to) {
      info(`✓ config already current (v${result.to})`);
    } else {
      info(`✓ config upgraded v${result.from} → v${result.to} (${await resolveConfigFilePath(stateRoot)})`);
    }
    return 0;
  }
  if (sub !== undefined) {
    err(`unknown config subcommand: ${sub} (expected: upgrade)`);
  }
  const repository = await ensureLoaded(cwd);
  info(JSON.stringify(repository.get().config, null, 2));
  return 0;
}

async function cmdAudit(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const repository = await ensureLoaded(cwd);
  const entries =
    typeof flags.proposal === "string"
      ? getAuditLogFrom(repository, Number(flags.proposal))
      : getAllAuditLogFrom(repository);
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
  const repository = await ensureLoaded(cwd);
  const s = repository.get();
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

  const HUMAN_VOTER = "cli-user";
  const agent = typeof flags.agent === "string" ? flags.agent : HUMAN_VOTER;

  const repository = await ensureLoaded(cwd);
  const p = getProposalFrom(repository, id);
  if (!p) err(`proposal #${id} not found`);

  const roster = repository.get().agents ?? [];
  const member = roster.find((candidate) => candidate.id === agent);
  if (agent !== HUMAN_VOTER && !member) {
    const known = roster.map((candidate) => candidate.id).join(", ") || "(none — run swarm-dao setup)";
    err(`unknown agent '${agent}'. Use a council id (${known}) or omit --agent for a human vote (${HUMAN_VOTER}).`);
  }

  const weight = typeof flags.weight === "string" ? Number(flags.weight) : (member?.weight ?? 1);
  if (!Number.isFinite(weight) || weight <= 0) {
    err("--weight must be a positive number");
  }

  const result = await addVoteOn(repository, id, {
    agentId: agent,
    agentName: member?.name ?? agent,
    position,
    reasoning,
    weight,
  });
  if (!result.ok) err(result.error);
  await recordAuditOn(repository, id, "governance", "vote-cast", agent, `${position} (w=${weight}): ${reasoning}`);
  info(`✓ Vote ${result.replaced ? "updated" : "recorded"} for #${id}: ${positionRaw} by ${agent}`);
  info(c.dim(`  → next: swarm-dao show ${id} · after approval: swarm-dao control ${id}`));
}

async function cmdRejectProposal(
  cwd: string,
  positional: string[],
  flags: Record<string, string | true>,
): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao reject-proposal <id> --reason <text>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const reason = typeof flags.reason === "string" ? flags.reason : "";
  if (!reason.trim()) err("--reason is required (it is recorded in the audit trail)");

  const repository = await ensureLoaded(cwd);
  const result = await new RejectProposalUseCase({ repository, clock: systemClock }).execute({
    proposalId: id,
    actor: "cli-user",
    reason,
  });
  if (!result.ok) err(result.error);
  info(`✓ Proposal #${id} rejected (${result.via}) — status: rejected`);
  info(c.dim(`  → audit trail: swarm-dao audit --proposal ${id}`));
}

async function cmdRate(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao rate <id> --score <1-5> --comment <text> [--by <name>]");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const score = typeof flags.score === "string" ? Number(flags.score) : NaN;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    err("--score is required and must be an integer from 1 to 5");
  }
  const comment = typeof flags.comment === "string" ? flags.comment : "";
  if (!comment.trim()) err("--comment is required (it is recorded in the audit trail)");
  const by = typeof flags.by === "string" && flags.by.trim() ? flags.by.trim() : "cli-user";

  const repository = await ensureLoaded(cwd);
  const result = await new RateProposalUseCase({ repository, clock: systemClock }).execute({
    proposalId: id,
    rater: by,
    score: score as 1 | 2 | 3 | 4 | 5,
    comment,
  });
  if (!result.ok) err(result.error);
  await recordAuditOn(repository, id, "governance", "outcome-rated", by, `score ${result.rating.score}/5: ${comment}`);
  const outcome = getOutcomeFrom(repository, id);
  info(`✓ Rating recorded for #${id}: ${result.rating.score}/5 by ${by}`);
  if (outcome) {
    info(c.dim(`  overall: ${outcome.overallScore.toFixed(1)}/5 across ${outcome.ratings.length} rating(s)`));
  }
  info(c.dim(`  → audit trail: swarm-dao audit --proposal ${id}`));
}

/** swarm-dao dry-run <id> — record the dry-run analysis of a proposal.
 *
 *  Red-zone proposals are blocked by the mandatory-dry-run control gate until
 *  `dryRunAt` is set. Until now only the dao_dry_run host tool could write it,
 *  so a red-zone proposal produced from the CLI could never pass `control`
 *  without an MCP/pi session. This command runs the exact same
 *  DryRunProposalUseCase, so both surfaces record identical evidence. */
async function cmdDryRun(cwd: string, positional: string[]): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao dry-run <id>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const repository = await ensureLoaded(cwd);
  const result = await new DryRunProposalUseCase({ repository, clock: systemClock }).execute({
    proposalId: id,
  });
  if (!result.ok) err(result.error);
  info(presentDryRun(result.analysis));
  info(c.dim(`  → next: swarm-dao control ${id}`));
}

async function cmdControl(cwd: string, positional: string[]): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao control <id>");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const repository = await ensureLoaded(cwd);
  const result = await new ControlProposalUseCase({ repository, clock: systemClock }).execute({
    proposalId: id,
    failOnGateFailure: false,
  });
  if (!result.ok) err(result.error);
  info(formatControlResult(result.control));
  info(`status: ${result.status}`);
  if (result.status === "controlled") {
    info(c.dim(`  → next: swarm-dao ship ${id}`));
  } else if (!result.control.allGatesPassed) {
    info(c.dim("  → gates failed; the proposal stays approved so you can fix and re-run control"));
  }
}

async function cmdShip(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao ship <id> [--cascade] [--force]");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const cascade = flags.cascade === true;
  const force = flags.force === true;

  const repository = await ensureLoaded(cwd);
  const projectConfig = await loadConfig(await daoStateRoot(cwd));

  // Ship audit challenge (opt-in): first call challenges, unchanged second
  // call proceeds (models/ship-audit.md).
  let auditConsume: (() => Promise<void>) | undefined;
  let auditRelease: (() => Promise<void>) | undefined;
  if (projectConfig.ship?.auditChallenge === true) {
    const proposal = getProposalFrom(repository, id);
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
    auditRelease = gate.release;
  }

  const workspace = createExecutionWorkspace(projectConfig.execution, cliRunner(), cwd);
  let result: Awaited<ReturnType<ShipProposalUseCase["execute"]>>;
  try {
    result = await new ShipProposalUseCase({
      repository,
      clock: systemClock,
      workspace,
      // With the challenge enabled, force bypasses the audit ONLY —
      // dependency checks still run.
    }).execute({ proposalId: id, actor: "cli", cascade, force: auditConsume ? undefined : force });
  } catch (error) {
    // Release the audit claim on a thrown ship so it cannot leak; the
    // confirmation is spent only on the success path below.
    await auditRelease?.();
    throw error;
  }
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
    const proposal = getProposalFrom(repository, shippedId);
    info(`✓ Shipped #${shippedId}: ${proposal?.title ?? "proposal"}`);
  }
}

// ── Implement (dispatch herdr child agents to build proposals) ──

/** Synthetic agent bound to implementation dispatch — not a deliberation
 *  voter: it carries no weight and never enters the tally. */
const IMPLEMENTATION_AGENT: DAOAgent = {
  id: "implementer",
  name: "Implementer",
  role: "delivery",
  description: "herdr child agent that implements a proposal in an isolated workspace",
  weight: 1,
  systemPrompt: "",
};

function implementationPrompt(p: Proposal): string {
  const criteria = Array.isArray(p.acceptanceCriteria)
    ? p.acceptanceCriteria.map((ac) => `- ${typeof ac === "string" ? ac : ac.id}`).join("\n")
    : "";
  return [
    `Implement proposal #${p.id} — ${p.title} (${p.type}).`,
    "",
    "Description:",
    p.description,
    ...(criteria ? ["", "Acceptance criteria:", criteria] : []),
    "",
    "You are working in an isolated checkout of the repository. Make the code changes needed to satisfy the proposal; keep the change minimal and focused. Run the project's checks/build/tests when done.",
    "Finish with a short summary: what changed, files touched, and check results.",
  ].join("\n");
}

interface ImplementResult {
  id: number;
  name?: string;
  workDir?: string;
  output?: AgentOutput;
  error?: string;
}

/** swarm-dao implement <id> [<id>…] — one herdr child agent per proposal;
 *  multiple ids develop in parallel, each in its own execution workspace
 *  (worktree/sandbox isolation from .dao/config.json execution). */
async function cmdImplement(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  if (positional.length === 0) {
    err(
      "usage: swarm-dao implement <id> [<id>…] [--host <herdr|tmux|auto>] [--kind <pi|codex|claude|…>] [--keep-panes] [--timeout-ms <ms>]",
    );
  }
  const ids = positional.map((s) => Number(s));
  const bad = positional.find((_, i) => !Number.isInteger(ids[i]));
  if (bad !== undefined) err(`invalid proposal id '${bad}'`);

  const projectConfig = await loadConfig(await daoStateRoot(cwd));
  const child = childSessionOptionsFrom(flags, projectConfig);
  const repository = await ensureLoaded(cwd);
  const proposals: Proposal[] = [];
  for (const id of ids) {
    const p = getProposalFrom(repository, id);
    if (!p) err(`proposal #${id} not found`);
    proposals.push(p);
  }

  // Parallel development only with per-proposal isolation: without a
  // worktree/sandbox every child would edit the same checkout.
  const isolation = projectConfig.execution?.isolation;
  if (proposals.length > 1 && isolation !== "worktree" && isolation !== "sandbox") {
    err(
      `implementing ${proposals.length} proposals in parallel needs execution.isolation "worktree" (or "sandbox") in .dao/config.json — children would otherwise share one checkout`,
    );
  }

  const workspace = createExecutionWorkspace(projectConfig.execution, cliRunner(), cwd);

  announceChildren(
    `${proposals.length} implementation child session(s) (${isolation ?? "none"} isolation)`,
    child,
    proposals.map((p) => childName(child, p.id, IMPLEMENTATION_AGENT.id)),
  );

  const results: ImplementResult[] = await Promise.all(
    proposals.map(async (p): Promise<ImplementResult> => {
      let workDir = cwd;
      if (workspace) {
        const prep = await workspace.prepare(p);
        if (!prep.ok) return { id: p.id, error: `workspace: ${prep.error}` };
        if (prep.path) workDir = prep.path;
      }
      const output = await childAdapter(child, workDir).spawnAgent({
        agent: IMPLEMENTATION_AGENT,
        proposal: p,
        systemPrompt: implementationPrompt(p),
        ...(child.timeoutMs !== undefined ? { timeoutMs: child.timeoutMs } : {}),
      });
      return { id: p.id, name: childName(child, p.id, IMPLEMENTATION_AGENT.id), workDir, output };
    }),
  );

  // Audit after the fan-out: sequential writes to the shared DAO state.
  for (const r of results) {
    if (!r.error && r.name && r.workDir) {
      await recordAuditOn(
        repository,
        r.id,
        "delivery",
        "implementation-dispatched",
        "cli",
        `herdr child ${r.name} (${child.kind}) → ${r.workDir}`,
      );
    }
  }

  let failures = 0;
  for (const r of results) {
    if (r.error) {
      failures++;
      info(`✗ #${r.id}: ${r.error}`);
      continue;
    }
    if (r.output?.error) {
      failures++;
      info(`✗ #${r.id} (${r.name}): ${r.output.error}`);
      continue;
    }
    const seconds = r.output ? Math.round(r.output.durationMs / 1000) : 0;
    info(`✓ #${r.id} (${r.name}) — ${r.workDir} (${seconds}s)`);
    const tail = (r.output?.content ?? "").trimEnd().split("\n").slice(-5).join("\n");
    if (tail) info(c.dim(`    ${tail.replace(/\n/g, "\n    ")}`));
  }
  if (failures > 0) {
    info(c.dim(`  → ${failures} child session(s) failed — details: .dao/herdr.log · audit: swarm-dao audit`));
  } else {
    info(c.dim("  → next: review each workspace, then swarm-dao execute/ship the proposals"));
  }
}

async function cmdGithubConfig(cwd: string, flags: Record<string, string | true>): Promise<void> {
  const owner = typeof flags.owner === "string" ? flags.owner : "";
  const repo = typeof flags.repo === "string" ? flags.repo : "";

  if (!owner) err("--owner is required");
  if (!repo) err("--repo is required");

  const githubConfig = { owner, repo, issues: flags.issues === true, enabled: true };

  // Persist to the resolved project config — no credentials are stored:
  // authentication is delegated to the GitHub CLI (`gh auth login`).
  const layout = await resolveDaoLayout(cwd);
  const configPath = await resolveConfigFilePath(layout.stateRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let configData: Record<string, unknown> = {};
  try {
    configData = JSON.parse(await fs.readFile(configPath, "utf-8"));
  } catch {
    /* no existing config */
  }
  configData.github = { owner, repo, enabled: true, issues: flags.issues === true };
  await fs.writeFile(configPath, JSON.stringify(configData, null, 2), "utf-8");

  // Also configure in-memory for current process
  configureGitHub(githubConfig);
  info(`✓ GitHub config set: ${owner}/${repo}`);
  info("   Authentication is delegated to the GitHub CLI — run `gh auth login` once if you have not already.");
  info(
    githubConfig.issues
      ? "   Proposal tracking via GitHub issues is enabled."
      : "   Issue tracking is disabled (pass --issues to enable).",
  );
}

/**
 * Read GitHub config from .dao/config.json and configure the in-memory module.
 * Returns true if GitHub is configured, false otherwise.
 */
async function loadGitHubConfigFromStorage(cwd: string): Promise<boolean> {
  const configPath = await resolveConfigFilePath(await daoStateRoot(cwd));
  try {
    const configData = JSON.parse(await fs.readFile(configPath, "utf-8"));
    const github = configData.github;
    if (github?.owner && github?.repo) {
      configureGitHub({ owner: github.owner, repo: github.repo, issues: github.issues === true, enabled: true });
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

  const repository = await ensureLoaded(cwd);
  const p = getProposalFrom(repository, id);
  if (!p) err(`proposal #${id} not found`);

  const configured = await loadGitHubConfigFromStorage(cwd);
  if (!configured || !isGitHubEnabled()) {
    err("GitHub not configured. Run: swarm-dao github-config --owner <o> --repo <r> [--issues]");
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

  const repository = await ensureLoaded(cwd);
  const p = getProposalFrom(repository, id);
  if (!p) err(`proposal #${id} not found`);

  const configured = await loadGitHubConfigFromStorage(cwd);
  if (!configured || !isGitHubEnabled()) {
    err("GitHub not configured. Run: swarm-dao github-config --owner <o> --repo <r> [--issues]");
  }

  const result = await ghCreatePullRequest(p, { headBranch });
  if (!result) err("failed to create PR (GitHub API returned null)");

  info(`✓ PR created: #${result.number} — ${result.url}`);
}

// ── Graph Engineering and Product loop runs (in any project) ──

const GRAPH_RUN_ROOT = ".dao/graph-runs";
const PRODUCT_RUN_ROOT = ".dao/product-loops";

const GRAPH_USAGE = `usage: swarm-dao graph <init|status|submit|implement> [options]

  init      --run-id <id> [--evidence-root <path>]
  status    --run-id <id> [--evidence-root <path>]
  submit    --run-id <id> --signal <file.json> [--evidence-root <path>]
  implement --run-id <id> --task <text> [--role <text>] [--evidence-root <path>]
            [--host <herdr|tmux|auto>] [--kind <pi|codex|claude|…>]
            [--keep-panes] [--timeout-ms <ms>]

Graph runs live under .dao/graph-runs by default; override with --evidence-root
(repos carrying the frozen graph use evidence/graph-runs). Signals are
validated against the frozen Graph Engineering machine; human-source events
require explicit owner authorization (see models/graph-engineering.md).
implement prepends CLASSIFIER_CHARTER, routes on evaluateAttempt, and only then
emits IMPLEMENTATION_READY or IMPLEMENTATION_FAILED. It never emits EVALUATE.`;

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
  if (positional[0] === "implement") return cmdGraphImplement(cwd, flags);
  return cmdRunCommand(cwd, positional, flags, GRAPH_SPEC);
}

function graphImplementProposal(runId: string): Proposal {
  let hash = 0;
  for (let i = 0; i < runId.length; i++) hash = (hash * 31 + runId.charCodeAt(i)) | 0;
  return {
    id: (hash >>> 0) % 900_000_000,
    title: `graph implement ${runId}`,
    type: "technical-change",
    description: runId,
    proposedBy: "graph-engineering",
    status: "approved",
    votes: [],
    agentOutputs: [],
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

async function hashCheckout(cwd: string): Promise<string> {
  const head = await execCommand("git rev-parse HEAD", { cwd, timeout: 10_000 });
  if (head.exitCode !== 0) throw new Error(head.stderr.trim() || "git rev-parse HEAD failed");
  const status = await execCommand("git status --porcelain", { cwd, timeout: 10_000 });
  const diff = await execCommand("git diff HEAD", { cwd, timeout: 30_000 });
  return createHash("sha256").update(`${head.stdout}\n${status.stdout}\n${diff.stdout}`).digest("hex");
}

const toToolStatus = (exitCode: number): ToolCheckStatus => (exitCode === 0 ? "passed" : "failed");

async function runRepoTools(cwd: string): Promise<ToolEvidence> {
  const tests = await execCommand("bun test", { cwd, timeout: 180_000 });
  const types = await execCommand("bun run typecheck", { cwd, timeout: 180_000 });
  const lint = await execCommand("bun run lint", { cwd, timeout: 180_000 });
  return {
    tests: toToolStatus(tests.exitCode),
    types: toToolStatus(types.exitCode),
    lint: toToolStatus(lint.exitCode),
  };
}

async function cmdGraphImplement(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const stringFlag = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const runId = stringFlag("run-id");
  if (!runId) err(`--run-id is required\n${GRAPH_USAGE}`);
  const task = stringFlag("task");
  if (!task) err(`--task is required\n${GRAPH_USAGE}`);
  const evidenceRoot = path.resolve(cwd, stringFlag("evidence-root") ?? GRAPH_RUN_ROOT);
  const role = stringFlag("role");

  const peek = await createGraphRunner({ evidenceRoot, runId });
  if (peek.snapshot().state !== "implementing") {
    err(`run is in ${peek.snapshot().state}, not implementing`);
  }

  const projectConfig = await loadConfig(await daoStateRoot(cwd));
  const child = childSessionOptionsFrom(flags, projectConfig);
  const proposal = graphImplementProposal(runId);
  const adapter = childAdapter(child, cwd);
  announceChildren(`graph implementer for ${runId}`, child, [childName(child, proposal.id, IMPLEMENTATION_AGENT.id)]);

  const result = await runGraphImplementing({
    evidenceRoot,
    runId,
    task,
    ...(role ? { role } : {}),
    ports: {
      turn: async (prompt) => {
        const output = await adapter.spawnAgent({
          agent: IMPLEMENTATION_AGENT,
          proposal,
          systemPrompt: prompt,
          ...(child.timeoutMs !== undefined ? { timeoutMs: child.timeoutMs } : {}),
          ...(child.host === "herdr" ? { harness: child.kind } : {}),
        });
        if (output.error) return { ok: false, error: output.error };
        return { ok: true, transcript: output.content };
      },
      runTools: () => runRepoTools(cwd),
      implementationHash: () => hashCheckout(cwd),
    },
  });

  info(JSON.stringify({ loop: result.loop, submitted: result.submitted, state: result.snapshot.state }, null, 2));
  if (result.error) err(result.error);
  if (result.loop.kind === "escalate" || result.loop.kind === "block") return 1;
  return result.submitted ? 0 : 1;
}

function cmdProduct(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  return cmdRunCommand(cwd, positional, flags, PRODUCT_SPEC);
}

const DELIVERY_MODEL_AGENT: DAOAgent = {
  id: "modeler",
  name: "Delivery modeler",
  role: "planning",
  description: "signal-only Graph modeler for repository-local software delivery",
  weight: 1,
  systemPrompt: "",
};

async function checkoutSnapshot(cwd: string): Promise<string> {
  const head = await execCommand("git rev-parse HEAD", { cwd, timeout: 10_000 });
  if (head.exitCode !== 0) throw new Error(head.stderr.trim() || "git rev-parse HEAD failed");
  const status = await execCommand("git status --porcelain", { cwd, timeout: 10_000 });
  const diff = await execCommand("git diff HEAD", { cwd, timeout: 30_000 });
  return `${head.stdout}\n${status.stdout}\n${diff.stdout}`;
}

async function readJsonFileOrNull<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

type DeliveryJournalLine = Record<string, unknown> & { sequence: number; runId: string };

async function readDeliveryJournal(root: string, runId: string): Promise<DeliveryJournalLine[]> {
  let content: string;
  try {
    content = await fs.readFile(path.resolve(root, runId, "journal.ndjson"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).sequence !== index + 1 ||
      (parsed as Record<string, unknown>).runId !== runId
    ) {
      throw new Error(`delivery scorecard journal ${runId} line ${index + 1} is malformed`);
    }
    return parsed as DeliveryJournalLine;
  });
}

async function readScorecardJournal(root: string, runId: string): Promise<DeliveryJournalLine[]> {
  return readDeliveryJournal(root, runId);
}

async function loadDeliveryScorecardEntries(roots: DeliveryCommandRoots): Promise<DeliveryScorecardEntry[]> {
  const entries: DeliveryScorecardEntry[] = [];
  let directoryEntries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    directoryEntries = await fs.readdir(roots.evidenceRoot, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isDirectory()) continue;
    const deliveryRunId = directoryEntry.name;
    const delivery = await readJsonFileOrNull<{
      state?: string;
      context?: { productRunId?: string; graphRunId?: string };
    }>(path.resolve(roots.evidenceRoot, deliveryRunId, "snapshot.json"));
    if (!delivery?.context?.productRunId || !delivery.context.graphRunId) continue;
    for (const row of await readScorecardJournal(roots.evidenceRoot, deliveryRunId)) {
      entries.push({
        deliveryRunId,
        journal: "delivery",
        kind: typeof row.kind === "string" ? row.kind : undefined,
        eventType: typeof row.eventType === "string" ? row.eventType : null,
        accepted: row.accepted === true,
        receivedAt: typeof row.receivedAt === "string" ? row.receivedAt : undefined,
        signal:
          typeof row.signal === "object" && row.signal !== null
            ? (row.signal as DeliveryScorecardEntry["signal"])
            : undefined,
      });
    }
    entries.push({
      deliveryRunId,
      journal: "delivery",
      kind: "snapshot",
      receivedAt: new Date().toISOString(),
      snapshot: delivery,
    });

    const childSpecs = [
      { journal: "product" as const, root: roots.productRoot, runId: delivery.context.productRunId },
      { journal: "graph" as const, root: roots.graphRoot, runId: delivery.context.graphRunId },
    ];
    for (const child of childSpecs) {
      const childSnapshot = await readJsonFileOrNull<{ state?: string; context?: Record<string, unknown> }>(
        path.resolve(child.root, child.runId, "snapshot.json"),
      );
      if (!childSnapshot) continue;
      entries.push({
        deliveryRunId,
        journal: child.journal,
        kind: "snapshot",
        receivedAt: new Date().toISOString(),
        snapshot: childSnapshot,
      });
      for (const row of await readScorecardJournal(child.root, child.runId)) {
        if (row.accepted !== true || typeof row.signal !== "object" || row.signal === null) continue;
        const signal = row.signal as Record<string, unknown>;
        entries.push({
          deliveryRunId,
          journal: child.journal,
          kind: "signal",
          eventType: typeof signal.type === "string" ? signal.type : null,
          accepted: true,
          source: typeof signal.source === "string" ? signal.source : undefined,
          receivedAt: typeof row.receivedAt === "string" ? row.receivedAt : undefined,
          payload:
            typeof signal.payload === "object" && signal.payload !== null
              ? (signal.payload as Record<string, unknown>)
              : {},
        });
      }
    }
  }
  return entries;
}

async function deliveryPortsFrom(
  cwd: string,
  roots: DeliveryCommandRoots & { deliveryRunId: string; productRunId: string; graphRunId: string },
  flags: Record<string, string | true>,
): Promise<DeliveryExecutorPorts> {
  const projectConfig = await loadConfig(await daoStateRoot(cwd));
  const child = childSessionOptionsFrom(flags, projectConfig);
  const adapter = childAdapter(child, cwd);
  const stageTarget = createLocalStagingTarget({
    stageRoot: roots.stageRoot,
    snapshotSource: () => checkoutSnapshot(cwd),
  });
  const graphEvidenceRoot = roots.graphRoot;
  const productEvidenceRoot = roots.productRoot;
  const deliveryEvidenceRoot = roots.evidenceRoot;
  const graphModelPath = path.resolve(deliveryEvidenceRoot, roots.deliveryRunId, "graph-model.md");
  const graphJournalPath = (runId: string): string => path.resolve(graphEvidenceRoot, runId, "journal.ndjson");
  const productJournalPath = (runId: string): string => path.resolve(productEvidenceRoot, runId, "journal.ndjson");
  const clock = () => new Date().toISOString();

  const productView = async (runId: string) => {
    try {
      await fs.access(path.resolve(productEvidenceRoot, runId, "snapshot.json"));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const product = await openProductChild({ evidenceRoot: productEvidenceRoot, runId });
    return { snapshot: product.snapshot, acceptedSignals: product.acceptedSignals };
  };
  const graphView = async (runId: string) => {
    try {
      await fs.access(path.resolve(graphEvidenceRoot, runId, "snapshot.json"));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const graph = await openGraphChild({ evidenceRoot: graphEvidenceRoot, runId });
    return { snapshot: graph.snapshot, acceptedSignals: graph.acceptedSignals };
  };
  const graphSignal = async (
    runId: string,
    type: string,
    source: "ai" | "tool" | "system",
    producer: string,
    payload: Record<string, unknown>,
    evidence: string,
  ) => {
    const runner = await createGraphRunner({ evidenceRoot: graphEvidenceRoot, runId });
    const submitted = await submitGraphChildSignal(runner, {
      runId,
      type,
      source,
      producer,
      occurredAt: clock(),
      payload,
      evidence: [evidence],
    });
    if (!submitted.accepted) throw new Error(`Graph child rejected ${type}: ${submitted.issues.join("; ")}`);
    return submitted;
  };
  const productSignal = async (runId: string, signal: unknown) => {
    const runner = await createProductRunner({ evidenceRoot: productEvidenceRoot, runId });
    if (typeof signal === "object" && signal !== null && !Array.isArray(signal)) {
      const value = signal as Record<string, unknown>;
      const payload =
        typeof value.payload === "object" && value.payload !== null && !Array.isArray(value.payload)
          ? (value.payload as Record<string, unknown>)
          : {};
      const control = payload.control as { name?: unknown; status?: unknown; evidence?: unknown } | undefined;
      if (
        value.type === "VERIFY_RUN" &&
        control &&
        typeof control.name === "string" &&
        JSON.stringify(runner.snapshot().context.controls[control.name]) === JSON.stringify(control)
      ) {
        return {
          evidence: `Product control ${control.name} already recorded`,
          value: { accepted: true, state: runner.snapshot().state },
        };
      }
      const anchor = payload.anchor;
      const recordedAnchor =
        typeof anchor === "string"
          ? (runner.snapshot().context.anchors as Record<string, { status?: string } | undefined>)[anchor]
          : undefined;
      if (value.type === "ANCHOR_RECORDED" && typeof anchor === "string" && recordedAnchor?.status === payload.status) {
        return {
          evidence: `Product anchor ${anchor} already recorded`,
          value: { accepted: true, state: runner.snapshot().state },
        };
      }
      if (value.type === "VERIFY_EVALUATE" && runner.snapshot().state !== "verification") {
        return {
          evidence: `Product verification already evaluated`,
          value: { accepted: true, state: runner.snapshot().state },
        };
      }
    }
    const submitted = await submitProductChildSignal(runner, signal);
    const value = signal as { type?: string; evidence?: readonly string[] };
    return {
      evidence: (value.evidence ?? []).join("; ") || `product:${runId}:${value.type ?? "signal"}`,
      value: { accepted: submitted.accepted, state: submitted.snapshot.state },
    };
  };

  return {
    readProductRun: productView,
    readGraphRun: graphView,
    stageRoot: roots.stageRoot,
    clock,
    createGraphRun: async (runId, effectId) => {
      await createGraphRunner({ evidenceRoot: graphEvidenceRoot, runId });
      return { evidence: path.resolve(graphEvidenceRoot, runId, "snapshot.json"), value: { effectId } };
    },
    draftGraphModel: async (input) => {
      let model: string;
      try {
        model = await fs.readFile(graphModelPath, "utf8");
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        const proposal = graphImplementProposal(input.runId);
        const modelPrompt = [
          "Draft a concise, reviewable change model for this repository task.",
          "Return the model as plain Markdown with these exact headings: Scope, Acceptance criteria, Rollback, Validation.",
          "Do not edit files or submit any signals. Do not include personal data or credentials.",
          `Risk classification: ${input.riskClass}`,
          `Scope SHA-256: ${input.scopeHash}`,
          "Task scope:",
          input.scope,
        ].join("\n\n");
        const output = await adapter.spawnAgent({
          agent: DELIVERY_MODEL_AGENT,
          proposal,
          systemPrompt: modelPrompt,
          ...(child.timeoutMs !== undefined ? { timeoutMs: child.timeoutMs } : {}),
          ...(child.host === "herdr" ? { harness: child.kind } : {}),
        });
        if (output.error) throw new Error(output.error);
        model = output.content.trim();
        if (!model) throw new Error("delivery modeler returned an empty change model");
        await fs.mkdir(path.dirname(graphModelPath), { recursive: true });
        await fs.writeFile(graphModelPath, `${model}\n`, { encoding: "utf8", flag: "wx" });
      }
      const modelHash = createHash("sha256").update(model).digest("hex");
      await graphSignal(
        input.runId,
        "MODEL_DRAFTED",
        "ai",
        "modeler",
        { modelHash },
        `delivery model artifact ${modelHash}; effect ${input.effectId}`,
      );
      return { evidence: graphModelPath, value: { modelArtifactHash: modelHash } };
    },
    validateGraphModel: async ({ runId, effectId }) => {
      const model = await fs.readFile(graphModelPath, "utf8");
      const modelHash = createHash("sha256").update(model.trimEnd()).digest("hex");
      const requiredHeadings = ["Scope", "Acceptance criteria", "Rollback", "Validation"];
      const valid = requiredHeadings.every((heading) => new RegExp(`^#{1,3}\\s+${heading}\\s*$`, "im").test(model));
      if (valid) {
        await graphSignal(
          runId,
          "MODEL_CONTRACT_VALID",
          "tool",
          "model-contract-validator",
          {},
          `change model ${modelHash} validated; effect ${effectId}`,
        );
      } else {
        await graphSignal(
          runId,
          "MODEL_CONTRACT_INVALID",
          "tool",
          "model-contract-validator",
          { reason: "change model must include Scope, Acceptance criteria, Rollback, and Validation headings" },
          `change model ${modelHash} failed validation; effect ${effectId}`,
        );
      }
      return { evidence: `${graphModelPath}#${modelHash}`, value: { valid, modelHash } };
    },
    startGraphImplementation: async ({ runId, modelHash, effectId }) => {
      const graph = await createGraphRunner({ evidenceRoot: graphEvidenceRoot, runId });
      if (graph.snapshot().context.approvedModelHash !== modelHash)
        throw new Error("Graph exact-hash owner approval is no longer current");
      const submitted = await graphSignal(
        runId,
        "START_IMPLEMENTATION",
        "system",
        "graph-runner",
        {},
        `exact approved model ${modelHash}; effect ${effectId}`,
      );
      return { evidence: graphJournalPath(runId), value: { sequence: submitted.snapshot.context.attempt } };
    },
    runGraphImplementation: async ({ runId, modelHash, effectId }) => {
      const graph = await createGraphRunner({ evidenceRoot: graphEvidenceRoot, runId });
      const before = graph.snapshot();
      if (
        before.state !== "implementing" ||
        before.context.approvedModelHash !== modelHash ||
        before.context.modelHash !== modelHash
      ) {
        throw new Error("Graph implementation is not authorized by the exact approved model hash");
      }
      const product = await productView(roots.productRunId);
      const implementationTask = product?.snapshot.context.draft?.scope;
      if (typeof implementationTask !== "string" || implementationTask.trim().length === 0) {
        throw new Error("Product scope is unavailable for the approved Graph implementation");
      }
      const approvedChangeModel = await fs.readFile(graphModelPath, "utf8");
      announceChildren(`delivery implementer for ${runId}`, child, [
        childName(child, graphImplementProposal(runId).id, IMPLEMENTATION_AGENT.id),
      ]);
      const result = await runGraphImplementing({
        evidenceRoot: graphEvidenceRoot,
        runId,
        task: `${implementationTask}\n\nOwner-approved change model:\n${approvedChangeModel}\nEffect checkpoint: ${effectId}`,
        ports: {
          turn: async (prompt) => {
            const output = await adapter.spawnAgent({
              agent: IMPLEMENTATION_AGENT,
              proposal: graphImplementProposal(runId),
              systemPrompt: prompt,
              ...(child.timeoutMs !== undefined ? { timeoutMs: child.timeoutMs } : {}),
              ...(child.host === "herdr" ? { harness: child.kind } : {}),
            });
            if (output.error) return { ok: false, error: output.error };
            return { ok: true, transcript: output.content };
          },
          runTools: () => runRepoTools(cwd),
          implementationHash: () => hashCheckout(cwd),
        },
      });
      if (result.error || !result.submitted) {
        throw new Error(
          result.error ?? `Graph implementer paused for ${result.loop.kind}; operator review is required`,
        );
      }
      return { evidence: graphJournalPath(runId), value: { state: result.snapshot.state } };
    },
    verifyGraphAnchors: async ({ runId, effectId }) => {
      const graph = await createGraphRunner({ evidenceRoot: graphEvidenceRoot, runId });
      const commands = JSON.parse(
        await fs.readFile(path.resolve(cwd, "models/graph-engineering.graph.json"), "utf8"),
      ) as {
        anchorCommands?: Record<string, string>;
      };
      const producers: Record<string, string> = {
        "graph-tests": "runtime-verifier",
        "architecture-contract": "architecture-watcher",
        "repository-ci": "runtime-verifier",
        "runtime-scenario": "runtime-verifier",
        regression: "regression-watcher",
      };
      for (const anchor of REQUIRED_GRAPH_ANCHORS) {
        if (
          anchor === "model-contract" ||
          graph.snapshot().context.anchors[anchor]?.attempt === graph.snapshot().context.attempt
        )
          continue;
        const command = commands.anchorCommands?.[anchor];
        const producer = producers[anchor];
        if (!command || !producer) throw new Error(`Graph anchor ${anchor} has no frozen command or producer`);
        const result = await execCommand(command, { cwd, timeout: 300_000 });
        const status = result.exitCode === 0 ? "passed" : "failed";
        const evidence = `command ${command}: exit ${result.exitCode}; effect ${effectId}`;
        const submitted = await graphSignal(runId, "ANCHOR_RECORDED", "tool", producer, { anchor, status }, evidence);
        if (!submitted.accepted) throw new Error(`Graph rejected anchor ${anchor}`);
      }
      await graphSignal(runId, "EVALUATE", "system", "graph-runner", {}, `Graph anchors evaluated; effect ${effectId}`);
      return { evidence: graphJournalPath(runId), value: { state: graph.snapshot().state } };
    },
    submitProductSignal: productSignal,
    verifyProduct: async ({ runId, effectId }) => {
      const toolEvidence = await runRepoTools(cwd);
      for (const [name, status] of Object.entries(toolEvidence)) {
        const submitted = await productSignal(runId, {
          runId,
          type: "VERIFY_RUN",
          source: "tool",
          producer: "verifier",
          occurredAt: clock(),
          payload: {
            control: {
              name,
              status: status === "passed" ? "passed" : "failed",
              evidence: `repository ${name} check; effect ${effectId}`,
            },
          },
          evidence: [`repository ${name} check; effect ${effectId}`],
        });
        if (!submitted.value?.accepted) throw new Error(`Product rejected ${name} verification control`);
      }
      const stageInspection = await stageTarget.inspect();
      for (const [anchor, status, command] of [
        ["frozen-set-intact", stageInspection.intact ? "passed" : "failed", "staging integrity inspection"],
        ["regression", "pending", "bun test packages/product-loop/tests packages/software-delivery/tests"],
      ] as const) {
        const result = anchor === "regression" ? await execCommand(command, { cwd, timeout: 300_000 }) : null;
        const resolvedStatus = anchor === "regression" ? (result?.exitCode === 0 ? "passed" : "failed") : status;
        const submitted = await productSignal(runId, {
          runId,
          type: "ANCHOR_RECORDED",
          source: "tool",
          producer: "verifier",
          occurredAt: clock(),
          payload: { anchor, status: resolvedStatus },
          evidence: [`${command}; effect ${effectId}`],
        });
        if (!submitted.value?.accepted) throw new Error(`Product rejected ${anchor} verification anchor`);
      }
      const evaluated = await productSignal(runId, {
        runId,
        type: "VERIFY_EVALUATE",
        source: "system",
        producer: "product-runner",
        occurredAt: clock(),
        payload: { effectId },
        evidence: [`Product controls evaluated; effect ${effectId}`],
      });
      const state = evaluated.value?.state;
      return {
        evidence: path.resolve(productEvidenceRoot, runId, "journal.ndjson"),
        value: { state: state === "ship" || state === "review" ? state : "blocked" },
      };
    },
    verifyRollbackPath: async ({ effectId }) => {
      const result = await stageTarget.verifyRollbackPath();
      return { evidence: `${result.evidence}; effect ${effectId}`, value: { restorable: result.restorable } };
    },
    hasReversibleStaging: async () => {
      try {
        return (await stageTarget.inspect()).intact;
      } catch {
        return false;
      }
    },
    ship: async ({ artifactHash, effectId }) => {
      const artifact = await stageTarget.snapshot();
      if (artifact.hash !== artifactHash)
        throw new Error("staging snapshot hash differs from the Graph implementation hash");
      const result = await stageTarget.ship({ effectId, artifact });
      return {
        evidence: `staging ship ${result.effectId} activated ${result.artifactHash}`,
        value: { artifactHash: result.artifactHash },
      };
    },
    rollback: async ({ artifactHash, effectId }) => {
      const result = await stageTarget.rollback({ effectId, expectedActiveHash: artifactHash });
      return { evidence: `staging rollback ${result.effectId} restored ${result.restoredHash ?? "empty baseline"}` };
    },
    sampleObservation: async ({ effectId, observationWindowMs }) => {
      const started = Date.now();
      const inspection = await stageTarget.inspect();
      const elapsed = Date.now() - started;
      const observedAt = clock();
      const activationTime = Date.parse(inspection.activatedAt);
      const windowElapsed =
        Number.isFinite(activationTime) && Date.parse(observedAt) - activationTime >= observationWindowMs;
      const samples = await createStagingObservationSamples({
        inspect: async () => ({
          intact: inspection.intact,
          errorCount: inspection.intact ? 0 : 1,
          checkLatencyMs: elapsed,
          evidence: `staging inspection at ${observedAt}; effect ${effectId}`,
        }),
      });
      return { evidence: `staging observation ${effectId}`, value: { samples, windowElapsed, observedAt } };
    },
    cancelChildren: async ({ productRunId, graphRunId, effectId }) => {
      const [product, graph] = await Promise.all([productView(productRunId), graphView(graphRunId)]);
      const productTerminal =
        !product || ["validated", "rejected", "cancelled", "blocked", "budgetBlocked"].includes(product.snapshot.state);
      const graphTerminal = !graph || ["succeeded", "failed", "blocked", "cancelled"].includes(graph.snapshot.state);
      if (!productTerminal || !graphTerminal) {
        throw new Error(
          "child runs remain active; settle cancellation through Product and Graph human controls before delivery can finish",
        );
      }
      return {
        evidence: `child cancellation reconciliation complete; no child cancellation signal synthesized; effect ${effectId}`,
      };
    },
    reconcileEffect: async (effect): Promise<DeliveryReconciliation> => {
      const [product, graph] = await Promise.all([productView(roots.productRunId), graphView(roots.graphRunId)]);
      const containsEffect = (signals: readonly { evidence: readonly string[] }[] | undefined): string | null =>
        signals?.find((signal) => signal.evidence.some((item) => item.includes(effect.key)))?.evidence[0] ?? null;
      if (effect.name === "draft-graph-model" && graph) {
        const drafted = graph.acceptedSignals.find(
          (signal) => signal.eventType === "MODEL_DRAFTED" && signal.evidence.some((item) => item.includes(effect.key)),
        );
        if (drafted && graph.snapshot.context.modelHash) {
          return {
            status: "completed",
            evidence: drafted.evidence[0] ?? graphJournalPath(roots.graphRunId),
            result: { value: { modelArtifactHash: graph.snapshot.context.modelHash } },
          };
        }
      }
      if (effect.name === "validate-graph-model" && graph) {
        const validated = graph.acceptedSignals.find(
          (signal) =>
            signal.eventType === "MODEL_CONTRACT_VALID" && signal.evidence.some((item) => item.includes(effect.key)),
        );
        if (validated) {
          return {
            status: "completed",
            evidence: validated.evidence[0] ?? graphJournalPath(roots.graphRunId),
            result: { value: { valid: true, modelHash: graph.snapshot.context.modelHash } },
          };
        }
        const rejected = graph.acceptedSignals.find(
          (signal) =>
            signal.eventType === "MODEL_CONTRACT_INVALID" && signal.evidence.some((item) => item.includes(effect.key)),
        );
        if (rejected) {
          return {
            status: "completed",
            evidence: rejected.evidence[0] ?? graphJournalPath(roots.graphRunId),
            result: { value: { valid: false, modelHash: graph.snapshot.context.modelHash } },
          };
        }
      }
      if (effect.name === "verify-product" && product?.snapshot.state === "verification") {
        return { status: "not-started" };
      }
      if (effect.name === "verify-graph-anchors" && graph?.snapshot.state === "verifying") {
        return { status: "not-started" };
      }
      const childEvidence = containsEffect(product?.acceptedSignals) ?? containsEffect(graph?.acceptedSignals);
      if (childEvidence) {
        const signal = [...(product?.acceptedSignals ?? []), ...(graph?.acceptedSignals ?? [])].find((candidate) =>
          candidate.evidence.some((item) => item.includes(effect.key)),
        );
        return {
          status: "completed",
          evidence: childEvidence,
          result: { value: { accepted: true, state: product?.snapshot.state, type: signal?.eventType } },
        };
      }
      if (effect.name === "create-graph-run" && graph) {
        return {
          status: "completed",
          evidence: path.resolve(graphEvidenceRoot, roots.graphRunId, "snapshot.json"),
          result: { value: { effectId: effect.key } },
        };
      }
      if (effect.name === "run-graph-implementation" && graph && graph.snapshot.state !== "implementing") {
        return {
          status: "completed",
          evidence: graphJournalPath(roots.graphRunId),
          result: { value: { state: graph.snapshot.state } },
        };
      }
      if (
        effect.name === "verify-product" &&
        product &&
        ["ship", "review", "observation", "blocked", "rejected"].includes(product.snapshot.state)
      ) {
        const state = ["ship", "review"].includes(product.snapshot.state) ? product.snapshot.state : "blocked";
        return { status: "completed", evidence: productJournalPath(roots.productRunId), result: { value: { state } } };
      }
      if (
        effect.name === "verify-graph-anchors" &&
        graph &&
        ["succeeded", "failed", "blocked", "cancelled"].includes(graph.snapshot.state)
      ) {
        return {
          status: "completed",
          evidence: graphJournalPath(roots.graphRunId),
          result: { value: { state: graph.snapshot.state } },
        };
      }
      if (
        effect.name === "start-graph-implementation" &&
        graph &&
        ["implementing", "verifying", "succeeded"].includes(graph.snapshot.state)
      ) {
        return {
          status: "completed",
          evidence: graphJournalPath(roots.graphRunId),
          result: { value: { state: graph.snapshot.state } },
        };
      }
      if (effect.name === "sample-staging-observation") return { status: "not-started" };
      return { status: effect.name === "run-graph-implementation" ? "ambiguous" : "not-started" };
    },
  };
}

async function cmdDelivery(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  const args = [
    ...positional,
    ...Object.entries(flags).flatMap(([name, value]) => (value === true ? [`--${name}`] : [`--${name}`, value])),
  ];
  const dependencies: DeliveryCommandDependencies = {
    cwd,
    now: () => new Date().toISOString(),
    output: info,
    createRunner: createDeliveryRunner,
    readDeliverySnapshot: async (evidenceRoot, runId) =>
      readJsonFileOrNull(path.resolve(evidenceRoot, runId, "snapshot.json")),
    readProductRun: async (evidenceRoot, runId) => {
      try {
        await fs.access(path.resolve(evidenceRoot, runId, "snapshot.json"));
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const child = await openProductChild({ evidenceRoot, runId });
      return { snapshot: child.snapshot, acceptedSignals: child.acceptedSignals };
    },
    readGraphRun: async (evidenceRoot, runId) => {
      try {
        await fs.access(path.resolve(evidenceRoot, runId, "snapshot.json"));
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const child = await openGraphChild({ evidenceRoot, runId });
      return { snapshot: child.snapshot, acceptedSignals: child.acceptedSignals };
    },
    hasReversibleStaging: async (stageRoot) => {
      try {
        return (
          await createLocalStagingTarget({ stageRoot, snapshotSource: async () => checkoutSnapshot(cwd) }).inspect()
        ).intact;
      } catch {
        return false;
      }
    },
    createStageTarget: (stageRoot) =>
      createLocalStagingTarget({ stageRoot, snapshotSource: async () => checkoutSnapshot(cwd) }),
    createPorts: (roots) => deliveryPortsFrom(cwd, roots, flags),
    advanceOnce: advanceDeliveryOnce,
    readScorecardEntries: loadDeliveryScorecardEntries,
  };
  return runDeliveryCommand(args, dependencies);
}

// ── Improve (continuous improvement series in any project) ──

const IMPROVE_SERIES_ROOT = ".dao/improvement-series";
const IMPROVE_CYCLE_ROOT = ".dao/improvement-cycles";

const IMPROVE_USAGE = `usage: swarm-dao improve <init|status|once|submit|cycles|retry|retry-workers|restart|cancel|reference> [options]

  init   --series-id <id> --scope <s> --reference-hash <hash> [--cooldown-ms <ms>] [--force]
         (init replays an existing journal; --force acknowledges it — never a clean slate)
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
  cancel-cycle   --cycle-id <id> --reason <text>        terminal (standalone cycle)
  reference      --cycle-id <id> --decision approve|reject [--reason <text>]

Execution environments (--exec, default branch):
  branch    workers and anchors run in the current checkout
  worktree  idempotent git worktree per series (branch dao/loop/<series-id>,
            path .dao/worktrees/<series-id>); evidence stays in this repo
  container anchor commands run in a throwaway bounded container (workers are
            herdr agents on the host; --sandbox overrides the runtime choice).
            Omitted --sandbox / sandbox.mode defaults to auto (fail-closed if
            no container runtime); set none for explicit host anchors.

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

/** herdr worker options (agent kind, extra args, harvest pacing) from flags
 * layered over the optional `worker` section of .dao/improvement.json.
 * Explicit flags win for kind/agentArgs; the kind must be a safe herdr
 * identifier; numeric pacing fields pass through validated config parsing. */
function workerOptionsFrom(
  flags: Record<string, string | true>,
  config: ProjectImprovementConfig | null,
): WorkerExecutionOptions {
  const base = workerOptionsFromConfig(config);
  const stringFlag = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) err(`--${name} requires a value`);
    return value;
  };
  const kind = stringFlag("agent") ?? base.kind;
  if (kind !== undefined && !SAFE_HERDR_KIND.test(kind)) {
    err(`--agent must be a valid herdr agent kind (e.g. pi, codex, claude), got '${kind}'`);
  }
  const argsFlag = stringFlag("agent-args");
  const agentArgs = argsFlag !== undefined ? argsFlag.split(/\s+/).filter(Boolean) : base.agentArgs;
  return {
    ...base,
    ...(kind !== undefined ? { kind } : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
  };
}

async function cmdImprove(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<number> {
  const sub = positional[0];
  // Human-gate subs take --cycle-id or --series-id themselves; dispatch before
  // the shared --series-id requirement so `improve retry --cycle-id X` works.
  if (sub === "retry") return cmdImproveRetry(cwd, flags);
  if (sub === "retry-workers") return cmdImproveRetryWorkers(cwd, flags);
  if (sub === "restart") return cmdImproveRestart(cwd, flags);
  if (sub === "cancel") return cmdImproveCancel(cwd, flags);
  if (sub === "cancel-cycle") return cmdImproveCancelCycle(cwd, flags);
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

  /** Phantom-series guard (issue #144): the evidence root resolves relative
   * to the process CWD, so running from a subdirectory can silently answer
   * from a fresh idle snapshot and mislead the operator ("series is
   * terminal (idle)"). Read paths must prove the series exists at the
   * resolved root or fail with that path. */
  const requireSeriesEvidence = async (root: string): Promise<void> => {
    try {
      await fs.access(path.join(root, seriesId, "snapshot.json"));
    } catch {
      err(
        `no series '${seriesId}' under ${root} (no snapshot.json) — check --evidence-root, or run from the repository root`,
      );
    }
  };

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
    // init replays an existing journal (deterministic restore) — that is
    // never a clean slate (issue #144): after RESTART_SERIES the operator
    // re-running init would resurrect the pre-restart context. Refuse, and
    // require an explicit --force to continue from the existing journal.
    const journalPath = path.join(evidenceRoot, seriesId, "journal.ndjson");
    const journalExists = await fs
      .access(journalPath)
      .then(() => true)
      .catch(() => false);
    if (journalExists && flags.force !== true) {
      err(
        `series journal already exists at ${journalPath} — init replays it and is never a clean slate. Use a new --series-id for a fresh series, or pass --force to continue from the existing journal.`,
      );
    }
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    const result = await runner.submit({ type: "START_SERIES", source: "human", scope, referenceHash, cooldownMs });
    info(JSON.stringify(result.snapshot, null, 2));
    if (result.accepted)
      info(c.dim(`  → next: swarm-dao improve once --series-id ${seriesId} (drives one authorized step)`));
    return result.accepted ? 0 : 2;
  }

  if (sub === "status") {
    const located = await locateRoot(cwd, seriesId, SERIES_ROOT_CANDIDATES, rootFlagValue("evidence-root"));
    await requireSeriesEvidence(located.root);
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
    const runner = await requireSeriesEvidence(evidenceRoot).then(() =>
      OrchestratorRunner.create({ seriesId, evidenceRoot }),
    );
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
  const runCommand = sandboxAnchorRunner(sandboxRequest, workDir);
  const deps: OrchestratorOnceDeps = {
    workDir,
    cycleEvidenceRoot: cycleRoot,
    worker: workerOptionsFrom(flags, config),
    ...(runCommand ? { runCommand } : {}),
  };
  await requireSeriesEvidence(evidenceRoot);
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
  const { flags, positional, repeated } = parseFlags(rest);

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
      case "gc":
        await cmdGc(cwd, flags);
        return 0;
      case "migrate":
        await cmdMigrate(cwd, flags);
        return 0;
      case "setup":
        await cmdSetup(cwd);
        return 0;
      case "propose":
        await cmdPropose(cwd, flags, repeated);
        return 0;
      case "dry-run":
        await cmdDryRun(cwd, positional);
        return 0;
      case "deliberate":
        await cmdDeliberate(cwd, positional, flags);
        return 0;
      case "roundtable":
        await cmdRoundtable(cwd, flags);
        return 0;
      case "implement":
        await cmdImplement(cwd, positional, flags);
        return 0;
      case "list":
        await cmdList(cwd, flags);
        return 0;
      case "show":
        await cmdShow(cwd, positional);
        return 0;
      case "config":
        return await cmdConfig(cwd, positional);
      case "audit":
        await cmdAudit(cwd, flags);
        return 0;
      case "attention":
        await cmdAttention(cwd, flags);
        return 0;
      case "next":
        return await cmdNext(cwd);
      case "watch":
        return await cmdWatch(cwd, flags);
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
      case "delivery":
        return await cmdDelivery(cwd, positional, flags);
      case "vote":
        await cmdVote(cwd, positional, flags);
        return 0;
      case "control":
      case "check":
        await cmdControl(cwd, positional);
        return 0;
      case "reject-proposal":
        await cmdRejectProposal(cwd, positional, flags);
        return 0;
      case "rate":
        await cmdRate(cwd, positional, flags);
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
