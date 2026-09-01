// Swarm DAO — Improvement Orchestrator series runner and CLI.
//
// The series machine in packages/core/src/models/improvement-orchestrator.machine.ts
// is the only series-state authority. This module is the executor: it journals
// every orchestrator event, persists the series snapshot under
// evidence/improvement-series/ (restored by deterministic journal replay), and
// — via `once` — executes exactly the effect authorized by the current series
// state:
//   preparing   INIT_CYCLE            -> CYCLE_INITIALIZED   (tool)
//   sampling    RUN_WORKERS(sensors)  -> WORKERS_HARVESTED   (tool) | WORKERS_FAILED
//   sealing     SUBMIT_SAMPLES        -> SAMPLES_SUBMITTED   (tool) | SIGNAL_REJECTED
//   auditing    RUN_WORKERS(drift)    -> WORKERS_HARVESTED   (tool) | WORKERS_FAILED
//   arbitrating SUBMIT_DRIFT          -> ARBITRATION_SUBMITTED (tool) | SIGNAL_REJECTED
//   grounding   RUN_ANCHOR_COMMANDS   -> ANCHORS_SUBMITTED   (tool)
//   evaluating  SUBMIT_EVALUATE       -> EVALUATE_SUBMITTED  (tool)
//   observing   OBSERVE_CYCLE         -> CYCLE_SUCCEEDED | CYCLE_AWAITING_HUMAN |
//                                        CYCLE_FAILED | CYCLE_BLOCKED |
//                                        CYCLE_CANCELLED      (system)
//   cooldown    SCHEDULE_NEXT_CYCLE   -> COOLDOWN_ELAPSED    (system, injected clock)
//   awaitingHumanCycleDecision OBSERVE_CYCLE -> CYCLE_RESUMED (system)
//
// Authority split: the CLI forwards ONLY human events (RETRY_WORKERS,
// RESTART_SERIES, CANCEL_SERIES); tool and system events are produced
// exclusively by `once`, so free-form text or an AI can never forge a series
// transition. Anchor commands come only from the frozen
// models/improvement-loop.graph.json; a failed anchor is submitted honestly,
// never retried by the orchestrator.

import { exec as execCallback } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  arbitratePairedSignals,
  createOrchestratorActor,
  isRequiredImprovementAnchor,
  ORCHESTRATOR_MIN_COOLDOWN_MS,
  ORCHESTRATOR_TERMINAL_STATES,
  type OrchestratorActor,
  type OrchestratorContext,
  type OrchestratorEvent,
  type WorkerPhase,
} from "@guyghost/swarm-dao-core/models/improvement";
import { createImprovementRunner, type ImprovementRunner } from "./runner.js";

// Re-exported for CLI hosts: init validates the cooldown floor.
export { ORCHESTRATOR_MIN_COOLDOWN_MS };

import { AUTO_RECORDED_ANCHORS, loadProjectImprovementConfig } from "./config.js";
import { extractLastJsonObject, runHerdrWorker, type WorkerHarvest } from "./workers.js";

const execAsync = promisify(execCallback);

export const DEFAULT_SERIES_EVIDENCE_ROOT = "evidence/improvement-series";
export const DEFAULT_CYCLE_EVIDENCE_ROOT = "evidence/improvement-cycles";

const ACTIVE_SERIES_FILE = "active-series.json";

// The AUTO_RECORDED_ANCHORS set (SAMPLES_SEALED and ARBITRATION anchors) and
// the per-project anchor config live in ./config.js.

const PHASE_WORKERS: Readonly<Record<WorkerPhase, readonly string[]>> = {
  sampling: ["sensor", "counter-sensor"],
  auditing: ["drift-auditor"],
};

// Worker prompts are executor configuration, not model state (see
// models/improvement-orchestrator.review.md); the machine binds only the
// worker identities, the output contract, and the retry bound.
const WORKER_PROMPTS: Readonly<Record<string, (scope: string) => string>> = {
  // Sample values are vocabulary-tolerant by model contract: the frozen
  // negative-outcome set {declined, fell} (models/improvement-loop.md,
  // "Deterministic arbitration policy") owns the counter-veto, so prompt
  // phrasing can drift without disarming it. Prompts keep the canonical
  // words so journal samples stay uniformly worded.
  sensor: (scope) =>
    `You are the sensor worker of a Swarm DAO improvement series for scope '${scope}'. ` +
    `Observe the optimizing metric for this scope in the repository around you, then answer with ONLY a JSON object: ` +
    `{"sample": {"value": "improved|held|declined", "evidence": "<concise observation>"}}. No other text.`,
  "counter-sensor": (scope) =>
    `You are the counter-sensor worker of a Swarm DAO improvement series for scope '${scope}'. ` +
    `Observe the counter-metric (the thing that must not regress while the optimizing metric moves), ` +
    `then answer with ONLY a JSON object: {"sample": {"value": "improved|held|declined", "evidence": "<concise observation>"}}. No other text.`,
  "drift-auditor": (scope) =>
    `You are the drift-auditor worker of a Swarm DAO improvement series for scope '${scope}'. ` +
    `Compare the current implementation behavior against the approved reference for this scope, ` +
    `then answer with ONLY a JSON object: {"driftClass": "none|partial|detached", "evidence": "<concise observation>"}. No other text.`,
};

