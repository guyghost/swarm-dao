// ============================================================
// Swarm DAO Core — Shared host-adapter utilities
// ============================================================

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function parseCommand(command: string): { file: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command cannot be empty");
  }
  if (/[|&;<>()`$\n\r]/.test(trimmed)) {
    throw new Error("Unsafe command: shell metacharacters are not allowed");
  }
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length === 0) {
    throw new Error("Command cannot be empty");
  }
  const decodeToken = (token: string): string => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  };
  const file = decodeToken(tokens[0] ?? "");
  const args = tokens.slice(1).map(decodeToken);
  if (!file) {
    throw new Error("Command executable is required");
  }
  return { file, args };
}

/** Spawn wrapper using shell-free execution to avoid command injection risks. */
export function execCommand(
  command: string,
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let parsed: { file: string; args: string[] };
    try {
      parsed = parseCommand(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ stdout: "", stderr: message, exitCode: 1 });
      return;
    }

    const child = spawn(parsed.file, parsed.args, {
      cwd: options?.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options?.timeout;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 });
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        resolve({
          stdout,
          stderr: `${stderr}${stderr.endsWith("\n") ? "" : "\n"}Command timed out after ${timeoutMs}ms`,
          exitCode: 124,
        });
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function resolveContainedPath(filePath: string, baseDir: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, filePath);

  // Ensure base has a trailing separator for a foolproof prefix check,
  // handle the case where it might already have one (like root "/").
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;

  // The path is contained if it IS the base directory, OR if it starts with "base + separator"
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(baseWithSep)) {
    throw new Error(`Path traversal denied: "${filePath}" is outside "${baseDir}"`);
  }
  return resolvedPath;
}

/** Read a file as UTF-8, with optional path containment enforcement. */
export async function readFileContained(filePath: string, baseDir?: string): Promise<string> {
  if (baseDir) {
    const resolved = resolveContainedPath(filePath, baseDir);
    return fs.readFile(resolved, "utf-8");
  }
  return fs.readFile(filePath, "utf-8");
}

/** Write a file as UTF-8, with optional path containment enforcement. */
export async function writeFileContained(filePath: string, content: string, baseDir?: string): Promise<void> {
  if (baseDir) {
    const resolved = resolveContainedPath(filePath, baseDir);
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  await fs.writeFile(filePath, content, "utf-8");
}
