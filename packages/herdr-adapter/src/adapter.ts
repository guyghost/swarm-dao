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
//   herdr agent start <name> --kind <kind> --pane <id> --timeout    (blocks until ready)
//   herdr agent prompt <name> '<prompt>' --wait --timeout           (settles on idle/done/blocked)
//   herdr agent read <name> --source recent-unwrapped --lines N     (ANSI-stripped output)
//   herdr workspace close <id>                                      (unless keepPanes)
//
// Boundary: deliberation is read-only analysis; outputs feed the same
// deterministic tally as every other host. A BLOCKED agent (approval or
// question UI) surfaces as an error output, never as a vote.
//
// Prerequisites: the herdr server must be running (`herdr` once) and the
// chosen kind's executable installed and authenticated.

import { exec as execCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOutput, DAOAgent, HostAdapter, Proposal } from "@guyghost/swarm-dao-core";

/** Minimal command surface the adapter needs (node:child_process-backed by default). */
export interface HerdrRunner {
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const execAsync = promisify(execCallback);

const defaultRunner = (): HerdrRunner => ({
  exec: async (command, options) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
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

/**
 * herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique among
 * live agents. Sanitize deterministically: lowercase, collapse invalid runs,
 * force a leading letter, truncate to 32.
 */
export function sanitizeHerdrName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (cleaned.length === 0) return "agent";
  return /^[a-z]/.test(cleaned) ? cleaned : `a-${cleaned}`.slice(0, 32);
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
  /** Lines of terminal output harvested per agent (default 200). */
  readLines?: number;
  /** Keep the herdr workspaces alive after harvest (default false). */
  keepPanes?: boolean;
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
    workspace?: { workspace_id?: string };
    agent?: { status?: string; state?: string };
  };
  error?: { code?: string; message?: string };
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
  return result?.agent?.status ?? result?.agent?.state ?? null;
}

export function createHerdrHostAdapter(options: HerdrAdapterOptions): HostAdapter {
  const runner = options.runner ?? defaultRunner();
  const defaultTimeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 300_000);
  const startTimeoutMs = Math.min(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, 300_000);
  const readLines = options.readLines ?? DEFAULT_READ_LINES;
  const prefix = sanitizeHerdrName(options.prefix ?? "swarm-dao");
  const keepPanes = options.keepPanes === true;
  const extraArgs = (options.agentArgs ?? []).join(" ").trim();

  /** Resolve adapter file access against workDir, contained (like other hosts). */
  const containedPath = (file: string): string => {
    const resolved = path.resolve(options.workDir, file);
    const root = path.resolve(options.workDir);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`path escapes the working directory: ${file}`);
    }
    return resolved;
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

    if (!options.kind || options.kind.trim().length === 0) {
      return {
        ...base,
        error:
          'herdr.kind is not configured: set { "herdr": { "kind": "pi" } } in .dao/config.json (a supported herdr agent kind whose executable is installed).',
      };
    }

    const name = `${prefix}-p${proposal.id}-${sanitizeHerdrName(agent.id)}`.slice(0, 32);
    let workspaceId: string | null = null;

    try {
      // 1. Isolated workspace with one root pane (never touches the user's layout).
      const created = await runner.exec(
        `herdr workspace create --cwd ${quote(options.workDir)} --label ${quote(name)} --no-focus`,
      );
      if (created.exitCode !== 0) {
        return {
          ...base,
          error: `herdr workspace create failed: ${herdrErrorDetail(created.stderr, created.stdout)} (is the herdr server running? start it with \`herdr\`)`,
        };
      }
      const paneId = parseHerdrJson(created.stdout)?.result?.root_pane?.pane_id ?? null;
      workspaceId = parseHerdrJson(created.stdout)?.result?.workspace?.workspace_id ?? null;
      if (!paneId || !workspaceId) {
        return {
          ...base,
          error: `herdr workspace create returned no pane/workspace id: ${created.stdout.slice(0, 200)}`,
        };
      }

      // 2. Start the agent (blocks until herdr detects it ready for input).
      const started = await runner.exec(
        `herdr agent start ${name} --kind ${options.kind} --pane ${paneId} --timeout ${startTimeoutMs}${extraArgs ? ` -- ${extraArgs}` : ""}`,
      );
      if (started.exitCode !== 0) {
        return {
          ...base,
          error: `herdr agent start (${options.kind}) failed: ${herdrErrorDetail(started.stderr, started.stdout)}`,
        };
      }

      // 3. Prompt and wait for a settled state (idle | done | blocked).
      const prompted = await runner.exec(`herdr agent prompt ${name} ${quote(prompt)} --wait --timeout ${timeoutMs}`);
      if (prompted.exitCode !== 0) {
        const detail = herdrErrorDetail(prompted.stderr, prompted.stdout);
        return { ...base, error: `herdr agent prompt failed (likely timeout): ${detail}` };
      }
      const state = agentState(parseHerdrJson(prompted.stdout)?.result);
      if (state === "blocked") {
        return {
          ...base,
          error: `herdr agent ${agent.id} is blocked (approval/question UI) — it never produced a votable answer. Attach with \`herdr\` to inspect.`,
        };
      }

      // 4. Harvest the ANSI-stripped terminal output.
      const read = await runner.exec(`herdr agent read ${name} --source recent-unwrapped --lines ${readLines}`);
      if (read.exitCode !== 0) {
        return { ...base, error: `herdr agent read failed: ${herdrErrorDetail(read.stderr, read.stdout)}` };
      }
      return { ...base, content: read.stdout.replace(/\n+$/, "\n") };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    } finally {
      // 5. Cleanup — unless the operator wants to inspect the workspace.
      if (!keepPanes && workspaceId) {
        await runner.exec(`herdr workspace close ${workspaceId}`).catch(() => undefined);
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
    readFile: async (file) => fs.readFile(containedPath(file), "utf8"),
    writeFile: async (file, content) => fs.writeFile(containedPath(file), content, "utf8"),
    exec: (command, execOptions) => runner.exec(command, execOptions),
    hasCapability: (capability) => capability === "parallel-spawn",
  };
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