export type PersistedSeriesSnapshot = Readonly<{
  seriesId: string;
  state: string;
  status: string;
  context: OrchestratorContext;
  cooldownEnteredAt: string | null;
}>;

export type OrchestratorSubmissionResult = Readonly<{
  accepted: boolean;
  issues: readonly string[];
  snapshot: PersistedSeriesSnapshot;
}>;

export type AnchorCommandOutcome = Readonly<{ ok: boolean; detail: string }>;

export interface OrchestratorOnceDeps {
  /** Injected wall clock (ms) for cooldown scheduling; defaults to Date.now. */
  nowMs?: () => number;
  /** Worker executor override (tests); default runs the worker through herdr. */
  runWorker?: (phase: WorkerPhase, worker: string) => Promise<WorkerHarvest>;
  /** Anchor command runner override (tests); default executes via child exec. */
  runCommand?: (command: string) => Promise<AnchorCommandOutcome>;
  /** Improvement cycle evidence root (default evidence/improvement-cycles). */
  cycleEvidenceRoot?: string;
  /** Repository root for herdr workspaces and anchor commands (default cwd). */
  workDir?: string;
  /** herdr worker executor options: agent kind (pi, codex, claude, …) and
   * extra agent args for the default worker executor. Executor configuration
   * only — never model state. */
  worker?: { kind?: string; agentArgs?: readonly string[] };
}

export type OrchestratorOnceResult = Readonly<{
  seriesId: string;
  stateBefore: string;
  stateAfter: string;
  executed: boolean;
  event: string | null;
  accepted: boolean;
  issues: readonly string[];
  detail: string;
}>;

export interface OrchestratorRunnerOptions {
  seriesId: string;
  evidenceRoot: string;
  clock?: () => string;
}

