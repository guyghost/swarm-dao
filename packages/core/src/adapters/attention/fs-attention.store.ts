import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  ATTENTION_CLI_DIRS,
  ATTENTION_EVIDENCE_DIRS,
  type AttentionSnapshot,
  type AttentionSource,
  type AttentionStorePort,
} from "../../observability/attention.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Roots scanned per source: the documented evidence root first (precedence),
 * then the CLI-default project root (.dao/…) used by foreign projects. */
const rootsFor = (source: AttentionSource): readonly string[] => [
  ATTENTION_EVIDENCE_DIRS[source],
  ATTENTION_CLI_DIRS[source],
];

/**
 * Filesystem attention store over the documented evidence roots
 * (`evidence/graph-runs`, `evidence/improvement-cycles`,
 * `evidence/product-loops`) plus the CLI-default project roots
 * (`.dao/graph-runs`, `.dao/improvement-cycles`, `.dao/product-loops`),
 * each run directory holding a `snapshot.json`.
 *
 * Read-only and fail-soft: a missing root or an unreadable/corrupted
 * snapshot yields no attention rather than an error — a corrupted run must
 * never hide the gates pending in other runs. A runId present in both roots
 * resolves to the documented root's snapshot.
 */
export class FsAttentionStore implements AttentionStorePort {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async listRuns(source: AttentionSource): Promise<readonly string[]> {
    const seen = new Set<string>();
    for (const relative of rootsFor(source)) {
      let entries: Dirent[];
      try {
        entries = await readdir(join(this.#root, relative), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && SAFE_RUN_ID.test(entry.name)) seen.add(entry.name);
      }
    }
    return [...seen].sort();
  }

  public async readSnapshot(source: AttentionSource, runId: string): Promise<AttentionSnapshot | null> {
    if (!SAFE_RUN_ID.test(runId) || runId.includes("..")) return null;
    for (const relative of rootsFor(source)) {
      const directory = resolve(this.#root, relative);
      const file = resolve(directory, runId, "snapshot.json");
      if (!file.startsWith(`${directory}${sep}`)) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        if (typeof parsed !== "object" || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (typeof record.state !== "string" || record.state.length === 0) continue;
        return {
          runId: typeof record.runId === "string" && record.runId.length > 0 ? record.runId : runId,
          state: record.state,
          status: typeof record.status === "string" ? record.status : "unknown",
          context:
            typeof record.context === "object" && record.context !== null
              ? (record.context as Record<string, unknown>)
              : null,
        };
      } catch {}
    }
    return null;
  }
}
