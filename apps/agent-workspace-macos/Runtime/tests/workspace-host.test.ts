import { describe, expect, test } from "bun:test";
import type {
  AgentActivityEntry,
  AutonomyContract,
  LocalAgentProcessPort,
  LocalAgentWorkerResult,
} from "../../../../packages/core/src/index.js";
import { decodeWorkspaceRequest, WorkspaceHost } from "../src/workspace-host.js";

const autonomyContract: AutonomyContract = {
  allowedToolIds: ["workspace.read", "workspace.write"],
  budgetLimits: { maxActions: 40, maxRuntimeSeconds: 1_800 },
  delegationLimits: {
    enabled: true,
    maxDepth: 1,
    maxChildrenPerParent: 2,
    maxMissionConcurrency: 3,
  },
  fileAccessRules: { readRoots: ["/tmp/mission"], writeRoots: ["/tmp/mission/output"] },
  validationThresholds: { humanRetryAttempt: 2, requireHumanForPolicyOverride: true },
  retryLimits: { start: 1, runtime: 1, subagentStart: 1, stop: 1 },
};

class FakeProcessPort implements LocalAgentProcessPort {
  readonly running = new Set<string>();

  async start(agentId: string): Promise<Readonly<{ processId: number }>> {
    this.running.add(agentId);
    return { processId: this.running.size + 100 };
  }

  async send(agentId: string, content: string): Promise<LocalAgentWorkerResult> {
    const activity: AgentActivityEntry = { kind: "worker_roundtrip", detail: "stdout: private worker trace" };
    return {
      signal: {
        kind: "shared_message",
        messageId: `${agentId}:1`,
        content: `Réponse locale à « ${content} »`,
        createdAt: "2026-08-12T12:00:01.000Z",
      },
      activity,
    };
  }

  async stop(agentId: string): Promise<"stopped" | "absent"> {
    return this.running.delete(agentId) ? "stopped" : "absent";
  }
}

const createHost = (): WorkspaceHost =>
  new WorkspaceHost({
    missionId: "mission-local-1",
    ownerId: "local-owner",
    processPort: new FakeProcessPort(),
    clock: { now: () => "2026-08-12T12:00:00.000Z" },
    hash: { digest: (value) => `sha256:test:${value.length}` },
  });

describe("WorkspaceHost", () => {
  test("exposes a closed command protocol and model-derived projection", async () => {
    const host = createHost();
    const initial = await host.handle({ type: "get_workspace" });

    expect(initial.ok).toBe(true);
    expect(initial.projection.mission.state).toBe("draft");
    expect(initial.projection.mission.availableCommands).toEqual(["launch", "send_message", "cancel"]);
    expect(initial.templates.map((template) => template.templateId)).toEqual(["core-duo"]);

    const launched = await host.handle({
      type: "launch_mission",
      templateId: "core-duo",
      enabledAgentIds: ["planner", "builder"],
      autonomyContract,
    });

    expect(launched.ok).toBe(true);
    expect(launched.projection.mission.state).toBe("active");
    expect(launched.projection.mission.templateSnapshot?.sourceTemplateId).toBe("core-duo");
    expect(launched.projection.agents.map((agent) => agent.agentId)).toEqual(["planner", "builder"]);
  });

  test("keeps shared conversation and technical profiles separated", async () => {
    const host = createHost();
    await host.handle({
      type: "launch_mission",
      templateId: "core-duo",
      enabledAgentIds: ["planner"],
      autonomyContract,
    });

    const response = await host.handle({ type: "send_message", content: "Prépare le plan" });

    expect(response.ok).toBe(true);
    expect(response.projection.messages).toHaveLength(3);
    expect(response.projection.messages.every((message) => message.visibility.kind === "mission_shared")).toBe(true);
    expect(response.projection.messages.some((message) => message.content.includes("stdout"))).toBe(false);
    expect(response.projection.agents[0]?.activity).toContainEqual({
      kind: "worker_roundtrip",
      detail: "[redacted technical output]",
    });
  });

  test("rejects malformed and out-of-state commands without moving the model", async () => {
    expect(() => decodeWorkspaceRequest({ type: "direct_message", content: "future" })).toThrow(
      "unsupported workspace command",
    );

    const host = createHost();
    const response = await host.handle({ type: "pause_mission" });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("pause is not available");
    expect(response.projection.mission.state).toBe("draft");
  });
});
