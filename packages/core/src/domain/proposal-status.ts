// ============================================================
// Swarm DAO Core — Proposal status policy (pure)
// ============================================================
// The archived/live split is a governance rule, not an I/O concern: it is read
// by the persistence adapter (ADR-004 partitioning) and by application use
// cases that mutate a proposal and must tell the repository which partition
// they touched. Living in `domain/` keeps application code free of
// infrastructure imports (hexagonal contract).

import type { ProposalStatus } from "../types/index.js";

/** Closed proposals are archived; only these two statuses stay in `state.json`.
 *  Same predicate as the decisions sweep — keep them aligned. */
export function isArchivedStatus(status: ProposalStatus): boolean {
  return status !== "open" && status !== "deliberating";
}
