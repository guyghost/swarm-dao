// ============================================================
// Swarm DAO — tmux Host Adapter
// ============================================================
// The swarm-forge execution model for DAO deliberation: each agent runs as
// its own detached tmux session. Output streams LIVE into the pane (the
// operator can `tmux attach` and watch an agent think), and is harvested at
// completion via `tmux capture-pane` — no silent file-only redirection.
//
// Security notes:
// - agent ids are sanitized before touching the filesystem (a hostile id
//   cannot traverse out of .dao/tmux/<proposalId>/) and before naming a
//   session;
// - `tmux.command` is operator configuration and runs as-is inside the pane
//   shell — the same trust level as package.json scripts. Never point it at
//   untrusted input; the deliberation prompt travels via file ($PROMPT),
//   never through the command line.
//
// Boundary: deliberation is read-only analysis. Agents share the repository
// checkout for context; execution-side isolation stays with the delivery
// layer's GitWorkspace.

import { exec as execCallback, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOutput, DAOAgent, HostAdapter, Proposal } from "@guyghost/swarm-dao-core";

/** Minimal command surface the adapter needs (node:child_process-backed by default). */
/** Minimal command surface the adapter needs. Commands are ARGV — never
 * shell strings — the default runner spawns them via execFile (no shell), so
 * session names and pane programs are never interpreted by a host shell.
 * (The pane program itself is deliberately a shell program: tmux runs it
 * through /bin/sh inside the pane.) */
