// ============================================================
// Swarm DAO Product Loop — AI-channel signal submission
// ============================================================
// The single entry host adapters (MCP server, Pi adapter, …) should use to
// submit an AI worker's artifact to a product run. The source is forced to
// "ai" HERE, inside the package — an AI-facing host can never claim the
// tool/system/human channel, and the event types are restricted to the
// AI-artifact set at the type level (producer binding is still enforced by
// validateProductSignal). Human events (REVIEW_RESOLVED,
// RETRY_VERIFICATION_AUTHORIZED, CONTACT_RELAY_AUTHORIZED, CANCEL) belong to
// the CLI human channel.

import { createProductRunner, type ProductSubmissionResult } from "./runner.js";

/** The AI-artifact event types (the only ones the AI channel may emit). */
export const PRODUCT_AI_EVENT_TYPES = ["AGENT_SIGNAL", "FEEDBACK_AGGREGATED", "PROPOSAL_DRAFTED"] as const;

export type ProductAiEventType = (typeof PRODUCT_AI_EVENT_TYPES)[number];

export interface AiProductSignalInput {
  runId: string;
  type: ProductAiEventType;
  producer: string;
  payload: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
}

/**
 * Submit an AI-source signal to a product run. The caller supplies only the
 * artifact fields; this helper stamps `source: "ai"` and `occurredAt`, then
 * routes through the same validation and frozen machine as every other
 * submission.
 */
export async function submitAiProductSignal(
  options: { evidenceRoot: string; now?: () => string },
  signal: AiProductSignalInput,
): Promise<ProductSubmissionResult> {
  const runner = await createProductRunner({ evidenceRoot: options.evidenceRoot, runId: signal.runId });
  return runner.submit({
    ...signal,
    source: "ai",
    occurredAt: (options.now ?? (() => new Date().toISOString()))(),
  });
}
