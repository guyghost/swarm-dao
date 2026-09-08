// ============================================================
// Swarm DAO — herdr Host Adapter
// ============================================================
// Runs each deliberation agent as a REAL interactive coding agent inside a
// herdr workspace (https://herdr.dev — "the runtime your coding agents live
// on"). herdr owns the agent's terminal, tracks its lifecycle
// (working/idle/blocked/done), and the operator can attach to any agent
// pane live with `herdr`.
//
// Lifecycle per agent (packages/herdr-adapter):
//   herdr workspace create --cwd <repo> --label <name> --no-focus   (isolated pane)
//     — or, for a git-worktree cwd under a detectable parent session:
//       herdr worktree open --workspace <parent> --path <checkout> …
//       (the child nests under the parent in the Spaces sidebar, so the
//        spawned agent's owner is visible at a glance); same-checkout
//        children get a `parent` workspace token instead
//   herdr agent start <name> --kind <kind> --pane <id> --timeout    (blocks until ready)
//   herdr agent prompt <name> '<prompt>' --wait --timeout           (settles on idle/done/blocked)
//   herdr agent read <name> --source recent-unwrapped --lines N     (ANSI-stripped output)
//   herdr workspace close <id>                                      (unless keepPanes)
//
// Readiness race: workspace create returns before the fresh pane's shell has
// reached its interactive prompt, and herdr's agent start classifies such a
// pane as busy (agent_pane_busy) instead of waiting for the prompt — slower
// shell init under herd load makes this intermittent. startAgentUntilReady
// therefore retries agent start on the SAME pane (1 s apart) until the
// readiness budget is spent, so one slow shell init no longer fails the agent.
//
// Every command is spawned as ARGV via execFile — the JS side never builds
// a shell command line, so prompts and labels are never shell-interpreted.
//
// Boundary: deliberation is read-only analysis; outputs feed the same
// deterministic tally as every other host. A BLOCKED agent (approval or
// question UI) surfaces as an error output, never as a vote.
//
// Prerequisites: the herdr server must be running (`herdr` once) and the
// chosen kind's executable installed and authenticated.

import { exec as execCallback, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOutput, DAOAgent, HostAdapter, Proposal } from "@guyghost/swarm-dao-core";
/** Minimal command surface the adapter needs (node:child_process-backed by default).
 *
 * Commands are passed as ARGV — never as shell strings. The default runner
 * spawns them with execFile (no shell), so agent prompts, workspace labels
 * and agent args can never be interpreted by a shell. */
export interface HerdrRunner {
  exec(
    argv: readonly string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const execAsync = promisify(execCallback);

/** execFile with utf8 strings, promise-shaped. Failures reject with the child
 * error carrying .code/.stdout/.stderr (same shape the exec-based runner had). */
const execFileAsync = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const defaultRunner = (): HerdrRunner => ({
  exec: async (argv, options) => {
    try {
      const { stdout, stderr } = await execFileAsync(argv[0] ?? "", argv.slice(1), {
        cwd: options?.cwd,
        timeout: options?.timeout,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number | string };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? "command failed",
        exitCode: Number.isInteger(failure.code) ? (failure.code as number) : 1,
      };
    }
  },
});

/** Collapse any trailing newline run to a single '\n' — linear scan, no
 * trailing-run regex (\n+$ rescans every start position: polynomial). */
export function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return end === text.length ? text : `${text.slice(0, end)}\n`;
}

/**
 * herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique among
 * live agents. Sanitize deterministically: lowercase, collapse invalid runs,
 * force a leading letter, truncate to 32.
 */
export function sanitizeHerdrName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 32);
  // Trim leading/trailing dashes with a linear scan — /-+$/ style trailing
  // runs make every start position backtrack (polynomial ReDoS).
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned.charCodeAt(start) === 45) start++;
  while (end > start && cleaned.charCodeAt(end - 1) === 45) end--;
  const trimmed = cleaned.slice(start, end);
  if (trimmed.length === 0) return "agent";
  return /^[a-z]/.test(trimmed) ? trimmed : `a-${trimmed}`.slice(0, 32);
}

/** herdr kinds are identifiers — anything else is refused, never interpolated. */
const SAFE_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/** Short stable suffix so truncated names stay unique per agent id. */
function stableSuffix(value: string, length: number): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36).padStart(length, "0").slice(-length);
}

