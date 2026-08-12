export type WorkspaceEventSource = "human" | "ai" | "system" | "tool";

export type MissionState =
  | "draft"
  | "pending"
  | "active"
  | "pausing"
  | "paused"
  | "human_intervention_required"
  | "cancelling"
  | "failing"
  | "completed"
  | "cancelled"
  | "failed";

export type LocalAgentState =
  | "ready"
  | "starting"
  | "active"
  | "waiting_for_human"
  | "retry_wait"
  | "interrupted"
  | "stopping"
  | "failing"
  | "completed"
  | "cancelled"
  | "failed";

export type MissionVisibility =
  | Readonly<{ kind: "mission_shared"; participantIds: readonly [] }>
  | Readonly<{ kind: "direct"; participantIds: readonly string[] }>;

export type MissionMessage = Readonly<{
  messageId: string;
  missionId?: string;
  author: Readonly<{ kind: "human" | "agent" | "system"; id: string; displayName: string }>;
  visibility: MissionVisibility;
  kind: "conversation" | "system_notice";
  content: string;
  createdAt: string;
}>;

export type RetryLimits = Readonly<{
  start: number;
  runtime: number;
  subagentStart: number;
  stop: number;
}>;

export type AutonomyContract = Readonly<{
  allowedToolIds: readonly string[];
  budgetLimits: Readonly<{ maxActions: number; maxRuntimeSeconds: number }>;
  delegationLimits: Readonly<{
    enabled: boolean;
    maxDepth: number;
    maxChildrenPerParent: number;
    maxMissionConcurrency: number;
  }>;
  fileAccessRules: Readonly<{ readRoots: readonly string[]; writeRoots: readonly string[] }>;
  validationThresholds: Readonly<{ humanRetryAttempt: number; requireHumanForPolicyOverride: boolean }>;
  retryLimits: RetryLimits;
}>;

export type MissionTemplateAgent = Readonly<{
  agentId: string;
  role: string;
  capabilities: readonly string[];
  required: boolean;
}>;

export type MissionTemplateSnapshot = Readonly<{
  snapshotId: string;
  missionId: string;
  sourceTemplateId: string;
  sourceRevision: number;
  normalizedTeam: readonly MissionTemplateAgent[];
  autonomyContract: AutonomyContract;
  contentHash: string;
  sealedAt: string;
}>;

export type WorkspaceEffectIntent = Readonly<{
  kind: string;
  aggregateId: string;
  idempotencyKey: string;
}>;

export type AgentActivityEntry = Readonly<{
  kind: string;
  detail: string;
}>;

export const isNonEmpty = (value: string): boolean => value.trim().length > 0;

export const isMissionShared = (visibility: MissionVisibility): boolean => visibility.kind === "mission_shared";

export const isValidAutonomyContract = (contract: AutonomyContract): boolean =>
  contract.allowedToolIds.length > 0 &&
  contract.budgetLimits.maxActions > 0 &&
  contract.budgetLimits.maxRuntimeSeconds > 0 &&
  contract.delegationLimits.maxDepth >= 0 &&
  contract.delegationLimits.maxChildrenPerParent >= 0 &&
  contract.delegationLimits.maxMissionConcurrency > 0 &&
  contract.validationThresholds.humanRetryAttempt > 0 &&
  Object.values(contract.retryLimits).every((limit) => Number.isInteger(limit) && limit >= 0);

export const isValidTemplateSnapshot = (snapshot: MissionTemplateSnapshot, missionId: string): boolean => {
  const ids = snapshot.normalizedTeam.map((agent) => agent.agentId);
  return (
    snapshot.missionId === missionId &&
    isNonEmpty(snapshot.snapshotId) &&
    isNonEmpty(snapshot.sourceTemplateId) &&
    snapshot.sourceRevision > 0 &&
    snapshot.normalizedTeam.some((agent) => agent.required) &&
    new Set(ids).size === ids.length &&
    snapshot.normalizedTeam.every(
      (agent) => isNonEmpty(agent.agentId) && isNonEmpty(agent.role) && agent.capabilities.length > 0,
    ) &&
    isNonEmpty(snapshot.contentHash) &&
    isNonEmpty(snapshot.sealedAt) &&
    isValidAutonomyContract(snapshot.autonomyContract)
  );
};

export const appendUnique = <T extends { readonly messageId: string }>(items: readonly T[], item: T): readonly T[] =>
  items.some((candidate) => candidate.messageId === item.messageId) ? items : [...items, item];

export const sanitizeAgentActivity = (entry: AgentActivityEntry): AgentActivityEntry => {
  const containsSensitiveTechnicalOutput = /\b(stdout|stderr|token|secret|prompt)\s*:/i.test(entry.detail);
  return containsSensitiveTechnicalOutput ? { ...entry, detail: "[redacted technical output]" } : entry;
};
