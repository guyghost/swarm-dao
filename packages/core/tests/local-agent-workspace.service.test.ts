import { describe, expect, it } from "bun:test";
import {
  type LocalAgentProcessPort,
  LocalAgentWorkspaceService,
  type TeamTemplate,
} from "../src/application/local-agent-workspace.service.js";
import type { AutonomyContract } from "../src/models/local-mission.machine.js";

const template: TeamTemplate = {
  templateId: "core-duo",
  revision: 1,
  name: "Core Duo",
  origin: "built_in",
  agents: [
    { agentId: "planner", role: "Planner", capabilities: ["planning"], required: true },
    { agentId: "observer", role: "Observer", capabilities: ["observation"], required: true },
  ],
};

const autonomyContract: AutonomyContract = {
  allowedToolIds: ["workspace.read"],
  budgetLimits: { maxActions: 20, maxRuntimeSeconds: 300 },
  delegationLimits: { enabled: true, maxDepth: 2, maxChildrenPerParent: 2, maxMissionConcurrency: 4 },
  fileAccessRules: { readRoots: ["/tmp/workspace"], writeRoots: [] },
  validationThresholds: { humanRetryAttempt: 2, requireHumanForPolicyOverride: true },
  retryLimits: { start: 3, runtime: 2, subagentStart: 2, stop: 2 },
};

class FakeLocalProcessPort implements LocalAgentProcessPort {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  private nextProcessId = 100;

  async start(agentId: string): Promise<{ processId: number }> {
    this.started.push(agentId);
    return { processId: this.nextProcessId++ };
  }

  async send(
    agentId: string,
    content: string,
  ): Promise<{
    signal: { kind: "shared_message"; messageId: string; content: string; createdAt: string };
    activity: { kind: string; detail: string };
  }> {
    return {
      signal: {
        kind: "shared_message",
        messageId: `reply:${agentId}`,
        content: `${agentId} received: ${content}`,
        createdAt: "2026-08-12T12:00:02.000Z",
      },
      activity: { kind: "worker_roundtrip", detail: `stdout:${agentId}:technical` },
    };
  }

  async stop(agentId: string): Promise<"stopped" | "absent"> {
    this.stopped.push(agentId);
    return "stopped";
  }
}

const createService = () => {
  const processes = new FakeLocalProcessPort();
  let nowIndex = 0;
  const times = [
    "2026-08-12T12:00:00.000Z",
    "2026-08-12T12:00:01.000Z",
    "2026-08-12T12:00:02.000Z",
    "2026-08-12T12:00:03.000Z",
  ];
  const service = new LocalAgentWorkspaceService({
    missionId: "mission-1",
    ownerId: "owner-1",
    processPort: processes,
    clock: { now: () => times[Math.min(nowIndex++, times.length - 1)] as string },
    hash: { digest: (value) => `sha256:${value.length}` },
  });
  return { service, processes };
};

describe("LocalAgentWorkspaceService", () => {
  it("launches enabled agents from an immutable template/autonomy snapshot", async () => {
    const { service, processes } = createService();

    const projection = await service.launch({
      template,
      enabledAgentIds: ["planner", "observer"],
      autonomyContract,
    });

    expect(projection.mission.state).toBe("active");
    expect(projection.mission.availableCommands).toEqual(["send_message", "pause", "cancel"]);
    expect(projection.mission.templateSnapshot?.sourceTemplateId).toBe("core-duo");
    expect(projection.mission.templateSnapshot?.contentHash).toStartWith("sha256:");
    expect(projection.agents.map((agent) => agent.state)).toEqual(["active", "active"]);
    expect(processes.started).toEqual(["planner", "observer"]);
  });

  it("keeps shared conversation free of technical process activity", async () => {
    const { service } = createService();
    await service.launch({ template, enabledAgentIds: ["planner"], autonomyContract });

    const projection = await service.sendHumanMessage("Inspect the mission.");

    expect(projection.messages.map((message) => message.content)).toEqual([
      "Mission activated.",
      "Inspect the mission.",
      "planner received: Inspect the mission.",
    ]);
    expect(projection.messages.some((message) => message.content.includes("stdout:"))).toBe(false);
    expect(projection.agents[0]?.activity.some((entry) => entry.kind === "worker_roundtrip")).toBe(true);
    expect(projection.agents[0]?.activity.some((entry) => entry.detail.includes("stdout:"))).toBe(false);
  });

  it("derives pause, resume, and cancellation controls from mission snapshots", async () => {
    const { service, processes } = createService();
    await service.launch({ template, enabledAgentIds: ["planner"], autonomyContract });

    const paused = await service.pause();
    expect(paused.mission.state).toBe("paused");
    expect(paused.mission.availableCommands).toEqual(["send_message", "resume", "cancel"]);
    expect(processes.stopped).toEqual(["planner"]);

    const resumed = await service.resume();
    expect(resumed.mission.state).toBe("active");
    expect(processes.started).toEqual(["planner", "planner"]);

    const cancelled = await service.cancel();
    expect(cancelled.mission.state).toBe("cancelled");
    expect(cancelled.mission.availableCommands).toEqual([]);
    await expect(service.sendHumanMessage("too late")).rejects.toThrow("send_message is not available");
  });
});
