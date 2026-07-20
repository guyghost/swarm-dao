import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  createGraphEngineeringActor,
  type GraphEngineeringActor,
  type GraphEngineeringContext,
} from "../../packages/core/src/models/graph-engineering.machine.js";
import { type GraphSignal, validateGraphSignal } from "./signal.js";

export type PersistedGraphSnapshot = Readonly<{
  runId: string;
  state: string;
  status: string;
  context: GraphEngineeringContext;
}>;

export type GraphSubmissionResult = Readonly<{
  accepted: boolean;
  issues: readonly string[];
  snapshot: PersistedGraphSnapshot;
}>;

type JournalEntry = Readonly<{
  sequence: number;
  runId: string;
  receivedAt: string;
  eventType: string | null;
  producer: string | null;
  accepted: boolean;
  issues: readonly string[];
  beforeState: string;
  afterState: string;
  signal?: GraphSignal;
}>;

type RunnerOptions = Readonly<{
  evidenceRoot: string;
  runId: string;
  clock?: () => string;
}>;

const validRunId = (runId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) && !runId.includes("..");

const eventTypeFrom = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null || !("type" in input)) return null;
  return typeof input.type === "string" ? input.type : null;
};

const serializeSnapshot = (actor: GraphEngineeringActor): PersistedGraphSnapshot => {
  const snapshot = actor.getSnapshot();
  return {
    runId: snapshot.context.runId,
    state: String(snapshot.value),
    status: snapshot.status,
    context: structuredClone(snapshot.context),
  };
};

const snapshotChanged = (before: PersistedGraphSnapshot, after: PersistedGraphSnapshot): boolean =>
  before.state !== after.state ||
  before.status !== after.status ||
  JSON.stringify(before.context) !== JSON.stringify(after.context);

export class GraphRunner {
  readonly #runId: string;
  readonly #runDirectory: string;
  readonly #clock: () => string;
  readonly #actor: GraphEngineeringActor;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: RunnerOptions, runDirectory: string) {
    this.#runId = options.runId;
    this.#runDirectory = runDirectory;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#actor = createGraphEngineeringActor(options.runId);
  }

  static async create(options: RunnerOptions): Promise<GraphRunner> {
    if (!validRunId(options.runId)) throw new Error("runId must be a safe non-empty filesystem identifier");

    const root = resolve(options.evidenceRoot);
    const runDirectory = resolve(root, options.runId);
    if (!runDirectory.startsWith(`${root}${sep}`)) throw new Error("runId resolves outside the evidence root");

    await mkdir(runDirectory, { recursive: true });
    const runner = new GraphRunner(options, runDirectory);
    await runner.#restoreJournal();
    await runner.#persistSnapshot(serializeSnapshot(runner.#actor));
    return runner;
  }

  snapshot(): PersistedGraphSnapshot {
    return serializeSnapshot(this.#actor);
  }

  submit(input: unknown): Promise<GraphSubmissionResult> {
    const operation = this.#tail.then(() => this.#submitNow(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #submitNow(input: unknown): Promise<GraphSubmissionResult> {
    const before = serializeSnapshot(this.#actor);
    const validation = validateGraphSignal(input);
    let accepted = false;
    let issues: readonly string[] = [];
    let signal: GraphSignal | undefined;

    if (!validation.ok) {
      issues = validation.issues;
    } else if (validation.signal.runId !== this.#runId) {
      issues = [`signal runId must match ${this.#runId}`];
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
      runId: this.#runId,
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

  async #persistSnapshot(snapshot: PersistedGraphSnapshot): Promise<void> {
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

      const validation = validateGraphSignal(entry.signal);
      if (!validation.ok || validation.signal.runId !== this.#runId) {
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

export const createGraphRunner = (options: RunnerOptions): Promise<GraphRunner> => GraphRunner.create(options);