type SeriesJournalEntry = Readonly<{
  sequence: number;
  seriesId: string;
  receivedAt: string;
  eventType: string | null;
  source: string | null;
  accepted: boolean;
  issues: readonly string[];
  beforeState: string;
  afterState: string;
  event?: Record<string, unknown>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validSeriesId = (seriesId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(seriesId) && !seriesId.includes("..");

const HUMAN_CHANNEL_EVENTS: ReadonlySet<string> = new Set(["RETRY_WORKERS", "RESTART_SERIES", "CANCEL_SERIES"]);

/**
 * The CLI submit channel forwards only human events; tool/system events are
 * produced by `once`. CANCEL_SERIES must already carry a non-empty reason so
 * the CLI fails early instead of surfacing a generic machine rejection later.
 */
export const isHumanChannelEvent = (event: unknown): boolean => {
  if (!isRecord(event) || !HUMAN_CHANNEL_EVENTS.has(event.type as string) || event.source !== "human") return false;
  if (event.type === "CANCEL_SERIES") return typeof event.reason === "string" && event.reason.trim().length > 0;
  return true;
};

/** Maps a persisted improvement cycle state to exactly one typed observation, or null (poll continues). */
export const mapCycleStateToObservation = (
  cycleState: string,
  terminalReason: string | null,
): OrchestratorEvent | null => {
  switch (cycleState) {
    case "succeeded":
      return { type: "CYCLE_SUCCEEDED", source: "system" };
    case "adjusting":
    case "retrying":
      return { type: "CYCLE_AWAITING_HUMAN", source: "system" };
    case "failed":
      return { type: "CYCLE_FAILED", source: "system", reason: terminalReason ?? "improvement cycle failed" };
    case "blocked":
      return { type: "CYCLE_BLOCKED", source: "system", reason: terminalReason ?? "improvement cycle blocked" };
    case "cancelled":
      return { type: "CYCLE_CANCELLED", source: "system", reason: terminalReason ?? "improvement cycle cancelled" };
    default:
      return null;
  }
};

/**
 * Resolve the anchor commands for a working directory. `.dao/improvement.json`
 * (explicit, human-owned project config) wins; repositories that ship the
 * frozen improvement graph (swarm-dao itself) fall back to it. A missing
 * anchor configuration is an error with actionable guidance, never a silent
 * no-op: grounding without gates would be forged ground contact.
 */
export const resolveAnchorCommands = async (
  workDir: string,
): Promise<ReadonlyArray<readonly [anchor: string, command: string]>> => {
  const project = await loadProjectImprovementConfig(workDir);
  if (project) return Object.entries(project.raw.anchorCommands);
  return loadFrozenAnchorCommands(workDir);
};

/** Reads the frozen anchor commands (minus the auto-recorded pair) from the improvement graph. */
export const loadFrozenAnchorCommands = async (
  root: string,
): Promise<ReadonlyArray<readonly [anchor: string, command: string]>> => {
  const graph: unknown = JSON.parse(await readFile(resolve(root, "models/improvement-loop.graph.json"), "utf8"));
  const commands = isRecord(graph) && isRecord(graph.anchorCommands) ? graph.anchorCommands : null;
  const required = isRecord(graph) && Array.isArray(graph.requiredAnchors) ? graph.requiredAnchors : null;
  if (!commands || !required) throw new Error("models/improvement-loop.graph.json has no anchorCommands map");
  return Object.entries(commands)
    .filter(([anchor]) => !AUTO_RECORDED_ANCHORS.has(anchor))
    .map(([anchor, command]) => {
      if (
        !required.includes(anchor) ||
        !isRequiredImprovementAnchor(anchor) ||
        typeof command !== "string" ||
        command.trim().length === 0
      ) {
        throw new Error(`frozen anchor '${anchor}' is not a required improvement anchor command`);
      }
      return [anchor, command] as const;
    });
};

const tail = (value: string, max: number): string => (value.length <= max ? value : `…${value.slice(-max + 1)}`);

const defaultRunCommand =
  (cwd: string) =>
  async (command: string): Promise<AnchorCommandOutcome> => {
    try {
      const { stdout } = await execAsync(command, { cwd, timeout: 600_000 });
      return { ok: true, detail: tail(stdout.trim(), 300) || "exit 0" };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const detail = [failure.stderr, failure.stdout, failure.message]
        .filter((part) => part && part.length > 0)
        .join(" ");
      return { ok: false, detail: tail(detail.trim(), 300) || "command failed" };
    }
  };

const defaultRunWorker =
  (deps: OrchestratorOnceDeps, scope: string) =>
  async (_phase: WorkerPhase, worker: string): Promise<WorkerHarvest> => {
    const prompt = WORKER_PROMPTS[worker]?.(scope);
    if (!prompt) return { ok: false, error: `no prompt configured for worker '${worker}'` };
    return runHerdrWorker(
      { workDir: resolve(deps.workDir ?? process.cwd()), ...(deps.worker ?? {}) },
      `orchestrator-${worker}`,
      prompt,
    );
  };

const sampleFromAnswer = (answer: unknown): Record<string, unknown> => ({
  sample: isRecord(answer) && isRecord(answer.sample) ? answer.sample : answer,
});

const evidenceFromAnswer = (answer: unknown): readonly string[] => {
  const source = isRecord(answer) && isRecord(answer.sample) ? answer.sample : answer;
  const evidence = isRecord(source) && typeof source.evidence === "string" ? source.evidence.trim() : "";
  return evidence ? [evidence] : [];
};

export class OrchestratorRunner {
  readonly #seriesId: string;
  readonly #evidenceRoot: string;
  readonly #seriesDirectory: string;
  readonly #clock: () => string;
  readonly #actor: OrchestratorActor;
  #sequence = 0;
  #cooldownEnteredAt: string | null = null;
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: OrchestratorRunnerOptions, seriesDirectory: string) {
    this.#seriesId = options.seriesId;
    this.#evidenceRoot = resolve(options.evidenceRoot);
    this.#seriesDirectory = seriesDirectory;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#actor = createOrchestratorActor({ seriesId: options.seriesId });
  }

  static async create(options: OrchestratorRunnerOptions): Promise<OrchestratorRunner> {
    if (!validSeriesId(options.seriesId)) throw new Error("seriesId must be a safe non-empty filesystem identifier");
    const root = resolve(options.evidenceRoot);
    const seriesDirectory = resolve(root, options.seriesId);
    if (!seriesDirectory.startsWith(`${root}${sep}`)) throw new Error("seriesId resolves outside the evidence root");
    await mkdir(seriesDirectory, { recursive: true });
    const runner = new OrchestratorRunner(options, seriesDirectory);
    await runner.#restoreJournal();
    const persisted = await runner.#readPersistedSnapshot();
    if (String(runner.#actor.getSnapshot().value) === "cooldown" && persisted?.state === "cooldown") {
      runner.#cooldownEnteredAt = persisted.cooldownEnteredAt;
    }
    await runner.#persistSnapshot(runner.#serialize());
    return runner;
  }

  snapshot(): PersistedSeriesSnapshot {
    return this.#serialize();
  }

  submit(input: unknown): Promise<OrchestratorSubmissionResult> {
    const operation = this.#tail.then(() => this.#submitNow(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /**
   * Execute the single effect authorized by the current series state and
   * submit the resulting tool/system event. Human-gated and terminal states
   * never execute an effect.
   */
  async once(deps: OrchestratorOnceDeps = {}): Promise<OrchestratorOnceResult> {
    const before = this.#serialize();
    const base = { seriesId: this.#seriesId, stateBefore: before.state };
    switch (before.state) {
      case "preparing":
        return this.#initCycle(base, deps);
      case "sampling":
        return this.#runPhaseWorkers("sampling", base, deps);
      case "sealing":
        return this.#submitSamples(base, deps);
      case "auditing":
        return this.#runPhaseWorkers("auditing", base, deps);
      case "arbitrating":
        return this.#submitDrift(base, deps);
      case "grounding":
        return this.#runAnchorCommands(base, deps);
      case "evaluating":
        return this.#submitEvaluate(base, deps);
      case "observing":
        return this.#observeCycle(base, deps);
      case "cooldown":
        return this.#pollCooldown(base, deps);
      case "awaitingHumanCycleDecision":
        return this.#pollResume(base, deps);
      case "workerFailed":
        return {
          ...base,
          stateAfter: before.state,
          executed: false,
          event: null,
          accepted: true,
          issues: [],
          detail: `worker failure pending human RETRY_WORKERS: ${before.context.pendingReason ?? "unknown"}`,
        };
      case "halted":
        return {
          ...base,
          stateAfter: before.state,
          executed: false,
          event: null,
          accepted: true,
          issues: [],
          detail: `series halted (${before.context.pendingReason ?? "unknown"}); human RESTART_SERIES or CANCEL_SERIES required`,
        };
      default:
        return {
          ...base,
          stateAfter: before.state,
          executed: false,
          event: null,
          accepted: true,
          issues: [],
          detail: `series is terminal (${before.state})`,
        };
    }
  }

  #serialize(): PersistedSeriesSnapshot {
    const snapshot = this.#actor.getSnapshot();
    return {
      seriesId: snapshot.context.seriesId,
      state: String(snapshot.value),
      status: snapshot.status,
      context: structuredClone(snapshot.context),
      cooldownEnteredAt: this.#cooldownEnteredAt,
    };
  }

  async #submitNow(input: unknown): Promise<OrchestratorSubmissionResult> {
    const before = this.#serialize();
    let accepted = false;
    let issues: readonly string[] = [];
    let event: Record<string, unknown> | undefined;

    const type = isRecord(input) && typeof input.type === "string" ? input.type : null;
    const source = isRecord(input) && typeof input.source === "string" ? input.source : null;
    if (!type || !source || !(source === "tool" || source === "human" || source === "system")) {
      issues = ["event must be an object with a type and a tool|human|system source"];
    } else {
      event = input as Record<string, unknown>;
      this.#actor.send(event as OrchestratorEvent);
      const candidate = this.#serialize();
      accepted =
        candidate.state !== before.state || JSON.stringify(candidate.context) !== JSON.stringify(before.context);
      if (!accepted) issues = ["machine rejected event for the current state or guards"];
    }

    const after = this.#serialize();
    if (accepted && after.state === "cooldown") this.#cooldownEnteredAt = this.#clock();
    else if (after.state !== "cooldown") this.#cooldownEnteredAt = null;
    // Re-serialize after stamping the cooldown timer: the persisted snapshot
    // must carry cooldownEnteredAt, otherwise every fresh CLI runner restarts
    // the timer on its first poll (dogfood-002 finding).
    const persisted = this.#serialize();

    const entry: SeriesJournalEntry = {
      sequence: ++this.#sequence,
      seriesId: this.#seriesId,
      receivedAt: this.#clock(),
      eventType: type,
      source,
      accepted,
      issues,
      beforeState: before.state,
      afterState: after.state,
      ...(event ? { event } : {}),
    };
    await appendFile(resolve(this.#seriesDirectory, "journal.ndjson"), `${JSON.stringify(entry)}\n`, "utf8");
    await this.#persistSnapshot(persisted);
    // One active series per scope (invariant 7): the runner maintains the
    // scope registry so every start path (CLI or library) is covered.
    if (accepted && type === "START_SERIES" && typeof after.context.scope === "string") {
      await rememberActiveSeries(this.#evidenceRoot, after.context.scope, this.#seriesId);
    }
    return { accepted, issues, snapshot: persisted };
  }

  async #restoreJournal(): Promise<void> {
    let content: string;
    try {
      content = await readFile(resolve(this.#seriesDirectory, "journal.ndjson"), "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`series journal line ${index + 1} is not valid JSON`);
      }
      if (
        !isRecord(entry) ||
        entry.sequence !== index + 1 ||
        typeof entry.accepted !== "boolean" ||
        entry.seriesId !== this.#seriesId
      ) {
        throw new Error(`series journal line ${index + 1} violates the sequence contract`);
      }
      this.#sequence = entry.sequence;
      if (!entry.accepted) continue;
      if (!isRecord(entry.event) || typeof entry.event.type !== "string") {
        throw new Error(`accepted series journal line ${index + 1} has no event`);
      }
      const before = this.#serialize();
      this.#actor.send(entry.event as OrchestratorEvent);
      const after = this.#serialize();
      if (after.state !== before.state || JSON.stringify(after.context) !== JSON.stringify(before.context)) continue;
      throw new Error(`accepted series journal line ${index + 1} cannot be replayed deterministically`);
    }
  }

  async #readPersistedSnapshot(): Promise<PersistedSeriesSnapshot | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(resolve(this.#seriesDirectory, "snapshot.json"), "utf8"));
      return isRecord(parsed) ? (parsed as PersistedSeriesSnapshot) : null;
    } catch {
      return null;
    }
  }

  async #persistSnapshot(snapshot: PersistedSeriesSnapshot): Promise<void> {
    await writeFile(resolve(this.#seriesDirectory, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  #result(
    base: { seriesId: string; stateBefore: string },
    submitted: OrchestratorSubmissionResult,
    event: string,
    detail: string,
  ): OrchestratorOnceResult {
    return {
      ...base,
      stateAfter: submitted.snapshot.state,
      executed: true,
      event,
      accepted: submitted.accepted,
      issues: submitted.issues,
      detail,
    };
  }

  #gateResult(base: { seriesId: string; stateBefore: string }, detail: string): OrchestratorOnceResult {
    return { ...base, stateAfter: base.stateBefore, executed: false, event: null, accepted: true, issues: [], detail };
  }

  async #cycleRunner(cycleEvidenceRoot: string): Promise<ImprovementRunner> {
    const context = this.#actor.getSnapshot().context;
    if (!context.started || !context.scope || !context.referenceHash || !context.improvementCycleId) {
      throw new Error("series has no active improvement cycle");
    }
    return createImprovementRunner({
      evidenceRoot: cycleEvidenceRoot,
      cycleId: context.improvementCycleId,
      scope: context.scope,
      referenceHash: context.referenceHash,
    });
  }

  #workDirectory(): string {
    const sequence = this.#actor.getSnapshot().context.cycleSequence;
    return resolve(this.#seriesDirectory, "work", `c${sequence}`);
  }

  async #readWorkAnswer(worker: string): Promise<unknown> {
    return JSON.parse(await readFile(resolve(this.#workDirectory(), `worker-${worker}.json`), "utf8"));
  }

  async #initCycle(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const context = this.#actor.getSnapshot().context;
    if (!context.scope || !context.referenceHash) throw new Error("series identity is incomplete");
    const cycleId = `${this.#seriesId}-c${context.cycleSequence + 1}`;
    await createImprovementRunner({
      evidenceRoot: resolve(deps.cycleEvidenceRoot ?? DEFAULT_CYCLE_EVIDENCE_ROOT),
      cycleId,
      scope: context.scope,
      referenceHash: context.referenceHash,
    });
    const submitted = await this.submit({ type: "CYCLE_INITIALIZED", source: "tool", cycleId });
    return this.#result(base, submitted, "CYCLE_INITIALIZED", `initialized improvement cycle ${cycleId}`);
  }

  async #runPhaseWorkers(
    phase: WorkerPhase,
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const context = this.#actor.getSnapshot().context;
    const runWorker = deps.runWorker ?? defaultRunWorker(deps, context.scope ?? "");
    await mkdir(this.#workDirectory(), { recursive: true });

    for (const worker of PHASE_WORKERS[phase]) {
      const harvest = await runWorker(phase, worker);
      if (!harvest.ok) {
        const submitted = await this.submit({ type: "WORKERS_FAILED", source: "tool", reason: harvest.error, phase });
        return this.#result(base, submitted, "WORKERS_FAILED", harvest.error);
      }
      const answer = extractLastJsonObject(harvest.content);
      if (!answer) {
        // Preserve the harvested transcript so parse failures are diagnosable
        // without replaying the worker by hand (dogfood-002 finding).
        await writeFile(
          resolve(this.#workDirectory(), `worker-${worker}.transcript.txt`),
          harvest.content,
          "utf8",
        ).catch(() => undefined);
        const reason = `worker ${worker} produced no parseable JSON answer`;
        const submitted = await this.submit({ type: "WORKERS_FAILED", source: "tool", reason, phase });
        return this.#result(base, submitted, "WORKERS_FAILED", reason);
      }
      await writeFile(
        resolve(this.#workDirectory(), `worker-${worker}.json`),
        `${JSON.stringify(answer, null, 2)}\n`,
        "utf8",
      );
    }
    const submitted = await this.submit({ type: "WORKERS_HARVESTED", source: "tool" });
    return this.#result(base, submitted, "WORKERS_HARVESTED", `harvested ${PHASE_WORKERS[phase].join(", ")}`);
  }

  async #submitSignal(
    runner: ImprovementRunner,
    signal: Record<string, unknown>,
  ): Promise<OrchestratorSubmissionResult | null> {
    const result = await runner.submit({ occurredAt: this.#clock(), ...signal });
    if (result.accepted) return null;
    return this.submit({ type: "SIGNAL_REJECTED", source: "tool", issues: result.issues });
  }

  async #submitSamples(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const context = this.#actor.getSnapshot().context;
    const runner = await this.#cycleRunner(deps.cycleEvidenceRoot ?? DEFAULT_CYCLE_EVIDENCE_ROOT);
    const cycleId = context.improvementCycleId as string;

    const sensor = await this.#readWorkAnswer("sensor");
    const counter = await this.#readWorkAnswer("counter-sensor");
    const signals: ReadonlyArray<Record<string, unknown>> = [
      {
        cycleId,
        type: "METRIC_SAMPLED",
        source: "ai",
        producer: "sensor",
        payload: sampleFromAnswer(sensor),
        evidence: evidenceFromAnswer(sensor),
      },
      {
        cycleId,
        type: "COUNTER_SAMPLED",
        source: "ai",
        producer: "counter-sensor",
        payload: sampleFromAnswer(counter),
        evidence: evidenceFromAnswer(counter),
      },
      {
        cycleId,
        type: "SAMPLES_SEALED",
        source: "tool",
        producer: "sample-gate",
        payload: {},
        evidence: ["sensor and counter-sensor samples sealed"],
      },
    ];
    for (const signal of signals) {
      const rejected = await this.#submitSignal(runner, signal);
      if (rejected) return this.#result(base, rejected, "SIGNAL_REJECTED", rejected.issues.join("; "));
    }
    const submitted = await this.submit({ type: "SAMPLES_SUBMITTED", source: "tool" });
    return this.#result(base, submitted, "SAMPLES_SUBMITTED", "paired samples sealed into the cycle");
  }

  async #submitDrift(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const context = this.#actor.getSnapshot().context;
    const runner = await this.#cycleRunner(deps.cycleEvidenceRoot ?? DEFAULT_CYCLE_EVIDENCE_ROOT);
    const cycleId = context.improvementCycleId as string;

    const drift = await this.#readWorkAnswer("drift-auditor");
    const rejectedDrift = await this.#submitSignal(runner, {
      cycleId,
      type: "DRIFT_ESTIMATE",
      source: "ai",
      producer: "drift-auditor",
      payload: { driftClass: isRecord(drift) ? drift.driftClass : undefined },
      evidence: evidenceFromAnswer(drift),
    });
    if (rejectedDrift) return this.#result(base, rejectedDrift, "SIGNAL_REJECTED", rejectedDrift.issues.join("; "));

    const cycleSnapshot = runner.snapshot();
    const { outcome } = arbitratePairedSignals(cycleSnapshot.context.metric, cycleSnapshot.context.counterMetric);
    const rejectedArbitration = await this.#submitSignal(runner, {
      cycleId,
      type: "ARBITRATION",
      source: "tool",
      producer: "arbitrator",
      payload: { outcome },
      evidence: [`deterministic arbitration outcome: ${outcome}`],
    });
    if (rejectedArbitration) {
      return this.#result(base, rejectedArbitration, "SIGNAL_REJECTED", rejectedArbitration.issues.join("; "));
    }
    const submitted = await this.submit({ type: "ARBITRATION_SUBMITTED", source: "tool" });
    return this.#result(base, submitted, "ARBITRATION_SUBMITTED", `arbitration outcome: ${outcome}`);
  }

  async #runAnchorCommands(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const workDir = resolve(deps.workDir ?? process.cwd());
    const runner = await this.#cycleRunner(deps.cycleEvidenceRoot ?? DEFAULT_CYCLE_EVIDENCE_ROOT);
    const context = this.#actor.getSnapshot().context;
    const cycleId = context.improvementCycleId as string;

    const commands = await resolveAnchorCommands(workDir);
    const runCommand = deps.runCommand ?? defaultRunCommand(workDir);
    const outcomes: string[] = [];
    for (const [anchor, command] of commands) {
      const outcome = await runCommand(command);
      const result = await runner.submit({
        cycleId,
        type: "ANCHOR_RECORDED",
        source: "tool",
        producer: "anchor-verifier",
        occurredAt: this.#clock(),
        payload: { anchor, status: outcome.ok ? "passed" : "failed" },
        evidence: [`$ ${command}`, outcome.detail],
      });
      if (!result.accepted) {
        throw new Error(`anchor ${anchor} outcome rejected by the cycle runner: ${result.issues.join("; ")}`);
      }
      outcomes.push(`${anchor}: ${outcome.ok ? "passed" : "failed"}`);
    }
    const submitted = await this.submit({ type: "ANCHORS_SUBMITTED", source: "tool" });
    return this.#result(base, submitted, "ANCHORS_SUBMITTED", outcomes.join(", "));
  }

  async #submitEvaluate(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const context = this.#actor.getSnapshot().context;
    const runner = await this.#cycleRunner(deps.cycleEvidenceRoot ?? DEFAULT_CYCLE_EVIDENCE_ROOT);
    const rejected = await this.#submitSignal(runner, {
      cycleId: context.improvementCycleId,
      type: "EVALUATE",
      source: "system",
      producer: "improvement-runner",
      payload: {},
      evidence: [],
    });
    if (rejected) return this.#result(base, rejected, "SIGNAL_REJECTED", rejected.issues.join("; "));
    const submitted = await this.submit({ type: "EVALUATE_SUBMITTED", source: "tool" });
    return this.#result(base, submitted, "EVALUATE_SUBMITTED", "evaluation submitted to the cycle");
  }

  async #readCycleSnapshot(deps: OrchestratorOnceDeps): Promise<{ state: string; terminalReason: string | null }> {
    const cycleId = this.#actor.getSnapshot().context.improvementCycleId;
    if (!cycleId) throw new Error("series has no active improvement cycle to observe");
    const parsed: unknown = JSON.parse(
      await readFile(resolve(deps.cycleEvidenceRoot ?? DEFAULT_CYCLE_EVIDENCE_ROOT, cycleId, "snapshot.json"), "utf8"),
    );
    if (!isRecord(parsed) || typeof parsed.state !== "string") {
      throw new Error(`cycle snapshot for ${cycleId} is malformed`);
    }
    const context = isRecord(parsed.context) ? parsed.context : {};
    return {
      state: parsed.state,
      terminalReason: typeof context.terminalReason === "string" ? context.terminalReason : null,
    };
  }

  async #observeCycle(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const cycle = await this.#readCycleSnapshot(deps);
    const observation = mapCycleStateToObservation(cycle.state, cycle.terminalReason);
    if (!observation) return this.#gateResult(base, `cycle still '${cycle.state}'; poll again`);
    const submitted = await this.submit(observation);
    return this.#result(base, submitted, observation.type, `observed cycle state '${cycle.state}'`);
  }

  async #pollCooldown(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const snapshot = this.#serialize();
    if (snapshot.cooldownEnteredAt === null || Number.isNaN(Date.parse(snapshot.cooldownEnteredAt))) {
      this.#cooldownEnteredAt = this.#clock();
      await this.#persistSnapshot(this.#serialize());
      return this.#gateResult(base, "cooldown timer started");
    }
    const elapsed = (deps.nowMs ?? Date.now)() - Date.parse(snapshot.cooldownEnteredAt);
    const cooldownMs = snapshot.context.cooldownMs ?? 0;
    if (elapsed < cooldownMs) {
      return this.#gateResult(base, `cooldown pending; ${Math.ceil((cooldownMs - elapsed) / 1000)}s remaining`);
    }
    const submitted = await this.submit({ type: "COOLDOWN_ELAPSED", source: "system" });
    return this.#result(base, submitted, "COOLDOWN_ELAPSED", "cooldown elapsed; next cycle scheduled");
  }

  async #pollResume(
    base: { seriesId: string; stateBefore: string },
    deps: OrchestratorOnceDeps,
  ): Promise<OrchestratorOnceResult> {
    const cycle = await this.#readCycleSnapshot(deps);
    if (cycle.state !== "sampling") {
      return this.#gateResult(base, `cycle in '${cycle.state}'; human decision still pending`);
    }
    const submitted = await this.submit({ type: "CYCLE_RESUMED", source: "system" });
    return this.#result(base, submitted, "CYCLE_RESUMED", "human resolved the cycle gate; workers rerun");
  }
}

