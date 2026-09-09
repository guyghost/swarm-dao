// Swarm DAO — Improvement Orchestrator herdr worker executor.
// Runs one Improvement Loop AI worker (sensor, counter-sensor, drift-auditor)
// as a real coding agent inside a herdr workspace, mirroring the battle-tested
// lifecycle of packages/herdr-adapter:
//   herdr workspace create --cwd <repo> --label <name> --no-focus
//     (or `herdr worktree open --workspace <parent>` for series-worktree
//      workers, linking the child to the parent session's Spaces entry)
//   herdr agent start <name> --kind <kind> --pane <id> --timeout <ms> -- <args>
//   herdr agent prompt <name> '<prompt>'
//   herdr agent read <name> --source recent-unwrapped --lines N   (polled)
//   herdr workspace close <id>
//
// State-detection-free harvest (#148): herdr state detection misreads busy
// coding-agent panes — `agent prompt --wait` reports agent_prompt_stalled
// with a frozen state_change_seq while the worker works, and grace-poll
// recovery re-prompts a live worker (double submission). The prompt is
// therefore submitted without --wait and the transcript is polled directly:
// the attempt ends when its last JSON object satisfies the worker contract,
// the output settles without one, or the deadline expires.
//
// Readiness race: workspace create returns before the fresh pane's shell has
// reached its interactive prompt, and herdr's agent start classifies such a
// pane as busy (agent_pane_busy) instead of waiting for the prompt — slower
// shell init under herd load makes this intermittent. agent start is therefore
// retried on the SAME pane (1 s apart) until the readiness budget is spent, so
// one slow shell init no longer burns a whole attempt.
//
// Boundary: a blocked, timed-out, or unparseable worker is an ERROR, never a
// signal (models/improvement-orchestrator.md). Executor retries are
// effect-level, bounded, and idempotent (fresh workspace per attempt); they
// never change series or cycle state.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ORCHESTRATOR_MAX_WORKER_RETRIES } from "@guyghost/swarm-dao-core/models/improvement";
import type { HerdrRunner } from "@guyghost/swarm-dao-herdr-adapter";
import {
  createChildWorkspace,
  herdrParentWorkspaceId,
  sanitizeHerdrName,
  startAgentUntilReady,
  trimTrailingNewlines,
} from "@guyghost/swarm-dao-herdr-adapter";

/** execFile with utf8 strings, promise-shaped. Failures reject with the child
 * error carrying .code/.stdout/.stderr. Commands are ARGV — never shell
 * strings — so worker prompts and labels are never shell-interpreted. */
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

export interface HerdrWorkerOptions {
  /** Repository root the worker workspaces run in. */
  workDir: string;
  /** herdr agent kind (default "pi"). */
  kind?: string;
  /** Extra args passed to the agent executable. Default: ["-ne"] for the pi
   * kind (signal-only workers must not carry the dao_* extension tools), plus
   * an explicit -e to herdr's state reporter when it is installed so herdr
   * keeps a lifecycle state authority on the worker pane; other kinds default
   * to no extra args. */
  agentArgs?: readonly string[];
  /** Path checked (for existence) before appending `-e` to the pi kind
   * default args. Default: herdr's pi integration install location. */
  piStateReporterPath?: string;
  /** Parent herdr workspace id for child-session linkage (default:
   * HERDR_WORKSPACE_ID when running inside a herdr pane). Series-worktree
   * workers open nested under it; same-checkout workers get a parent token. */
  parentWorkspaceId?: string;
  /** Per-attempt harvest deadline in ms (default 10 min; ceiling 15 min).
   * The old herdr --wait cap no longer applies: real observation work
   * (running repo measurements, reading models) legitimately takes 5–10 min
   * under load. */
  timeoutMs?: number;
  /** agent start readiness timeout in ms (default 120 s; herdr max 300000). */
  startTimeoutMs?: number;
  /** Lines of terminal output harvested per worker (default 200). */
  readLines?: number;
  /** Keep the herdr workspaces alive after harvest (default false). */
  keepPanes?: boolean;
  /** Delay between same-pane agent start readiness retries (default 1 s; 0
   * only for tests). */
  readinessRetryDelayMs?: number;
  /** Delay between transcript harvest polls (default 5 s; 0 only for
   * tests). */
  pollIntervalMs?: number;
  /** Injectable command runner (tests). */
  runner?: HerdrRunner;
}

