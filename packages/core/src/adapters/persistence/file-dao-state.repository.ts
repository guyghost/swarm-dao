import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../../observability/logging.js";
import { TraceLog } from "../../observability/tracing.js";
import { PersistConflictError } from "../../ports/persist-conflict.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import {
  createInitialState,
  type DAOConfig,
  type DAOState,
  type DecisionRecord,
  type ProposalType,
} from "../../types/index.js";
import { normalizeBatchSize } from "../../utils/batching.js";
import { resolveDaoLayout } from "../dao-home/dao-home.js";
import {
  ARCHIVE_FILE_NAME,
  archiveSignature,
  isArchivedStatus,
  mergeArchive,
  parseArchive,
  partitionState,
} from "./archive.js";
import { AUDIT_JSONL_FILE_NAME, auditLine, mergeAuditEntries, parseAuditJsonl } from "./audit-jsonl.js";

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Shape of a `typeQuorum` entry: both thresholds must be numbers. */
function sanitizeTypeQuorum(
  candidate: unknown,
  fallback: DAOConfig["typeQuorum"],
): { value: DAOConfig["typeQuorum"]; repaired: boolean } {
  if (candidate === undefined) return { value: fallback, repaired: false };
  if (!isRecord(candidate)) return { value: fallback, repaired: true };
  const value: DAOConfig["typeQuorum"] = { ...fallback };
  let repaired = false;
  for (const [type, entry] of Object.entries(candidate)) {
    if (
      !isRecord(entry) ||
      typeof entry.quorumPercent !== "number" ||
      !Number.isFinite(entry.quorumPercent) ||
      typeof entry.approvalPercent !== "number" ||
      !Number.isFinite(entry.approvalPercent)
    ) {
      repaired = true;
      continue;
    }
    value[type as ProposalType] = {
      quorumPercent: entry.quorumPercent,
      approvalPercent: entry.approvalPercent,
      description: typeof entry.description === "string" ? entry.description : String(type),
    };
  }
  return { value, repaired };
}

/**
 * Repair the persisted `config` (issue: config shape was never validated, so
 * `{ "config": {} }` in an editable state.json replaced the whole default and
 * crashed `runGates`/`tallyVotes`). Missing fields fall back to the defaults;
 * present-but-invalid fields are substituted and flag the file for backup.
 * `maxConcurrent` is normalized so the chunking loops can never stall.
 */
