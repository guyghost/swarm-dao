import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutonomyContract,
  createLocalWorkspacePersistenceActor,
  isValidAutonomyContract,
  isValidTemplateSnapshot,
  type LocalWorkspacePersistedState,
  type LocalWorkspacePersistencePort,
  type MissionTemplateAgent,
  type MissionTemplateSnapshot,
  sanitizeAgentActivity,
  type WorkspaceStorageStatus,
  workspaceStorageStatus,
} from "../../../../packages/core/src/index.js";

const currentSchemaVersion = 1;
const committedFilename = "workspace-v1.json";

type WorkspaceEnvelopeV1 = Readonly<{
  schemaVersion: 1;
  revision: number;
  savedAt: string;
  payloadHash: string;
  payload: LocalWorkspacePersistedState;
  checksum: string;
}>;

type WorkspaceEnvelopeV0 = Readonly<{
  schemaVersion: 0;
  revision: number;
  savedAt: string;
  payload: LocalWorkspacePersistedState;
}>;

export type WorkspaceLoadResult = Readonly<{
  state: LocalWorkspacePersistedState | null;
  migrated: boolean;
}>;

export class WorkspacePersistenceError extends Error {
  public constructor(
    public readonly code: "storage_corrupt" | "storage_incompatible" | "storage_write_failed",
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePersistenceError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isStringArray = (value: unknown, allowEmpty = true): value is readonly string[] =>
  Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(isNonEmptyString);

const isNatural = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;

const isValidPersistedAutonomyContract = (value: unknown): value is AutonomyContract => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "allowedToolIds",
      "budgetLimits",
      "delegationLimits",
      "fileAccessRules",
      "validationThresholds",
      "retryLimits",
    ])
  ) {
    return false;
  }
  const { budgetLimits, delegationLimits, fileAccessRules, validationThresholds, retryLimits } = value;
  if (
    !isStringArray(value.allowedToolIds, false) ||
    !isRecord(budgetLimits) ||
    !hasExactKeys(budgetLimits, ["maxActions", "maxRuntimeSeconds"]) ||
    !isRecord(delegationLimits) ||
    !hasExactKeys(delegationLimits, ["enabled", "maxDepth", "maxChildrenPerParent", "maxMissionConcurrency"]) ||
    !isRecord(fileAccessRules) ||
    !hasExactKeys(fileAccessRules, ["readRoots", "writeRoots"]) ||
    !isRecord(validationThresholds) ||
    !hasExactKeys(validationThresholds, ["humanRetryAttempt", "requireHumanForPolicyOverride"]) ||
    !isRecord(retryLimits) ||
    !hasExactKeys(retryLimits, ["start", "runtime", "subagentStart", "stop"]) ||
    typeof delegationLimits.enabled !== "boolean" ||
    typeof validationThresholds.requireHumanForPolicyOverride !== "boolean" ||
    !isStringArray(fileAccessRules.readRoots) ||
    !isStringArray(fileAccessRules.writeRoots) ||
    !Object.values(budgetLimits).every(isNatural) ||
    ![delegationLimits.maxDepth, delegationLimits.maxChildrenPerParent, delegationLimits.maxMissionConcurrency].every(
      isNatural,
    ) ||
    !isNatural(validationThresholds.humanRetryAttempt) ||
    !Object.values(retryLimits).every(isNatural)
  ) {
    return false;
  }
  return isValidAutonomyContract(value as unknown as AutonomyContract);
};

const isValidTemplateAgent = (value: unknown): value is MissionTemplateAgent =>
  isRecord(value) &&
  hasExactKeys(value, ["agentId", "role", "capabilities", "required"]) &&
  isNonEmptyString(value.agentId) &&
  isNonEmptyString(value.role) &&
  isStringArray(value.capabilities, false) &&
  typeof value.required === "boolean";

