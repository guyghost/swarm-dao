// ============================================================
// Swarm DAO Core — Ship Audit Store Port
// ============================================================
// Narrow port through which the ship handler loads, persists, and
// exclusively claims a proposal's audit-challenge snapshots. The machine
// stays pure; implementations live in adapters (FsShipAuditStore writes
// .dao/ship-audits/<id>.json with an O_EXCL cross-process claim).

export interface ShipAuditSnapshot {
  proposalId: number;
  state: string;
  status: string;
  context: {
    proposalId: number;
    fingerprint: string | null;
    challengeCount: number;
    confirmedAt: string | null;
    terminalReason: string | null;
  };
}

export interface ShipAuditStorePort {
  load(proposalId: number): Promise<ShipAuditSnapshot | null>;
  save(snapshot: ShipAuditSnapshot): Promise<void>;
  /**
   * Exclusive cross-process claim for the gate's read→transition→write
   * sequence (INV-6: one confirmation must not authorize concurrent
   * ships). Resolve true when acquired; release via the returned function.
   */
  claim(proposalId: number): Promise<{ acquired: boolean; release: () => Promise<void> }>;
}
