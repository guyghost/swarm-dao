// Swarm DAO CLI — evidence-root location.
//
// Reads (status, cycles, gates) resolve an existing series/run across the
// known roots (.dao/* default, evidence/* repo-dogfood convention) instead of
// silently answering from a fresh idle snapshot. Creation effects (init, once,
// submit) keep the strict explicit/default root: no silent resolution on
// writes.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SERIES_ROOT_CANDIDATES = [".dao/improvement-series", "evidence/improvement-series"] as const;
export const CYCLE_ROOT_CANDIDATES = [".dao/improvement-cycles", "evidence/improvement-cycles"] as const;
export const GRAPH_ROOT_CANDIDATES = [".dao/graph-runs", "evidence/graph-runs"] as const;

export interface LocatedRoot {
  /** Absolute resolved root — the flag when given, else the best hit. */
  root: string;
  /** True when <root>/<id>/snapshot.json exists. */
  found: boolean;
  /** Relative candidates tried (for "not found" messages). */
  tried: readonly string[];
}

/**
 * Locate an evidence object across candidate roots. When the same id exists
 * in several roots, a series that has actually started beats a fresh idle
 * snapshot (running `improve status` without a root flag materializes an idle
 * series under .dao/ — the operator's real series usually lives elsewhere).
 */
export async function locateRoot(
  cwd: string,
  id: string,
  candidates: readonly string[],
  explicit?: string,
): Promise<LocatedRoot> {
  const list = explicit ? [explicit] : candidates;
  let fallback: LocatedRoot | null = null;
  for (const relative of list) {
    const root = path.resolve(cwd, relative);
    const parsed = await readJsonOrNull(path.join(root, id, "snapshot.json"));
    if (parsed === null) continue;
    const located: LocatedRoot = { root, found: true, tried: list };
    const started = (parsed as { context?: { started?: boolean } }).context?.started;
    if (started === true) return located;
    fallback ??= located;
  }
  if (fallback) return fallback;
  return { root: path.resolve(cwd, list[0] ?? "."), found: false, tried: list };
}

/** Read and parse a JSON file, or null when absent/invalid. */
export async function readJsonOrNull(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** First/last journal timestamps as cycle duration, or null when unknowable. */
export async function readJournalDurationMs(cycleDir: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(cycleDir, "journal.ndjson"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const first = Date.parse((JSON.parse(lines[0] ?? "") as { receivedAt?: string }).receivedAt ?? "");
    const last = Date.parse((JSON.parse(lines[lines.length - 1] ?? "") as { receivedAt?: string }).receivedAt ?? "");
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
    return last - first;
  } catch {
    return null;
  }
}

/** All cycle directories <root>/<seriesId>-c<N>, sorted by N. */
export async function listCycleDirs(
  cycleRoot: string,
  seriesId: string,
): Promise<Array<{ number: number; dir: string }>> {
  let entries: string[] = [];
  try {
    entries = await readdir(cycleRoot);
  } catch {
    return [];
  }
  const prefix = `${seriesId}-c`;
  return entries
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => ({ number: Number(name.slice(prefix.length)), dir: path.join(cycleRoot, name) }))
    .sort((a, b) => a.number - b.number);
}