export type WorkerHarvest = Readonly<{ ok: true; content: string } | { ok: false; error: string }>;

/** herdr kinds are identifiers — anything else is refused, never interpolated. */
export const SAFE_HERDR_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/** Default extra args for the pi kind: worker agents are signal-only and must
 * not carry the dao_* extension tools; disabling extension discovery also
 * sidesteps the local .pi extension conflict. Other kinds use their own
 * defaults unless the caller passes explicit agentArgs. */
export const DEFAULT_PI_AGENT_ARGS: readonly string[] = ["-ne"];

/** Default install path of herdr's pi state integration (reported by
 * `herdr integration status`); herdr's lifecycle state authority for pi. */
export const PI_STATE_REPORTER_PATH = path.join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");

/**
 * pi worker args with herdr's state reporter loaded explicitly when it is
 * installed. -ne disables extension discovery, so without this the reporter
 * never loads and herdr falls back to screen-manifest detection — which
 * matches no rule on a fast worker pane, herdr observes no state change, and
 * every `agent prompt --wait` trips agent_prompt_stalled with a frozen
 * state_change_seq while the worker actually completes (reproduced live).
 * Explicit -e still works under -ne, and discovery stays off, so the dao_*
 * extension tools are still never loaded.
 */
export function piWorkerAgentArgs(reporterPath: string = PI_STATE_REPORTER_PATH): readonly string[] {
  return existsSync(reporterPath) ? [...DEFAULT_PI_AGENT_ARGS, "-e", reporterPath] : DEFAULT_PI_AGENT_ARGS;
}

/**
 * Escape raw control characters that are illegal inside JSON string literals.
 * Terminal hard-wraps inject literal newlines mid-string (observed on real
 * herdr `agent read --source recent-unwrapped` harvests); whitespace between
 * JSON tokens is preserved — only in-string characters are rewritten.
 */
const escapeInStringControls = (candidate: string): string => {
  let repaired = "";
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (inString && !escaped) {
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char === "\n") {
        repaired += "\\n";
        continue;
      } else if (char === "\r") {
        repaired += "\\r";
        continue;
      } else if (char === "\t") {
        repaired += "\\t";
        continue;
      }
    } else if (inString && escaped) {
      if (char === "\n" || char === "\r" || char === "\t") {
        // Hard-wrap injected between the backslash and its escaped character:
        // drop the artifact and keep consuming the escape (Copilot review on #79).
        continue;
      }
      escaped = false;
    } else if (char === '"') {
      inString = true;
    }
    repaired += char;
  }
  return repaired;
};

// Numeric options reach herdr command lines as argv elements, so they must be
// finite integers within bounds even when callers bypass the TypeScript types
// (e.g. JSON config); anything else falls back to the default.
export const toBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

function herdrErrorDetail(stderr: string, stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stderr.trim() || stdout.trim());
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { code, message } = (parsed as { error: { code?: string; message?: string } }).error;
      return [code, message].filter((part) => part && part.length > 0).join(": ");
    }
  } catch {
    // fall through to raw output
  }
  return (stderr.trim() || stdout.trim() || "unknown herdr error").slice(0, 300);
}

interface HerdrJson {
  result?: {
    root_pane?: { pane_id?: string };
    workspace?: { workspace_id?: string };
    workspaces?: Array<{ label?: string; workspace_id?: string }>;
  };
}

function parseHerdrJson(raw: string): HerdrJson | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HerdrJson) : null;
  } catch {
    return null;
  }
}

/** Close workspaces left behind by a run killed mid-flight (host timeout,
 * crash): the labels are deterministic per worker, so any workspace carrying
 * our label (or a retry variant) when we start is an orphan from a previous
 * attempt. Retries must converge instead of accumulating orphan panes
 * (dogfood-003 c6 finding: two MCP client timeouts left two workspaces). */
