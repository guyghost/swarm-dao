import { promises as fs } from "node:fs";
import path from "node:path";

function assertSafeRelativeRoot(relativeRoot: string): void {
  if (relativeRoot.includes("\0")) {
    throw new Error("Path traversal denied: null bytes are not allowed");
  }
  if (relativeRoot.trim() === "") {
    throw new Error("Path traversal denied: empty roots are not allowed");
  }
  if (path.isAbsolute(relativeRoot)) {
    throw new Error(`Path traversal denied: absolute paths are not allowed ("${relativeRoot}")`);
  }
  const segments = relativeRoot.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Path traversal denied: ".." segments are not allowed ("${relativeRoot}")`);
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
}

async function resolveRealBase(baseDir: string): Promise<string> {
  try {
    return await fs.realpath(baseDir);
  } catch {
    return path.resolve(baseDir);
  }
}

function getErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code: string }).code : "";
}

async function assertNearestExistingParentContained(resolvedPath: string, resolvedBase: string): Promise<void> {
  let parent = path.dirname(resolvedPath);
  while (true) {
    if (parent === resolvedPath) {
      return;
    }
    try {
      const realParent = await fs.realpath(parent);
      if (!isPathInsideRoot(resolvedBase, realParent)) {
        throw new Error("Path traversal denied: parent path escapes base directory");
      }
      return;
    } catch (parentError) {
      const parentCode = getErrorCode(parentError);
      if (parentCode !== "ENOENT") {
        throw parentError;
      }
      if (parent === resolvedBase) {
        return;
      }
      const nextParent = path.dirname(parent);
      if (nextParent === parent) {
        return;
      }
      parent = nextParent;
    }
  }
}

async function assertRealPathContained(resolvedPath: string, resolvedBase: string): Promise<void> {
  try {
    const realPath = await fs.realpath(resolvedPath);
    if (!isPathInsideRoot(resolvedBase, realPath)) {
      throw new Error("Path traversal denied: resolved path escapes base directory");
    }
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      await assertNearestExistingParentContained(resolvedPath, resolvedBase);
      return;
    }
    throw error;
  }
}

/** Resolve `relativeRoot` under `workDir`, rejecting absolute paths, `..` segments, and symlink escapes. */
export async function resolveContainedRoot(workDir: string, relativeRoot: string): Promise<string> {
  assertSafeRelativeRoot(relativeRoot);
  const resolvedBase = await resolveRealBase(workDir);
  const resolvedPath = path.resolve(resolvedBase, relativeRoot);
  if (!isPathInsideRoot(resolvedBase, resolvedPath)) {
    throw new Error(`Path traversal denied: "${relativeRoot}" is outside "${workDir}"`);
  }
  await assertRealPathContained(resolvedPath, resolvedBase);
  return resolvedPath;
}
