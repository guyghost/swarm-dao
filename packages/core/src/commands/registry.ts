// ============================================================
// Swarm DAO — `/dao` Command Registry (source of truth)
// ============================================================
// Every host adapter projects this registry into its native completion
// surface. No adapter hardcodes a command list. See
// docs/DAO_COMMAND_REGISTRY.md for the human-readable model.
//
// Discipline (Model → Review → Implement → Verify):
// - The registry only NAMES commands and maps them to existing handlers.
// - It never re-declares proposal status transitions; those belong to the
//   XState machine in governance/proposal.machine.ts (dispatchProposalEvent).
// - No entry lets an LLM decide a state transition. The LLM produces content
//   inside dao_propose / deliberation; the model decides.
// ============================================================

export type DaoCommandPhase =
  | "init"
  | "propose"
  | "deliberate"
  | "control"
  | "execute"
  | "ship"
  | "retro"
  | "discover"
  | "governance"
  | "github";

export type DaoCommandHost = "claude" | "pi" | "opencode" | "mcp" | "cli" | "copilot" | "codex";

export interface DaoCommand {
  /** Canonical subcommand, e.g. "propose" → `/dao:propose` / `/dao propose`. */
  id: string;
  /** Alternate spellings that resolve to this command, e.g. ["check"]. */
  aliases?: string[];
  /** Lifecycle group, drives completion ordering and `/dao help` sections. */
  phase: DaoCommandPhase;
  /** One-line, completion-style description. */
  summary: string;
  /** Human-facing argument signature, e.g. "proposalId [cascade] [force]". */
  args?: string;
  /** Underlying MCP tool / core handler name, e.g. "dao_propose". */
  tool?: string;
  /** True if the command can change DAO/proposal state. */
  mutating?: boolean;
  /**
   * Hosts that expose this command. `undefined` = every host.
   * Used to filter projections (e.g. `vote` is CLI-only).
   */
  hosts?: DaoCommandHost[];
}

