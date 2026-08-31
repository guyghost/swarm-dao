// Swarm DAO — Improvement Orchestrator herdr worker executor.
// Runs one Improvement Loop AI worker (sensor, counter-sensor, drift-auditor)
// as a real coding agent inside a herdr workspace, mirroring the battle-tested
// lifecycle of packages/herdr-adapter:
//   herdr workspace create --cwd <repo> --label <name> --no-focus
//   herdr agent start <name> --kind <kind> --pane <id> --timeout <ms> -- <args>
//   herdr agent prompt <name> '<prompt>' --wait --timeout <ms>
//   herdr agent read <name> --source recent-unwrapped --lines N
//   herdr workspace close <id>
//
// Boundary: a blocked, timed-out, or unparseable worker is an ERROR, never a
// signal (models/improvement-orchestrator.md). Executor retries are
// effect-level, bounded, and idempotent (fresh workspace per attempt); they
// never change series or cycle state.

import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { ORCHESTRATOR_MAX_WORKER_RETRIES } from "@guyghost/swarm-dao-core/models/improvement";
import type { HerdrRunner } from "@guyghost/swarm-dao-herdr-adapter";
import { sanitizeHerdrName } from "@guyghost/swarm-dao-herdr-adapter";

const execAsync = promisify(execCallback);

const defaultRunner = (): HerdrRunner => ({
  exec: async (command, options) => {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: options?.cwd, timeout: options?.timeout });
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
  /** Extra args passed to the agent executable. Default ["-ne"]: worker agents
   * are signal-only and must not carry the dao_* extension tools; disabling
   * extension discovery also sidesteps the local .pi extension conflict. */
  agentArgs?: readonly string[];
  /** Per-attempt prompt timeout in ms (default 5 min; herdr max 300000). */
  timeoutMs?: number;
  /** agent start readiness timeout in ms (default 120 s; herdr max 300000). */
  startTimeoutMs?: number;
  /** Lines of terminal output harvested per worker (default 200). */
  readLines?: number;
  /** Keep the herdr workspaces alive after harvest (default false). */
  keepPanes?: boolean;
  /** Injectable command runner (tests). */
  runner?: HerdrRunner;
}

export type WorkerHarvest = Readonly<{ ok: true; content: string } | { ok: false; error: string }>;

const SAFE_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

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

// Numeric options are interpolated into herdr shell commands, so they must be
// finite integers within bounds even when callers bypass the TypeScript types
// (e.g. JSON config); anything else falls back to the default.
export const toBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

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
    agent?: { status?: string; state?: string };
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

function agentState(result: HerdrJson["result"]): string | null {
  return result?.agent?.status ?? result?.agent?.state ?? null;
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
  const agentArgs = options.agentArgs ?? ["-ne"];
  // herdr's own timeout ceiling is 300000ms; readLines is capped to keep the
  // read command (and the harvested transcript) bounded.
  const timeoutMs = toBoundedInt(options.timeoutMs, 300_000, 1_000, 300_000);
  const startTimeoutMs = toBoundedInt(options.startTimeoutMs, 120_000, 1_000, 300_000);
  const readLines = toBoundedInt(options.readLines, 200, 1, 10_000);
  const extraArgs = agentArgs.map((arg) => quote(arg)).join(" ");

  if (!SAFE_KIND.test(kind)) return { ok: false, error: `herdr kind '${kind}' is not a valid agent kind identifier.` };
  const baseName = sanitizeHerdrName(name);

  const maxAttempts = ORCHESTRATOR_MAX_WORKER_RETRIES + 1;
  let lastError = "unknown worker error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const agentName = attempt === 1 ? baseName : `${baseName}-r${attempt}`.slice(0, 32);
    let workspaceId: string | null = null;
    try {
      const created = await runner.exec(
        `herdr workspace create --cwd ${quote(options.workDir)} --label ${quote(agentName)} --no-focus`,
      );
      if (created.exitCode !== 0) {
        lastError = `herdr workspace create failed: ${herdrErrorDetail(created.stderr, created.stdout)}`;
        continue;
      }
      const paneId = parseHerdrJson(created.stdout)?.result?.root_pane?.pane_id ?? null;
      workspaceId = parseHerdrJson(created.stdout)?.result?.workspace?.workspace_id ?? null;
      if (!paneId || !workspaceId) {
        lastError = `herdr workspace create returned no pane/workspace id: ${created.stdout.slice(0, 200)}`;
        continue;
      }

      const started = await runner.exec(
        `herdr agent start ${agentName} --kind ${kind} --pane ${paneId} --timeout ${startTimeoutMs}${extraArgs ? ` -- ${extraArgs}` : ""}`,
      );
      if (started.exitCode !== 0) {
        lastError = `herdr agent start (${kind}) failed: ${herdrErrorDetail(started.stderr, started.stdout)}`;
        continue;
      }

      const prompted = await runner.exec(
        `herdr agent prompt ${agentName} ${quote(prompt)} --wait --timeout ${timeoutMs}`,
      );
      if (prompted.exitCode !== 0) {
        lastError = `herdr agent prompt failed (likely timeout): ${herdrErrorDetail(prompted.stderr, prompted.stdout)}`;
        continue;
      }
      if (agentState(parseHerdrJson(prompted.stdout)?.result) === "blocked") {
        lastError = `herdr agent ${agentName} is blocked (approval/question UI) — it never produced a signal.`;
        continue;
      }

      const read = await runner.exec(`herdr agent read ${agentName} --source recent-unwrapped --lines ${readLines}`);
      if (read.exitCode !== 0) {
        lastError = `herdr agent read failed: ${herdrErrorDetail(read.stderr, read.stdout)}`;
        continue;
      }
      return { ok: true, content: read.stdout.replace(/\n+$/, "\n") };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (!options.keepPanes && workspaceId) {
        await runner.exec(`herdr workspace close ${workspaceId}`).catch(() => undefined);
      }
    }
  }
  return { ok: false, error: `worker ${baseName} failed after ${maxAttempts} attempts: ${lastError}` };
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
