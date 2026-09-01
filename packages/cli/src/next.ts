// Swarm DAO CLI — `next`: what the machines need from you, and what is
// quietly progressing. Attention (human gates) first, then live-but-calm
// workflows (cooldown countdowns, in-flight runs), each with the exact
// command to copy. Read-only.

import { ATTENTION_SOURCES, type AttentionSource, collectAttention, FsAttentionStore } from "@guyghost/swarm-dao-core";
import { c, formatRemaining, GLYPH } from "./render.js";
import { locateRoot, readJsonOrNull, SERIES_ROOT_CANDIDATES } from "./roots.js";

interface RunView {
  state: string;
  context: Record<string, unknown>;
}

const TERMINAL_STATES: Readonly<Record<AttentionSource, ReadonlySet<string>>> = {
  "graph-engineering": new Set(["succeeded", "failed", "blocked", "cancelled"]),
  "improvement-loop": new Set(["succeeded", "failed", "cancelled"]),
  "improvement-series": new Set(["cancelled"]),
  "product-loop": new Set(["succeeded", "failed", "abandoned"]),
};

/** One frame of `next` output — shared by the command and `watch`. */
export async function renderNext(cwd: string): Promise<string> {
  const store = new FsAttentionStore(cwd);
  const items = await collectAttention(store);
  const gated = new Set(items.map((i) => `${i.source}/${i.runId}`));

  const progress: string[] = [];
  for (const source of ATTENTION_SOURCES) {
    const runIds = await store.listRuns(source).catch(() => [] as readonly string[]);
    for (const runId of runIds) {
      if (gated.has(`${source}/${runId}`)) continue;
      const snapshot = (await store.readSnapshot(source, runId).catch(() => null)) as
        | (RunView & { runId: string })
        | null;
      if (!snapshot || TERMINAL_STATES[source]?.has(snapshot.state)) continue;
      progress.push(...(await describeProgress(source, runId, snapshot)));
    }
  }

  if (items.length === 0 && progress.length === 0) {
    return "nothing pending — no human gates, no active workflows\n";
  }

  const lines: string[] = [];
  if (items.length > 0) {
    lines.push(`${c.bold("Needs you")} — human gates`);
    for (const item of items) {
      lines.push(`  ${GLYPH.warn} ${c.bold(item.runId)} — ${item.action}${c.dim(` [${item.source}, ${item.state}]`)}`);
      if (item.detail) lines.push(`      ${c.dim(`detail: ${item.detail}`)}`);
      if (item.command) lines.push(`      ${GLYPH.arrow} ${item.command}`);
    }
  } else {
    lines.push(`${c.bold("Needs you")} — nothing; no human gates are pending`);
  }

  if (progress.length > 0) {
    lines.push(``, `${c.bold("In progress")} — no action needed`);
    for (const line of progress) lines.push(`  ${GLYPH.wait} ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function cmdNext(cwd: string): Promise<number> {
  process.stdout.write(await renderNext(cwd));
  return 0;
}

async function describeProgress(
  source: AttentionSource,
  runId: string,
  snapshot: { state: string; context: Record<string, unknown> },
): Promise<string[]> {
  if (source === "improvement-series" && (snapshot.state === "idle" || snapshot.context.started === false)) {
    // `improve status` materializes idle series storage on demand; a series
    // that never started is not live progress.
    return [];
  }
  if (source === "improvement-series" && snapshot.state === "cooldown") {
    // The attention store drops top-level fields (cooldownEnteredAt); read
    // the real series snapshot for the countdown and the next cycle number.
    return cooldownProgress(runId);
  }
  return [`${runId} — ${c.info(snapshot.state)}${c.dim(` [${source}]`)}`];
}

async function cooldownProgress(seriesId: string): Promise<string[]> {
  const located = await locateRoot(process.cwd(), seriesId, SERIES_ROOT_CANDIDATES);
  const snapshot = (await readJsonOrNull(`${located.root}/${seriesId}/snapshot.json`)) as {
    cooldownEnteredAt?: string | null;
    context?: { cooldownMs?: number | null; cycleSequence?: number };
  } | null;
  if (!snapshot) return [`${seriesId} — cooldown`];
  const remaining = formatRemaining(
    snapshot.cooldownEnteredAt ?? null,
    snapshot.context?.cooldownMs ?? null,
    Date.now(),
  );
  const nextCycle = (snapshot.context?.cycleSequence ?? 0) + 1;
  if (remaining === "ready") {
    return [`${seriesId} — cycle ${nextCycle} ready to start → swarm-dao improve once --series-id ${seriesId}`];
  }
  return [
    `${seriesId} — cycle ${nextCycle} ready in ${c.info(remaining)} → swarm-dao improve once --series-id ${seriesId}`,
  ];
}
