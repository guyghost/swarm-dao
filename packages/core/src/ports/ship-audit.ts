// ============================================================
// Swarm DAO Core — Ship Audit Store Port
// ============================================================
// Narrow port through which the ship handler loads and persists a proposal's
// audit-challenge snapshots. The machine stays pure; implementations live in
// adapters (FsShipAuditStore writes .dao/ship-audits/<id>.json).

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
}