function repairConfig(candidate: unknown, fallback: DAOConfig): { config: DAOConfig; repaired: boolean } {
  if (candidate === undefined) return { config: fallback, repaired: false };
  if (!isRecord(candidate)) return { config: fallback, repaired: true };
  let repaired = false;
  const config: DAOConfig = { ...fallback, ...(candidate as Partial<DAOConfig>) };
  for (const key of ["quorumPercent", "approvalThreshold", "riskThreshold", "quorumFloor"] as const) {
    const raw = candidate[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      config[key] = fallback[key];
      repaired = true;
    }
  }
  if (
    candidate.maxConcurrent !== undefined &&
    (typeof candidate.maxConcurrent !== "number" ||
      !Number.isFinite(candidate.maxConcurrent) ||
      candidate.maxConcurrent < 1)
  ) {
    repaired = true;
  }
  config.maxConcurrent = normalizeBatchSize(config.maxConcurrent);
  if (candidate.requiredGates !== undefined) {
    if (!Array.isArray(candidate.requiredGates) || !candidate.requiredGates.every((gate) => typeof gate === "string")) {
      config.requiredGates = [...fallback.requiredGates];
      repaired = true;
    }
  }
  const typeQuorum = sanitizeTypeQuorum(candidate.typeQuorum, fallback.typeQuorum);
  config.typeQuorum = typeQuorum.value;
  if (typeQuorum.repaired) repaired = true;
  return { config, repaired };
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
  const configRepair = repairConfig((value as { config?: unknown }).config, fallback.config);
  state.config = configRepair.config;
  if (configRepair.repaired) repaired = true;
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
  /** Ids of audit entries durably present in audit.jsonl (ADR-005). Entries
   *  whose id is missing here are appended on the next persist. */
  private persistedAuditIds = new Set<number>();
  /** Corrupt lines were skipped on open: the next persist rewrites a clean trail. */
  private auditRewritePending = false;
  /** Audit length at the last full rewrite. The trail is rewritten every
   *  AUDIT_COMPACT_EVERY new entries so torn lines cannot accumulate forever. */
  private auditCompactBaseline = 0;
  /** Per-repository trace log. Persist spans land here, not on the process bus. */
  readonly traces = new TraceLog();

  /** Test hook: runs inside the lock, immediately before the commit-point ownership check. */
  static commitProbe: (() => Promise<void>) | null = null;

  /** Name of the append-only audit trail file written next to state.json. */
  private static readonly AUDIT_FILE = AUDIT_JSONL_FILE_NAME;

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
  public static fromLoaded(
    state: DAOState,
    rawStateOnDisk: string | null,
    options?: { persistedAuditIds?: Set<number> },
  ): FileDaoStateRepository {
    const repository = new FileDaoStateRepository(
      state,
      state.daoRoot,
      rawStateOnDisk,
      isPositiveInteger(state.stateRevision) ? state.stateRevision : undefined,
    );
    repository.lastArchiveSignature = archiveSignature(state);
    if (options?.persistedAuditIds) repository.persistedAuditIds = options.persistedAuditIds;
    repository.auditCompactBaseline = state.auditLog.length;
    return repository;
  }

  public static async open(cwd: string): Promise<FileDaoStateRepository> {
    // ADR-007: route through the DAO home layout (legacy `.dao` or the
    // external home's branch dir). Ensures project.json + passive GC.
    const layout = await resolveDaoLayout(cwd);
    const daoRoot = layout.stateRoot;
    await fs.mkdir(daoRoot, { recursive: true });
    return FileDaoStateRepository.loadAt(daoRoot);
  }

  /** Re-read durable files into this instance, discarding unsaved memory. */
  public async reload(): Promise<void> {
    const fresh = await FileDaoStateRepository.loadAt(this.daoRoot);
    Object.assign(this.state, fresh.state);
    this.rawStateOnDisk = fresh.rawStateOnDisk;
    this.seenRevision = fresh.seenRevision;
    this.writeCache.clear();
    this.decisionsPending = fresh.decisionsPending;
    this.archivedDirty = fresh.archivedDirty;
    this.lastArchiveSignature = fresh.lastArchiveSignature;
    this.archiveOnDiskKnown = fresh.archiveOnDiskKnown;
    this.persistedAuditIds = new Set(fresh.persistedAuditIds);
    this.auditRewritePending = fresh.auditRewritePending;
    this.auditCompactBaseline = fresh.auditCompactBaseline;
  }

  /** Load state already rooted at `daoRoot` (the directory that holds state.json). */
  public static async loadAt(daoRoot: string): Promise<FileDaoStateRepository> {
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
    /** Ids the archive file itself supplied — a closed proposal in state.json
     *  that is missing here has not reached the archive yet. */
    const archivedOnDiskIds = new Set<number>();
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
      let archive: ReturnType<typeof parseArchive>;
      try {
        archive = parseArchive(rawArchive);
      } catch (error) {
        // Same wrapping as state.json: a raw parse error names no file.
        throw new Error(
          `Corrupt DAO proposal archive at ${archivePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      mergeArchive(state, archive);
      for (const proposal of archive.proposals) archivedOnDiskIds.add(proposal.id);
    }
    // ADR-005: fold the append-only audit trail into the in-memory log.
    // Tolerant by design — torn/corrupt lines are skipped, duplicates are
    // removed by id during the merge.
    let auditIds: Set<number> | undefined;
    let auditRewrite = false;
    const auditPath = path.join(daoRoot, FileDaoStateRepository.AUDIT_FILE);
    let rawAudit: string | undefined;
    try {
      rawAudit = await fs.readFile(auditPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Failed to read DAO audit trail at ${auditPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rawAudit !== undefined) {
      const { entries, skipped } = parseAuditJsonl(rawAudit);
      mergeAuditEntries(state.auditLog, entries);
      auditIds = new Set(entries.map((entry) => entry.id));
      if (skipped > 0) {
        logger.warn(`⚠ Skipped ${skipped} corrupt audit.jsonl line(s) at ${auditPath} (torn tail or damaged entries)`);
        auditRewrite = true;
      }
    }
    // Counters must account for archived proposal AND audit-trail ids
    // (issue #157): a restored old state.json can never reuse ids.
    repairCounters(state);
    const repository = new FileDaoStateRepository(state, daoRoot, rawState, state.stateRevision);
    repository.lastArchiveSignature = archiveSignature(state);
    repository.archiveOnDiskKnown = rawArchive !== null;
    // Legacy layout guard: state.json used to carry closed proposals. The
    // archive signature cannot see that they are missing from archive.json, so
    // without this flag the first persist would drop them from the live
    // partition while leaving the archive untouched — losing them from both
    // files (ADR-004 exists precisely to prevent that).
    repository.archivedDirty = state.proposals.some(
      (proposal) => isArchivedStatus(proposal.status) && !archivedOnDiskIds.has(proposal.id),
    );
    if (auditIds) repository.persistedAuditIds = auditIds;
    repository.auditRewritePending = auditRewrite;
    repository.auditCompactBaseline = repository.persistedAuditIds.size;
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
      await withFileLock(this.daoRoot, async (lease) => {
        const span = this.traces.startSpan("dao.persist");
        try {
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
            await this.writeIfChanged(archivePath, archive, lease);
            this.archiveOnDiskKnown = true;
          }
          // ADR-005: the audit trail is durable BEFORE state.json. A crash in
          // between leaves the trail ahead of the state — accepted governance
          // semantics. appendDurable fsyncs the file and its directory first.
          await this.persistAudit(lease);
          const statePath = path.join(this.daoRoot, "state.json");
          await this.writeIfChanged(statePath, live, lease);
          this.rawStateOnDisk = this.writeCache.get(statePath) ?? null;
          this.seenRevision = this.state.stateRevision;
          this.lastArchiveSignature = signature;
          this.archivedDirty = false;
          try {
            await this.persistDecisions(lease);
            this.decisionsPending = false;
          } catch (error) {
            this.decisionsPending = true;
            throw error;
          }
          this.traces.finishSpan(span.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.traces.finishSpan(span.id, message);
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
    if (this.auditRewritePending) return true;
    if (this.state.auditLog.length - this.auditCompactBaseline >= AUDIT_COMPACT_EVERY) return true;
    if (this.writeCache.get(statePath) !== formatJson(live)) return true;
    // ADR-004: the archived partition is clean only when its structural
    // signature is unchanged, no caller flagged in-place value edits via
    // markArchivedDirty(), and the archive is known to be on disk. The
    // signature costs O(closed) key checks — far below serializing the
    // closed proposals themselves.
    const archiveClean =
      archiveSignature(this.state) === this.lastArchiveSignature && !this.archivedDirty && this.archiveOnDiskKnown;
    // ADR-005: audit entries not yet appended to audit.jsonl also count as
    // pending work (O(audit) probe via Set lookups — no serialization).
    const auditChanged =
      this.state.auditLog.length !== this.persistedAuditIds.size ||
      this.state.auditLog.some((entry) => !this.persistedAuditIds.has(entry.id));
    if (!archiveClean || auditChanged) return true;
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
      throw new PersistConflictError(
        `Concurrent modification detected in ${path.join(this.daoRoot, "state.json")}: ` +
          `disk revision (${diskRevision}) differs from the revision this instance last saw (${this.seenRevision}). ` +
          "Reopen the repository and retry.",
        true,
      );
    }
    if (!onDisk || !Array.isArray(onDisk.proposals)) return diskRevision;
    const diskIds = new Set(onDisk.proposals.map((p) => (p as { id?: unknown }).id));
    const memIds = new Set(this.state.proposals.map((p) => p.id));
    for (const id of diskIds) {
      if (!memIds.has(id as number)) {
        throw new PersistConflictError(
          `Concurrent modification detected in ${path.join(this.daoRoot, "state.json")}: ` +
            `proposal #${String(id)} exists on disk but not in memory. Reopen the repository and retry.`,
          true,
        );
      }
    }
    const diskNext = typeof onDisk.nextProposalId === "number" ? onDisk.nextProposalId : 1;
    if (diskNext > this.state.nextProposalId) {
      throw new PersistConflictError(
        `Concurrent modification detected in ${path.join(this.daoRoot, "state.json")}: ` +
          `disk nextProposalId (${diskNext}) is ahead of memory (${this.state.nextProposalId}). Reopen and retry.`,
        true,
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

  /** Rewrite the audit trail when it is damaged or has grown by AUDIT_COMPACT_EVERY
   *  entries; otherwise append the new lines and fsync them before state.json. */
  private async persistAudit(lease: LockLease): Promise<void> {
    const auditPath = path.join(this.daoRoot, FileDaoStateRepository.AUDIT_FILE);
    const rewrite =
      this.auditRewritePending || this.state.auditLog.length - this.auditCompactBaseline >= AUDIT_COMPACT_EVERY;
    if (rewrite) {
      await writeAtomic(auditPath, this.state.auditLog.map(auditLine).join(""), lease);
      this.persistedAuditIds = new Set(this.state.auditLog.map((entry) => entry.id));
      this.auditRewritePending = false;
      this.auditCompactBaseline = this.state.auditLog.length;
      return;
    }
    const pending = this.state.auditLog.filter((entry) => !this.persistedAuditIds.has(entry.id));
    if (pending.length === 0) return;
    await appendDurable(auditPath, pending.map(auditLine).join(""), lease);
    for (const entry of pending) this.persistedAuditIds.add(entry.id);
  }

  private async persistDecisions(lease: LockLease): Promise<void> {
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
    await this.writeIfChanged(indexPath, decisions, lease);
    await Promise.all(
      decisions.map((decision) =>
        this.writeIfChanged(
          path.join(decisionsDir, `${decision.id.toString().padStart(3, "0")}.json`),
          decision,
          lease,
        ),
      ),
    );
  }

  private async writeIfChanged(filePath: string, value: unknown, lease: LockLease): Promise<void> {
    const serialized = formatJson(value);
    if (this.writeCache.get(filePath) === serialized) return;
    await writeAtomic(filePath, serialized, lease);
    this.writeCache.set(filePath, serialized);
  }
}

async function writeAtomic(filePath: string, content: string, lease: LockLease): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await lease.assertOwned();
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
    lease.markWritten();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await safeUnlink(tmpPath);
    throw error;
  }
}