const isValidPersistedTemplateSnapshot = (value: unknown, missionId: string): value is MissionTemplateSnapshot => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "snapshotId",
      "missionId",
      "sourceTemplateId",
      "sourceRevision",
      "normalizedTeam",
      "autonomyContract",
      "contentHash",
      "sealedAt",
    ]) ||
    !isNonEmptyString(value.snapshotId) ||
    value.missionId !== missionId ||
    !isNonEmptyString(value.sourceTemplateId) ||
    !Number.isInteger(value.sourceRevision) ||
    Number(value.sourceRevision) < 1 ||
    !Array.isArray(value.normalizedTeam) ||
    !value.normalizedTeam.every(isValidTemplateAgent) ||
    !isValidPersistedAutonomyContract(value.autonomyContract) ||
    !isNonEmptyString(value.contentHash) ||
    !isNonEmptyString(value.sealedAt)
  ) {
    return false;
  }
  return isValidTemplateSnapshot(value as unknown as MissionTemplateSnapshot, missionId);
};

const isValidActivity = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["kind", "detail"]) &&
  isNonEmptyString(value.kind) &&
  typeof value.detail === "string" &&
  sanitizeAgentActivity({ kind: value.kind, detail: value.detail }).detail === value.detail;

const isValidEffect = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["kind", "aggregateId", "idempotencyKey"]) &&
  isNonEmptyString(value.kind) &&
  isNonEmptyString(value.aggregateId) &&
  isNonEmptyString(value.idempotencyKey);

const isValidRetryLimits = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["start", "runtime", "subagentStart", "stop"]) &&
  Object.values(value).every(isNatural);

const isValidAgentContext = (value: Record<string, unknown>, missionId: string, agentId: string): boolean => {
  if (
    !hasExactKeys(value, [
      "agentId",
      "missionId",
      "ownerId",
      "role",
      "parentAgentId",
      "capabilities",
      "effectivePermissions",
      "retryLimits",
      "humanRetryAttempt",
      "startAttempt",
      "runtimeAttempt",
      "stopAttempt",
      "launchToken",
      "processId",
      "stopReason",
      "descendantsQuiescent",
      "pendingHumanRetry",
      "activity",
      "effects",
      "errorCode",
    ]) ||
    value.agentId !== agentId ||
    value.missionId !== missionId ||
    !isNonEmptyString(value.ownerId) ||
    !isNonEmptyString(value.role) ||
    (value.parentAgentId !== null && !isNonEmptyString(value.parentAgentId)) ||
    !isStringArray(value.capabilities, false) ||
    !isStringArray(value.effectivePermissions) ||
    !isValidRetryLimits(value.retryLimits) ||
    !isNatural(value.humanRetryAttempt) ||
    Number(value.humanRetryAttempt) < 1 ||
    !isNatural(value.startAttempt) ||
    !isNatural(value.runtimeAttempt) ||
    !isNatural(value.stopAttempt) ||
    (value.launchToken !== null && !isNonEmptyString(value.launchToken)) ||
    (value.processId !== null && (!Number.isInteger(value.processId) || Number(value.processId) < 1)) ||
    ![null, "restartable", "terminal"].includes(value.stopReason as null | string) ||
    typeof value.descendantsQuiescent !== "boolean" ||
    !Array.isArray(value.activity) ||
    !value.activity.every(isValidActivity) ||
    !Array.isArray(value.effects) ||
    !value.effects.every(isValidEffect) ||
    (value.errorCode !== null && !isNonEmptyString(value.errorCode))
  ) {
    return false;
  }
  if (value.pendingHumanRetry === null) return true;
  return (
    isRecord(value.pendingHumanRetry) &&
    hasExactKeys(value.pendingHumanRetry, ["operation", "attempt"]) &&
    (value.pendingHumanRetry.operation === "start" || value.pendingHumanRetry.operation === "runtime") &&
    isNatural(value.pendingHumanRetry.attempt)
  );
};

const missionStates = new Set([
  "draft",
  "pending",
  "active",
  "pausing",
  "paused",
  "human_intervention_required",
  "cancelling",
  "failing",
  "completed",
  "cancelled",
  "failed",
]);

