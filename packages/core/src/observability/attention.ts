// ============================================================
// Swarm DAO Core — Attention Queue (read-only human-gate view)
// ============================================================
// Aggregates the pending human decisions across the repository-local
// workflow machines (Graph Engineering runs, Improvement Loop cycles,
// Product Loop runs). Read-only: this module never sends events, never
// mutates machine state, and never writes evidence. It only projects
// persisted snapshots into an actionable list for the human owner.
//
// Authority boundary (unchanged): the machines decide states; this view
// merely classifies which persisted states await a human-source event.

export type AttentionSource = "graph-engineering" | "improvement-loop" | "product-loop";

/** Minimal persisted-snapshot shape shared by the three runners. */
export interface AttentionSnapshot {
  runId: string;
  state: string;
  status: string;
  context?: Record<string, unknown> | null;
}

export interface AttentionItem {
  source: AttentionSource;
  runId: string;
  state: string;
  /** What the human owner must decide. */
  action: string;
  /** Suggested resolution command, if any. */
  command: string | null;
  /** Concrete anchor for the decision (model hash, reference hash, reason). */
  detail: string | null;
}

/** Filesystem view over the evidence roots (injected; no ambient I/O here). */
export interface AttentionStorePort {
  /** Stable run identifiers persisted under the source's evidence root. */
  listRuns(source: AttentionSource): Promise<readonly string[]>;
  /** Persisted snapshot for a run, or null when unreadable. */
  readSnapshot(source: AttentionSource, runId: string): Promise<AttentionSnapshot | null>;
}

/** Documented evidence roots per source (relative to the repository root). */
export const ATTENTION_EVIDENCE_DIRS: Readonly<Record<AttentionSource, string>> = {
  "graph-engineering": "evidence/graph-runs",
  "improvement-loop": "evidence/improvement-cycles",
  "product-loop": "evidence/product-loops",
};

/**
 * Project-local (.dao) roots the swarm-dao CLI defaults to in foreign
 * projects (graph runs, improvement cycles, product loops keep their state
 * under .dao/). Scanned in addition to the documented evidence roots; a
 * runId present in both resolves to the documented root's snapshot.
 */
export const ATTENTION_CLI_DIRS: Readonly<Record<AttentionSource, string>> = {
  "graph-engineering": ".dao/graph-runs",
  "improvement-loop": ".dao/improvement-cycles",
  "product-loop": ".dao/product-loops",
};

export const ATTENTION_SOURCES: readonly AttentionSource[] = ["graph-engineering", "improvement-loop", "product-loop"];

interface GateDefinition {
  action: string;
  command: string | null;
  detail?: (context: Record<string, unknown> | null | undefined) => string | null;
}

const stringField = (context: Record<string, unknown> | null | undefined, field: string): string | null => {
  const value = context?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * States that persist only while a human decision is pending. Terminal
 * outcomes (succeeded, failed, blocked, cancelled, validated, rejected) are
 * deliberately excluded: they are closed, not awaiting attention.
 * `budgetBlocked` is transient (always -> review) and never persists.
 */
const HUMAN_GATES: Readonly<Record<AttentionSource, Readonly<Record<string, GateDefinition>>>> = {
  "graph-engineering": {
    awaitingApproval: {
      action: "Approve or reject the exact model hash (MODEL_APPROVED / MODEL_REJECTED)",
      command: "swarm-dao graph submit --run-id <id> --signal <signal.json>",
      detail: (ctx) => stringField(ctx, "modelHash"),
    },
    retrying: {
      action: "Authorize a retry (RETRY_AUTHORIZED) or cancel the run",
      command: "swarm-dao graph submit --run-id <id> --signal <signal.json>",
    },
  },
  "improvement-loop": {
    adjusting: {
      action: "Approve or reject the reference change (REFERENCE_CHANGE_APPROVED / REJECTED)",
      command: "bun run improvement:submit -- --cycle-id <id> --signal <signal.json>",
      detail: (ctx) => stringField(ctx, "referenceHash"),
    },
    retrying: {
      action: "Authorize a retry (RETRY_AUTHORIZED) or cancel the cycle",
      command: "bun run improvement:submit -- --cycle-id <id> --signal <signal.json>",
    },
  },
  "product-loop": {
    review: {
      action: "Resolve the review: reduce scope, expand budget, retry verification, or abandon",
      command: "swarm-dao product submit --run-id <id> --signal <signal.json>",
      detail: (ctx) => stringField(ctx, "reviewReason"),
    },
  },
};

/** Classify one persisted snapshot; null when no human decision is pending. */
export function classifyAttention(source: AttentionSource, snapshot: AttentionSnapshot): AttentionItem | null {
  const gate = HUMAN_GATES[source]?.[snapshot.state];
  if (!gate) return null;
  const runId =
    typeof snapshot.context?.cycleId === "string" && snapshot.context.cycleId.length > 0
      ? snapshot.context.cycleId
      : snapshot.runId;
  return {
    source,
    runId,
    state: snapshot.state,
    action: gate.action,
    // Substitute the run id so the suggested command is directly runnable.
    command: gate.command ? gate.command.replaceAll("<id>", runId) : null,
    detail: gate.detail ? gate.detail(snapshot.context) : null,
  };
}

/**
 * Sweep every source (or a filtered subset) and return the pending human
 * gates, sorted by source then run id. Unreadable snapshots are skipped:
 * the sweep itself must never fail because one run is corrupted.
 */
export async function collectAttention(
  store: AttentionStorePort,
  sources: readonly AttentionSource[] = ATTENTION_SOURCES,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  for (const source of ATTENTION_SOURCES) {
    if (!sources.includes(source)) continue;
    let runIds: readonly string[] = [];
    try {
      runIds = await store.listRuns(source);
    } catch {
      continue;
    }
    for (const runId of runIds) {
      const snapshot = await store.readSnapshot(source, runId).catch(() => null);
      if (!snapshot) continue;
      const item = classifyAttention(source, snapshot);
      if (item) items.push(item);
    }
  }
  return items.sort((a, b) => `${a.source}/${a.runId}`.localeCompare(`${b.source}/${b.runId}`));
}

/** Human-readable table; pure formatting, no decisions. */
export function formatAttention(items: readonly AttentionItem[]): string {
  if (items.length === 0) {
    return "Attention: no pending human gates. All workflow runs are either progressing or terminal.";
  }
  const width = Math.max(...items.map((i) => `${i.source}/${i.runId}`.length));
  const lines = items.map((item) => {
    const id = `${item.source}/${item.runId}`.padEnd(width);
    const detail = item.detail ? ` [${item.detail}]` : "";
    return `${id}  ${item.state.padEnd(17)}${detail}\n           → ${item.action}`;
  });
  return [`Attention: ${items.length} pending human gate${items.length === 1 ? "" : "s"}`, ...lines].join("\n");
}