export interface TmuxRunner {
  exec(
    argv: readonly string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const execAsync = promisify(execCallback);

/** execFile with utf8 strings, promise-shaped. */
const execFileAsync = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const defaultRunner = (): TmuxRunner => ({
  exec: async (argv, options) => {
    try {
      const { stdout, stderr } = await execFileAsync(argv[0] ?? "", argv.slice(1), {
        cwd: options?.cwd,
        timeout: options?.timeout,
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

/** tmux session names and run-directory segments accept [a-zA-Z0-9_-] only. */
export function sanitizeSessionName(raw: string): string {
  const collapsed = raw.replace(/[^a-zA-Z0-9_-]+/g, "-");
  // Trim leading/trailing dashes with a linear scan — /-+$/ style trailing
  // runs make every start position backtrack (polynomial ReDoS).
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45) start++;
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--;
  const cleaned = collapsed.slice(start, end);
  return cleaned.length > 0 ? cleaned : "agent";
}

export interface TmuxAdapterOptions {
  /** Repository root the sessions run in. */
  workDir: string;
  /** Agent command, e.g. 'claude -p "$PROMPT"'. $PROMPT carries the
   * deliberation prompt; stdout streams into the pane and is harvested via
   * capture-pane. Operator-only configuration (see security notes). */
  command?: string;
  /** Per-agent timeout in ms (default 5 min). */
  timeoutMs?: number;
  /** Session name prefix (default "swarm-dao"). */
  sessionPrefix?: string;
  /** Keep panes alive after harvest for operator inspection (default false). */
  keepSessions?: boolean;
  /** Injectable command runner (tests). */
  runner?: TmuxRunner;
  /** Polling interval for completion markers (default 250ms). */
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 250;
/** Cap on capture-pane scrollback (-S is exclusive of the first lines). */
const CAPTURE_LINES = 100_000;

interface PreparedRun {
  session: string;
  runDir: string;
}

export function createTmuxHostAdapter(options: TmuxAdapterOptions): HostAdapter {
  const runner = options.runner ?? defaultRunner();
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const prefix = sanitizeSessionName(options.sessionPrefix ?? "swarm-dao");
  const keepSessions = options.keepSessions === true;

  /** Resolve adapter file access against workDir, contained (like other hosts). */
  const containedPath = (file: string): string => {
    const resolved = path.resolve(options.workDir, file);
    const root = path.resolve(options.workDir);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`path escapes the working directory: ${file}`);
    }
    return resolved;
  };

  const prepare = async (proposal: Proposal, agent: DAOAgent, prompt: string): Promise<PreparedRun> => {
    // Sanitize BOTH the session name and the run-directory segment: a
    // hostile agent id ("../../x") can neither name a foreign session nor
    // traverse out of the run directory.
    const safeAgentId = sanitizeSessionName(agent.id);
    const session = `${prefix}-p${proposal.id}-${safeAgentId}`;
    const runDir = path.join(options.workDir, ".dao", "tmux", String(proposal.id), safeAgentId);
    await fs.mkdir(runDir, { recursive: true });
    // Clear stale completion markers so a rerun (e.g. after a crash) cannot
    // harvest the previous attempt's output as this one's.
    await Promise.allSettled(["done"].map((name) => fs.rm(path.join(runDir, name), { force: true })));
    await fs.writeFile(path.join(runDir, "prompt.md"), prompt, "utf8");
    return { session, runDir };
  };

  const startSession = async (run: PreparedRun, command: string): Promise<void> => {
    // Output streams into the pane (live, watchable); the done marker carries
    // the exit code and makes completion observable from the outside. The
    // trailing idle loop keeps the pane (and its scrollback) alive after the
    // program exits — without it the pane dies before the harvest can
    // capture-pane it. keepSessions simply skips the final kill.
    const inner = `PROMPT="$(cat ${quote(path.join(run.runDir, "prompt.md"))})"; ${command}; printf '%s' "$?" > ${quote(path.join(run.runDir, "done"))}; while :; do sleep 3600; done`;
    const sessionProgram = `sh -c ${quote(inner)}`;
    // Clear any stale session with the same name (e.g. a keepSessions
    // leftover) so reruns are deterministic.
    await runner.exec(["tmux", "kill-session", "-t", run.session]);
    // The pane program is a shell program BY DESIGN (it streams the agent's
    // output into the pane); tmux itself runs it via /bin/sh inside the pane.
    // It rides as a single argv element — no host-side shell ever sees it.
    const created = await runner.exec([
      "tmux",
      "new-session",
      "-d",
      "-s",
      run.session,
      "-c",
      options.workDir,
      "sh",
      "-c",
      sessionProgram,
    ]);
    if (created.exitCode !== 0) {
      throw new Error(`tmux new-session failed: ${created.stderr.trim().slice(0, 300)}`);
    }
  };

  const waitForDone = async (
    run: PreparedRun,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; timedOut: boolean }> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const raw = (await fs.readFile(path.join(run.runDir, "done"), "utf8")).trim();
        const exitCode = Number(raw);
        if (Number.isInteger(exitCode)) return { exitCode, timedOut: false };
      } catch {
        // Not done yet.
      }
      if (Date.now() >= deadline) return { exitCode: null, timedOut: true };
      await sleep(pollIntervalMs);
    }
  };

  const harvestPane = async (session: string): Promise<string> => {
    const captured = await runner.exec(["tmux", "capture-pane", "-p", "-S", `-${CAPTURE_LINES}`, "-t", session]);
    // The last line can be the idle marker loop's shell prompt — trim
    // trailing blank noise but keep the agent's own output verbatim.
    // Collapse trailing blank noise to one newline (linear, ReDoS-safe).
    let end = captured.stdout.length;
    while (end > 0 && captured.stdout.charCodeAt(end - 1) === 10) end--;
    return end === captured.stdout.length ? captured.stdout : `${captured.stdout.slice(0, end)}\n`;
  };

  const harvest = async (
    proposal: Proposal,
    agent: DAOAgent,
    prompt: string,
    timeoutMs: number,
    startedAt: number,
  ): Promise<AgentOutput> => {
    const base: AgentOutput = {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: "",
      durationMs: Date.now() - startedAt,
    };

    if (!options.command || options.command.trim().length === 0) {
      return {
        ...base,
        error:
          'tmux.command is not configured: set { "tmux": { "command": "your-agent-cli "$PROMPT"" } } in .dao/config.json ($PROMPT carries the deliberation prompt).',
      };
    }

    const run = await prepare(proposal, agent, prompt);
    try {
      await startSession(run, options.command);
      const { exitCode, timedOut } = await waitForDone(run, timeoutMs);

      if (timedOut) {
        return { ...base, error: `tmux agent ${agent.id} timed out after ${timeoutMs}ms (session ${run.session})` };
      }
      // Capture the pane BEFORE any cleanup kills it.
      const content = await harvestPane(run.session);
      if (exitCode !== 0) {
        return { ...base, content, error: `tmux agent ${agent.id} exited with ${exitCode}` };
      }
      return { ...base, content };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (!keepSessions) {
        await runner.exec(["tmux", "kill-session", "-t", run.session]).catch(() => undefined);
      }
    }
  };

  return {
    hostId: "tmux",
    spawnAgent: async ({ agent, proposal, systemPrompt, timeoutMs }) =>
      harvest(proposal, agent, systemPrompt, timeoutMs ?? defaultTimeoutMs, Date.now()),
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
      const line = `[tmux:${level}] ${message}`;
      await fs.appendFile(path.join(options.workDir, ".dao", "tmux.log"), `${line}\n`, "utf8").catch(() => undefined);
    },
    getWorkingDirectory: () => options.workDir,
    readFile: async (file) => fs.readFile(containedPath(file), "utf8"),
    writeFile: async (file, content) => fs.writeFile(containedPath(file), content, "utf8"),
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

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
