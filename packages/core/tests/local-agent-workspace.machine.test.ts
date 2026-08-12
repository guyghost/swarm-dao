import { describe, expect, it } from "bun:test";
import { createLocalAgentActor, type LocalAgentMachineInput } from "../src/models/local-agent.machine.js";
import {
  type AutonomyContract,
  createLocalMissionActor,
  type MissionTemplateSnapshot,
  missionAvailableCommands,
} from "../src/models/local-mission.machine.js";
import { evaluatePolicy, type PolicyEvaluationInput } from "../src/models/local-workspace.policy.js";
import { createPolicyOverrideActor } from "../src/models/policy-override.machine.js";
import { createSubagentRequestActor } from "../src/models/subagent-request.machine.js";

const autonomyContract: AutonomyContract = {
  allowedToolIds: ["workspace.read"],
  budgetLimits: { maxActions: 20, maxRuntimeSeconds: 300 },
  delegationLimits: { enabled: true, maxDepth: 2, maxChildrenPerParent: 2, maxMissionConcurrency: 4 },
  fileAccessRules: { readRoots: ["/tmp/workspace"], writeRoots: [] },
  validationThresholds: { humanRetryAttempt: 2, requireHumanForPolicyOverride: true },
  retryLimits: { start: 3, runtime: 2, subagentStart: 2, stop: 2 },
};

const snapshot: MissionTemplateSnapshot = {
  snapshotId: "snapshot-1",
  missionId: "mission-1",
  sourceTemplateId: "core-duo",
  sourceRevision: 1,
  normalizedTeam: [
    { agentId: "planner", role: "Planner", capabilities: ["planning"], required: true },
    { agentId: "observer", role: "Observer", capabilities: ["observation"], required: true },
  ],
  autonomyContract,
  contentHash: "sha256:approved-snapshot",
  sealedAt: "2026-08-12T12:00:00.000Z",
};

const reachActiveMission = () => {
  const actor = createLocalMissionActor({ missionId: "mission-1", ownerId: "owner-1" });
  actor.send({
    type: "MISSION_LAUNCH_REQUESTED",
    source: "human",
    ownerId: "owner-1",
    snapshot,
  });
  actor.send({
    type: "MISSION_ACTIVATION_EVALUATED",
    source: "system",
    requiredAgents: [
      { agentId: "planner", state: "active" },
      { agentId: "observer", state: "active" },
    ],
  });
  return actor;
};

