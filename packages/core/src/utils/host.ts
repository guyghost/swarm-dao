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

function assertSafeRelativePath(filePath: string): void {
  if (filePath.includes("\0")) {
    throw new Error("Path traversal denied: null bytes are not allowed");
  }
  if (path.isAbsolute(filePath)) {
    throw new Error(`Path traversal denied: absolute paths are not allowed ("${filePath}")`);
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolveRealBase(baseDir: string): Promise<string> {
  try {
    return await fs.realpath(baseDir);
  } catch {
    return path.resolve(baseDir);
  }
}

async function assertRealPathContained(resolvedPath: string, resolvedBase: string): Promise<void> {
  try {
    const realPath = await fs.realpath(resolvedPath);
    if (!isPathInsideRoot(resolvedBase, realPath)) {
      throw new Error(`Path traversal denied: resolved path escapes base directory`);
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: string }).code : "";
    if (code === "ENOENT") {
      const parent = path.dirname(resolvedPath);
      if (parent !== resolvedPath) {
        try {
          const realParent = await fs.realpath(parent);
          if (!isPathInsideRoot(resolvedBase, realParent)) {
            throw new Error(`Path traversal denied: parent path escapes base directory`);
          }
        } catch (parentError) {
          const parentCode =
            typeof parentError === "object" && parentError !== null && "code" in parentError
              ? (parentError as { code: string }).code
              : "";
          if (parentCode !== "ENOENT") {
            throw parentError;
          }
        }
      }
      return;
    }
    throw error;
  }
}

async function resolveContainedPath(filePath: string, baseDir: string): Promise<string> {
  assertSafeRelativePath(filePath);
  const resolvedBase = await resolveRealBase(baseDir);
  const resolvedPath = path.resolve(resolvedBase, filePath);
  if (!isPathInsideRoot(resolvedBase, resolvedPath)) {
    throw new Error(`Path traversal denied: "${filePath}" is outside "${baseDir}"`);
  }
  await assertRealPathContained(resolvedPath, resolvedBase);
  return resolvedPath;
}

/** Read a file as UTF-8, with optional path containment enforcement. */
export async function readFileContained(filePath: string, baseDir?: string): Promise<string> {
  if (baseDir) {
    const resolved = await resolveContainedPath(filePath, baseDir);
    return fs.readFile(resolved, "utf-8");
  }
  return fs.readFile(filePath, "utf-8");
}

/** Write a file as UTF-8, with optional path containment enforcement. */
export async function writeFileContained(filePath: string, content: string, baseDir?: string): Promise<void> {
  if (baseDir) {
    const resolved = await resolveContainedPath(filePath, baseDir);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  await fs.writeFile(filePath, content, "utf-8");
}
