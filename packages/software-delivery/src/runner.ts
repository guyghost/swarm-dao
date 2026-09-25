import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  createSoftwareDeliveryActor,
  type SoftwareDeliveryActor,
  type SoftwareDeliveryContext,
  type SoftwareDeliveryEvent,
  type SoftwareDeliveryMachineInput,
} from "@guyghost/swarm-dao-core";
import { type DeliverySignal, validateDeliverySignal } from "./signal.js";

export type PersistedDeliverySnapshot = Readonly<{
  runId: string;
  state: string;
  status: string;
  sequence: number;
  context: SoftwareDeliveryContext;
}>;

export type DeliverySubmissionResult = Readonly<{
  accepted: boolean;
  issues: readonly string[];
  snapshot: PersistedDeliverySnapshot;
}>;

export type DeliveryEffectStatus = "pending" | "completed";

export type PersistedDeliveryEffect = Readonly<{
  key: string;
  name: string;
  attempt: number;
  status: DeliveryEffectStatus;
  intent: unknown;
  result?: unknown;
  evidence?: string;
}>;

export type DeliveryEffectIntentInput = Readonly<{
  name: string;
  attempt: number;
  intent: unknown;
}>;

export type DeliveryEffectCompletionInput = Readonly<{
  key: string;
  result: unknown;
  evidence: string;
}>;

export type DeliveryRunnerOptions = Readonly<{
  evidenceRoot: string;
  runId: string;
  clock?: () => string;
  machineInput?: Omit<SoftwareDeliveryMachineInput, "runId">;
}>;

type DeliveryActor = SoftwareDeliveryActor;

const validRunId = (runId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) && !runId.includes("..");

const validEffectName = (name: string): boolean => /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const eventTypeFrom = (input: unknown): string | null =>
  isRecord(input) && typeof input.type === "string" ? input.type : null;

const producerFrom = (input: unknown): string | null =>
  isRecord(input) && typeof input.producer === "string" ? input.producer : null;

const serializeSnapshot = (actor: DeliveryActor, runId: string, sequence: number): PersistedDeliverySnapshot => {
  const snapshot = actor.getSnapshot();
  return {
    runId,
    state: String(snapshot.value),
    status: snapshot.status,
    sequence,
    context: structuredClone(snapshot.context),
  };
};

const contextHash = (context: SoftwareDeliveryContext): string =>
  createHash("sha256").update(JSON.stringify(context)).digest("hex");

const snapshotChanged = (before: PersistedDeliverySnapshot, after: PersistedDeliverySnapshot): boolean =>
  before.state !== after.state ||
  before.status !== after.status ||
  contextHash(before.context) !== contextHash(after.context);

