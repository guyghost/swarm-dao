// ============================================================
// Swarm DAO Graph Engineering — AI-channel signal submission
// ============================================================
// The single entry host adapters (MCP server, Pi adapter, …) should use to
// submit an AI worker's artifact to a graph run. The source is forced to
// "ai" HERE, inside the package — an AI-facing host can never claim the
// tool/system/human channel, and the event types are restricted to the
// AI-artifact set at the type level. Human events (MODEL_APPROVED,
// MODEL_REJECTED, RETRY_AUTHORIZED, CANCEL) belong to the CLI human channel;
// tool/system events belong to the deterministic tools.

import { createGraphRunner, type GraphSubmissionResult } from "./runner.js";

/** The AI-artifact event types (the only ones the AI channel may emit). */
export const GRAPH_AI_EVENT_TYPES = ["MODEL_DRAFTED", "IMPLEMENTATION_READY", "IMPLEMENTATION_FAILED"] as const;

export type GraphAiEventType = (typeof GRAPH_AI_EVENT_TYPES)[number];

export interface AiGraphSignalInput {
  runId: string;
  type: GraphAiEventType;
  producer: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}

/**
 * Submit an AI-source signal to a graph run. The caller supplies only the
 * artifact fields; this helper stamps `source: "ai"` and `occurredAt`, then
 * routes through the same validation and frozen machine as every other
 * submission.
 */
export async function submitAiGraphSignal(
  options: { evidenceRoot: string; now?: () => string },
  signal: AiGraphSignalInput,
): Promise<GraphSubmissionResult> {
  const runner = await createGraphRunner({ evidenceRoot: options.evidenceRoot, runId: signal.runId });
  return runner.submit({
    ...signal,
    source: "ai",
    occurredAt: (options.now ?? (() => new Date().toISOString()))(),
  });
}
