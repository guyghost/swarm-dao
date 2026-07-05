#!/usr/bin/env bun

// ============================================================
// Swarm DAO — Standalone CLI
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProposalType, VotePosition } from "@guyghost/swarm-dao-core";
import {
  addVote,
  configureGitHub,
  createProposal,
  executeProposal,
  getAllAuditLog,
  getAuditLog,
  getDaoCommandsByPhase,
  getDaoRoot,
  getOrCreateState,
  getProposal,
  getState,
  getUnexecutedDependencies,
  ghBranchNameFor,
  ghCreateBranch,
  ghCreatePullRequest,
  initializeAgents,
  initStorage,
  isGitHubEnabled,
  listProposals,
  loadState,
  PROPOSAL_TYPES,
  recordAudit,
  saveState,
  setState,
} from "@guyghost/swarm-dao-core";

// ── Helpers ─────────────────────────────────────────────────

class CliError extends Error {}
function err(msg: string): never {
  throw new CliError(msg);
}
function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
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

async function ensureLoaded(cwd: string): Promise<void> {
  const loaded = await loadState(cwd);
  if (!loaded) {
    setState(getOrCreateState(cwd));
  }
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
  "status",
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
  const root = await initStorage(cwd);
  setState(getOrCreateState(cwd));
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

  await ensureLoaded(cwd);
  const p = await createProposal(title, type, description, by);
  if (dependsOn && dependsOn.length > 0) {
    const state = getState();
    for (const depId of dependsOn) {
      if (!state.proposals.find((q) => q.id === depId)) {
        err(`--depends-on references unknown proposal #${depId}`);
      }
    }
    p.dependsOn = dependsOn;
  }
  await recordAudit(p.id, "governance", "proposal-created", by, `via cli: ${title}`);
  await saveState();
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

async function shipOne(proposalId: number): Promise<void> {
  const p = getProposal(proposalId);
  if (!p) err(`proposal #${proposalId} not found`);
  if (p.status !== "controlled") {
    err(`Proposal #${p.id} must be in 'controlled' state to ship (current: ${p.status})`);
  }
  const result = await executeProposal(p);
  if (!result.success) err(result.result);
  await recordAudit(p.id, "delivery", "proposal-shipped", "cli", "shipped via ship command");
  await saveState();
  info(`✓ Shipped #${p.id}: ${p.title}`);
}

async function cmdShip(cwd: string, positional: string[], flags: Record<string, string | true>): Promise<void> {
  const idStr = positional[0];
  if (!idStr) err("usage: swarm-dao ship <id> [--cascade] [--force]");
  const id = Number(idStr);
  if (!Number.isInteger(id)) err(`invalid proposal id '${idStr}'`);

  const cascade = flags.cascade === true;
  const force = flags.force === true;

  await ensureLoaded(cwd);
  const proposal = getProposal(id);
  if (!proposal) err(`proposal #${id} not found`);

  if (force) {
    await shipOne(id);
    return;
  }

  const unexecutedResolution = getUnexecutedDependencies(id, getState().proposals);
  if (unexecutedResolution.error) err(unexecutedResolution.error);

  const unexecutedDeps = unexecutedResolution.order ?? [];

  if (unexecutedDeps.length > 0) {
    if (!cascade) {
      info(`⚠️  Proposal #${id} has unexecuted dependencies:`);
      for (const depId of unexecutedDeps) {
        const dep = getProposal(depId);
        if (dep) info(`   #${String(dep.id).padStart(3)} [${dep.status.padEnd(12)}] ${dep.title}`);
      }
      info("");
      info(`Run with --cascade to ship all dependencies first:`);
      info(`  swarm-dao ship ${id} --cascade`);
      err("Dependencies not yet executed — use --cascade to ship in order");
    }

    // Validate all unexecuted deps are in 'controlled' state before executing anything
    const notReady = unexecutedDeps.filter((depId) => getProposal(depId)?.status !== "controlled");
    if (notReady.length > 0) {
      const msgs = notReady
        .map((depId) => {
          const dep = getProposal(depId);
          return dep ? `#${dep.id} (${dep.status})` : `#${depId} (not found)`;
        })
        .join(", ");
      err(`Cannot cascade: dependencies not in 'controlled' state: ${msgs}`);
    }

    info(`▶ Shipping ${unexecutedDeps.length} dependency(ies) before #${id}...`);
    for (const depId of unexecutedDeps) {
      await shipOne(depId);
    }
  }

  await shipOne(id);
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
      case "status":
        await cmdStatus(cwd);
        return 0;
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