export const DAO_COMMANDS: readonly DaoCommand[] = [
  // ── Lifecycle spine ───────────────────────────────────────────
  {
    id: "setup",
    phase: "init",
    summary: "Initialize the DAO with the default 7 product agents",
    tool: "dao_setup",
    mutating: true,
    args: "[useDefaults=true]",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "propose",
    phase: "propose",
    summary: "Create a new proposal",
    tool: "dao_propose",
    mutating: true,
    args: "title type description [acceptanceCriteria...] [affectedPaths...]",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "deliberate",
    phase: "deliberate",
    summary: "Run swarm deliberation / build the dispatch plan",
    tool: "dao_deliberate",
    mutating: true,
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "record-outputs",
    aliases: ["record"],
    phase: "deliberate",
    summary: "Record sub-agent outputs and finalize deliberation",
    tool: "dao_record_outputs",
    mutating: true,
    args: "proposalId outputs[]",
    hosts: ["claude", "copilot", "codex", "opencode", "mcp"],
  },
  {
    id: "control",
    aliases: ["check"],
    phase: "control",
    summary: "Run the quality-control gates",
    tool: "dao_control",
    mutating: true,
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "execute",
    phase: "execute",
    summary: "Execute an approved / controlled proposal",
    tool: "dao_execute",
    mutating: true,
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "ship",
    phase: "ship",
    summary: "Ship a controlled proposal (optionally cascade dependencies)",
    tool: "dao_ship",
    mutating: true,
    args: "proposalId [cascade] [force]",
    hosts: ["mcp", "claude", "copilot", "codex", "pi"],
  },
  {
    id: "rollback",
    phase: "retro",
    summary: "Revert an executed proposal to its pre-execution snapshot",
    tool: "dao_rollback",
    mutating: true,
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },

  // ── Discovery (read-only) ─────────────────────────────────────
  {
    id: "help",
    phase: "discover",
    summary: "Show the DAO workflow and every available command",
    tool: "dao_help",
    hosts: ["mcp", "claude", "copilot", "codex", "opencode", "pi"],
  },
  {
    id: "status",
    aliases: ["dashboard"],
    phase: "discover",
    summary: "Show the governance health dashboard",
    tool: "dao_dashboard",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "list",
    phase: "discover",
    summary: "List all proposals",
    tool: "dao_list",
    args: "[--status] [--type]",
    hosts: ["mcp", "claude", "copilot", "codex", "opencode", "pi"],
  },
  { id: "show", phase: "discover", summary: "Show full details for one proposal", args: "<id>", hosts: ["cli"] },
  {
    id: "agents",
    phase: "discover",
    summary: "List the configured DAO agents",
    tool: "dao_agents",
    hosts: ["mcp", "claude", "copilot", "codex", "opencode", "pi"],
  },
  {
    id: "plan",
    phase: "discover",
    summary: "Show the delivery plan for a proposal",
    tool: "dao_plan",
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "artefacts",
    phase: "discover",
    summary: "View the auto-generated artefacts for a proposal",
    tool: "dao_artefacts",
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "audit",
    phase: "discover",
    summary: "View the audit trail",
    tool: "dao_audit",
    args: "[proposalId]",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "dry-run",
    phase: "discover",
    summary: "Preview execution without applying changes",
    tool: "dao_dry_run",
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },
  {
    id: "roundtable",
    phase: "discover",
    summary: "Ask every agent to suggest a proposal idea",
    tool: "dao_roundtable",
    hosts: ["mcp", "claude", "copilot", "codex", "pi", "opencode"],
  },

  // ── Governance / mutation ─────────────────────────────────────
  {
    id: "vote",
    phase: "deliberate",
    summary: "Cast a deterministic vote on a proposal",
    mutating: true,
    args: "<id> --position <for|against|abstain> --reasoning <text> [--weight n]",
    hosts: ["cli"],
  },
  {
    id: "rate",
    phase: "retro",
    summary: "Rate a proposal outcome (1–5 stars)",
    tool: "dao_rate",
    mutating: true,
    args: "proposalId score comment",
    hosts: ["mcp", "claude", "copilot", "codex", "pi"],
  },
  {
    id: "update-proposal",
    phase: "propose",
    summary: "Update structured fields on an open proposal",
    tool: "dao_update_proposal",
    mutating: true,
    args: "proposalId [problemStatement] [acceptanceCriteria] [successMetrics] [rollbackConditions]",
    hosts: ["mcp", "claude", "copilot", "codex", "pi"],
  },
  {
    id: "propose-amendment",
    phase: "governance",
    summary: "Propose an amendment (agents, config, quorum, gates)",
    tool: "dao_propose_amendment",
    mutating: true,
    args: "title description amendmentType [agentId] [agentChanges] [configChanges] [addGates] [removeGates]",
    hosts: ["mcp", "claude", "copilot", "codex", "opencode"],
  },

  // ── GitHub integration ────────────────────────────────────────
  {
    id: "github-config",
    phase: "github",
    summary: "Configure the GitHub integration",
    tool: "dao_config_github",
    args: "--token <t> --owner <o> --repo <r>",
    hosts: ["mcp", "claude", "copilot", "codex"],
  },
  {
    id: "github-branch",
    phase: "github",
    summary: "Create a GitHub branch for a proposal",
    tool: "dao_github_create_branch",
    args: "proposalId",
    hosts: ["mcp", "claude", "copilot", "codex"],
  },
  {
    id: "github-pr",
    phase: "github",
    summary: "Open a GitHub pull request for a proposal",
    tool: "dao_github_open_pr",
    args: "proposalId --head-branch <b>",
    hosts: ["mcp", "claude", "copilot", "codex"],
  },

  // ── Meta (CLI-native) ─────────────────────────────────────────
  { id: "init", phase: "init", summary: "Initialize the .dao/ storage directory", args: "", hosts: ["cli"] },
  { id: "config", phase: "discover", summary: "Print the DAO configuration", hosts: ["cli"] },
];

const PHASE_ORDER: DaoCommandPhase[] = [
  "init",
  "propose",
  "deliberate",
  "control",
  "execute",
  "ship",
  "retro",
  "discover",
  "governance",
  "github",
];