// ---------------------------------------------------------------------------
// One active series per scope (invariant 7): scope -> seriesId registry in the
// series evidence root. Single-process assumption, like the cycles it runs.
// ---------------------------------------------------------------------------

type ActiveSeriesMap = Record<string, string>;

const readActiveSeriesMap = async (evidenceRoot: string): Promise<ActiveSeriesMap> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(evidenceRoot, ACTIVE_SERIES_FILE), "utf8"));
    return isRecord(parsed) ? (parsed as ActiveSeriesMap) : {};
  } catch {
    return {};
  }
};

/** Rejects starting a series for a scope that already has a non-terminal series (invariant 7). */
export const assertNoActiveSeriesForScope = async (
  evidenceRoot: string,
  scope: string,
  seriesId: string,
): Promise<void> => {
  const map = await readActiveSeriesMap(evidenceRoot);
  const existing = map[scope];
  if (!existing || existing === seriesId) return;
  const other = await OrchestratorRunner.create({ seriesId: existing, evidenceRoot });
  if (!ORCHESTRATOR_TERMINAL_STATES.includes(other.snapshot().state as (typeof ORCHESTRATOR_TERMINAL_STATES)[number])) {
    throw new Error(`scope '${scope}' already has an active series '${existing}'; cancel it first`);
  }
};