async function closeLingeringWorkspaces(runner: HerdrRunner, baseName: string): Promise<void> {
  let listed: Awaited<ReturnType<HerdrRunner["exec"]>>;
  try {
    listed = await runner.exec(["herdr", "workspace", "list"]);
  } catch {
    return; // listing is best-effort; creation will surface real errors
  }
  if (listed.exitCode !== 0) return;
  const workspaces = parseHerdrJson(listed.stdout)?.result?.workspaces ?? [];
  for (const workspace of workspaces) {
    const label = typeof workspace.label === "string" ? workspace.label : "";
    if (!workspace.workspace_id || (label !== baseName && !label.startsWith(`${baseName}-r`))) continue;
    await runner.exec(["herdr", "workspace", "close", workspace.workspace_id]).catch(() => undefined);
  }
}

/**
 * Run one worker prompt inside a herdr workspace, with bounded effect-level
 * retries (fresh workspace and unique agent name per attempt).
 */
export async function runHerdrWorker(
  options: HerdrWorkerOptions,
  name: string,
  prompt: string,
): Promise<WorkerHarvest> {
  const runner = options.runner ?? defaultRunner();
  const kind = options.kind ?? "pi";
  const agentArgs = options.agentArgs ?? (kind === "pi" ? piWorkerAgentArgs(options.piStateReporterPath) : []);
  // The harvest deadline bounds the whole attempt; readLines is capped to
  // keep the read command (and the harvested transcript) bounded.
  const timeoutMs = toBoundedInt(options.timeoutMs, 600_000, 1_000, 900_000);
  const startTimeoutMs = toBoundedInt(options.startTimeoutMs, 120_000, 1_000, 300_000);
  const readLines = toBoundedInt(options.readLines, 200, 1, 10_000);
  const readinessRetryDelayMs = toBoundedInt(options.readinessRetryDelayMs, 1_000, 0, 60_000);
  const pollIntervalMs = toBoundedInt(options.pollIntervalMs, 5_000, 0, 60_000);
  const parentWorkspaceId = options.parentWorkspaceId ?? herdrParentWorkspaceId();

  if (!SAFE_HERDR_KIND.test(kind))
    return { ok: false, error: `herdr kind '${kind}' is not a valid agent kind identifier.` };
  const baseName = sanitizeHerdrName(name);

  const maxAttempts = ORCHESTRATOR_MAX_WORKER_RETRIES + 1;
  let lastError = "unknown worker error";

  // Orphaned workspace from a killed previous run under the same label?
  // Close it before carving a fresh one.
  await closeLingeringWorkspaces(runner, baseName);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const agentName = attempt === 1 ? baseName : `${baseName}-r${attempt}`.slice(0, 32);
    let workspaceId: string | null = null;
    try {
      // Linked to the parent herdr session when one is detectable: series
      // worktree workers nest under it in the Spaces sidebar (linked
      // worktree children); same-checkout workers get a parent token.
      const created = await createChildWorkspace(runner, {
        workDir: options.workDir,
        label: agentName,
        parentWorkspaceId,
      });
      if (!created.ok) {
        lastError = created.error;
        continue;
      }
      const paneId = created.paneId;
      workspaceId = created.workspaceId;

      // agent_pane_busy is transient (pane not yet at its shell prompt):
      // startAgentUntilReady retries on the same pane until the readiness
      // budget is spent; any other code surfaces immediately.
      const started = await startAgentUntilReady(runner, {
        agentName,
        kind,
        paneId,
        timeoutMs: startTimeoutMs,
        agentArgs,
        retryDelayMs: readinessRetryDelayMs,
      });
      if (started.exitCode !== 0) {
        lastError = `herdr agent start (${kind}) failed: ${herdrErrorDetail(started.stderr, started.stdout)}`;
        continue;
      }

      // 3. Submit the prompt without waiting on herdr state detection: busy
      // coding-agent panes read as idle with a frozen state_change_seq, so
      // --wait stalls on live workers and grace-poll recovery re-prompts
      // them (double submission). The transcript itself is the authority
      // (issue #148); at most one prompt per attempt, ever.
      const prompted = await runner.exec(["herdr", "agent", "prompt", agentName, prompt]);
      if (prompted.exitCode !== 0) {
        lastError = `herdr agent prompt failed: ${herdrErrorDetail(prompted.stderr, prompted.stdout)}`;
        continue;
      }

      // 4. Harvest the transcript until the last JSON object satisfies the
      // worker contract, the output settles without one, or the deadline
      // expires. Read failures are transient: poll again until the deadline.
      const deadline = Date.now() + timeoutMs;
      let content = "";
      let previousLength = -1;
      let stablePolls = 0;
      let readError: string | null = null;
      let harvested: string | null = null;
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const read = await runner.exec([
          "herdr",
          "agent",
          "read",
          agentName,
          "--source",
          "recent-unwrapped",
          "--lines",
          String(readLines),
        ]);
        if (read.exitCode !== 0) {
          readError = herdrErrorDetail(read.stderr, read.stdout);
          continue;
        }
        readError = null;
        content = trimTrailingNewlines(read.stdout);
        if (isWorkerContract(extractLastJsonObject(content))) {
          harvested = content;
          break;
        }
        // Settled output that never satisfies the contract (blocked UI,
        // prose-only transcript): four identical non-empty polls are enough.
        if (content.length > 0 && content.length === previousLength) stablePolls += 1;
        else stablePolls = 0;
        previousLength = content.length;
        if (stablePolls >= 4) break;
      }
      if (harvested !== null) return { ok: true, content: harvested };

      // Attempt failure with field diagnostics: captured size and the last
      // parsed JSON fragment for post-mortems. Blocked-agent detection is
      // deliberately gone — a blocked UI settles without a contract, and
      // environment-level "cannot measure" halts at the anchor layer (#145).
      const lastJson = extractLastJsonObject(content);
      const fragment = lastJson === null ? "none" : JSON.stringify(lastJson).slice(0, 300);
      lastError =
        `herdr agent ${agentName} settled without a valid contract` +
        (readError !== null ? ` (last read error: ${readError})` : "") +
        ` (captured ${content.length} chars, last JSON: ${fragment})`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (!options.keepPanes && workspaceId) {
        await runner.exec(["herdr", "workspace", "close", workspaceId]).catch(() => undefined);
      }
    }
  }
  return { ok: false, error: `worker ${baseName} failed after ${maxAttempts} attempts: ${lastError}` };
}

