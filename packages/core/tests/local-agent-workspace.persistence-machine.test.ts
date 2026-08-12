import { describe, expect, it } from "bun:test";
import { createLocalAgentActor, type LocalAgentMachineInput } from "../src/models/local-agent.machine.js";
import {
  type AutonomyContract,
  createLocalMissionActor,
  type MissionTemplateSnapshot,
  missionAvailableCommands,
} from "../src/models/local-mission.machine.js";
import {
  createLocalWorkspacePersistenceActor,
  workspaceStorageStatus,
} from "../src/models/local-workspace-persistence.machine.js";

const autonomyContract: AutonomyContract = {
  allowedToolIds: ["workspace.read"],
  budgetLimits: { maxActions: 20, maxRuntimeSeconds: 300 },
  delegationLimits: { enabled: true, maxDepth: 1, maxChildrenPerParent: 2, maxMissionConcurrency: 3 },
  fileAccessRules: { readRoots: ["/tmp/workspace"], writeRoots: [] },
  validationThresholds: { humanRetryAttempt: 2, requireHumanForPolicyOverride: true },
  retryLimits: { start: 2, runtime: 2, subagentStart: 1, stop: 1 },
};

const templateSnapshot: MissionTemplateSnapshot = {
  snapshotId: "mission-1:snapshot:1",
  missionId: "mission-1",
  sourceTemplateId: "core-duo",
  sourceRevision: 1,
  normalizedTeam: [{ agentId: "planner", role: "Planner", capabilities: ["planning"], required: true }],
  autonomyContract,
  contentHash: "sha256:snapshot",
  sealedAt: "2026-08-12T12:00:00.000Z",
};

const activeMission = () => {
  const actor = createLocalMissionActor({ missionId: "mission-1", ownerId: "owner-1" });
  actor.send({
    type: "MISSION_LAUNCH_REQUESTED",
    source: "human",
    ownerId: "owner-1",
    snapshot: templateSnapshot,
  });
  actor.send({
    type: "MISSION_ACTIVATION_EVALUATED",
    source: "system",
    requiredAgents: [{ agentId: "planner", state: "active" }],
  });
  return actor;
};

const agentInput: LocalAgentMachineInput = {
  agentId: "planner",
  missionId: "mission-1",
  ownerId: "owner-1",
  role: "Planner",
  parentAgentId: null,
  capabilities: ["planning"],
  effectivePermissions: ["workspace.read"],
  retryLimits: autonomyContract.retryLimits,
  humanRetryAttempt: 2,
};

describe("local workspace recovery model", () => {
  it("interrupts a live agent and pauses its mission without creating a launch intent", () => {
    const agent = createLocalAgentActor(agentInput);
    agent.send({ type: "AGENT_START_AUTHORIZED", source: "system", launchToken: "old", reservationId: "r-1" });
    agent.send({ type: "PROCESS_STARTED", source: "tool", launchToken: "old", processId: 42 });

    agent.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition: "restartable_interruption",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      processAbsenceVerified: true,
    });
    expect(agent.getSnapshot().value).toBe("interrupted");
    expect(agent.getSnapshot().context.processId).toBeNull();
    expect(agent.getSnapshot().context.launchToken).toBeNull();
    expect(agent.getSnapshot().context.effects).toEqual([]);

    const mission = activeMission();
    mission.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition: "restartable_interruption",
      previousState: "active",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      agentStates: ["interrupted"],
      liveProcessCount: 0,
    });
    expect(mission.getSnapshot().value).toBe("paused");
    expect(mission.getSnapshot().context.recovery).toEqual({
      required: true,
      previousState: "active",
      recoveredAt: "2026-08-12T13:00:00.000Z",
    });
    expect(missionAvailableCommands(mission.getSnapshot().value)).toEqual(["send_message", "resume", "cancel"]);
    expect(mission.getSnapshot().context.effects).toEqual([]);
  });

  it("rejects AI recovery and process-presence claims", () => {
    const mission = activeMission();
    mission.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "ai",
      disposition: "restartable_interruption",
      previousState: "active",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      agentStates: ["interrupted"],
      liveProcessCount: 0,
    });
    mission.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition: "restartable_interruption",
      previousState: "active",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      agentStates: ["interrupted"],
      liveProcessCount: 1,
    });
    expect(mission.getSnapshot().value).toBe("active");
  });

  it("keeps already-terminal agents terminal while recovering the remaining mission", () => {
    const mission = activeMission();
    mission.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition: "restartable_interruption",
      previousState: "active",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      agentStates: ["interrupted", "failed"],
      liveProcessCount: 0,
    });

    expect(mission.getSnapshot().value).toBe("paused");
    expect(mission.getSnapshot().context.recovery?.required).toBe(true);
  });

  it("preserves cancellation and failure direction during restart recovery", () => {
    const cancelling = activeMission();
    cancelling.send({ type: "MISSION_CANCEL_REQUESTED", source: "human", ownerId: "owner-1" });
    cancelling.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition: "terminal_cancellation",
      previousState: "cancelling",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      agentStates: ["cancelled"],
      liveProcessCount: 0,
    });
    expect(cancelling.getSnapshot().value).toBe("cancelled");

    const failing = activeMission();
    failing.send({ type: "MISSION_FAILURE_RECORDED", source: "system", errorCode: "fatal-storage-independent" });
    failing.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition: "terminal_failure",
      previousState: "failing",
      recoveredAt: "2026-08-12T13:00:00.000Z",
      agentStates: ["failed"],
      liveProcessCount: 0,
    });
    expect(failing.getSnapshot().value).toBe("failed");
    expect(missionAvailableCommands(failing.getSnapshot().value)).toEqual([]);
  });
});

