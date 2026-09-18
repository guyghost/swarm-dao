import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../../observability/logging.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import { createInitialState, type DAOState, type DecisionRecord } from "../../types/index.js";
import { ARCHIVE_FILE_NAME, archiveSignature, mergeArchive, parseArchive, partitionState } from "./archive.js";

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Repair ID counters from the maximum existing ids (issue #157). Shared by
 * every load path (loadState and FileDaoStateRepository.open) so both produce
 * identical, collision-free counters — e.g. a nextProposalId left behind a
 * hand-edit or a restored backup no longer yields duplicate proposal ids.
 */
export function repairCounters(state: DAOState): void {
  const highestProposalId = state.proposals.reduce((max, proposal) => {
    const id = (proposal as { id?: unknown }).id;
    return isPositiveInteger(id) ? Math.max(max, id) : max;
  }, 0);
  if (state.nextProposalId <= highestProposalId) state.nextProposalId = highestProposalId + 1;
  const highestAuditId = state.auditLog.reduce((max, entry) => {
    const id = (entry as { id?: unknown })?.id;
    return isPositiveInteger(id) ? Math.max(max, id) : max;
  }, 0);
  if (state.nextAuditId <= highestAuditId) state.nextAuditId = highestAuditId + 1;
}

function readRevision(value: Partial<DAOState>): number {
  return isPositiveInteger(value.stateRevision) ? value.stateRevision : 0;
}

interface RepairResult {
  state: DAOState;
  /** True when shape repair substituted data (a sign of a damaged file that
   *  the caller should back up before the first persist overwrites it). */
  repaired: boolean;
}

function repairState(value: Partial<DAOState>, daoRoot: string): RepairResult {
  const fallback = createInitialState(daoRoot);
  const state = { ...fallback, ...value, daoRoot } as DAOState;
  let repaired = false;
  // Shape substitution means the file was damaged (partial write, manual edit,
  // restore): keep defaults but flag it so the original gets backed up.
  const arrayOr = <T>(candidate: unknown, fallbackValue: T): T => {
    if (Array.isArray(candidate)) return candidate as T;
    repaired = true;
    return fallbackValue;
  };
  const recordOr = <T>(candidate: unknown, fallbackValue: T): T => {
    // Plain objects only (review): a truthy primitive (string/number) in a
    // corrupted state.json must be substituted, not adopted as a record.
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) return candidate as T;
    repaired = true;
    return fallbackValue;
  };
  const intOr = (candidate: unknown, fallbackValue: number): number => {
    if (isPositiveInteger(candidate)) return candidate;
    repaired = true;
    return fallbackValue;
  };
  state.proposals = arrayOr(value.proposals, []);
  state.agents = arrayOr(value.agents, []);
  state.auditLog = arrayOr(value.auditLog, []);
  state.controlResults = recordOr(value.controlResults, {});
  state.deliveryPlans = recordOr(value.deliveryPlans, {});
  state.artefacts = recordOr(value.artefacts, {});
  state.outcomes = recordOr(value.outcomes, {});
  state.snapshots = recordOr(value.snapshots, {});
  state.verifications = recordOr(value.verifications, {});
  state.nextProposalId = intOr(value.nextProposalId, 1);
  state.nextAuditId = intOr(value.nextAuditId, 1);
  state.stateRevision = readRevision(value);
  repairCounters(state);
  return { state, repaired };
}

/** Instance-owned filesystem adapter. No process-global DAO state or write cache. */
export class FileDaoStateRepository implements DaoStateRepositoryPort {
  private readonly writeCache = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();
  /** Set when a persist failed after state.json was written, forcing the next
   *  persist to run the full decision sweep so failed writes are retried. */
  private decisionsPending = false;
  /** ADR-004: set by markArchivedDirty() when a caller mutated values inside
   *  the archived partition (in-place edits invisible to the structural
   *  signature); forces the archive to be re-serialized on the next persist. */
  private archivedDirty = false;
  /** Last structural signature of the archived partition — the cheap
   *  auto-detection half of the ADR-004 mutation contract. */
  private lastArchiveSignature = "";
  /** Whether archive.json is known to exist on disk. False for fresh
   *  repositories and compat loaders: the archive must then be written on the
   *  next full persist even when the signature is unchanged (legacy migration
   *  would otherwise drop closed proposals from state.json without ever
   *  archiving them). */
  private archiveOnDiskKnown = false;

  /** Name of the closed-proposal archive file written next to state.json. */
  private static readonly ARCHIVE_FILE = ARCHIVE_FILE_NAME;

