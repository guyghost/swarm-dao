import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Model / README evidence folder name for product-loop runs. */
export const PRODUCT_EVIDENCE_FOLDER = "product-loops";

/**
 * Resolve an evidence root without breaking existing data:
 * 1. explicit caller path
 * 2. `evidence/<name>` if it already exists
 * 3. `.dao/<name>` if it already exists
 * 4. otherwise the frozen model path `evidence/<name>`
 */
export const resolveEvidenceRoot = (
  folderName: string,
  explicit?: string,
  cwd: string = process.cwd(),
): string => {
  if (explicit !== undefined && explicit.trim().length > 0) return resolve(cwd, explicit);
  const modelRoot = resolve(cwd, "evidence", folderName);
  const daoRoot = resolve(cwd, ".dao", folderName);
  if (existsSync(modelRoot)) return modelRoot;
  if (existsSync(daoRoot)) return daoRoot;
  return modelRoot;
};
