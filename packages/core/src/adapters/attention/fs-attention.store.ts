import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  ATTENTION_EVIDENCE_DIRS,
  type AttentionSnapshot,
  type AttentionSource,
  type AttentionStorePort,
} from "../../observability/attention.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Filesystem attention store over the documented evidence roots
 * (`evidence/graph-runs`, `evidence/improvement-cycles`,
 * `evidence/product-loops`), each run directory holding a `snapshot.json`.
 *
 * Read-only and fail-soft: a missing root or an unreadable/corrupted
 * snapshot yields no attention rather than an error — a corrupted run must
 * never hide the gates pending in other runs.
 */
export class FsAttentionStore implements AttentionStorePort {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async listRuns(source: AttentionSource): Promise<readonly string[]> {
    try {
      const entries = await readdir(join(this.#root, ATTENTION_EVIDENCE_DIRS[source]), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SAFE_RUN_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  public async readSnapshot(source: AttentionSource, runId: string): Promise<AttentionSnapshot | null> {
    if (!SAFE_RUN_ID.test(runId) || runId.includes("..")) return null;
    const directory = resolve(this.#root, ATTENTION_EVIDENCE_DIRS[source]);
    const file = resolve(directory, runId, "snapshot.json");
    if (!file.startsWith(`${directory}${sep}`)) return null;

    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.state !== "string" || record.state.length === 0) return null;
      return {
        runId: typeof record.runId === "string" && record.runId.length > 0 ? record.runId : runId,
        state: record.state,
        status: typeof record.status === "string" ? record.status : "unknown",
        context:
          typeof record.context === "object" && record.context !== null
            ? (record.context as Record<string, unknown>)
            : null,
      };
    } catch {
      return null;
    }
  }
}