const rememberActiveSeries = async (evidenceRoot: string, scope: string, seriesId: string): Promise<void> => {
  const map = await readActiveSeriesMap(evidenceRoot);
  map[scope] = seriesId;
  await writeFile(resolve(evidenceRoot, ACTIVE_SERIES_FILE), `${JSON.stringify(map, null, 2)}\n`, "utf8");
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const usage = `Usage:
  bun run improvement:series:init -- --series-id <id> --scope <s> --reference-hash <hash> --cooldown-ms <ms>
  bun run improvement:series:status -- --series-id <id> [--evidence-root <path>]
  bun run improvement:series:submit -- --series-id <id> --event <file> [--evidence-root <path>]
  bun run improvement:series:once -- --series-id <id> [--work-dir <dir>] [--evidence-root <path>]`;

export const runSeriesCliInner = async (argv: string[]): Promise<number> => {
  const command = argv[0];
  if (command !== "init" && command !== "status" && command !== "submit" && command !== "once") throw new Error(usage);

  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    options: {
      "series-id": { type: "string" },
      scope: { type: "string" },
      "reference-hash": { type: "string" },
      "cooldown-ms": { type: "string" },
      "evidence-root": { type: "string" },
      event: { type: "string" },
      "work-dir": { type: "string" },
    },
  });

  const seriesId = values["series-id"];
  if (!seriesId) throw new Error(`--series-id is required\n${usage}`);
  const evidenceRoot = resolve(values["evidence-root"] ?? DEFAULT_SERIES_EVIDENCE_ROOT);

  if (command === "init") {
    const scope = values.scope;
    const referenceHash = values["reference-hash"];
    if (!scope) throw new Error(`--scope is required\n${usage}`);
    if (!referenceHash) throw new Error(`--reference-hash is required\n${usage}`);
    const cooldownMs = Number(values["cooldown-ms"]);
    if (!Number.isInteger(cooldownMs) || cooldownMs < ORCHESTRATOR_MIN_COOLDOWN_MS) {
      throw new Error(`--cooldown-ms must be an integer >= ${ORCHESTRATOR_MIN_COOLDOWN_MS}\n${usage}`);
    }
    await assertNoActiveSeriesForScope(evidenceRoot, scope, seriesId);
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    const result = await runner.submit({ type: "START_SERIES", source: "human", scope, referenceHash, cooldownMs });
    process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
    return result.accepted ? 0 : 2;
  }

  if (command === "submit") {
    if (!values.event) throw new Error(`--event is required\n${usage}`);
    const event: unknown = JSON.parse(await readFile(resolve(values.event), "utf8"));
    if (!isHumanChannelEvent(event)) {
      throw new Error(
        "CLI submit only forwards human events (RETRY_WORKERS, RESTART_SERIES, CANCEL_SERIES with a non-empty reason)",
      );
    }
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    const result = await runner.submit(event);
    process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
    return result.accepted ? 0 : 2;
  }

  if (command === "once") {
    const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
    const result = await runner.once({ workDir: values["work-dir"] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.event && !result.accepted ? 2 : 0;
  }

  const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
  process.stdout.write(`${JSON.stringify(runner.snapshot(), null, 2)}\n`);
  return 0;
};

/**
 * Entry point for the `improvement:series:*` scripts and the swarm-dao CLI.
 * Exit codes: 0 success, 2 machine rejection, 1 usage or execution error.
 */
export const runSeriesCli = async (argv: string[]): Promise<number> => {
  try {
    return await runSeriesCliInner(argv);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
