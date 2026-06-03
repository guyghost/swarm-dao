// ============================================================
// Swarm DAO Core — Inter-Proposal Dependency Resolution
// ============================================================

import type { Proposal } from "../types/index.js";

export type DependencyResolution =
  | { order: number[]; error?: undefined }
  | { order?: undefined; error: string };

/**
 * Resolve the execution order for a proposal and all its transitive dependencies.
 * Returns a topologically sorted list of proposal IDs (leaves first, target last).
 * Errors on cycles or missing dependency references.
 */
export function resolveDependencyOrder(targetId: number, proposals: Proposal[]): DependencyResolution {
  const proposalMap = new Map<number, Proposal>(proposals.map((p) => [p.id, p]));
  const order: number[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>(); // in-progress nodes for cycle detection

  function dfs(id: number): string | null {
    if (visiting.has(id)) {
      return `Circular dependency detected involving proposal #${id}`;
    }
    if (visited.has(id)) return null;

    const proposal = proposalMap.get(id);
    if (!proposal) {
      return `Proposal #${id} referenced as dependency but not found`;
    }

    visiting.add(id);
    for (const depId of proposal.dependsOn ?? []) {
      const cycleError = dfs(depId);
      if (cycleError) return cycleError;
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
    return null;
  }

  const cycleError = dfs(targetId);
  if (cycleError) return { error: cycleError };
  return { order };
}

/**
 * Return only the unexecuted dependencies (excluding the target itself)
 * in the order they must be shipped.
 */
export function getUnexecutedDependencies(targetId: number, proposals: Proposal[]): DependencyResolution {
  const resolution = resolveDependencyOrder(targetId, proposals);
  if (resolution.error) return resolution;

  const proposalMap = new Map<number, Proposal>(proposals.map((p) => [p.id, p]));
  const allOrder = resolution.order!;
  const unexecuted = allOrder
    .filter((id) => id !== targetId)
    .filter((id) => proposalMap.get(id)?.status !== "executed");

  return { order: unexecuted };
}