const PHASE_LABEL: Record<DaoCommandPhase, string> = {
  init: "Setup",
  propose: "Propose",
  deliberate: "Deliberate",
  control: "Control",
  execute: "Execute",
  ship: "Ship",
  retro: "Retro",
  discover: "Discover",
  governance: "Governance",
  github: "GitHub",
};

/** Commands available on a given host (`undefined` = all). */
export function getDaoCommands(host?: DaoCommandHost): DaoCommand[] {
  return DAO_COMMANDS.filter((c) => !c.hosts || !host || c.hosts.includes(host));
}

/** Commands grouped by lifecycle phase, optionally filtered by host. */
export function getDaoCommandsByPhase(host?: DaoCommandHost): Record<DaoCommandPhase, DaoCommand[]> {
  const grouped = {} as Record<DaoCommandPhase, DaoCommand[]>;
  for (const phase of PHASE_ORDER) grouped[phase] = [];
  for (const cmd of getDaoCommands(host)) grouped[cmd.phase].push(cmd);
  return grouped;
}

/** Resolve a raw subcommand string to a command via id or alias. */
export function resolveDaoCommand(input: string, host?: DaoCommandHost): DaoCommand | undefined {
  const needle = input.trim().toLowerCase();
  if (!needle) return undefined;
  for (const cmd of getDaoCommands(host)) {
    if (cmd.id === needle) return cmd;
    if (cmd.aliases?.some((a) => a.toLowerCase() === needle)) return cmd;
  }
  return undefined;
}

/** Sorted render of a command for help text. */
function renderCommand(cmd: DaoCommand): string {
  const arg = cmd.args ? ` ${cmd.args}` : "";
  return `- \`/dao ${cmd.id}\`${arg} — ${cmd.summary}`;
}

export interface BuildDaoCommandHelpOptions {
  host?: DaoCommandHost;
  /** Header (default "# /dao Help"). */
  title?: string;
}

/** Build the grouped, registry-driven `/dao help` text. */
export function buildDaoCommandHelp(options: BuildDaoCommandHelpOptions = {}): string {
  const grouped = getDaoCommandsByPhase(options.host);
  const lines: string[] = [options.title ?? "# /dao Help", ""];
  lines.push("Workflow: setup → propose → deliberate → control → execute → ship.");
  lines.push("");
  for (const phase of PHASE_ORDER) {
    const cmds = grouped[phase];
    if (cmds.length === 0) continue;
    lines.push(`## ${PHASE_LABEL[phase]}`);
    for (const cmd of cmds) lines.push(renderCommand(cmd));
    lines.push("");
  }
  lines.push("Aliases: check→control, dashboard→status, record→record-outputs.");
  return lines.join("\n").trimEnd();
}

/** Levenshtein distance for nearest-match suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/**
 * Nearest-match suggestion for an unknown subcommand.
 * Returns a human string, never empty.
 */
export function suggestDaoCommand(input: string, host?: DaoCommandHost): string {
  const needle = input.trim().toLowerCase();
  const pool = getDaoCommands(host);
  if (!needle) {
    return "Unknown /dao subcommand. Run `/dao help` for the full list.";
  }
  const scored = pool
    .map((cmd) => {
      const candidates = [cmd.id, ...(cmd.aliases ?? [])];
      const best = Math.min(...candidates.map((c) => editDistance(needle, c.toLowerCase())));
      return { cmd, best };
    })
    .sort((x, y) => x.best - y.best);
  const top = scored[0];
  if (top && top.best <= 2) {
    const nearest = scored.filter((s) => s.best === top.best).map((s) => s.cmd.id);
    return `Unknown /dao subcommand: "${input}". Did you mean ${nearest.map((n) => `\`/dao ${n}\``).join(" or ")}? Run \`/dao help\` for the full list.`;
  }
  return `Unknown /dao subcommand: "${input}". Run \`/dao help\` for the full list.`;
}

/** Public registry metadata for adapters that materialize files (e.g. Claude). */
export const DAO_COMMAND_PHASE_ORDER = PHASE_ORDER;
export const DAO_COMMAND_PHASE_LABEL = PHASE_LABEL;
