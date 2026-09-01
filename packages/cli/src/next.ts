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

export async function cmdNext(cwd: string): Promise<number> {
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
    process.stdout.write("nothing pending — no human gates, no active workflows\n");
    return 0;
  }

  if (items.length > 0) {
    process.stdout.write(`${c.bold("Needs you")} — human gates\n`);
    for (const item of items) {
      process.stdout.write(
        `  ${GLYPH.warn} ${c.bold(item.runId)} — ${item.action}${c.dim(` [${item.source}, ${item.state}]`)}\n`,
      );
      if (item.detail) process.stdout.write(`      ${c.dim(`detail: ${item.detail}`)}\n`);
      if (item.command) process.stdout.write(`      ${GLYPH.arrow} ${item.command}\n`);
    }
  } else {
    process.stdout.write(`${c.bold("Needs you")} — nothing; no human gates are pending\n`);
  }

  if (progress.length > 0) {
    process.stdout.write(`\n${c.bold("In progress")} — no action needed\n`);
    for (const line of progress) process.stdout.write(`  ${GLYPH.wait} ${line}\n`);
  }
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