/** Append `content` and fsync the file and its directory before the caller commits state.json. */
async function appendDurable(filePath: string, content: string, lease: LockLease): Promise<void> {
  await lease.assertOwned();
  const handle = await fs.open(filePath, "a");
  try {
    await handle.appendFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
  lease.markWritten();
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Directories cannot be fsynced on every platform. The file fsync above
    // is the durability barrier; a directory sync failure must not fail the commit.
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR" && code !== "EBADF") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
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
/** Full audit rewrite cadence. Appends stay O(new entries) between rewrites. */
const AUDIT_COMPACT_EVERY = 2000;

interface LockLease {
  assertOwned(): Promise<void>;
  markWritten(): void;
}

export async function withFileLock<T>(daoRoot: string, fn: (lease: LockLease) => Promise<T>): Promise<T> {
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
        throw new PersistConflictError(`Timed out acquiring DAO lock at ${lockPath} (another writer holds it)`, true);
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
  let probed = false;
  let written = false;
  const lease: LockLease = {
    markWritten() {
      written = true;
    },
    async assertOwned() {
      if (!probed && FileDaoStateRepository.commitProbe) {
        probed = true;
        await FileDaoStateRepository.commitProbe();
      }
      let raw: string;
      try {
        raw = await fs.readFile(lockPath, "utf8");
      } catch {
        throw new PersistConflictError(`DAO lock lost at ${lockPath}. Reopen the repository and retry.`, !written);
      }
      let parsed: { token?: unknown };
      try {
        parsed = JSON.parse(raw) as { token?: unknown };
      } catch {
        throw new PersistConflictError(`DAO lock lost at ${lockPath}. Reopen the repository and retry.`, !written);
      }
      if (parsed.token !== token) {
        throw new PersistConflictError(
          `DAO lock lost at ${lockPath}: another writer took over. Reopen the repository and retry.`,
          !written,
        );
      }
    },
  };
  try {
    return await fn(lease);
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
