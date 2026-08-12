import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { systemClock } from "../../../../packages/core/src/index.js";
import { FileWorkspacePersistence } from "./file-workspace-persistence.js";
import { LocalWorkerProcessPort } from "./local-worker-process.js";
import { decodeWorkspaceRequest, WorkspaceHost } from "./workspace-host.js";

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) yield line;
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const writeLine = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const argumentAfter = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
};

const runWorker = async (): Promise<void> => {
  const agentId = argumentAfter("--agent-id");
  if (!agentId) throw new Error("worker requires --agent-id");
  let sequence = 0;
  for await (const line of readLines(Bun.stdin.stream())) {
    const input = JSON.parse(line) as unknown;
    if (typeof input !== "object" || input === null || !("content" in input) || typeof input.content !== "string") {
      throw new Error("worker input must contain content");
    }
    sequence += 1;
    writeLine({
      signal: {
        kind: "shared_message",
        messageId: `${agentId}:${sequence}`,
        content: `Agent local ${agentId} a reçu : ${input.content}`,
        createdAt: new Date().toISOString(),
      },
      activity: { kind: "worker_roundtrip", detail: "Structured local worker response received" },
    });
  }
};

const currentWorkerCommand = (): readonly string[] => {
  const bundled = import.meta.path.includes("$bunfs");
  return bundled ? [process.execPath] : [process.execPath, import.meta.path];
};

const runHost = async (): Promise<void> => {
  const processPort = new LocalWorkerProcessPort(currentWorkerCommand());
  const missionId = "local-mission";
  const ownerId = "local-owner";
  const storageDirectory =
    argumentAfter("--storage-directory") ??
    process.env.AGENT_WORKSPACE_STORAGE_DIRECTORY ??
    join(homedir(), "Library", "Application Support", "Swarm DAO", "Agent Workspace");
  const persistence = new FileWorkspacePersistence({
    directory: storageDirectory,
    missionId,
    ownerId,
    clock: systemClock,
  });
  const host = await WorkspaceHost.restore({
    missionId: "local-mission",
    ownerId,
    processPort,
    clock: systemClock,
    hash: { digest: (value) => createHash("sha256").update(value).digest("hex") },
    persistence,
  });
  process.on("SIGTERM", () => {
    void processPort.stopAll().finally(() => process.exit(0));
  });
  for await (const line of readLines(Bun.stdin.stream())) {
    if (process.env.AGENT_WORKSPACE_PROTOCOL_DEBUG === "1") console.error("workspace host received a command");
    let requestId = "unknown";
    try {
      const envelope = JSON.parse(line) as unknown;
      if (typeof envelope !== "object" || envelope === null) throw new Error("request envelope must be an object");
      if (!("requestId" in envelope) || typeof envelope.requestId !== "string") {
        throw new Error("request envelope requires requestId");
      }
      requestId = envelope.requestId;
      if (!("command" in envelope)) throw new Error("request envelope requires command");
      const response = await host.handle(decodeWorkspaceRequest(envelope.command));
      writeLine({ requestId, ...response });
      if (process.env.AGENT_WORKSPACE_PROTOCOL_DEBUG === "1") console.error("workspace host wrote a response");
    } catch (error) {
      const current = await host.handle({ type: "get_workspace" });
      writeLine({
        requestId,
        ...current,
        ok: false,
        error: error instanceof Error ? error.message : "unknown request error",
      });
    }
  }
  await processPort.stopAll();
};

await (process.argv.includes("--worker") ? runWorker() : runHost());