const agentStates = new Set([
  "ready",
  "starting",
  "active",
  "waiting_for_human",
  "retry_wait",
  "interrupted",
  "stopping",
  "failing",
  "completed",
  "cancelled",
  "failed",
]);

const isValidMessage = (value: unknown, missionId: string): boolean => {
  if (!isRecord(value)) return false;
  const keys =
    value.missionId === undefined
      ? ["messageId", "author", "visibility", "kind", "content", "createdAt"]
      : ["messageId", "missionId", "author", "visibility", "kind", "content", "createdAt"];
  if (
    !hasExactKeys(value, keys) ||
    !isNonEmptyString(value.messageId) ||
    (value.missionId !== undefined && value.missionId !== missionId) ||
    !isRecord(value.author) ||
    !hasExactKeys(value.author, ["kind", "id", "displayName"]) ||
    !["human", "agent", "system"].includes(String(value.author.kind)) ||
    !isNonEmptyString(value.author.id) ||
    !isNonEmptyString(value.author.displayName) ||
    !isRecord(value.visibility) ||
    !hasExactKeys(value.visibility, ["kind", "participantIds"]) ||
    !["mission_shared", "direct"].includes(String(value.visibility.kind)) ||
    !isStringArray(value.visibility.participantIds) ||
    (value.visibility.kind === "mission_shared" && value.visibility.participantIds.length !== 0) ||
    !["conversation", "system_notice"].includes(String(value.kind)) ||
    !isNonEmptyString(value.content) ||
    !isNonEmptyString(value.createdAt)
  ) {
    return false;
  }
  return true;
};

const isValidTeamTemplate = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const keys =
    value.lineage === undefined
      ? ["templateId", "revision", "name", "origin", "agents"]
      : ["templateId", "revision", "name", "origin", "agents", "lineage"];
  if (
    !hasExactKeys(value, keys) ||
    !isNonEmptyString(value.templateId) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !isNonEmptyString(value.name) ||
    (value.origin !== "user" && value.origin !== "duplicate") ||
    !Array.isArray(value.agents) ||
    value.agents.length === 0 ||
    !value.agents.every(isValidTemplateAgent) ||
    !value.agents.some((agent) => agent.required) ||
    new Set(value.agents.map((agent) => agent.agentId)).size !== value.agents.length
  ) {
    return false;
  }
  if (value.lineage === undefined) return true;
  return (
    isRecord(value.lineage) &&
    hasExactKeys(value.lineage, ["sourceTemplateId", "sourceRevision"]) &&
    isNonEmptyString(value.lineage.sourceTemplateId) &&
    Number.isInteger(value.lineage.sourceRevision) &&
    Number(value.lineage.sourceRevision) > 0
  );
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalPayload = (payload: LocalWorkspacePersistedState): string => JSON.stringify(payload);

const checksumInput = (envelope: Omit<WorkspaceEnvelopeV1, "checksum">): string => JSON.stringify(envelope);

const snapshotContext = (snapshot: unknown): Record<string, unknown> | null => {
  if (!isRecord(snapshot) || !isRecord(snapshot.context) || typeof snapshot.value !== "string") return null;
  return snapshot.context;
};