const cloneJsonValue = (value: unknown, label: string): unknown => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`);
  return JSON.parse(serialized) as unknown;
};

export const deriveDeliveryEffectKey = (runId: string, name: string, attempt: number): string => {
  if (!validRunId(runId)) throw new Error("runId must be a safe non-empty filesystem identifier");
  if (!validEffectName(name)) throw new Error("effect name must be a safe identifier");
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("effect attempt must be a non-negative integer");
  const digest = createHash("sha256").update(`${runId}\0${name}\0${attempt}`).digest("hex");
  return `delivery-effect:${digest}`;
};

/**
 * Journal-replayed local delivery runner. Journal rows are the source of truth;
 * snapshots are convenience files and are rebuilt after every successful append.
 */
export class DeliveryRunner {
  readonly #runId: string;
  readonly #runDirectory: string;
  readonly #clock: () => string;
  readonly #input: SoftwareDeliveryMachineInput;
  #actor: DeliveryActor;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #effects = new Map<string, PersistedDeliveryEffect>();

  private constructor(options: DeliveryRunnerOptions, runDirectory: string) {
    this.#runId = options.runId;
    this.#runDirectory = runDirectory;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#input = {
      runId: options.runId,
      ...(options.machineInput ?? {
        productRunId: "",
        graphRunId: "",
        proposalId: null,
        scope: "",
        scopeHash: "",
        riskClass: "unknown" as const,
      }),
    };
    this.#actor = createSoftwareDeliveryActor(this.#input);
  }

  static async create(options: DeliveryRunnerOptions): Promise<DeliveryRunner> {
    if (!validRunId(options.runId)) throw new Error("runId must be a safe non-empty filesystem identifier");

    const root = resolve(options.evidenceRoot);
    const runDirectory = resolve(root, options.runId);
    if (!runDirectory.startsWith(`${root}${sep}`)) throw new Error("runId resolves outside the evidence root");

    await mkdir(runDirectory, { recursive: true });
    const runner = new DeliveryRunner(options, runDirectory);
    await runner.#restoreJournal();
    await runner.#persistSnapshot();
    return runner;
  }

  snapshot(): PersistedDeliverySnapshot {
    return serializeSnapshot(this.#actor, this.#runId, this.#sequence);
  }

  submit(input: unknown): Promise<DeliverySubmissionResult> {
    const operation = this.#tail.then(() => this.#submitNow(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  beginEffect(input: DeliveryEffectIntentInput): Promise<PersistedDeliveryEffect> {
    const operation = this.#tail.then(() => this.#beginEffectNow(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  completeEffect(input: DeliveryEffectCompletionInput): Promise<PersistedDeliveryEffect> {
    const operation = this.#tail.then(() => this.#completeEffectNow(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  getEffect(key: string): PersistedDeliveryEffect | null {
    const effect = this.#effects.get(key);
    return effect ? structuredClone(effect) : null;
  }

  effects(): readonly PersistedDeliveryEffect[] {
    return [...this.#effects.values()].map((effect) => structuredClone(effect));
  }

  stop(): void {
    this.#actor.stop();
  }

  async #submitNow(input: unknown): Promise<DeliverySubmissionResult> {
    await this.#assertJournalAtSequence(this.#sequence);
    const before = serializeSnapshot(this.#actor, this.#runId, this.#sequence);
    const validation = validateDeliverySignal(input, this.#runId);
    const issues: readonly string[] = validation.ok ? [] : validation.issues;
    let accepted = false;
    let signal: DeliverySignal | undefined;
    let candidate: DeliveryActor | undefined;

    if (validation.ok) {
      signal = validation.signal;
      candidate = createSoftwareDeliveryActor(this.#input, this.#actor.getPersistedSnapshot());
      candidate.send(validation.event satisfies SoftwareDeliveryEvent);
      accepted = snapshotChanged(before, serializeSnapshot(candidate, this.#runId, this.#sequence));
    }

    const after = accepted && candidate ? serializeSnapshot(candidate, this.#runId, this.#sequence + 1) : before;
    const submissionIssues = accepted
      ? issues
      : validation.ok
        ? ["machine rejected event for the current state or guards"]
        : issues;
    const row: Record<string, unknown> = {
      kind: "signal",
      eventType: eventTypeFrom(input),
      producer: signal?.producer ?? producerFrom(input),
      accepted,
      issues: submissionIssues,
      beforeState: before.state,
      afterState: after.state,
      beforeContextHash: contextHash(before.context),
      afterContextHash: contextHash(after.context),
      ...(signal ? { signal } : {}),
    };

    try {
      await this.#appendJournal(row);
      if (accepted && candidate) {
        this.#actor.stop();
        this.#actor = candidate;
      } else {
        candidate?.stop();
      }
      await this.#persistSnapshot();
      return { accepted, issues: submissionIssues, snapshot: this.snapshot() };
    } catch (error) {
      candidate?.stop();
      throw error;
    }
  }

  async #beginEffectNow(input: DeliveryEffectIntentInput): Promise<PersistedDeliveryEffect> {
    const key = deriveDeliveryEffectKey(this.#runId, input.name, input.attempt);
    const intent = cloneJsonValue(input.intent, "effect intent");
    const existing = this.#effects.get(key);
    if (existing) {
      if (
        existing.name !== input.name ||
        existing.attempt !== input.attempt ||
        JSON.stringify(existing.intent) !== JSON.stringify(intent)
      ) {
        throw new Error(`effect key ${key} was reused with different intent`);
      }
      return structuredClone(existing);
    }

    await this.#assertJournalAtSequence(this.#sequence);
    const effect: PersistedDeliveryEffect = {
      key,
      name: input.name,
      attempt: input.attempt,
      status: "pending",
      intent,
    };
    await this.#appendJournal({ kind: "effect-intent", effect });
    this.#effects.set(key, effect);
    await this.#persistSnapshot();
    return structuredClone(effect);
  }

  async #completeEffectNow(input: DeliveryEffectCompletionInput): Promise<PersistedDeliveryEffect> {
    if (!isNonEmpty(input.evidence)) throw new Error("effect completion requires non-empty evidence");
    const previous = this.#effects.get(input.key);
    if (!previous) throw new Error(`effect ${input.key} has no durable intent`);
    const result = cloneJsonValue(input.result, "effect result");
    if (previous.status === "completed") {
      if (JSON.stringify(previous.result) !== JSON.stringify(result) || previous.evidence !== input.evidence) {
        throw new Error(`effect ${input.key} already has a different durable result`);
      }
      return structuredClone(previous);
    }

    await this.#assertJournalAtSequence(this.#sequence);
    const completed: PersistedDeliveryEffect = { ...previous, status: "completed", result, evidence: input.evidence };
    await this.#appendJournal({ kind: "effect-result", key: input.key, result, evidence: input.evidence });
    this.#effects.set(input.key, completed);
    await this.#persistSnapshot();
    return structuredClone(completed);
  }

  async #appendJournal(fields: Record<string, unknown>): Promise<void> {
    await this.#assertJournalAtSequence(this.#sequence);
    const row = {
      sequence: this.#sequence + 1,
      runId: this.#runId,
      receivedAt: this.#clock(),
      ...fields,
    };
    let line: string | undefined;
    try {
      line = JSON.stringify(row);
    } catch {
      throw new Error("journal entry must be JSON-serializable");
    }
    if (line === undefined) throw new Error("journal entry must be JSON-serializable");
    await appendFile(resolve(this.#runDirectory, "journal.ndjson"), `${line}\n`, "utf8");
    this.#sequence += 1;
  }

  async #persistSnapshot(): Promise<void> {
    const snapshot = this.snapshot();
    await writeFile(resolve(this.#runDirectory, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  async #assertJournalAtSequence(expectedLast: number): Promise<void> {
    let content: string;
    try {
      content = await readFile(resolve(this.#runDirectory, "journal.ndjson"), "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        if (expectedLast !== 0)
          throw new Error(`delivery journal vanished while run state is at sequence ${expectedLast}`);
        return;
      }
      throw error;
    }
    const lastLine = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1);
    if (lastLine === undefined) {
      if (expectedLast !== 0)
        throw new Error(`delivery journal is empty while run state is at sequence ${expectedLast}`);
      return;
    }
    let last: unknown;
    try {
      last = JSON.parse(lastLine);
    } catch {
      throw new Error("delivery journal tail is not valid JSON; refusing to append");
    }
    const lastSequence = isRecord(last) && typeof last.sequence === "number" ? last.sequence : Number.NaN;
    if (lastSequence !== expectedLast) {
      throw new Error(
        `concurrent delivery runner detected: journal is at sequence ${lastSequence}, this runner holds ${expectedLast}; nothing was written`,
      );
    }
  }

  async #restoreJournal(): Promise<void> {
    let content: string;
    try {
      content = await readFile(resolve(this.#runDirectory, "journal.ndjson"), "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }

    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`delivery journal line ${index + 1} is not valid JSON`);
      }
      if (
        !isRecord(entry) ||
        entry.sequence !== index + 1 ||
        entry.runId !== this.#runId ||
        !isNonEmpty(entry.receivedAt)
      ) {
        throw new Error(`delivery journal line ${index + 1} violates sequence or run identity contract`);
      }

      if (entry.kind === "signal") {
        this.#replaySignalEntry(entry, index + 1);
      } else if (entry.kind === "effect-intent") {
        this.#replayEffectIntent(entry, index + 1);
      } else if (entry.kind === "effect-result") {
        this.#replayEffectResult(entry, index + 1);
      } else {
        throw new Error(`delivery journal line ${index + 1} has an unknown record kind`);
      }
      this.#sequence = index + 1;
    }
  }

  #replaySignalEntry(entry: Record<string, unknown>, line: number): void {
    if (entry.accepted === true && entry.signal === undefined) {
      throw new Error(`accepted delivery journal line ${line} has no signal`);
    }
    if (
      typeof entry.accepted !== "boolean" ||
      typeof entry.beforeState !== "string" ||
      typeof entry.afterState !== "string" ||
      typeof entry.beforeContextHash !== "string" ||
      typeof entry.afterContextHash !== "string"
    ) {
      throw new Error(`delivery journal line ${line} violates signal record contract`);
    }

    const before = serializeSnapshot(this.#actor, this.#runId, this.#sequence);
    if (before.state !== entry.beforeState || contextHash(before.context) !== entry.beforeContextHash) {
      throw new Error(`accepted journal line ${line} has a mismatched before-state snapshot`);
    }

    if (entry.signal !== undefined) {
      const validation = validateDeliverySignal(entry.signal, this.#runId);
      if (!validation.ok) throw new Error(`delivery journal line ${line} has an invalid signal`);
      if (entry.eventType !== validation.signal.type || entry.producer !== validation.signal.producer) {
        throw new Error(`delivery journal line ${line} signal metadata does not match its payload`);
      }
      this.#actor.send(validation.event);
      const after = serializeSnapshot(this.#actor, this.#runId, this.#sequence);
      const changed = snapshotChanged(before, after);
      if (entry.accepted !== changed)
        throw new Error(`delivery journal line ${line} acceptance cannot be replayed deterministically`);
      if (after.state !== entry.afterState || contextHash(after.context) !== entry.afterContextHash) {
        throw new Error(`delivery journal line ${line} has a nondeterministic replay result`);
      }
      return;
    }

    if (entry.beforeState !== entry.afterState || entry.beforeContextHash !== entry.afterContextHash) {
      throw new Error(`rejected delivery journal line ${line} changed machine state`);
    }
  }

  #replayEffectIntent(entry: Record<string, unknown>, line: number): void {
    if (!isRecord(entry.effect)) throw new Error(`delivery journal line ${line} has no effect intent`);
    const effect = entry.effect;
    if (
      typeof effect.key !== "string" ||
      typeof effect.name !== "string" ||
      !Object.hasOwn(effect, "intent") ||
      typeof effect.attempt !== "number" ||
      !Number.isSafeInteger(effect.attempt) ||
      effect.attempt < 0 ||
      effect.status !== "pending"
    ) {
      throw new Error(`delivery journal line ${line} violates effect intent contract`);
    }
    const expectedKey = deriveDeliveryEffectKey(this.#runId, effect.name, effect.attempt);
    if (effect.key !== expectedKey || this.#effects.has(effect.key)) {
      throw new Error(`delivery journal line ${line} has an invalid or duplicate effect key`);
    }
    this.#effects.set(effect.key, structuredClone(effect) as PersistedDeliveryEffect);
  }

  #replayEffectResult(entry: Record<string, unknown>, line: number): void {
    if (typeof entry.key !== "string" || !isNonEmpty(entry.evidence) || !Object.hasOwn(entry, "result")) {
      throw new Error(`delivery journal line ${line} violates effect result contract`);
    }
    const effect = this.#effects.get(entry.key);
    if (effect?.status !== "pending") {
      throw new Error(`delivery journal line ${line} has no pending effect intent`);
    }
    this.#effects.set(entry.key, {
      ...effect,
      status: "completed",
      result: structuredClone(entry.result),
      evidence: entry.evidence,
    });
  }
}

export const createDeliveryRunner = (options: DeliveryRunnerOptions): Promise<DeliveryRunner> =>
  DeliveryRunner.create(options);