  /** Last state.json content this instance read or wrote, for cheap divergence checks. */
  private rawStateOnDisk: string | null;

  /** Revision this instance last read from, or wrote to, disk (issue #153). */
  private seenRevision: number;

  private constructor(
    private readonly state: DAOState,
    private readonly daoRoot: string,
    rawStateOnDisk: string | null,
    /** Revision already extracted by the caller's parse — passing it avoids a
     *  second full JSON.parse of state.json (measured +86% on a 500-proposal
     *  reload when this constructor re-parsed). */
    seenRevision?: number,
  ) {
    this.rawStateOnDisk = rawStateOnDisk;
    if (seenRevision !== undefined) {
      this.seenRevision = seenRevision;
      return;
    }
    let revision = 0;
    if (rawStateOnDisk) {
      try {
        revision = readRevision(JSON.parse(rawStateOnDisk) as Partial<DAOState>);
      } catch {
        revision = 0;
      }
    }
    this.seenRevision = revision;
  }

  /** Wrap already-loaded state so compatibility loaders share the locked persist path. */
  public static fromLoaded(state: DAOState, rawStateOnDisk: string | null): FileDaoStateRepository {
    const repository = new FileDaoStateRepository(
      state,
      state.daoRoot,
      rawStateOnDisk,
      isPositiveInteger(state.stateRevision) ? state.stateRevision : undefined,
    );
    repository.lastArchiveSignature = archiveSignature(state);
    return repository;
  }

