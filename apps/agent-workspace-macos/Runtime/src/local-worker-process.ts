import type { LocalAgentProcessPort, LocalAgentWorkerResult } from "../../../../packages/core/src/index.js";

type WorkerRecord = {
  process: Bun.Subprocess<"pipe", "pipe", "inherit">;
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  decoder: TextDecoder;
  bufferedOutput: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeWorkerResult = (value: unknown, agentId: string): LocalAgentWorkerResult => {
  if (!isRecord(value) || !isRecord(value.signal) || value.signal.kind !== "shared_message") {
    throw new Error(`worker ${agentId} returned an invalid signal`);
  }
  if (
    typeof value.signal.messageId !== "string" ||
    !value.signal.messageId.startsWith(`${agentId}:`) ||
    typeof value.signal.content !== "string" ||
    value.signal.content.trim().length === 0 ||
    typeof value.signal.createdAt !== "string"
  ) {
    throw new Error(`worker ${agentId} returned a signal outside the shared protocol`);
  }
  if (
    !isRecord(value.activity) ||
    typeof value.activity.kind !== "string" ||
    typeof value.activity.detail !== "string"
  ) {
    throw new Error(`worker ${agentId} returned invalid technical activity`);
  }
  return {
    signal: {
      kind: "shared_message",
      messageId: value.signal.messageId,
      content: value.signal.content,
      createdAt: value.signal.createdAt,
    },
    activity: { kind: value.activity.kind, detail: value.activity.detail },
  };
};

export class LocalWorkerProcessPort implements LocalAgentProcessPort {
  readonly #workerCommand: readonly string[];
  readonly #workers = new Map<string, WorkerRecord>();

  public constructor(workerCommand: readonly string[]) {
    if (workerCommand.length === 0) throw new Error("worker command must not be empty");
    this.#workerCommand = workerCommand;
  }

  public async start(agentId: string): Promise<Readonly<{ processId: number }>> {
    if (this.#workers.has(agentId)) throw new Error(`worker ${agentId} is already running`);
    const process = Bun.spawn([...this.#workerCommand, "--worker", "--agent-id", agentId], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    if (!process.pid) throw new Error(`worker ${agentId} did not start`);
    this.#workers.set(agentId, {
      process,
      reader: process.stdout.getReader(),
      decoder: new TextDecoder(),
      bufferedOutput: "",
    });
    await Promise.resolve();
    return { processId: process.pid };
  }

  public async send(agentId: string, content: string): Promise<LocalAgentWorkerResult> {
    const worker = this.#workers.get(agentId);
    if (!worker) throw new Error(`worker ${agentId} is not running`);
    worker.process.stdin.write(`${JSON.stringify({ content })}\n`);
    await worker.process.stdin.flush();
    const line = await this.#readLine(agentId, worker);
    return decodeWorkerResult(JSON.parse(line) as unknown, agentId);
  }

  public async stop(agentId: string): Promise<"stopped" | "absent"> {
    const worker = this.#workers.get(agentId);
    if (!worker) return "absent";
    this.#workers.delete(agentId);
    worker.process.stdin.end();
    worker.process.kill("SIGTERM");
    await worker.process.exited;
    return "stopped";
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.#workers.keys()].map((agentId) => this.stop(agentId)));
  }

  async #readLine(agentId: string, worker: WorkerRecord): Promise<string> {
    while (true) {
      const newline = worker.bufferedOutput.indexOf("\n");
      if (newline >= 0) {
        const line = worker.bufferedOutput.slice(0, newline);
        worker.bufferedOutput = worker.bufferedOutput.slice(newline + 1);
        if (line.trim().length > 0) return line;
      }
      const chunk = await worker.reader.read();
      if (chunk.done) throw new Error(`worker ${agentId} stopped before returning a result`);
      worker.bufferedOutput += worker.decoder.decode(chunk.value, { stream: true });
    }
  }
}