/**
 * Resolve after ms milliseconds — harvest poll pacing.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFilled = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The worker contract: the transcript's last JSON object must carry a
 * resolved answer — a sample contract (sensor / counter-sensor) or a drift
 * contract (drift-auditor) — with non-placeholder evidence. The echoed prompt
 * contains the JSON template itself ("improved|held|declined",
 * "<concise observation>"), so a matching shape alone is not enough (issue
 * #148).
 */
export function isWorkerContract(candidate: Record<string, unknown> | null): boolean {
  if (candidate === null) return false;
  const sample = isRecord(candidate.sample) ? candidate.sample : null;
  // Contract shape: a sample object or a named drift class.
  if (sample === null && !isFilled(candidate.driftClass)) return false;
  // The echoed template's sample.value is the "improved|held|declined" menu.
  const value = sample?.value;
  if (typeof value === "string" && value.includes("|")) return false;
  // Evidence must be real prose; "<...>" is the unfilled prompt placeholder.
  // Drift answers carry it at top level, not under sample.
  const evidence = sample?.evidence ?? candidate.evidence ?? candidate.driftEvidence;
  return isFilled(evidence) && !evidence.startsWith("<");
}

/**
 * Extract the worker's JSON answer from a harvested transcript. Agents echo
 * the prompt (which itself contains JSON templates), so only the LAST JSON
 * object in the transcript is the answer; earlier ones are ignored.
 */
export function extractLastJsonObject(content: string): Record<string, unknown> | null {
  const lastClose = content.lastIndexOf("}");
  if (lastClose === -1) return null;
  let open = content.lastIndexOf("{", lastClose);
  for (let scans = 0; open !== -1 && scans < 50; scans++, open = content.lastIndexOf("{", open - 1)) {
    const raw = content.slice(open, lastClose + 1);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      try {
        const repaired: unknown = JSON.parse(escapeInStringControls(raw));
        if (typeof repaired === "object" && repaired !== null && !Array.isArray(repaired)) {
          return repaired as Record<string, unknown>;
        }
      } catch {
        // walk back to the previous opening brace
      }
    }
  }
  return null;
}