describe("local mission machine", () => {
  it("seals the launch snapshot, activates required agents, and appends shared messages", () => {
    const actor = reachActiveMission();

    actor.send({
      type: "HUMAN_MESSAGE_SUBMITTED",
      source: "human",
      ownerId: "owner-1",
      message: {
        messageId: "message-1",
        author: { kind: "human", id: "owner-1", displayName: "Owner" },
        visibility: { kind: "mission_shared", participantIds: [] },
        kind: "conversation",
        content: "Prepare the local plan.",
        createdAt: "2026-08-12T12:01:00.000Z",
      },
    });
    actor.send({
      type: "AGENT_SIGNAL_RECORDED",
      source: "ai",
      agentId: "planner",
      signal: {
        kind: "shared_message",
        messageId: "message-2",
        content: "Plan ready for review.",
        createdAt: "2026-08-12T12:01:01.000Z",
      },
    });

    const current = actor.getSnapshot();
    expect(current.value).toBe("active");
    expect(current.context.templateSnapshot).toEqual(snapshot);
    expect(current.context.messages.map((message) => message.content)).toEqual([
      "Mission activated.",
      "Prepare the local plan.",
      "Plan ready for review.",
    ]);
    expect(missionAvailableCommands(current.value)).toEqual(["send_message", "pause", "cancel"]);
  });

  it("rejects private visibility and AI-authored lifecycle commands", () => {
    const actor = reachActiveMission();
    const before = actor.getSnapshot();

    actor.send({
      type: "HUMAN_MESSAGE_SUBMITTED",
      source: "human",
      ownerId: "owner-1",
      message: {
        messageId: "private-message",
        author: { kind: "human", id: "owner-1", displayName: "Owner" },
        visibility: { kind: "direct", participantIds: ["planner"] },
        kind: "conversation",
        content: "This must stay disabled in M1.",
        createdAt: "2026-08-12T12:02:00.000Z",
      },
    });
    actor.send({ type: "MISSION_CANCEL_REQUESTED", source: "ai", ownerId: "owner-1" });

    const after = actor.getSnapshot();
    expect(after.value).toBe("active");
    expect(after.context.messages).toEqual(before.context.messages);
  });

  it("cannot report paused before restartable quiescence and terminalizes cancellation explicitly", () => {
    const actor = reachActiveMission();
    actor.send({ type: "MISSION_PAUSE_REQUESTED", source: "human", ownerId: "owner-1" });
    expect(actor.getSnapshot().value).toBe("pausing");

    actor.send({
      type: "MISSION_PAUSE_QUIESCENCE_EVALUATED",
      source: "system",
      agentStates: ["active", "interrupted"],
      openStartIntents: 0,
    });
    expect(actor.getSnapshot().value).toBe("pausing");

    actor.send({
      type: "MISSION_PAUSE_QUIESCENCE_EVALUATED",
      source: "system",
      agentStates: ["interrupted", "interrupted"],
      openStartIntents: 0,
    });
    expect(actor.getSnapshot().value).toBe("paused");
    expect(missionAvailableCommands(actor.getSnapshot().value)).toEqual(["send_message", "resume", "cancel"]);

    actor.send({ type: "MISSION_CANCEL_REQUESTED", source: "human", ownerId: "owner-1" });
    actor.send({
      type: "MISSION_QUIESCENCE_EVALUATED",
      source: "system",
      allAgentsQuiescent: true,
      openSubagentRequests: 0,
      liveProcessCount: 0,
    });
    expect(actor.getSnapshot().value).toBe("cancelled");
    actor.send({ type: "MISSION_RESUME_REQUESTED", source: "human", ownerId: "owner-1" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });
});

const agentInput: LocalAgentMachineInput = {
  agentId: "planner",
  missionId: "mission-1",
  ownerId: "owner-1",
  role: "Planner",
  parentAgentId: null,
  capabilities: ["planning"],
  effectivePermissions: ["workspace.read"],
  retryLimits: autonomyContract.retryLimits,
  humanRetryAttempt: autonomyContract.validationThresholds.humanRetryAttempt,
};

describe("local agent machine", () => {
  it("starts only from a system authorization and records technical activity outside conversation", () => {
    const actor = createLocalAgentActor(agentInput);
    actor.send({
      type: "AGENT_START_AUTHORIZED",
      source: "ai",
      launchToken: "launch-1",
      reservationId: "reservation-1",
    });
    expect(actor.getSnapshot().value).toBe("ready");

    actor.send({
      type: "AGENT_START_AUTHORIZED",
      source: "system",
      launchToken: "launch-1",
      reservationId: "reservation-1",
    });
    actor.send({
      type: "PROCESS_STARTED",
      source: "tool",
      launchToken: "launch-1",
      processId: 42,
    });

    const current = actor.getSnapshot();
    expect(current.value).toBe("active");
    expect(current.context.activity.map((entry) => entry.kind)).toEqual(["start_requested", "process_started"]);
  });

  it("classifies retries deterministically and requires exact human authorization at the threshold", () => {
    const actor = createLocalAgentActor(agentInput);
    actor.send({
      type: "AGENT_START_AUTHORIZED",
      source: "system",
      launchToken: "launch-1",
      reservationId: "reservation-1",
    });
    actor.send({ type: "PROCESS_START_FAILED", source: "tool", errorCode: "process-temporary" });
    expect(actor.getSnapshot().value).toBe("retry_wait");
    expect(actor.getSnapshot().context.startAttempt).toBe(1);

    actor.send({ type: "AGENT_RETRY_DUE", source: "system", attempt: 1 });
    actor.send({ type: "PROCESS_START_FAILED", source: "tool", errorCode: "process-temporary" });
    expect(actor.getSnapshot().context.startAttempt).toBe(2);
    expect(actor.getSnapshot().context.pendingHumanRetry).toEqual({ operation: "start", attempt: 2 });

    actor.send({
      type: "AGENT_RETRY_AUTHORIZED",
      source: "ai",
      ownerId: "owner-1",
      operation: "start",
      attempt: 2,
    });
    expect(actor.getSnapshot().value).toBe("retry_wait");
    actor.send({
      type: "AGENT_RETRY_AUTHORIZED",
      source: "human",
      ownerId: "owner-1",
      operation: "start",
      attempt: 2,
    });
    expect(actor.getSnapshot().value).toBe("starting");
  });

  it("does not acknowledge a parent stop until descendants and launch intents are quiescent", () => {
    const actor = createLocalAgentActor(agentInput);
    actor.send({
      type: "AGENT_START_AUTHORIZED",
      source: "system",
      launchToken: "launch-1",
      reservationId: "reservation-1",
    });
    actor.send({ type: "PROCESS_STARTED", source: "tool", launchToken: "launch-1", processId: 42 });
    actor.send({ type: "AGENT_CANCEL_REQUESTED", source: "system", reason: "mission-cancelled" });
    actor.send({
      type: "DESCENDANTS_QUIESCENT",
      source: "system",
      descendantStates: ["active"],
      openLaunchIntents: 0,
    });
    actor.send({ type: "PROCESS_STOPPED", source: "tool", stopToken: "stop:planner" });
    expect(actor.getSnapshot().value).toBe("stopping");

    actor.send({
      type: "DESCENDANTS_QUIESCENT",
      source: "system",
      descendantStates: ["cancelled"],
      openLaunchIntents: 0,
    });
    actor.send({ type: "PROCESS_STOPPED", source: "tool", stopToken: "stop:planner" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });
});

const basePolicy: PolicyEvaluationInput = {
  request: {
    toolIds: ["workspace.read"],
    budgetActions: 4,
    depth: 1,
    readPaths: ["/tmp/workspace/spec.md"],
    writePaths: [],
  },
  systemCeilings: {
    toolIds: ["workspace.read", "workspace.write"],
    maxBudgetActions: 100,
    maxDepth: 3,
    readRoots: ["/tmp/workspace"],
    writeRoots: ["/tmp/workspace"],
  },
  globalRules: {
    revision: "global-1",
    toolIds: ["workspace.read"],
    maxBudgetActions: 20,
    maxDepth: 2,
    readRoots: ["/tmp/workspace"],
    writeRoots: [],
    overrideableFields: ["maxBudgetActions"],
  },
  missionContract: autonomyContract,
  activeOverrides: [],
};

describe("subagent and policy models", () => {
  it("allows only requests within ceilings, rules, mission contract, and canonical roots", () => {
    expect(evaluatePolicy(basePolicy)).toEqual({
      decision: "allow",
      reasonCodes: [],
      policyRevision: "global-1",
    });

    expect(
      evaluatePolicy({
        ...basePolicy,
        request: { ...basePolicy.request, depth: 4 },
      }),
    ).toEqual({
      decision: "deny",
      reasonCodes: ["system_ceiling_exceeded"],
      policyRevision: "global-1",
    });
  });

  it("starts a same-mission child only after deterministic policy validation", () => {
    const actor = createSubagentRequestActor({
      requestId: "request-1",
      missionId: "mission-1",
      parentAgentId: "planner",
      parentState: "active",
      requestedRole: "Researcher",
      requestedCapabilities: ["research"],
      policyInput: basePolicy,
      retryLimit: 2,
      humanRetryAttempt: 2,
    });
    actor.send({ type: "POLICY_VALIDATION_REQUESTED", source: "system" });
    actor.send({ type: "POLICY_FACTS_RECORDED", source: "tool", facts: basePolicy });
    expect(actor.getSnapshot().value).toBe("approved");

    actor.send({
      type: "SUBAGENT_START_AUTHORIZED",
      source: "system",
      facts: basePolicy,
      missionState: "active",
      parentState: "active",
    });
    actor.send({
      type: "CHILD_AGENT_ACTIVE",
      source: "system",
      childAgentId: "researcher-1",
      missionId: "mission-1",
      parentAgentId: "planner",
    });
    expect(actor.getSnapshot().value).toBe("started");
    expect(actor.getSnapshot().context.childAgentId).toBe("researcher-1");
  });

  it("records a visible refusal and never lets AI provide a policy verdict", () => {
    const deniedFacts: PolicyEvaluationInput = {
      ...basePolicy,
      request: { ...basePolicy.request, depth: 4 },
    };
    const actor = createSubagentRequestActor({
      requestId: "request-denied",
      missionId: "mission-1",
      parentAgentId: "planner",
      parentState: "active",
      requestedRole: "Researcher",
      requestedCapabilities: ["research"],
      policyInput: deniedFacts,
      retryLimit: 2,
      humanRetryAttempt: 2,
    });
    actor.send({ type: "POLICY_VALIDATION_REQUESTED", source: "system" });
    actor.send({ type: "POLICY_FACTS_RECORDED", source: "ai", facts: basePolicy });
    expect(actor.getSnapshot().value).toBe("policy_validating");
    actor.send({ type: "POLICY_FACTS_RECORDED", source: "tool", facts: deniedFacts });
    expect(actor.getSnapshot().value).toBe("refused");
    expect(actor.getSnapshot().context.visibleNotice).toContain("refused");
  });

  it("requires exact owner confirmation and never permits overriding a system ceiling", () => {
    const diff = { field: "maxBudgetActions" as const, from: 20, to: 30 };
    const actor = createPolicyOverrideActor({
      overrideId: "override-1",
      missionId: "mission-1",
      ownerId: "owner-1",
      requestId: "request-1",
      diff,
      fingerprint: "sha256:exact-diff",
    });
    actor.send({ type: "OVERRIDE_FACTS_REQUESTED", source: "system" });
    actor.send({ type: "OVERRIDE_FACTS_RECORDED", source: "tool", policy: basePolicy });
    expect(actor.getSnapshot().value).toBe("awaiting_confirmation");
    actor.send({
      type: "POLICY_OVERRIDE_CONFIRMED",
      source: "ai",
      ownerId: "owner-1",
      fingerprint: "sha256:exact-diff",
    });
    expect(actor.getSnapshot().value).toBe("awaiting_confirmation");
    actor.send({
      type: "POLICY_OVERRIDE_CONFIRMED",
      source: "human",
      ownerId: "owner-1",
      fingerprint: "sha256:wrong-diff",
    });
    expect(actor.getSnapshot().value).toBe("awaiting_confirmation");
    actor.send({
      type: "POLICY_OVERRIDE_CONFIRMED",
      source: "human",
      ownerId: "owner-1",
      fingerprint: "sha256:exact-diff",
    });
    expect(actor.getSnapshot().value).toBe("active");

    const ceilingActor = createPolicyOverrideActor({
      overrideId: "override-2",
      missionId: "mission-1",
      ownerId: "owner-1",
      requestId: "request-2",
      diff: { field: "maxDepth", from: 2, to: 5 },
      fingerprint: "sha256:ceiling-diff",
    });
    ceilingActor.send({ type: "OVERRIDE_FACTS_REQUESTED", source: "system" });
    ceilingActor.send({ type: "OVERRIDE_FACTS_RECORDED", source: "tool", policy: basePolicy });
    expect(ceilingActor.getSnapshot().value).toBe("rejected");
  });
});
