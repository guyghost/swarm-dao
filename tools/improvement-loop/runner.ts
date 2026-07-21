import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  createImprovementActor,
  type ImprovementActor,
  type ImprovementContext,
} from "../../packages/core/src/models/improvement-loop.machine.js";
import { type ImprovementSignal, validateImprovementSignal } from "./signal.js";

export type PersistedImprovementSnapshot = Readonly<{
  cycleId: string;
  state: string;
  status: string;
  context: ImprovementContext;
}>;

export type ImprovementSubmissionResult = Readonly<{
  accepted: boolean;
  issues: readonly string[];
  snapshot: PersistedImprovementSnapshot;
}>;

type JournalEntry = Readonly<{
  sequence: number;
  cycleId: string;
  receivedAt: string;
  eventType: string | null;
  producer: string | null;
  accepted: boolean;
  issues: readonly string[];
  beforeState: string;
  afterState: string;
  signal?: ImprovementSignal;
}>;

type RunnerOptions = Readonly<{
  evidenceRoot: string;
  cycleId: string;
  scope: string;
  referenceHash: string;
  clock?: () => string;
}>;

const validCycleId = (cycleId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cycleId) && !cycleId.includes("..");

// Reopening an existing cycle must not overwrite its immutable correlation
// inputs. If evidence already exists, the caller-supplied referenceHash and
// scope must exactly match what was sealed at initialization; otherwise a
// second `improvement:init` could replace the human-owned reference hash
// without a REFERENCE_CHANGE_APPROVED event.
const assertImmutableInputsMatch = async (runDirectory: string, options: RunnerOptions): Promise<void> => {
  let content: string;
  try {
    content = await readFile(resolve(runDirectory, "snapshot.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`existing snapshot for cycle ${options.cycleId} is not valid JSON`);
  }
  const context =
    typeof parsed === "object" && parsed !== null && "context" in parsed
      ? (parsed as { context: { referenceHash?: unknown; scope?: unknown } }).context
      : null;
  if (!context) throw new Error(`existing snapshot for cycle ${options.cycleId} has no context`);
  if (context.referenceHash !== options.referenceHash) {
    throw new Error(
      `cycle ${options.cycleId} already exists with a different referenceHash; use REFERENCE_CHANGE_APPROVED to change it`,
    );
  }
  if (context.scope !== options.scope) {
    throw new Error(`cycle ${options.cycleId} already exists with a different scope`);
  }
};

const eventTypeFrom = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null || !("type" in input)) return null;
  return typeof input.type === "string" ? input.type : null;
};

const serializeSnapshot = (actor: ImprovementActor): PersistedImprovementSnapshot => {
  const snapshot = actor.getSnapshot();
  return {
    cycleId: snapshot.context.cycleId,
    state: String(snapshot.value),
    status: snapshot.status,
    context: structuredClone(snapshot.context),
  };
};

const snapshotChanged = (before: PersistedImprovementSnapshot, after: PersistedImprovementSnapshot): boolean =>
  before.state !== after.state ||
  before.status !== after.status ||
  JSON.stringify(before.context) !== JSON.stringify(after.context);

export class ImprovementRunner {
  readonly #cycleId: string;
  readonly #runDirectory: string;
  readonly #clock: () => string;
  readonly #actor: ImprovementActor;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: RunnerOptions, runDirectory: string) {
    this.#cycleId = options.cycleId;
    this.#runDirectory = runDirectory;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#actor = createImprovementActor({
      cycleId: options.cycleId,
      scope: options.scope,
      referenceHash: options.referenceHash,
    });
  }

  static async create(options: RunnerOptions): Promise<ImprovementRunner> {
    if (!validCycleId(options.cycleId)) throw new Error("cycleId must be a safe non-empty filesystem identifier");

    const root = resolve(options.evidenceRoot);
    const runDirectory = resolve(root, options.cycleId);
    if (!runDirectory.startsWith(`${root}${sep}`)) throw new Error("cycleId resolves outside the evidence root");

    await mkdir(runDirectory, { recursive: true });
    await assertImmutableInputsMatch(runDirectory, options);
    const runner = new ImprovementRunner(options, runDirectory);
    await runner.#restoreJournal();
    await runner.#persistSnapshot(serializeSnapshot(runner.#actor));
    return runner;
  }

  snapshot(): PersistedImprovementSnapshot {
    return serializeSnapshot(this.#actor);
  }

  submit(input: unknown): Promise<ImprovementSubmissionResult> {
    const operation = this.#tail.then(() => this.#submitNow(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #submitNow(input: unknown): Promise<ImprovementSubmissionResult> {
    const before = serializeSnapshot(this.#actor);
    const validation = validateImprovementSignal(input);
    let accepted = false;
    let issues: readonly string[] = [];
    let signal: ImprovementSignal | undefined;

    if (!validation.ok) {
      issues = validation.issues;
    } else if (validation.signal.cycleId !== this.#cycleId) {
      issues = [`signal cycleId must match ${this.#cycleId}`];
      signal = validation.signal;
    } else {
      signal = validation.signal;
      this.#actor.send(validation.event);
      accepted = snapshotChanged(before, serializeSnapshot(this.#actor));
      if (!accepted) issues = ["machine rejected event for the current state or guards"];
    }

    const after = serializeSnapshot(this.#actor);
    const entry: JournalEntry = {
      sequence: ++this.#sequence,
      cycleId: this.#cycleId,
      receivedAt: this.#clock(),
      eventType: eventTypeFrom(input),
      producer: signal?.producer ?? null,
      accepted,
      issues,
      beforeState: before.state,
      afterState: after.state,
      ...(signal ? { signal } : {}),
    };

    await appendFile(resolve(this.#runDirectory, "journal.ndjson"), `${JSON.stringify(entry)}\n`, "utf8");
    await this.#persistSnapshot(after);
    return { accepted, issues, snapshot: after };
  }

  async #persistSnapshot(snapshot: PersistedImprovementSnapshot): Promise<void> {
    await writeFile(resolve(this.#runDirectory, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  async #restoreJournal(): Promise<void> {
    const journalPath = resolve(this.#runDirectory, "journal.ndjson");
    let content: string;
    try {
      content = await readFile(journalPath, "utf8");
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
        throw new Error(`journal line ${index + 1} is not valid JSON`);
      }
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("sequence" in entry) ||
        entry.sequence !== index + 1 ||
        !("accepted" in entry) ||
        typeof entry.accepted !== "boolean"
      ) {
        throw new Error(`journal line ${index + 1} violates sequence contract`);
      }
      this.#sequence = entry.sequence;
      if (!entry.accepted) continue;
      if (!("signal" in entry)) throw new Error(`accepted journal line ${index + 1} has no signal`);

      const validation = validateImprovementSignal(entry.signal);
      if (!validation.ok || validation.signal.cycleId !== this.#cycleId) {
        throw new Error(`accepted journal line ${index + 1} has an invalid signal`);
      }
      const before = serializeSnapshot(this.#actor);
      this.#actor.send(validation.event);
      if (!snapshotChanged(before, serializeSnapshot(this.#actor))) {
        throw new Error(`accepted journal line ${index + 1} cannot be replayed deterministically`);
      }
    }
  }
}

export const createImprovementRunner = (options: RunnerOptions): Promise<ImprovementRunner> =>
  ImprovementRunner.create(options);