/**
 * Build a per-agent herdr name that ALWAYS keeps the agent-specific suffix
 * unique: the prefix is capped so `p<id>-<agent>-<hash>` fits 32 chars even
 * for long ids (truncation can never merge two agents into one name).
 */
export function herdrAgentName(prefix: string, proposalId: number, agentId: string): string {
  const cappedPrefix = sanitizeHerdrName(prefix).slice(0, 10);
  const idPart = `p${proposalId}`;
  const agent = sanitizeHerdrName(agentId);
  const hash = stableSuffix(agentId, 4);
  const room = 32 - cappedPrefix.length - idPart.length - hash.length - 2;
  const agentPart = room > 0 ? agent.slice(0, room) : "";
  const name = `${cappedPrefix}-${idPart}-${agentPart}-${hash}`.replace(/-+/g, "-");
  return /^[a-z]/.test(name) ? name.slice(0, 32) : sanitizeHerdrName(name);
}

/**
 * Terminals ECHO the submitted prompt, so the harvested transcript contains
 * the charter's output-format template — including the literal line
 * `for | against | abstain`, which the tally's vote parser would read as a
 * vote for "for". Strip those template lines: a real vote line never
 * contains pipes. Character classes are [ \t]-only so no quantifier can
 * cross a newline (polynomial ReDoS under the /m anchors).
 */
export function stripEchoedVoteTemplates(content: string): string {
  return content.replace(/^[ \t]*for[ \t]*\|[ \t]*against[ \t]*\|[ \t]*abstain[ \t]*$/gim, "");
}

export interface HerdrAdapterOptions {
  /** Repository root the agent workspaces run in. */
  workDir: string;
  /** herdr agent kind: pi, claude, codex, gemini, cursor, grok, opencode…
   * Required for deliberation — the kind's executable must be installed. */
  kind?: string;
  /** Extra arguments passed to the agent executable (after herdr's --). */
  agentArgs?: readonly string[];
  /** Per-agent prompt timeout in ms (default 5 min; herdr max 300000). */
  timeoutMs?: number;
  /** agent start readiness timeout in ms (default 30s; herdr 3000..300000). */
  startTimeoutMs?: number;
  /** Delay between same-pane agent start readiness retries (default 1 s; 0
   * only for tests). */
  readinessRetryDelayMs?: number;
  /** Lines of terminal output harvested per agent (default 200). */
  readLines?: number;
  /** Grace-poll budget after a stalled prompt (default 20 s). */
  stalledGraceMs?: number;
  /** Delay between stalled-prompt grace polls (default 2 s; 0 only for tests). */
  stalledPollIntervalMs?: number;
  /** Keep the herdr workspaces alive after harvest (default false). */
  keepPanes?: boolean;
  /** Parent herdr workspace id for child-session linkage (default:
   * HERDR_WORKSPACE_ID when running inside a herdr pane). Worktree children
   * open nested under it; same-checkout children get a parent token. */
  parentWorkspaceId?: string;
  /** Injectable command runner (tests). */
  runner?: HerdrRunner;
  /** Agent name / workspace label prefix (default "swarm-dao"). */
  prefix?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_READ_LINES = 200;

interface HerdrJson {
  id?: string;
  result?: {
    root_pane?: { pane_id?: string; workspace_id?: string };
    workspace?: { workspace_id?: string; label?: string };
    label?: string;
    agent?: { agent_status?: string; status?: string; state?: string };
  };
  error?: { code?: string; message?: string };
}

export interface AgentPromptRequest {
  /** Unique herdr agent name ([a-z][a-z0-9_-]{0,31}). */
  readonly agentName: string;
  /** Verbatim prompt text (a single argv element — never shell-interpreted). */
  readonly prompt: string;
  /** herdr prompt/settle budget in ms (also used for the settle wait). */
  readonly timeoutMs: number;
  /** Grace-poll budget after a stalled prompt (default 20 s). */
  readonly stalledGraceMs?: number;
  /** Delay between grace polls (default 2 s; 0 only for tests). */
  readonly pollIntervalMs?: number;
}

/** Settled, non-idle agent states proving a stalled prompt took effect. */
const ACTIVE_AGENT_STATES = new Set(["working", "done", "blocked"]);

/**
 * Submit a prompt and wait for a settled state (idle | done | blocked),
 * recovering from the transient agent_prompt_stalled classification: herdr
 * requires an observed state change within a hardcoded 5 s window, and a fresh
 * agent in a heavy repo under load can exceed it while the prompt was accepted
 * and is being processed (issue #137). On stall, grace-poll the agent state;
 * if the agent came alive, wait for a settled state with `agent wait`. If it
 * stays idle through the grace period the submission was swallowed — re-prompt
 * exactly ONCE (naive re-prompting risks double submission into a working
 * agent).
 */
export async function promptAgentUntilSettled(
  runner: HerdrRunner,
  request: AgentPromptRequest,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const promptArgs = (): string[] => [
    "herdr",
    "agent",
    "prompt",
    request.agentName,
    request.prompt,
    "--wait",
    "--timeout",
    String(request.timeoutMs),
  ];
  const graceMs = Math.min(Math.max(request.stalledGraceMs ?? 20_000, 0), 60_000);
  const pollMs = Math.min(Math.max(request.pollIntervalMs ?? 2_000, 0), 30_000);

  const isAlive = (response: { stdout: string; exitCode: number }): boolean =>
    response.exitCode === 0 && ACTIVE_AGENT_STATES.has(agentState(parseHerdrJson(response.stdout)?.result) ?? "");

  const prompted = await runner.exec(promptArgs());
  if (prompted.exitCode === 0 || herdrErrorCode(prompted.stderr, prompted.stdout) !== "agent_prompt_stalled") {
    return prompted;
  }

  const graceDeadline = Date.now() + graceMs;
  for (;;) {
    const got = await runner.exec(["herdr", "agent", "get", request.agentName]);
    if (isAlive(got)) {
      // The prompt took effect — herdr just missed the 5 s state transition.
      return runner.exec(["herdr", "agent", "wait", request.agentName, "--timeout", String(request.timeoutMs)]);
    }
    if (Date.now() >= graceDeadline) break;
    if (pollMs > 0) await sleep(pollMs);
  }

  // Still idle through the grace period: the submission was swallowed.
  return runner.exec(promptArgs());
}

function parseHerdrJson(raw: string): HerdrJson | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HerdrJson) : null;
  } catch {
    return null;
  }
}

