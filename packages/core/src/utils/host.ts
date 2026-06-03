// ============================================================
// Swarm DAO Core — Shared host-adapter utilities
// ============================================================

import { exec as nodeExec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Promisified wrapper around child_process.exec. */
export function execCommand(
  command: string,
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    nodeExec(command, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function resolveContainedPath(filePath: string, baseDir: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, filePath);
  const relative = path.relative(resolvedBase, resolvedPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
