// ============================================================
// Swarm DAO Core — Ship Audit Filesystem Store
// ============================================================
// Persists audit-challenge snapshots under <repositoryRoot>/.dao/ship-audits/
// as <proposalId>.json. Read-soft: a missing or unreadable file yields null
// (a fresh cycle), never an error — the challenge must still gate.

import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeAtomic } from "../../persistence.js";
import type { ShipAuditSnapshot, ShipAuditStorePort } from "../../ports/ship-audit.js";

const SAFE_ID = /^\d+$/;

export class FsShipAuditStore implements ShipAuditStorePort {
  readonly #directory: string;

  public constructor(repositoryRoot: string) {
    this.#directory = resolve(repositoryRoot, ".dao", "ship-audits");
  }

  public async load(proposalId: number): Promise<ShipAuditSnapshot | null> {
    if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
    const file = this.#fileFor(proposalId);
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.state !== "string" || record.state.length === 0) return null;
      const context = record.context;
      if (typeof context !== "object" || context === null) return null;
      return parsed as ShipAuditSnapshot;
    } catch {
      return null;
    }
  }

  public async save(snapshot: ShipAuditSnapshot): Promise<void> {
    const file = this.#fileFor(snapshot.proposalId);
    await fs.mkdir(this.#directory, { recursive: true });
    await writeAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  public async claim(proposalId: number): Promise<{ acquired: boolean; release: () => Promise<void> }> {
    const lock = this.#fileFor(proposalId).replace(/\.json$/, ".lock");
    await fs.mkdir(this.#directory, { recursive: true });
    try {
      // O_EXCL ('wx'): exactly one concurrent caller across processes wins.
      const payload = `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`;
      const handle = await fs.open(lock, "wx");
      await handle.write(payload);
      await handle.close();
      return {
        acquired: true,
        release: async () => {
          await fs.rm(lock, { force: true }).catch(() => undefined);
        },
      };
    } catch {
      // EEXIST: a claim already exists. If its writer is provably gone
      // (dead pid) or it is old enough, reclaim it instead of failing ships
      // forever until manual cleanup (issue #167.5).
      if (await this.#claimIsAbandoned(lock)) {
        await fs.rm(lock, { force: true }).catch(() => undefined);
        return this.claim(proposalId);
      }
      return { acquired: false, release: async () => undefined };
    }
  }

  /** A claim is abandoned when the owning pid no longer exists, or when it
   *  is older than the staleness window (crash without cleanup, cross-machine
   *  writers where the pid check cannot apply). */
  static readonly #CLAIM_STALE_MS = 30 * 60 * 1000;

  async #claimIsAbandoned(lock: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(lock, "utf8");
      let pid: number | undefined;
      let ts: number | undefined;
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
        if (typeof parsed.ts === "number") ts = parsed.ts;
      } catch {
        // Legacy format: a bare pid line.
        const parsedPid = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(parsedPid)) pid = parsedPid;
      }
      if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // liveness probe — throws if the process is gone
          // Alive: only age can make the claim abandonable.
        } catch {
          return true; // owning process is gone
        }
      }
      if (ts !== undefined && Date.now() - ts > FsShipAuditStore.#CLAIM_STALE_MS) return true;
      return false;
    } catch {
      return false; // unreadable claim: keep failing closed
    }
  }

  #fileFor(proposalId: number): string {
    const name = String(proposalId);
    if (!SAFE_ID.test(name)) throw new Error("proposalId must be a positive integer");
    const file = resolve(join(this.#directory, `${name}.json`));
    if (!file.startsWith(`${this.#directory}${sep}`)) throw new Error("snapshot path escapes the store directory");
    return file;
  }
}
