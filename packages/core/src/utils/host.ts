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
      resolve({ stdout, stderr, exitCode: error ? ((error.code as number) ?? 1) : 0 });
    });
  });
}

/** Read a file as UTF-8, with optional path containment enforcement. */
export async function readFileContained(filePath: string, baseDir?: string): Promise<string> {
  if (baseDir) {
    const resolved = path.resolve(baseDir, filePath);
    if (!resolved.startsWith(path.resolve(baseDir))) {
      throw new Error(`Path traversal denied: "${filePath}" is outside "${baseDir}"`);
    }
    return fs.readFile(resolved, "utf-8");
  }
  return fs.readFile(filePath, "utf-8");
}

/** Write a file as UTF-8, with optional path containment enforcement. */
export async function writeFileContained(filePath: string, content: string, baseDir?: string): Promise<void> {
  if (baseDir) {
    const resolved = path.resolve(baseDir, filePath);
    if (!resolved.startsWith(path.resolve(baseDir))) {
      throw new Error(`Path traversal denied: "${filePath}" is outside "${baseDir}"`);
    }
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  await fs.writeFile(filePath, content, "utf-8");
}