function herdrErrorDetail(stderr: string, stdout: string): string {
  const parsed = parseHerdrJson(stderr.trim()) ?? parseHerdrJson(stdout.trim());
  if (parsed?.error) {
    const { code, message } = parsed.error;
    return [code, message].filter((part) => part && part.length > 0).join(": ");
  }
  return (stderr.trim() || stdout.trim() || "unknown herdr error").slice(0, 300);
}

function agentState(result: HerdrJson["result"]): string | null {
  // herdr exposes the lifecycle field as agent_status (verified live); the
  // others are defensive fallbacks — reading them alone silently disabled the
  // blocked-agent guard (issue #138).
  return result?.agent?.agent_status ?? result?.agent?.status ?? result?.agent?.state ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** herdr machine-readable error code from a failed command response, if any. */
export function herdrErrorCode(stderr: string, stdout: string): string | null {
  const parsed = parseHerdrJson(stderr.trim()) ?? parseHerdrJson(stdout.trim());
  const code = parsed?.error?.code;
  return typeof code === "string" ? code : null;
}

/** Parent herdr workspace for child-session linkage: herdr injects
 * HERDR_ENV=1 and HERDR_WORKSPACE_ID into panes it manages, so a process
 * spawned from a herdr pane (this CLI, an orchestrator) inherits the parent
 * context its children can be linked to. Returns undefined outside herdr. */
export function herdrParentWorkspaceId(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.HERDR_ENV === "1" && env.HERDR_WORKSPACE_ID ? env.HERDR_WORKSPACE_ID : undefined;
}

/** A registered git worktree checkout carries a .git FILE pointing at the
 * primary repo's worktree metadata; a primary checkout has a .git directory
 * (or none). */
async function isGitWorktreeCheckout(workDir: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(workDir, ".git"))).isFile();
  } catch {
    return false;
  }
}

