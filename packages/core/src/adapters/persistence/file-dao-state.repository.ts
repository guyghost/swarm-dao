import { promises as fs } from "node:fs";
import path from "node:path";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import { createInitialState, type DAOState, type DecisionRecord } from "../../types/index.js";

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function repairState(value: Partial<DAOState>, daoRoot: string): DAOState {
  const fallback = createInitialState(daoRoot);
  const state = { ...fallback, ...value, daoRoot } as DAOState;
  state.proposals = Array.isArray(value.proposals) ? value.proposals : [];
  state.agents = Array.isArray(value.agents) ? value.agents : [];
  state.auditLog = Array.isArray(value.auditLog) ? value.auditLog : [];
  state.controlResults = value.controlResults && !Array.isArray(value.controlResults) ? value.controlResults : {};
  state.deliveryPlans = value.deliveryPlans && !Array.isArray(value.deliveryPlans) ? value.deliveryPlans : {};
  state.artefacts = value.artefacts && !Array.isArray(value.artefacts) ? value.artefacts : {};
  state.outcomes = value.outcomes && !Array.isArray(value.outcomes) ? value.outcomes : {};
  state.snapshots = value.snapshots && !Array.isArray(value.snapshots) ? value.snapshots : {};
  state.verifications = value.verifications && !Array.isArray(value.verifications) ? value.verifications : {};
  const nextProposalId = value.nextProposalId;
  const nextAuditId = value.nextAuditId;
  state.nextProposalId =
    typeof nextProposalId === "number" && Number.isInteger(nextProposalId) && nextProposalId > 0 ? nextProposalId : 1;
  state.nextAuditId =
    typeof nextAuditId === "number" && Number.isInteger(nextAuditId) && nextAuditId > 0 ? nextAuditId : 1;
  return state;
}

/** Instance-owned filesystem adapter. No process-global DAO state or write cache. */
export class FileDaoStateRepository implements DaoStateRepositoryPort {
  private readonly writeCache = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly state: DAOState,
    private readonly daoRoot: string,
  ) {}

  public static async open(cwd: string): Promise<FileDaoStateRepository> {
    const daoRoot = path.join(cwd, ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    const statePath = path.join(daoRoot, "state.json");
    let state = createInitialState(daoRoot);
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as Partial<DAOState>;
      state = repairState(parsed, daoRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileDaoStateRepository(state, daoRoot);
  }

  public get(): DAOState {
    return this.state;
  }

  public async persist(): Promise<void> {
    const task = async (): Promise<void> => {
      await fs.mkdir(this.daoRoot, { recursive: true });
      await withFileLock(this.daoRoot, async () => {
        await this.checkNoConcurrentModification();
        await this.writeIfChanged(path.join(this.daoRoot, "state.json"), this.state);
        await this.persistDecisions();
      });
    };
    const queued = this.writeQueue.then(task, task);
    this.writeQueue = queued.catch(() => {});
    await queued;
  }

  /**
   * Fail-fast optimistic concurrency: if another process persisted a state
   * with proposals/ids we don't know about, refuse to overwrite it instead
   * of silently dropping votes/proposals (last-writer-wins).
   */
  private async checkNoConcurrentModification(): Promise<void> {
    let onDisk: Partial<DAOState> | null = null;
    try {
      onDisk = JSON.parse(await fs.readFile(path.join(this.daoRoot, "state.json"), "utf8")) as Partial<DAOState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!onDisk || !Array.isArray(onDisk.proposals)) return;
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
  }

  private async persistDecisions(): Promise<void> {
    const decisionsDir = path.join(this.daoRoot, "decisions");
    await fs.mkdir(decisionsDir, { recursive: true });
    const decisions = this.state.proposals
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
    await this.writeIfChanged(path.join(decisionsDir, "index.json"), decisions);
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

async function withFileLock<T>(daoRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(daoRoot, LOCK_FILE);
  await fs.mkdir(daoRoot, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), {
        flag: "wx",
      });
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
  try {
    return await fn();
  } finally {
    await safeUnlink(lockPath);
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
