// ============================================================
// Swarm DAO Core — Bounded Container Command (pure planning)
// ============================================================
// Builds the shell command line that runs one command inside a throwaway
// container (Docker or Apple container): repository/worktree bind-mounted at
// /workspace, network disabled, CPU/memory capped. Every value that reaches
// the command line (image, host path, command) is validated or quoted here;
// anything ambiguous fails closed.
//
// Pure: string in, string out. Executing the command is an effect that lives
// with the caller (improvement-loop sandbox runner, delivery adapters, hosts).
// Boundary, not authority: a sandbox never judges outcomes.

/** Shared mount point for the project workspace inside sandbox containers. */
export const SANDBOX_WORKDIR_MOUNT = "/workspace";

export type SandboxRuntime = "docker" | "container";

export interface SandboxCommandOptions {
  runtime: SandboxRuntime;
  /** OCI image reference (validated; never interpolated unquoted). */
  image: string;
  /** Absolute host path mounted read-write at /workspace. */
  workDir: string;
  cpus?: number;
  memoryMb?: number;
}

/** OCI image reference: optional registry host/port, repo path, tag and/or digest. */
const SAFE_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?(:[a-zA-Z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

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

const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

const boundedInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(parsed, min), max);
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Build the bounded container command line for one command. Both runtimes
 * accept the same option shapes: --rm --network none --cpus N --memory <n>M
 * -v <host>:<target> -w <target> <image> sh -c <command>.
 */
export function buildSandboxCommand(options: SandboxCommandOptions, command: string): string {
  const imageError = validateSandboxImage(options.image);
  if (imageError) throw new Error(imageError);
  if (typeof options.workDir !== "string" || !options.workDir.startsWith("/")) {
    throw new Error("sandbox workDir must be an absolute host path");
  }

  const cpus = boundedInt(options.cpus, DEFAULT_CPUS, 1, 64);
  const memoryMb = boundedInt(options.memoryMb, DEFAULT_MEMORY_MB, 256, 1_048_576);
  const args = [
    options.runtime,
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