describe("local workspace persistence machine", () => {
  it("loads, recovers, commits changed payloads, and deduplicates identical saves", () => {
    const actor = createLocalWorkspacePersistenceActor({ ownerId: "owner-1", maxSaveRetries: 1 });
    actor.send({ type: "STORAGE_LOAD_REQUESTED", source: "system" });
    actor.send({
      type: "STORAGE_RECORD_LOADED",
      source: "tool",
      schemaVersion: 1,
      shapeValid: true,
      integrityValid: true,
      payloadHash: "hash-1",
      revision: 3,
    });
    actor.send({ type: "WORKSPACE_RECOVERY_APPLIED", source: "system", allAggregatesSafe: true, liveProcessCount: 0 });
    expect(workspaceStorageStatus(actor)).toEqual({ state: "ready", revision: 3, errorCode: null });

    actor.send({ type: "PERSISTENCE_SAVE_REQUESTED", source: "system", payloadHash: "hash-2", proposedRevision: 4 });
    expect(actor.getSnapshot().value).toBe("saving");
    actor.send({ type: "STORAGE_SAVE_COMMITTED", source: "tool", payloadHash: "hash-2", revision: 4 });
    expect(workspaceStorageStatus(actor).revision).toBe(4);

    actor.send({ type: "PERSISTENCE_SAVE_REQUESTED", source: "system", payloadHash: "hash-2", proposedRevision: 4 });
    expect(actor.getSnapshot().value).toBe("ready");
    expect(workspaceStorageStatus(actor).revision).toBe(4);
  });

  it("fails closed for future versions, wrong-source recovery, stale commits, and exhausted retry", () => {
    const incompatible = createLocalWorkspacePersistenceActor({ ownerId: "owner-1", maxSaveRetries: 1 });
    incompatible.send({ type: "STORAGE_LOAD_REQUESTED", source: "system" });
    incompatible.send({
      type: "STORAGE_RECORD_LOADED",
      source: "tool",
      schemaVersion: 2,
      shapeValid: true,
      integrityValid: true,
      payloadHash: "future",
      revision: 1,
    });
    expect(incompatible.getSnapshot().value).toBe("incompatible");
    incompatible.send({ type: "STORAGE_MISSING", source: "tool" });
    expect(incompatible.getSnapshot().value).toBe("incompatible");

    const actor = createLocalWorkspacePersistenceActor({ ownerId: "owner-1", maxSaveRetries: 1 });
    actor.send({ type: "STORAGE_LOAD_REQUESTED", source: "system" });
    actor.send({ type: "STORAGE_MISSING", source: "tool" });
    actor.send({ type: "WORKSPACE_RECOVERY_APPLIED", source: "ai", allAggregatesSafe: true, liveProcessCount: 0 });
    expect(actor.getSnapshot().value).toBe("recovering");
    actor.send({ type: "WORKSPACE_RECOVERY_APPLIED", source: "system", allAggregatesSafe: true, liveProcessCount: 0 });
    actor.send({ type: "PERSISTENCE_SAVE_REQUESTED", source: "system", payloadHash: "hash-1", proposedRevision: 1 });
    actor.send({ type: "STORAGE_SAVE_COMMITTED", source: "tool", payloadHash: "stale", revision: 1 });
    expect(actor.getSnapshot().value).toBe("saving");
    actor.send({ type: "STORAGE_SAVE_FAILED", source: "tool", errorCode: "storage_write_failed" });
    actor.send({ type: "STORAGE_SAVE_RETRY_DUE", source: "system", payloadHash: "hash-1", attempt: 1 });
    actor.send({ type: "STORAGE_SAVE_FAILED", source: "tool", errorCode: "storage_write_failed" });
    actor.send({ type: "STORAGE_SAVE_RETRIES_EXHAUSTED", source: "system", payloadHash: "hash-1", attempt: 2 });
    expect(actor.getSnapshot().value).toBe("storage_blocked");
  });
});