export interface ChildWorkspaceRequest {
  /** Directory the child agent works in (repo checkout or git worktree). */
  readonly workDir: string;
  /** Workspace label (the sanitized child agent name). */
  readonly label: string;
  /** Parent herdr workspace id (see herdrParentWorkspaceId). When set, the
   * child is linked to the parent session; when absent nothing changes. */
  readonly parentWorkspaceId?: string;
}

export type ChildWorkspaceResult = { ok: true; paneId: string; workspaceId: string } | { ok: false; error: string };

/**
 * Create the herdr workspace a child agent runs in, linked to the parent
 * session when one is given:
 *  - git-worktree checkout + parent → `worktree open` nests the child under
 *    the parent workspace in the Spaces sidebar (herdr's parent/children
 *    view), so a spawned agent's owner is visible at a glance;
 *  - same-checkout child + parent → plain workspace stamped with a `parent`
 *    provenance token (renderable as $parent in Space sidebar rows);
 *  - no parent → exactly the plain workspace create.
 * Linking is presentation-only and best-effort: every linking failure falls
 * back to the plain workspace, and only a create failure fails the child.
 */
export async function createChildWorkspace(
  runner: HerdrRunner,
  request: ChildWorkspaceRequest,
): Promise<ChildWorkspaceResult> {
  if (request.parentWorkspaceId && (await isGitWorktreeCheckout(request.workDir))) {
    const opened = await runner.exec([
      "herdr",
      "worktree",
      "open",
      "--workspace",
      request.parentWorkspaceId,
      "--path",
      request.workDir,
      "--label",
      request.label,
      "--no-focus",
    ]);
    const openedPane = parseHerdrJson(opened.stdout)?.result?.root_pane?.pane_id ?? null;
    const openedWorkspace = parseHerdrJson(opened.stdout)?.result?.workspace?.workspace_id ?? null;
    if (opened.exitCode === 0 && openedPane && openedWorkspace) {
      return { ok: true, paneId: openedPane, workspaceId: openedWorkspace };
    }
    // Linking is presentation-only — fall back to the plain workspace below.
  }

  const created = await runner.exec([
    "herdr",
    "workspace",
    "create",
    "--cwd",
    request.workDir,
    "--label",
    request.label,
    "--no-focus",
  ]);
  if (created.exitCode !== 0) {
    return { ok: false, error: `herdr workspace create failed: ${herdrErrorDetail(created.stderr, created.stdout)}` };
  }
  const paneId = parseHerdrJson(created.stdout)?.result?.root_pane?.pane_id ?? null;
  const workspaceId = parseHerdrJson(created.stdout)?.result?.workspace?.workspace_id ?? null;
  if (!paneId || !workspaceId) {
    return {
      ok: false,
      error: `herdr workspace create returned no pane/workspace id: ${created.stdout.slice(0, 200)}`,
    };
  }

  if (request.parentWorkspaceId) {
    // Worktree children are already nested; same-checkout children only get
    // the provenance token. Human-readable parent label, id as fallback —
    // and never a run failure over display metadata.
    const parent = parseHerdrJson(
      (await runner.exec(["herdr", "workspace", "get", request.parentWorkspaceId]).catch(() => ({ stdout: "" })))
        .stdout,
    )?.result;
    const parentLabel = parent?.workspace?.label ?? parent?.label ?? request.parentWorkspaceId;
    await runner
      .exec([
        "herdr",
        "workspace",
        "report-metadata",
        workspaceId,
        "--source",
        "swarm-dao",
        "--token",
        `parent=${parentLabel}`,
      ])
      .catch(() => undefined);
  }
  return { ok: true, paneId, workspaceId };
}

export interface AgentStartRequest {
  /** Unique herdr agent name ([a-z][a-z0-9_-]{0,31}). */
  readonly agentName: string;
  /** herdr agent kind (pi, claude, …). */
  readonly kind: string;
  /** Pane to start the agent in. */
  readonly paneId: string;
  /** Readiness budget in ms — passed to herdr's --timeout and used as the
   * same-pane agent_pane_busy retry budget. */
  readonly timeoutMs: number;
  /** Extra arguments passed to the agent executable (after herdr's --). */
  readonly agentArgs?: readonly string[];
  /** Delay between agent_pane_busy retries in ms (default 1 s; 0 for tests). */
  readonly retryDelayMs?: number;
}

