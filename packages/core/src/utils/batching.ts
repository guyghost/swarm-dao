// ============================================================
// Swarm DAO Core — Batching helpers (pure)
// ============================================================

/**
 * Normalize a requested concurrency/batch size to a usable positive integer.
 *
 * The chunking loops (`for (i = 0; i < items.length; i += size)`) stall forever
 * on a zero, negative, `NaN`, or non-finite size — `i` never advances. That
 * value is caller/config input (`state.config.maxConcurrent`, mutated by the
 * `config-update` amendment and read from an editable `state.json`), so the
 * loops must not trust it. Mirrors the adapters' `Math.max(1, maxConcurrent)`
 * guard, additionally covering `NaN`/non-finite which `Math.max` passes through.
 */
export function normalizeBatchSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const truncated = Math.trunc(value);
  return truncated >= 1 ? truncated : 1;
}