export const isValidLocalWorkspacePersistedState = (
  value: unknown,
  missionId: string,
): value is LocalWorkspacePersistedState => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "missionSnapshot",
      "agents",
      "technicalActivity",
      "userTemplateRevisions",
      "lastAutonomyContract",
      "messageSequence",
    ]) ||
    !Number.isInteger(value.messageSequence) ||
    Number(value.messageSequence) < 0 ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.technicalActivity) ||
    !Array.isArray(value.userTemplateRevisions)
  ) {
    return false;
  }
  const missionContext = snapshotContext(value.missionSnapshot);
  if (
    !missionContext ||
    !missionStates.has(String((value.missionSnapshot as Record<string, unknown>).value)) ||
    !hasExactKeys(missionContext, [
      "missionId",
      "ownerId",
      "templateSnapshot",
      "messages",
      "blockers",
      "interventionOrigin",
      "effects",
      "recovery",
    ]) ||
    missionContext.missionId !== missionId ||
    !isNonEmptyString(missionContext.ownerId) ||
    (missionContext.templateSnapshot !== null &&
      !isValidPersistedTemplateSnapshot(missionContext.templateSnapshot, missionId)) ||
    !Array.isArray(missionContext.messages) ||
    !isStringArray(missionContext.blockers) ||
    ![null, "pending", "active"].includes(missionContext.interventionOrigin as null | string) ||
    !Array.isArray(missionContext.effects) ||
    !missionContext.effects.every(isValidEffect) ||
    (missionContext.recovery !== null &&
      (!isRecord(missionContext.recovery) ||
        !hasExactKeys(missionContext.recovery, ["required", "previousState", "recoveredAt"]) ||
        typeof missionContext.recovery.required !== "boolean" ||
        !missionStates.has(String(missionContext.recovery.previousState)) ||
        !isNonEmptyString(missionContext.recovery.recoveredAt)))
  ) {
    return false;
  }
  const messageIds = new Set<string>();
  for (const message of missionContext.messages) {
    if (
      !isRecord(message) ||
      typeof message.messageId !== "string" ||
      !isValidMessage(message, missionId) ||
      messageIds.has(message.messageId)
    ) {
      return false;
    }
    messageIds.add(message.messageId);
  }
  const agentIds = new Set<string>();
  const agentParents = new Map<string, string | null>();
  for (const record of value.agents) {
    if (!isRecord(record) || !hasExactKeys(record, ["agentId", "snapshot"]) || typeof record.agentId !== "string") {
      return false;
    }
    const context = snapshotContext(record.snapshot);
    if (
      !context ||
      !agentStates.has(String((record.snapshot as Record<string, unknown>).value)) ||
      !isValidAgentContext(context, missionId, record.agentId) ||
      agentIds.has(record.agentId) ||
      typeof context.agentId !== "string"
    ) {
      return false;
    }
    agentIds.add(record.agentId);
    agentParents.set(record.agentId, typeof context.parentAgentId === "string" ? context.parentAgentId : null);
  }
  for (const [agentId, parentAgentId] of agentParents) {
    if (parentAgentId !== null && (parentAgentId === agentId || !agentIds.has(parentAgentId))) return false;
  }
  const technicalAgentIds = new Set<string>();
  for (const record of value.technicalActivity) {
    if (
      !isRecord(record) ||
      !hasExactKeys(record, ["agentId", "entries"]) ||
      typeof record.agentId !== "string" ||
      !agentIds.has(record.agentId) ||
      technicalAgentIds.has(record.agentId) ||
      !Array.isArray(record.entries)
    ) {
      return false;
    }
    if (!record.entries.every(isValidActivity)) {
      return false;
    }
    technicalAgentIds.add(record.agentId);
  }
  const templateRevisions = new Set<string>();
  const latestTemplateRevision = new Map<string, number>();
  const templateOrigins = new Map<string, string>();
  for (const template of value.userTemplateRevisions) {
    if (
      !isValidTeamTemplate(template) ||
      !isRecord(template) ||
      typeof template.templateId !== "string" ||
      typeof template.revision !== "number"
    ) {
      return false;
    }
    const key = `${template.templateId}:${template.revision}`;
    if (templateRevisions.has(key)) return false;
    const previousRevision = latestTemplateRevision.get(template.templateId) ?? 0;
    if (template.revision !== previousRevision + 1) return false;
    const previousOrigin = templateOrigins.get(template.templateId);
    if (previousOrigin && previousOrigin !== template.origin) return false;
    templateRevisions.add(key);
    latestTemplateRevision.set(template.templateId, template.revision);
    templateOrigins.set(template.templateId, String(template.origin));
  }
  return value.lastAutonomyContract === null || isValidPersistedAutonomyContract(value.lastAutonomyContract);
};

export class FileWorkspacePersistence implements LocalWorkspacePersistencePort {
  readonly #directory: string;
  readonly #file: string;
  readonly #temporaryFile: string;
  readonly #missionId: string;
  readonly #clock: Readonly<{ now(): string }>;
  readonly #actor;

