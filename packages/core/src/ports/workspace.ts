// ============================================================
// Swarm DAO Core — Execution Workspace Port
// ============================================================
// Narrow port through which the application layer asks for an isolated
// execution workspace before a proposal is executed. Implementations live
// outside the business logic (adapters/git-workspace.ts binds it to
// `git worktree`); tests bind it to fakes.
//
// Contract: prepare() only provisions the workspace (branch + directory).
// It never mutates DAO state, never transitions the proposal machine, and
// never merges anything back — merging stays a deliberate, separately
// authorized action (e.g. via the existing GitHub PR flow).

import type { Proposal } from "../types/index.js";

export type ExecutionWorkspaceResult = { ok: true; branch: string; path: string | null } | { ok: false; error: string };

export interface ExecutionWorkspacePort {
  /** Provision (or reattach to) the isolated workspace for a proposal. */
  prepare(proposal: Pick<Proposal, "id" | "title">): Promise<ExecutionWorkspaceResult>;
}
