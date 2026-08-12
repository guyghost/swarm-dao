import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentActivityEntry,
  type AutonomyContract,
  type LocalAgentProcessPort,
  type LocalAgentWorkerResult,
  LocalAgentWorkspaceService,
} from "../../../../packages/core/src/index.js";
import { FileWorkspacePersistence, WorkspacePersistenceError } from "../src/file-workspace-persistence.js";
import { WorkspaceHost } from "../src/workspace-host.js";

const directories: string[] = [];
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agent-workspace-persistence-"));
  directories.push(directory);
  return directory;
};

const autonomyContract: AutonomyContract = {
  allowedToolIds: ["workspace.read", "workspace.write"],
  budgetLimits: { maxActions: 40, maxRuntimeSeconds: 1_800 },
  delegationLimits: { enabled: true, maxDepth: 1, maxChildrenPerParent: 2, maxMissionConcurrency: 3 },
  fileAccessRules: { readRoots: ["/tmp/mission"], writeRoots: ["/tmp/mission/output"] },
  validationThresholds: { humanRetryAttempt: 2, requireHumanForPolicyOverride: true },
  retryLimits: { start: 1, runtime: 1, subagentStart: 1, stop: 1 },
};

class FakeProcessPort implements LocalAgentProcessPort {
  readonly running = new Set<string>();
  startCount = 0;

  async start(agentId: string): Promise<Readonly<{ processId: number }>> {
    this.startCount += 1;
    this.running.add(agentId);
    return { processId: 100 + this.startCount };
  }

  async send(agentId: string, content: string): Promise<LocalAgentWorkerResult> {
    const activity: AgentActivityEntry = { kind: "roundtrip", detail: "structured response" };
    return {
      signal: {
        kind: "shared_message",
        messageId: `${agentId}:message:${content.length}`,
        content: `Reçu: ${content}`,
        createdAt: "2026-08-12T12:00:01.000Z",
      },
      activity,
    };
  }

  async stop(agentId: string): Promise<"stopped" | "absent"> {
    return this.running.delete(agentId) ? "stopped" : "absent";
  }
}

const persistence = (directory: string) =>
  new FileWorkspacePersistence({
    directory,
    missionId: "mission-local-1",
    ownerId: "local-owner",
    clock: { now: () => "2026-08-12T12:30:00.000Z" },
  });

const host = async (directory: string, processPort: FakeProcessPort) =>
  WorkspaceHost.restore({
    missionId: "mission-local-1",
    ownerId: "local-owner",
    processPort,
    clock: { now: () => "2026-08-12T12:30:00.000Z" },
    hash: { digest: (value) => `sha256:${value.length}` },
    persistence: persistence(directory),
  });

