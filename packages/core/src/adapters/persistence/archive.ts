// ============================================================
// Swarm DAO Core — Proposal Archive partitioning (ADR-004)
// ============================================================
// Pure partition/merge/signature logic for the closed-proposal
// archive. No filesystem, no clock, no randomness: everything here
// is unit-testable without disk. The repository adapter owns the
// I/O; this module owns the layout rules.

import type { DAOState, Proposal, ProposalStatus } from "../../types/index.js";

/** Bump on incompatible archive layout changes; `parseArchive` rejects
 *  archives written by a newer layout instead of silently mis-reading. */
export const ARCHIVE_VERSION = 1;

/** Single source for the archive file name used by every persistence path. */
export const ARCHIVE_FILE_NAME = "archive.json";

/** Satellite maps keyed by proposal id that follow their proposal into the
 *  archive. Anything not listed here stays in `state.json` untouched. */
const SATELLITE_KEYS = [
  "controlResults",
  "deliveryPlans",
  "artefacts",
  "outcomes",
  "snapshots",
  "verifications",
] as const;

type SatelliteMaps = {
  [K in (typeof SATELLITE_KEYS)[number]]: DAOState[K];
};

export interface ArchivePartition extends SatelliteMaps {
  version: number;
  /** Closed proposals, full objects — the sole on-disk home of their
   *  deliberation detail (votes, agent outputs, synthesis). */
  proposals: Proposal[];
}

/** Closed proposals are archived; only these two statuses stay in `state.json`.
 *  Same predicate as the decisions sweep — keep them aligned. */
export function isArchivedStatus(status: ProposalStatus): boolean {
  return status !== "open" && status !== "deliberating";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split one satellite map into live/archived halves. Entries whose key is not
 *  a numeric archived id stay live (preserves unknown/legacy keys verbatim). */
function splitMap<T>(map: unknown, archivedIds: Set<number>): { live: Record<number, T>; archived: Record<number, T> } {
  const live: Record<number, T> = {};
  const archived: Record<number, T> = {};
  if (!isRecord(map)) return { live, archived };
  for (const [key, value] of Object.entries(map)) {
    const id = Number(key);
    if (Number.isInteger(id) && archivedIds.has(id)) archived[id] = value as T;
    else (live as unknown as Record<string, T>)[key] = value as T;
  }
  return { live, archived };
}

/**
 * Pure view of `state` split into what `state.json` stores (live) and what
 * `.dao/archive.json` stores (archive). Does NOT mutate `state`: the result is
 * only serialized by the repository; the in-memory merged state is untouched.
 */
export function partitionState(state: DAOState): { live: DAOState; archive: ArchivePartition } {
  const archivedProposals = state.proposals.filter((proposal) => isArchivedStatus(proposal.status));
  const archivedIds = new Set(archivedProposals.map((proposal) => proposal.id));
  const live = { ...state, proposals: state.proposals.filter((proposal) => !archivedIds.has(proposal.id)) };
  const archive: ArchivePartition = {
    version: ARCHIVE_VERSION,
    proposals: archivedProposals,
    controlResults: {},
    deliveryPlans: {},
    artefacts: {},
    outcomes: {},
    snapshots: {},
    verifications: {},
  };
  for (const key of SATELLITE_KEYS) {
    const split = splitMap(state[key], archivedIds);
    (live as unknown as Record<string, unknown>)[key] = split.live;
    (archive as unknown as Record<string, unknown>)[key] = split.archived;
  }
  return { live, archive };
}

/**
 * Merge a parsed archive back into an in-memory state (open + archive → the
 * single merged `DAOState` consumers see). Archived ids shadow same-id live
 * proposals: the archive always holds the newer closed copy (crash ordering,
 * ADR-004). Mutates `state` in place; proposals end up ordered by id.
 */
export function mergeArchive(state: DAOState, archive: ArchivePartition): void {
  const archivedIds = new Set(archive.proposals.map((proposal) => proposal.id));
  const open = state.proposals.filter((proposal) => !archivedIds.has(proposal.id));
  state.proposals = [...open, ...archive.proposals].sort((left, right) => left.id - right.id);
  for (const key of SATELLITE_KEYS) {
    if (!isRecord(state[key])) (state as unknown as Record<string, unknown>)[key] = {};
    Object.assign(state[key] as Record<string, unknown>, archive[key]);
  }
}

/** Parse and validate serialized archive content. Missing pieces default to
 *  empty; wrong shapes or an unsupported version are corruption (throw), never
 *  silent data loss. */
export function parseArchive(raw: string): ArchivePartition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt proposal archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Corrupt proposal archive: not a JSON object");
  if (parsed.version !== ARCHIVE_VERSION) {
    throw new Error(`Unsupported archive version: ${String(parsed.version)} (expected ${ARCHIVE_VERSION})`);
  }
  if (!Array.isArray(parsed.proposals)) throw new Error("Corrupt proposal archive: proposals is not an array");
  const archive = {
    version: ARCHIVE_VERSION,
    proposals: parsed.proposals as Proposal[],
    controlResults: {},
    deliveryPlans: {},
    artefacts: {},
    outcomes: {},
    snapshots: {},
    verifications: {},
  } as ArchivePartition;
  for (const key of SATELLITE_KEYS) {
    const value = parsed[key as string];
    if (value === undefined) continue;
    if (!isRecord(value)) throw new Error(`Corrupt proposal archive: ${key} is not an object`);
    (archive as unknown as Record<string, unknown>)[key] = value;
  }
  return archive;
}

/**
 * Cheap O(closed) structural fingerprint of the archived partition, used by
 * the repository's no-op detection. Captures every change that alters the
 * archive's SHAPE: closures, reopenings, closed→closed status transitions,
 * first creation of a satellite entry. It deliberately does NOT capture
 * in-place value edits (e.g. re-rating an existing outcome) — those require
 * the caller to mark the archive dirty via the repository port (ADR-004
 * mutation contract).
 */
export function archiveSignature(state: DAOState): string {
  const parts: string[] = [];
  const archivedIds = new Set<number>();
  for (const proposal of state.proposals) {
    if (isArchivedStatus(proposal.status)) {
      archivedIds.add(proposal.id);
      parts.push(`${proposal.id}:${proposal.status}`);
    }
  }
  for (const key of SATELLITE_KEYS) {
    const map = state[key];
    let archivedEntries = 0;
    if (isRecord(map)) {
      for (const mapKey of Object.keys(map)) {
        if (archivedIds.has(Number(mapKey))) archivedEntries++;
      }
    }
    parts.push(`${key}:${archivedEntries}`);
  }
  return parts.join("|");
}