  public constructor(input: {
    directory: string;
    missionId: string;
    ownerId: string;
    clock: Readonly<{ now(): string }>;
    maxSaveRetries?: number;
  }) {
    this.#directory = input.directory;
    this.#file = join(input.directory, committedFilename);
    this.#temporaryFile = join(input.directory, `${committedFilename}.tmp`);
    this.#missionId = input.missionId;
    this.#clock = input.clock;
    this.#actor = createLocalWorkspacePersistenceActor({
      ownerId: input.ownerId,
      maxSaveRetries: input.maxSaveRetries ?? 1,
    });
  }

  public status(): WorkspaceStorageStatus {
    return workspaceStorageStatus(this.#actor);
  }

  public async load(): Promise<WorkspaceLoadResult> {
    this.#actor.send({ type: "STORAGE_LOAD_REQUESTED", source: "system" });
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        this.#actor.send({ type: "STORAGE_MISSING", source: "tool" });
        return { state: null, migrated: false };
      }
      return this.#failLoad("storage_read_failed");
    }
    try {
      await chmod(this.#directory, 0o700);
      await chmod(this.#file, 0o600);
    } catch {
      return this.#failLoad("storage_permissions_failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.#failLoad("storage_json_invalid");
    }
    if (!isRecord(parsed) || !Number.isInteger(parsed.schemaVersion)) return this.#failLoad("storage_shape_invalid");
    const schemaVersion = Number(parsed.schemaVersion);
    if (schemaVersion > currentSchemaVersion) {
      this.#actor.send({
        type: "STORAGE_RECORD_LOADED",
        source: "tool",
        schemaVersion,
        shapeValid: false,
        integrityValid: false,
        payloadHash: "future-version",
        revision: Number(parsed.revision ?? 0),
      });
      throw new WorkspacePersistenceError("storage_incompatible", "workspace storage version is newer than this app");
    }
    if (schemaVersion === 0) return this.#loadLegacy(parsed);
    if (!this.#isValidV1Envelope(parsed)) return this.#failLoad("storage_integrity_invalid");
    this.#actor.send({
      type: "STORAGE_RECORD_LOADED",
      source: "tool",
      schemaVersion: 1,
      shapeValid: true,
      integrityValid: true,
      payloadHash: parsed.payloadHash,
      revision: parsed.revision,
    });
    return { state: parsed.payload, migrated: false };
  }

  public completeRecovery(): void {
    this.#actor.send({
      type: "WORKSPACE_RECOVERY_APPLIED",
      source: "system",
      allAggregatesSafe: true,
      liveProcessCount: 0,
    });
    if (this.status().state !== "ready") throw new Error("persistence model rejected workspace recovery");
  }

  public async save(state: LocalWorkspacePersistedState): Promise<void> {
    if (!isValidLocalWorkspacePersistedState(state, this.#missionId)) {
      throw new WorkspacePersistenceError("storage_write_failed", "workspace payload failed validation");
    }
    const payloadHash = digest(canonicalPayload(state));
    const status = this.status();
    const proposedRevision =
      payloadHash === this.#actor.getSnapshot().context.committedPayloadHash ? status.revision : status.revision + 1;
    this.#actor.send({ type: "PERSISTENCE_SAVE_REQUESTED", source: "system", payloadHash, proposedRevision });
    if (this.status().state === "ready") return;
    if (this.status().state !== "saving") throw new Error("persistence model rejected save request");
    let lastError: unknown;
    while (this.status().state === "saving") {
      try {
        await this.#writeEnvelope(state, payloadHash, proposedRevision);
        this.#actor.send({
          type: "STORAGE_SAVE_COMMITTED",
          source: "tool",
          payloadHash,
          revision: proposedRevision,
        });
        return;
      } catch (error) {
        lastError = error;
        this.#actor.send({ type: "STORAGE_SAVE_FAILED", source: "tool", errorCode: "storage_write_failed" });
        const attempt = this.#actor.getSnapshot().context.saveAttempt;
        if (attempt <= this.#actor.getSnapshot().context.maxSaveRetries) {
          this.#actor.send({ type: "STORAGE_SAVE_RETRY_DUE", source: "system", payloadHash, attempt });
        } else {
          this.#actor.send({ type: "STORAGE_SAVE_RETRIES_EXHAUSTED", source: "system", payloadHash, attempt });
        }
      }
    }
    throw new WorkspacePersistenceError(
      "storage_write_failed",
      lastError instanceof Error ? lastError.message : "workspace storage write failed",
    );
  }

  async #loadLegacy(parsed: Record<string, unknown>): Promise<WorkspaceLoadResult> {
    if (
      !hasExactKeys(parsed, ["schemaVersion", "revision", "savedAt", "payload"]) ||
      !Number.isInteger(parsed.revision) ||
      Number(parsed.revision) < 0 ||
      typeof parsed.savedAt !== "string" ||
      !isValidLocalWorkspacePersistedState(parsed.payload, this.#missionId)
    ) {
      return this.#failLoad("storage_legacy_invalid");
    }
    const legacy = parsed as unknown as WorkspaceEnvelopeV0;
    const payloadHash = digest(canonicalPayload(legacy.payload));
    this.#actor.send({
      type: "STORAGE_RECORD_LOADED",
      source: "tool",
      schemaVersion: 0,
      shapeValid: true,
      integrityValid: false,
      payloadHash,
      revision: legacy.revision,
    });
    const revision = Math.max(1, legacy.revision + 1);
    try {
      await this.#writeEnvelope(legacy.payload, payloadHash, revision);
      this.#actor.send({
        type: "STORAGE_MIGRATION_SUCCEEDED",
        source: "tool",
        schemaVersion: 1,
        payloadHash,
        revision,
      });
      return { state: legacy.payload, migrated: true };
    } catch {
      this.#actor.send({ type: "STORAGE_MIGRATION_FAILED", source: "tool", errorCode: "storage_migration_failed" });
      throw new WorkspacePersistenceError("storage_corrupt", "workspace storage migration failed");
    }
  }

  #isValidV1Envelope(value: Record<string, unknown>): value is WorkspaceEnvelopeV1 {
    if (
      !hasExactKeys(value, ["schemaVersion", "revision", "savedAt", "payloadHash", "payload", "checksum"]) ||
      value.schemaVersion !== 1 ||
      !Number.isInteger(value.revision) ||
      Number(value.revision) < 1 ||
      typeof value.savedAt !== "string" ||
      typeof value.payloadHash !== "string" ||
      typeof value.checksum !== "string" ||
      !isValidLocalWorkspacePersistedState(value.payload, this.#missionId)
    ) {
      return false;
    }
    const envelopeWithoutChecksum = {
      schemaVersion: 1 as const,
      revision: Number(value.revision),
      savedAt: value.savedAt,
      payloadHash: value.payloadHash,
      payload: value.payload,
    };
    return (
      digest(canonicalPayload(value.payload)) === value.payloadHash &&
      digest(checksumInput(envelopeWithoutChecksum)) === value.checksum
    );
  }

  async #writeEnvelope(state: LocalWorkspacePersistedState, payloadHash: string, revision: number): Promise<void> {
    const withoutChecksum = {
      schemaVersion: 1 as const,
      revision,
      savedAt: this.#clock.now(),
      payloadHash,
      payload: state,
    };
    const envelope: WorkspaceEnvelopeV1 = {
      ...withoutChecksum,
      checksum: digest(checksumInput(withoutChecksum)),
    };
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.#temporaryFile, "w", 0o600);
      await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(this.#temporaryFile, 0o600);
      await rename(this.#temporaryFile, this.#file);
      const directoryHandle = await open(this.#directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(this.#temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  #failLoad(errorCode: string): never {
    this.#actor.send({ type: "STORAGE_LOAD_FAILED", source: "tool", errorCode });
    throw new WorkspacePersistenceError("storage_corrupt", `workspace storage is corrupt (${errorCode})`);
  }
}