  public static async open(cwd: string): Promise<FileDaoStateRepository> {
    const daoRoot = path.join(cwd, ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    const statePath = path.join(daoRoot, "state.json");
    let state = createInitialState(daoRoot);
    let rawState: string | null = null;
    try {
      rawState = await fs.readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Failed to read DAO state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rawState !== null) {
      let parsed: Partial<DAOState>;
      try {
        parsed = JSON.parse(rawState) as Partial<DAOState>;
      } catch (error) {
        // Same wrapping as loadState: a raw SyntaxError names no file and the
        // CLI/MCP (which load through open()) would give the user no hint.
        throw new Error(`Corrupt DAO state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const repaired = repairState(parsed, daoRoot);
      state = repaired.state;
      if (repaired.repaired) {
        // The damaged original is about to be silently overwritten by the
        // first persist: preserve it for forensics (issue #167.6).
        const backupPath = `${statePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await fs.copyFile(statePath, backupPath).catch(() => undefined);
        logger.warn(`⚠ state.json needed shape repair; original backed up to ${backupPath}`);
      }
    }
    // ADR-004: merge the closed-proposal archive into the in-memory state so
    // consumers keep seeing one merged DAOState. Archived ids shadow same-id
    // live proposals (crash ordering: the archive is always the newer copy).
    const archivePath = path.join(daoRoot, FileDaoStateRepository.ARCHIVE_FILE);
    let rawArchive: string | null = null;
    try {
      rawArchive = await fs.readFile(archivePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Failed to read DAO proposal archive at ${archivePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rawArchive !== null) {
      mergeArchive(state, parseArchive(rawArchive));
      // Counters must account for archived ids too (issue #157): a restored
      // old state.json next to an existing archive can never reuse ids.
      repairCounters(state);
    }
    const repository = new FileDaoStateRepository(state, daoRoot, rawState, state.stateRevision);
    repository.lastArchiveSignature = archiveSignature(state);
    repository.archiveOnDiskKnown = rawArchive !== null;
    return repository;
  }

  public get(): DAOState {
    return this.state;
  }

  /** ADR-004 mutation contract — see DaoStateRepositoryPort. */
  public markArchivedDirty(): void {
    this.archivedDirty = true;
  }

  public async persist(): Promise<void> {
    const task = async (): Promise<void> => {
      // No-op persist: nothing to write means no writer, so neither the
      // inter-process lock nor the on-disk concurrency check is needed.
      if (!this.hasPendingWrites()) return;
      await fs.mkdir(this.daoRoot, { recursive: true });
      await withFileLock(this.daoRoot, async () => {
        const diskRevision = await this.checkNoConcurrentModification();
        // Monotonic revision (issue #153): move past whatever is on disk so a
        // stale copy of this instance can never be accepted again.
        this.state.stateRevision = Math.max(diskRevision, this.seenRevision) + 1;
        // ADR-004: only re-serialize the archive when its partition may have
        // changed (mutation contract) or it is not known to be on disk yet
        // (fresh/legacy). A signature-clean archive keeps archive-only-heavy
        // flows (e.g. touching an open proposal) at O(open) cost.
        const signature = archiveSignature(this.state);
        const archiveChanged =
          this.archivedDirty || !this.archiveOnDiskKnown || signature !== this.lastArchiveSignature;
        const { live, archive } = partitionState(this.state);
        const archivePath = path.join(this.daoRoot, FileDaoStateRepository.ARCHIVE_FILE);
        // Crash ordering (ADR-004): the archive is written BEFORE state.json.
        // A crash in between leaves the archive holding the newer closed copy
        // while state.json still lists the proposal as open; the shadow rule
        // in mergeArchive resolves that deterministically on the next open.
        // The reverse order would lose the proposal entirely.
        if (archiveChanged) {
          await this.writeIfChanged(archivePath, archive);
          this.archiveOnDiskKnown = true;
        }
        const statePath = path.join(this.daoRoot, "state.json");
        await this.writeIfChanged(statePath, live);
        this.rawStateOnDisk = this.writeCache.get(statePath) ?? null;
        this.seenRevision = this.state.stateRevision;
        this.lastArchiveSignature = signature;
        this.archivedDirty = false;
        try {
          await this.persistDecisions();
          this.decisionsPending = false;
        } catch (error) {
          this.decisionsPending = true;
          throw error;
        }
      });
    };
    const queued = this.writeQueue.then(task, task);
    this.writeQueue = queued.catch(() => {});
    await queued;
  }

  /**
   * Whether persist() would write anything. Mirrors the per-file decisions in
   * writeIfChanged/persistDecisions: when every serialized payload matches the
   * write cache, persist is a no-op and can skip lock, check and I/O.
   */
  private hasPendingWrites(): boolean {
    const statePath = path.join(this.daoRoot, "state.json");
    const { live } = partitionState(this.state);
    if (this.writeCache.get(statePath) !== formatJson(live)) return true;
    // ADR-004: the archived partition is clean only when its structural
    // signature is unchanged, no caller flagged in-place value edits via
    // markArchivedDirty(), and the archive is known to be on disk. The
    // signature costs O(closed) key checks — far below serializing the
    // closed proposals themselves.
    const archiveClean =
      archiveSignature(this.state) === this.lastArchiveSignature && !this.archivedDirty && this.archiveOnDiskKnown;
    if (!archiveClean) return true;
    // Decision records are a pure function of state.proposals: when the
    // serialized state is byte-identical to the last write, the decision
    // index and per-decision files were written from this exact state and
    // must match the write cache. Skipping the O(proposals) serialize+compare
    // sweep removes the dominant cost of a no-op persist on large states.
    if (!this.decisionsPending) return false;
    const decisions = this.closedDecisions();
    if (this.writeCache.get(path.join(this.daoRoot, "decisions", "index.json")) !== formatJson(decisions)) {
      return true;
    }
    return decisions.some(
      (decision) =>
        this.writeCache.get(path.join(this.daoRoot, "decisions", `${decision.id.toString().padStart(3, "0")}.json`)) !==
        formatJson(decision),
    );
  }

  /**
   * Fail-fast optimistic concurrency: if another process persisted a state
   * this instance has not seen, refuse to overwrite it instead of silently
   * dropping votes/proposals (last-writer-wins).
   *
   * Returns the revision currently on disk. Two layers:
   * 1. stateRevision comparison (issue #153) — catches ANY divergence,
   *   including votes added to a proposal known to both processes.
   * 2. proposal-id/counter checks — catch hand-edited files whose revision
   *   was not bumped (state.json is a documented, readable format).
   */
  private async checkNoConcurrentModification(): Promise<number> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.daoRoot, "state.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    // Byte-identical to what this instance last read or wrote: no other
    // writer touched the file. Avoids a full JSON.parse of a potentially
    // large state on every persist.
    if (raw === this.rawStateOnDisk) return this.seenRevision;
    const onDisk = JSON.parse(raw) as Partial<DAOState>;
    const diskRevision = readRevision(onDisk);
    if (diskRevision !== this.seenRevision) {
      throw new Error(
        `Concurrent modification detected in ${path.join(this.daoRoot, "state.json")}: ` +
          `disk revision (${diskRevision}) differs from the revision this instance last saw (${this.seenRevision}). ` +
          "Reopen the repository and retry.",
      );
    }
    if (!onDisk || !Array.isArray(onDisk.proposals)) return diskRevision;
    const diskIds = new Set(onDisk.proposals.map((p) => (p as { id?: unknown }).id));
    const memIds = new Set(this.state.proposals.map((p) => p.id));
    for (const id of diskIds) {
      if (!memIds.has(id as number)) {
        throw new Error(
          `Concurrent modification detected in ${path.join(this.daoRoot, "state.json")}: ` +
            `proposal #${String(id)} exists on disk but not in memory. Reopen the repository and retry.`,
        );
      }
    }
    const diskNext = typeof onDisk.nextProposalId === "number" ? onDisk.nextProposalId : 1;
    if (diskNext > this.state.nextProposalId) {
      throw new Error(
        `Concurrent modification detected in ${path.join(this.daoRoot, "state.json")}: ` +
          `disk nextProposalId (${diskNext}) is ahead of memory (${this.state.nextProposalId}). Reopen and retry.`,
      );
    }
    return diskRevision;
  }

  /** Decisions to persist: closed proposals only, ordered by id. Single source for persistDecisions and hasPendingWrites. */
  private closedDecisions(): DecisionRecord[] {
    return this.state.proposals
      .filter((proposal) => proposal.status !== "open" && proposal.status !== "deliberating")
      .map(
        (proposal): DecisionRecord => ({
          id: proposal.id,
          title: proposal.title,
          type: proposal.type,
          status: proposal.status,
          riskZone: proposal.riskZone,
          createdAt: proposal.createdAt,
          resolvedAt: proposal.resolvedAt,
        }),
      )
      .sort((left, right) => left.id - right.id);
  }

  private async persistDecisions(): Promise<void> {
    const decisionsDir = path.join(this.daoRoot, "decisions");
    await fs.mkdir(decisionsDir, { recursive: true });
    const decisions = this.closedDecisions();
    const indexPath = path.join(decisionsDir, "index.json");
    // The per-decision files are a pure function of the decisions array that
    // produced index.json: a serialized index identical to the cached one
    // means every decision file already matches the cache too. Skip the
    // per-decision serialize+compare sweep (O(closed proposals)) — after a
    // mid-sweep failure, decisionsPending forces the full sweep instead.
    if (!this.decisionsPending && this.writeCache.get(indexPath) === formatJson(decisions)) return;
    await this.writeIfChanged(indexPath, decisions);
    await Promise.all(
      decisions.map((decision) =>
        this.writeIfChanged(path.join(decisionsDir, `${decision.id.toString().padStart(3, "0")}.json`), decision),
      ),
    );
  }

  private async writeIfChanged(filePath: string, value: unknown): Promise<void> {
    const serialized = formatJson(value);
    if (this.writeCache.get(filePath) === serialized) return;
    await writeAtomic(filePath, serialized);
    this.writeCache.set(filePath, serialized);
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await safeUnlink(tmpPath);
    throw error;
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // Ignore — file may not exist or may already be gone.
  }
}

const LOCK_FILE = "state.lock";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10000;

export async function withFileLock<T>(daoRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(daoRoot, LOCK_FILE);
  // Callers are responsible for creating daoRoot before locking.
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // Unique token (issue #167.1): the release step only removes the lock file
  // when it still holds ITS OWN token, so a stale takeover can never trick a
  // live writer into deleting someone else's lock.
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const lockPayload = (): string => JSON.stringify({ pid: process.pid, ts: Date.now(), token });
  for (;;) {
    try {
      await fs.writeFile(lockPath, lockPayload(), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isLockStale(lockPath)) {
        await safeUnlink(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring DAO lock at ${lockPath} (another writer holds it)`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  // Heartbeat: refresh the timestamp while the critical section runs, so a
  // legitimately long write is not declared stale by a waiting process. Only
  // refresh while the lock file still holds OUR token (review): after a
  // stale takeover by another writer, the old owner's heartbeat must not
  // clobber the new owner's token.
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { token?: unknown };
        if (parsed.token !== token) return; // we no longer own the lock file
        await fs.writeFile(lockPath, lockPayload(), { flag: "w" });
      } catch {
        // Lock already gone or unreadable — nothing to refresh.
      }
    })();
  }, LOCK_STALE_MS / 2);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      const raw = await fs.readFile(lockPath, "utf8");
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (parsed.token === token) await safeUnlink(lockPath);
    } catch {
      // Lock already gone or unreadable — nothing to remove.
    }
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { ts?: unknown };
    return typeof parsed.ts === "number" && Date.now() - parsed.ts > LOCK_STALE_MS;
  } catch {
    // Unreadable lock: treat missing as not-stale (retry), corrupt as stale.
    try {
      await fs.stat(lockPath);
    } catch {
      return false;
    }
    return true;
  }
}