/**
 * Start an agent in a pane, retrying on the SAME pane while herdr reports the
 * transient agent_pane_busy (a fresh pane is not yet at its interactive shell
 * prompt when agent start runs — workspace create returns before shell init
 * finishes, slower under herd load). Retries run 1 s apart until timeoutMs is
 * spent; any other failure code is not a readiness race and returns
 * immediately.
 */
export async function startAgentUntilReady(
  runner: HerdrRunner,
  request: AgentStartRequest,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const startArgs = (): string[] => [
    "herdr",
    "agent",
    "start",
    request.agentName,
    "--kind",
    request.kind,
    "--pane",
    request.paneId,
    "--timeout",
    String(request.timeoutMs),
    ...(request.agentArgs && request.agentArgs.length > 0 ? ["--", ...request.agentArgs] : []),
  ];
  const delayMs = Math.min(Math.max(request.retryDelayMs ?? 1_000, 0), 60_000);
  const deadline = Date.now() + request.timeoutMs;
  let started = await runner.exec(startArgs());
  while (
    started.exitCode !== 0 &&
    herdrErrorCode(started.stderr, started.stdout) === "agent_pane_busy" &&
    Date.now() < deadline
  ) {
    if (delayMs > 0) await sleep(delayMs);
    started = await runner.exec(startArgs());
  }
  return started;
}