describe("FileWorkspacePersistence", () => {
  test("atomically persists a complete payload and deduplicates an identical save", async () => {
    const directory = await temporaryDirectory();
    const adapter = persistence(directory);
    expect(await adapter.load()).toEqual({ state: null, migrated: false });
    adapter.completeRecovery();
    const service = new LocalAgentWorkspaceService({
      missionId: "mission-local-1",
      ownerId: "local-owner",
      processPort: new FakeProcessPort(),
      clock: { now: () => "2026-08-12T12:00:00.000Z" },
      hash: { digest: (value) => `sha256:${value.length}` },
    });

    await adapter.save(service.persistedState());
    const path = join(directory, "workspace-v1.json");
    const first = await readFile(path, "utf8");
    await adapter.save(service.persistedState());
    const second = await readFile(path, "utf8");

    expect(second).toBe(first);
    expect(adapter.status().revision).toBe(1);
    expect(JSON.parse(first).schemaVersion).toBe(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("migrates exact v0 data and never promotes a stale temporary file", async () => {
    const directory = await temporaryDirectory();
    const service = new LocalAgentWorkspaceService({
      missionId: "mission-local-1",
      ownerId: "local-owner",
      processPort: new FakeProcessPort(),
      clock: { now: () => "2026-08-12T12:00:00.000Z" },
      hash: { digest: (value) => `sha256:${value.length}` },
    });
    await writeFile(
      join(directory, "workspace-v1.json"),
      JSON.stringify({
        schemaVersion: 0,
        revision: 0,
        savedAt: "2026-08-12T11:00:00.000Z",
        payload: service.persistedState(),
      }),
      "utf8",
    );
    const migrated = persistence(directory);
    expect((await migrated.load()).migrated).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "workspace-v1.json"), "utf8")).schemaVersion).toBe(1);

    const staleDirectory = await temporaryDirectory();
    await writeFile(join(staleDirectory, "workspace-v1.json.tmp"), "partial", "utf8");
    const stale = persistence(staleDirectory);
    expect(await stale.load()).toEqual({ state: null, migrated: false });
    expect(await readFile(join(staleDirectory, "workspace-v1.json.tmp"), "utf8")).toBe("partial");
  });

  test("rejects corrupt and future-version storage without replacing it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "workspace-v1.json");
    await writeFile(path, "{partial", "utf8");
    const corrupt = persistence(directory);
    await expect(corrupt.load()).rejects.toBeInstanceOf(WorkspacePersistenceError);
    expect(corrupt.status().state).toBe("corrupt");
    expect(await readFile(path, "utf8")).toBe("{partial");

    const blockedHost = await host(directory, new FakeProcessPort());
    const blockedProjection = await blockedHost.handle({ type: "get_workspace" });
    expect(blockedProjection.ok).toBe(false);
    expect(blockedProjection.storage.state).toBe("corrupt");
    expect(blockedProjection.projection.mission.availableCommands).toEqual([]);

    await writeFile(path, JSON.stringify({ schemaVersion: 2, revision: 1 }), "utf8");
    const future = persistence(directory);
    await expect(future.load()).rejects.toMatchObject({ code: "storage_incompatible" });
    expect(future.status().state).toBe("incompatible");
  });

  test("rejects a checksummed envelope whose structured payload is malformed", async () => {
    const directory = await temporaryDirectory();
    const service = new LocalAgentWorkspaceService({
      missionId: "mission-local-1",
      ownerId: "local-owner",
      processPort: new FakeProcessPort(),
      clock: { now: () => "2026-08-12T12:00:00.000Z" },
      hash: { digest: (value) => `sha256:${value.length}` },
    });
    const payload = {
      ...service.persistedState(),
      userTemplateRevisions: [
        {
          templateId: "malformed",
          revision: 1,
          name: "Malformed",
          origin: "user",
          agents: [{ agentId: "reviewer", role: "Reviewer", capabilities: ["review"], required: false }],
        },
      ],
    };
    const payloadHash = digest(JSON.stringify(payload));
    const withoutChecksum = {
      schemaVersion: 1,
      revision: 1,
      savedAt: "2026-08-12T12:00:00.000Z",
      payloadHash,
      payload,
    };
    const envelope = { ...withoutChecksum, checksum: digest(JSON.stringify(withoutChecksum)) };
    const path = join(directory, "workspace-v1.json");
    const raw = JSON.stringify(envelope);
    await writeFile(path, raw, "utf8");

    await expect(persistence(directory).load()).rejects.toMatchObject({ code: "storage_corrupt" });
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  test("exhausts finite save retries and leaves no committed partial record", async () => {
    const root = await temporaryDirectory();
    const blockedDirectory = join(root, "blocked");
    const adapter = persistence(blockedDirectory);
    await adapter.load();
    adapter.completeRecovery();
    await writeFile(blockedDirectory, "not a directory", "utf8");
    const service = new LocalAgentWorkspaceService({
      missionId: "mission-local-1",
      ownerId: "local-owner",
      processPort: new FakeProcessPort(),
      clock: { now: () => "2026-08-12T12:00:00.000Z" },
      hash: { digest: (value) => `sha256:${value.length}` },
    });

    await expect(adapter.save(service.persistedState())).rejects.toMatchObject({ code: "storage_write_failed" });
    expect(adapter.status().state).toBe("storage_blocked");
    expect(await readFile(blockedDirectory, "utf8")).toBe("not a directory");
  });
});

describe("workspace restart integration", () => {
  test("restores mission history, templates, and policy while never reviving a process", async () => {
    const directory = await temporaryDirectory();
    const firstProcessPort = new FakeProcessPort();
    const first = await host(directory, firstProcessPort);
    const createdTemplate = await first.handle({
      type: "create_team_template",
      templateId: "user-reviewer",
      name: "Relecteur local",
      agents: [{ agentId: "reviewer", role: "Relecteur", capabilities: ["review"], required: true }],
    });
    expect(createdTemplate.ok).toBe(true);
    const revisedTemplate = await first.handle({
      type: "save_team_template_revision",
      templateId: "user-reviewer",
      expectedRevision: 1,
      name: "Relecteur local v2",
      agents: [{ agentId: "reviewer", role: "Relecteur", capabilities: ["review"], required: true }],
    });
    expect(revisedTemplate.ok).toBe(true);
    await first.handle({
      type: "launch_mission",
      templateId: "core-duo",
      enabledAgentIds: ["planner"],
      autonomyContract,
    });
    await first.handle({ type: "send_message", content: "Prépare le plan" });
    expect(firstProcessPort.startCount).toBe(1);

    const restartedProcessPort = new FakeProcessPort();
    const restarted = await host(directory, restartedProcessPort);
    const response = await restarted.handle({ type: "get_workspace" });

    expect(response.ok).toBe(true);
    expect(response.projection.mission.state).toBe("paused");
    expect(response.projection.mission.recovery).toMatchObject({ required: true, previousState: "active" });
    expect(response.projection.agents.map((agent) => agent.state)).toEqual(["interrupted"]);
    expect(response.projection.messages.some((message) => message.content === "Prépare le plan")).toBe(true);
    expect(response.templates.find((template) => template.templateId === "user-reviewer")).toMatchObject({
      revision: 2,
      name: "Relecteur local v2",
    });
    expect(response.autonomyConfiguration).toEqual(autonomyContract);
    expect(restartedProcessPort.startCount).toBe(0);

    const resumed = await restarted.handle({ type: "resume_mission" });
    expect(resumed.ok).toBe(true);
    expect(resumed.projection.mission.state).toBe("active");
    expect(restartedProcessPort.startCount).toBe(1);
  });
});
