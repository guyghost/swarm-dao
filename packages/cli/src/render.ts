// Swarm DAO CLI — human-readable rendering.
//
// Pure formatting only (no filesystem access): callers read snapshots and
// journals, then hand plain values to these renderers. Machine output stays
// available everywhere via `--json`; pretty is the default because the CLI's
// primary audience is the human who governs the machines.

const useColor = !process.env.NO_COLOR && process.stdout.isTTY === true;

const paint =
  (code: string) =>
  (text: string): string =>
    useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const c = {
  ok: paint("32"),
  warn: paint("33"),
  fail: paint("31"),
  info: paint("36"),
  dim: paint("2"),
  bold: paint("1"),
};

export const GLYPH = {
  ok: "✓",
  warn: "⚠",
  wait: "⏳",
  fail: "✗",
  arrow: "→",
} as const;

export function truncateHash(hash: string | null | undefined, keep = 8): string {
  if (!hash) return "—";
  return hash.length <= keep ? hash : hash.slice(0, keep);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatRemaining(fromIso: string | null | undefined, cooldownMs: number | null, now: number): string {
  if (!fromIso) return "—";
  const remaining = Date.parse(fromIso) + (cooldownMs ?? 0) - now;
  if (remaining <= 0) return "ready";
  return formatDuration(remaining);
}

// ── Series status ───────────────────────────────────────────

export interface SeriesStatusView {
  seriesId: string;
  state: string;
  scope: string | null;
  cycleSequence: number;
  activeCycleId: string | null;
  cooldownEnteredAt: string | null;
  cooldownMs: number | null;
  terminalReason: string | null;
}

export interface CycleStatusView {
  cycleId: string;
  state: string;
  attempt: number;
  maxRetries: number;
  metricValue: string | null;
  driftClass: string | null;
  arbitration: string | null;
  anchors: Record<string, { status: string; attempt: number }>;
  terminalReason: string | null;
}

const SERIES_STATE_GLYPH: Record<string, string> = {
  cooldown: GLYPH.wait,
  halted: GLYPH.warn,
  cancelled: GLYPH.fail,
  workerFailed: GLYPH.warn,
  awaitingHumanCycleDecision: GLYPH.warn,
};

export function renderSeriesStatus(
  series: SeriesStatusView,
  cycle: CycleStatusView | null,
  opts: { now: number; found: boolean; triedRoots?: readonly string[] },
): string[] {
  if (!opts.found) {
    return [
      `${c.bold(series.seriesId)} — ${c.warn("not found")} ${c.dim("(fresh idle snapshot)")}`,
      `tried: ${c.dim((opts.triedRoots ?? []).join(", "))}`,
      `start one: ${GLYPH.arrow} swarm-dao improve init --series-id ${series.seriesId} --scope <scope> --reference-hash <hash>`,
    ];
  }

  const glyph = SERIES_STATE_GLYPH[series.state] ?? GLYPH.ok;
  const lines = [
    `${c.bold(series.seriesId)}${series.scope ? c.dim(` — ${series.scope}`) : ""}`,
    `state:    ${c.info(series.state)} ${glyph}${series.terminalReason ? c.dim(` (${series.terminalReason})`) : ""}`,
    `cycles:   ${series.cycleSequence} completed${series.activeCycleId ? ` | active: ${c.bold(series.activeCycleId)}` : ""}`,
  ];

  if (cycle) {
    const passed = Object.values(cycle.anchors).filter((a) => a.status === "passed").length;
    const total = Object.keys(cycle.anchors).length;
    const anchorsPart = total > 0 ? ` | anchors ${passed}/${total} passed` : "";
    const retryPart = cycle.attempt > 0 ? c.dim(` (retry ${cycle.attempt}/${cycle.maxRetries})`) : "";
    lines.push(
      `cycle:    ${c.info(cycle.state)}${retryPart}${anchorsPart}` +
        (cycle.metricValue ? ` | metric ${cycle.metricValue}` : ""),
    );
    if (cycle.terminalReason) lines.push(`reason:   ${c.dim(cycle.terminalReason)}`);
  }

  if (series.state === "cooldown") {
    const remaining = formatRemaining(series.cooldownEnteredAt, series.cooldownMs, opts.now);
    lines.push(
      remaining === "ready"
        ? `cooldown: ${c.ok("ready")} — the next cycle can start`
        : `cooldown: ${c.warn(remaining)} remaining`,
    );
  }

  const next = nextStepFor(series, cycle);
  if (next) lines.push(`next:     ${GLYPH.arrow} ${next}`);
  return lines;
}

function nextStepFor(series: SeriesStatusView, cycle: CycleStatusView | null): string | null {
  switch (series.state) {
    case "cooldown":
      return `swarm-dao improve once --series-id ${series.seriesId}`;
    case "awaitingHumanCycleDecision":
      if (cycle?.state === "retrying") return `swarm-dao improve retry --cycle-id ${cycle.cycleId}`;
      return `swarm-dao improve status --series-id ${series.seriesId}`;
    case "workerFailed":
      return `swarm-dao improve retry-workers --series-id ${series.seriesId}`;
    case "halted":
      return `swarm-dao improve restart --series-id ${series.seriesId}`;
    default:
      return null;
  }
}

// ── Graph run status ────────────────────────────────────────

export interface GraphStatusView {
  runId: string;
  state: string;
  modelHash: string | null;
  approvedModelHash: string | null;
  implementationHash: string | null;
  anchors: Record<string, { status: string }>;
}

export function renderGraphStatus(run: GraphStatusView): string[] {
  const terminal = run.state === "succeeded";
  const glyph = run.state === "succeeded" ? GLYPH.ok : run.state === "awaitingApproval" ? GLYPH.warn : GLYPH.wait;
  const lines = [
    `${c.bold(run.runId)} — ${c.info(run.state)} ${glyph}`,
    `model:    ${truncateHash(run.modelHash)}` +
      (run.approvedModelHash
        ? ` ${c.ok(GLYPH.ok)} approved`
        : run.state === "awaitingApproval"
          ? ` ${c.warn("ACTION REQUIRED")}`
          : "") +
      (run.implementationHash ? c.dim(` · implemented (${truncateHash(run.implementationHash)})`) : ""),
  ];

  const anchorEntries = Object.entries(run.anchors);
  if (anchorEntries.length > 0) {
    const rendered = anchorEntries
      .map(([name, a]) => `${name} ${a.status === "passed" ? c.ok(GLYPH.ok) : c.fail(GLYPH.fail)}`)
      .join("  ");
    lines.push(`anchors:  ${rendered}`);
  }

  if (run.state === "awaitingApproval") {
    lines.push(`next:     ${GLYPH.arrow} swarm-dao approve --run-id ${run.runId}`);
  }
  if (run.state === "retrying") {
    lines.push(`next:     ${GLYPH.arrow} swarm-dao graph submit --run-id ${run.runId} --signal <signal.json>`);
  }
  if (terminal) lines.push(c.dim("run is terminal; evidence is preserved under the evidence root"));
  return lines;
}

// ── Cycle history table ─────────────────────────────────────

export interface CycleHistoryRow {
  number: number;
  cycleId: string;
  state: string;
  attempt: number;
  metricValue: string | null;
  driftClass: string | null;
  arbitration: string | null;
  durationMs: number | null;
}

export function renderCyclesTable(rows: readonly CycleHistoryRow[]): string[] {
  if (rows.length === 0) return [c.dim("no cycles recorded yet")];
  const header = ["cycle", "state", "attempt", "metric", "drift", "arbitration", "duration"];
  const cells = rows.map((r) => {
    const stateGlyph =
      r.state === "succeeded"
        ? c.ok(`${GLYPH.ok} ${r.state}`)
        : r.state === "failed"
          ? c.fail(`${GLYPH.fail} ${r.state}`)
          : r.state;
    return [
      String(r.number),
      stateGlyph,
      String(r.attempt),
      r.metricValue ?? "—",
      r.driftClass ?? "—",
      r.arbitration ?? "—",
      r.durationMs === null ? "—" : formatDuration(r.durationMs),
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(stripAnsi(h).length, ...cells.map((row) => stripAnsi(row[i] ?? "").length)),
  );
  const format = (row: string[]): string =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0, " "))).join("  ");
  return [c.dim(format(header)), ...cells.map((row) => format(row))];
}

function stripAnsi(text: string): string {
  // ANSI SGR codes only — what `c` emits above.
  const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return text.replace(SGR, "");
}
