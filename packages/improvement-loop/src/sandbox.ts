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

export type SandboxMode = "none" | "docker" | "container" | "auto";

export const SANDBOX_WORKDIR_MOUNT = "/workspace";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_TIMEOUT_MS = 600_000;
/** OCI image reference: optional registry host, repo path, optional tag/digest. */
const SAFE_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?(:[a-zA-Z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

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

const boundedInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(parsed, min), max);
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Fail closed on anything that is not a plain OCI image reference. */
export function validateSandboxImage(image: string): string | null {
  if (typeof image !== "string" || image.length === 0 || image.length > 256) {
    return "sandbox image must be a non-empty image reference";
  }
  if (!SAFE_IMAGE.test(image)) {
    return `sandbox image '${image}' is not a plain OCI reference (registry/repo[:tag][@digest])`;
  }
  return null;
}

/** Build the bounded container command line for one anchor command. */
export function buildSandboxCommand(options: SandboxOptions, command: string): string {
  const imageError = validateSandboxImage(options.image);
  if (imageError) throw new Error(imageError);
  if (typeof options.workDir !== "string" || !options.workDir.startsWith("/")) {
    throw new Error("sandbox workDir must be an absolute host path");
  }

  const cpus = boundedInt(options.cpus, DEFAULT_CPUS, 1, 64);
  const memoryMb = boundedInt(options.memoryMb, DEFAULT_MEMORY_MB, 256, 1_048_576);
  const runtime = options.mode === "docker" ? "docker" : "container";
  // Both runtimes accept: --rm --network none --cpus N --memory <n>M -v host:target -w dir image sh -c cmd
  const args = [
    runtime,
    "run",
    "--rm",
    "--network",
    "none",
    "--cpus",
    String(cpus),
    "--memory",
    `${memoryMb}M`,
    "-v",
    shellQuote(`${options.workDir}:${SANDBOX_WORKDIR_MOUNT}`),
    "-w",
    SANDBOX_WORKDIR_MOUNT,
    options.image,
    "sh",
    "-c",
    shellQuote(command),
  ];
  return args.join(" ");
}

const tail = (value: string, max: number): string => (value.length <= max ? value : `…${value.slice(-max + 1)}`);

/**
 * An AnchorCommandRunner that executes each command inside a fresh bounded
 * container. Errors surface as { ok: false } outcomes — an anchor honestly
 * failed — never as thrown exceptions above the machine.
 */
export function createSandboxRunCommand(
  options: SandboxOptions,
  runner: SandboxExecRunner = defaultExecRunner,
): AnchorCommandRunner {
  return async (command: string): Promise<AnchorCommandOutcome> => {
    const line = buildSandboxCommand(options, command);
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
