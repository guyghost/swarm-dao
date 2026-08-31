// ============================================================
// Swarm DAO Improvement Loop — bounded sandbox execution
// ============================================================
// Runs a project's ground-truth anchor commands inside a throwaway container
// (Docker or Apple container) instead of on the host: the repository is bind-
// mounted at /workspace, networking is disabled, and CPU/memory are capped.
// Every value that reaches a shell command line (image, host path, command)
// is validated or quoted here; anything ambiguous fails closed.
//
// Boundary: this module executes commands, it never judges them. Verdicts
// stay with the improvement machine; a sandbox is a boundary, not an authority.

import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildSandboxCommand, SANDBOX_WORKDIR_MOUNT, validateSandboxImage } from "@guyghost/swarm-dao-core/delivery";

export type SandboxMode = "none" | "docker" | "container" | "auto";

// The pure container command builder and image validation live in core
// (delivery/sandbox-command) and are shared with the delivery layer; this
// module keeps the executor-side concerns (runtime detection, outcome runner).

const DEFAULT_TIMEOUT_MS = 600_000;

export interface SandboxOptions {
  mode: Exclude<SandboxMode, "none">;
  /** OCI image reference (validated; never interpolated unquoted). */
  image: string;
  /** Absolute host path mounted read-write at /workspace. */
  workDir: string;
  cpus?: number;
  memoryMb?: number;
  timeoutMs?: number;
}

type AnchorCommandOutcome = import("./orchestrator.js").AnchorCommandOutcome;
export type SandboxExecRunner = (
  command: string,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type AnchorCommandRunner = (command: string) => Promise<AnchorCommandOutcome>;

export type { SandboxCommandOptions } from "@guyghost/swarm-dao-core/delivery";
export { buildSandboxCommand, SANDBOX_WORKDIR_MOUNT, validateSandboxImage };

const execAsync = promisify(execCallback);

const defaultExecRunner: SandboxExecRunner = async (command, timeoutMs) => {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "command failed",
      exitCode: Number.isInteger(failure.code) ? (failure.code as number) : 1,
    };
  }
};

const tail = (value: string, max: number): string => (value.length <= max ? value : `…${value.slice(-max + 1)}`);

/**
 * An AnchorCommandRunner that executes each command inside a fresh bounded
 * container. Errors surface as { ok: false } outcomes — an anchor honestly
 * failed — never as thrown exceptions above the machine.
 */
export function createSandboxRunCommand(
  options: SandboxOptions & { mode: Exclude<SandboxMode, "none" | "auto"> },
  runner: SandboxExecRunner = defaultExecRunner,
): AnchorCommandRunner {
  return async (command: string): Promise<AnchorCommandOutcome> => {
    const line = buildSandboxCommand({ ...options, runtime: options.mode }, command);
    const result = await runner(line, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      const detail = [result.stderr, result.stdout].filter((part) => part && part.length > 0).join(" ");
      return { ok: false, detail: tail(detail.trim(), 300) || `exit ${result.exitCode}` };
    }
    return { ok: true, detail: tail(result.stdout.trim(), 300) || "exit 0" };
  };
}

/** Probe a runtime binary by executing its version command. */
async function hasRuntime(binary: "docker" | "container", runner: SandboxExecRunner): Promise<boolean> {
  const probe = await runner(`${binary} --version`, 10_000);
  return probe.exitCode === 0;
}

/**
 * Resolve an explicit or auto-detected sandbox mode. "auto" prefers Apple
 * container on macOS-capable hosts, then Docker. Returns null for "none"
 * (caller uses default host execution). Throws when auto-detection finds no
 * runtime — an unreachable sandbox must never silently degrade to the host.
 */
export async function resolveSandboxMode(
  requested: SandboxMode,
  runner: SandboxExecRunner = defaultExecRunner,
): Promise<Exclude<SandboxMode, "none" | "auto"> | null> {
  if (requested === "none") return null;
  if (requested === "docker" || requested === "container") return requested;
  if (await hasRuntime("container", runner)) return "container";
  if (await hasRuntime("docker", runner)) return "docker";
  throw new Error("sandbox mode 'auto' found neither Apple container nor Docker on this host");
}

export interface SandboxRequest {
  sandbox?: SandboxMode;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  timeoutMs?: number;
}

/**
 * Build the sandbox AnchorCommandRunner for an `improve once` invocation from
 * CLI flags layered over `.dao/improvement.json` options. Returns null when
 * the resolved mode is "none" (caller falls back to host execution). Explicit
 * flags win over config; a sandbox mode without an image fails loudly.
 */
export async function resolveSandboxRunCommand(
  request: SandboxRequest,
  workDir: string,
  runner: SandboxExecRunner = defaultExecRunner,
): Promise<AnchorCommandRunner | null> {
  const mode = await resolveSandboxMode(request.sandbox ?? "none", runner);
  if (mode === null) return null;
  const image = request.image;
  const imageError = image === undefined ? "sandbox execution requires an image" : validateSandboxImage(image);
  if (imageError) throw new Error(imageError);
  return createSandboxRunCommand(
    {
      mode,
      image: image as string,
      workDir,
      cpus: request.cpus,
      memoryMb: request.memoryMb,
      timeoutMs: request.timeoutMs,
    },
    runner,
  );
}