export function createHerdrHostAdapter(options: HerdrAdapterOptions): HostAdapter {
  const runner = options.runner ?? defaultRunner();
  const defaultTimeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 300_000);
  const startTimeoutMs = Math.min(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, 300_000);
  const retryDelayMs = Math.min(Math.max(options.readinessRetryDelayMs ?? 1_000, 0), 60_000);
  const stalledGraceMs = Math.min(Math.max(options.stalledGraceMs ?? 20_000, 0), 60_000);
  const stalledPollIntervalMs = Math.min(Math.max(options.stalledPollIntervalMs ?? 2_000, 0), 30_000);
  const readLines = options.readLines ?? DEFAULT_READ_LINES;
  const prefix = sanitizeHerdrName(options.prefix ?? "swarm-dao");
  const keepPanes = options.keepPanes === true;
  const parentWorkspaceId = options.parentWorkspaceId ?? herdrParentWorkspaceId();
  const agentArgs = options.agentArgs ?? [];

  /** Resolve the deepest EXISTING ancestor's realpath, then rejoin the rest —
   * containment must hold even for files that do not exist yet. */
  const realPathOf = async (target: string): Promise<string> => {
    let current = target;
    const tail: string[] = [];
    for (;;) {
      const real = await fs.realpath(current).catch(() => null);
      if (real !== null) {
        return tail.length === 0 ? real : path.join(real, ...[...tail].reverse());
      }
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  };

  /** Resolve adapter file access against workDir, contained (like other hosts).
   * Symlinks are resolved: a repo symlink cannot escape the root. */
  const containedPath = async (file: string): Promise<string> => {
    const root = await fs.realpath(path.resolve(options.workDir)).catch(() => path.resolve(options.workDir));
    const resolved = await realPathOf(path.resolve(root, file));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`path escapes the working directory: ${file}`);
    }
    return path.resolve(root, file);
  };

  const harvest = async (
    proposal: Proposal,
    agent: DAOAgent,
    prompt: string,
    timeoutMs: number,
    startedAt: number,
  ): Promise<AgentOutput> => {
    // Duration is stamped at RETURN time — base carries only identity.
    const base = (): Omit<AgentOutput, "durationMs"> => ({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: "",
    });
    const finish = (fields: Partial<AgentOutput>): AgentOutput => ({
      ...base(),
      content: "",
      ...fields,
      durationMs: Date.now() - startedAt,
    });

    if (!options.kind || options.kind.trim().length === 0) {
      return finish({
        error:
          'herdr.kind is not configured: set { "herdr": { "kind": "pi" } } in .dao/config.json (a supported herdr agent kind whose executable is installed).',
      });
    }
    if (!SAFE_KIND.test(options.kind)) {
      // Never interpolate an arbitrary value into the shell command line.
      return finish({ error: `herdr.kind '${options.kind}' is not a valid agent kind identifier.` });
    }

    const name = herdrAgentName(prefix, proposal.id, agent.id);
    let workspaceId: string | null = null;

    try {
      // 1. Isolated workspace with one root pane (never touches the user's
      // layout), linked to the parent herdr session when one is detectable
      // (worktree children nest under it in the Spaces sidebar).
      const created = await createChildWorkspace(runner, {
        workDir: options.workDir,
        label: name,
        parentWorkspaceId,
      });
      if (!created.ok) {
        return finish({
          error: `${created.error} (is the herdr server running? start it with \`herdr\`)`,
        });
      }
      const paneId = created.paneId;
      workspaceId = created.workspaceId;

      // 2. Start the agent (blocks until herdr detects it ready for input;
      // same-pane retries while the fresh pane is still busy).
      const started = await startAgentUntilReady(runner, {
        agentName: name,
        kind: options.kind,
        paneId,
        timeoutMs: startTimeoutMs,
        agentArgs,
        retryDelayMs,
      });
      if (started.exitCode !== 0) {
        return finish({
          error: `herdr agent start (${options.kind}) failed: ${herdrErrorDetail(started.stderr, started.stdout)}`,
        });
      }

      // 3. Prompt and wait for a settled state (idle | done | blocked),
      // recovering from herdr's transient agent_prompt_stalled classification.
      const prompted = await promptAgentUntilSettled(runner, {
        agentName: name,
        prompt,
        timeoutMs,
        stalledGraceMs,
        pollIntervalMs: stalledPollIntervalMs,
      });
      if (prompted.exitCode !== 0) {
        const detail = herdrErrorDetail(prompted.stderr, prompted.stdout);
        return finish({ error: `herdr agent prompt failed: ${detail}` });
      }
      const state = agentState(parseHerdrJson(prompted.stdout)?.result);
      if (state === "blocked") {
        return finish({
          error: `herdr agent ${agent.id} is blocked (approval/question UI) — it never produced a votable answer. Attach with \`herdr\` to inspect.`,
        });
      }

      // 4. Harvest the ANSI-stripped terminal output.
      const read = await runner.exec([
        "herdr",
        "agent",
        "read",
        name,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(readLines),
      ]);
      if (read.exitCode !== 0) {
        return finish({ error: `herdr agent read failed: ${herdrErrorDetail(read.stderr, read.stdout)}` });
      }
      // The terminal echoes the submitted prompt: strip the charter's literal
      // vote template so the tally can never parse the echo as a vote.
      return finish({ content: stripEchoedVoteTemplates(trimTrailingNewlines(read.stdout)) });
    } catch (error) {
      return finish({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      // 5. Cleanup — unless the operator wants to inspect the workspace.
      if (!keepPanes && workspaceId) {
        await runner.exec(["herdr", "workspace", "close", workspaceId]).catch(() => undefined);
      }
    }
  };

  return {
    hostId: "herdr",
    spawnAgent: async ({ agent, proposal, systemPrompt, timeoutMs }) =>
      harvest(proposal, agent, systemPrompt, Math.min(timeoutMs ?? defaultTimeoutMs, 300_000), Date.now()),
    spawnAgents: async ({ agents, proposal, maxConcurrent }) => {
      const outputs: AgentOutput[] = [];
      for (let i = 0; i < agents.length; i += Math.max(1, maxConcurrent)) {
        const batch = agents.slice(i, i + Math.max(1, maxConcurrent));
        const startedAt = Date.now();
        const results = await Promise.all(
          batch.map((agent) => harvest(proposal, agent, agent.systemPrompt, defaultTimeoutMs, startedAt)),
        );
        outputs.push(...results);
      }
      return outputs;
    },
    log: async ({ level, message }) => {
      const line = `[herdr:${level}] ${message}`;
      await fs.appendFile(path.join(options.workDir, ".dao", "herdr.log"), `${line}\n`, "utf8").catch(() => undefined);
    },
    getWorkingDirectory: () => options.workDir,
    readFile: async (file) => fs.readFile(await containedPath(file), "utf8"),
    writeFile: async (file, content) => fs.writeFile(await containedPath(file), content, "utf8"),
    exec: (command, execOptions) =>
      execAsync(command, { cwd: execOptions?.cwd, timeout: execOptions?.timeout })
        .then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 }))
        .catch((error: unknown) => {
          const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number };
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? failure.message ?? "command failed",
            exitCode: failure.code ?? 1,
          };
        }),
    hasCapability: (capability) => capability === "parallel-spawn",
  };
}
