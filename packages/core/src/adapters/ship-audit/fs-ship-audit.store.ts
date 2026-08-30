// ============================================================
// Swarm DAO Core — Ship Audit Filesystem Store
// ============================================================
// Persists audit-challenge snapshots under <repositoryRoot>/.dao/ship-audits/
// as <proposalId>.json. Read-soft: a missing or unreadable file yields null
// (a fresh cycle), never an error — the challenge must still gate.

import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
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
    await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  public async claim(proposalId: number): Promise<{ acquired: boolean; release: () => Promise<void> }> {
    const lock = this.#fileFor(proposalId).replace(/\.json$/, ".lock");
    await fs.mkdir(this.#directory, { recursive: true });
    try {
      // O_EXCL ('wx'): exactly one concurrent caller across processes wins.
      const handle = await fs.open(lock, "wx");
      await handle.write(`${process.pid}\n`);
      await handle.close();
      return {
        acquired: true,
        release: async () => {
          await fs.rm(lock, { force: true }).catch(() => undefined);
        },
      };
    } catch {
      return { acquired: false, release: async () => undefined };
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
