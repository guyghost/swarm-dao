import { type ActorRefFrom, assign, createActor, setup } from "xstate";
import { isNonEmpty, type WorkspaceEventSource } from "./local-workspace.types.js";

export type WorkspacePersistenceState =
  | "uninitialized"
  | "loading"
  | "migrating"
  | "recovering"
  | "ready"
  | "saving"
  | "save_failed"
  | "storage_blocked"
  | "corrupt"
  | "incompatible";

export type WorkspaceStorageStatus = Readonly<{
  state: WorkspacePersistenceState;
  revision: number;
  errorCode: string | null;
}>;

export interface LocalWorkspacePersistenceContext {
  ownerId: string;
  maxSaveRetries: number;
  committedPayloadHash: string | null;
  committedRevision: number;
  pendingPayloadHash: string | null;
  pendingRevision: number | null;
  saveAttempt: number;
  errorCode: string | null;
}

export interface LocalWorkspacePersistenceInput {
  ownerId: string;
  maxSaveRetries: number;
}

export type LocalWorkspacePersistenceEvent =
  | Readonly<{ type: "STORAGE_LOAD_REQUESTED"; source: WorkspaceEventSource }>
  | Readonly<{ type: "STORAGE_MISSING"; source: WorkspaceEventSource }>
  | Readonly<{
      type: "STORAGE_RECORD_LOADED";
      source: WorkspaceEventSource;
      schemaVersion: number;
      shapeValid: boolean;
      integrityValid: boolean;
      payloadHash: string;
      revision: number;
    }>
  | Readonly<{ type: "STORAGE_LOAD_FAILED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{
      type: "STORAGE_MIGRATION_SUCCEEDED";
      source: WorkspaceEventSource;
      schemaVersion: 1;
      payloadHash: string;
      revision: number;
    }>
  | Readonly<{ type: "STORAGE_MIGRATION_FAILED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{
      type: "WORKSPACE_RECOVERY_APPLIED";
      source: WorkspaceEventSource;
      allAggregatesSafe: boolean;
      liveProcessCount: number;
    }>
  | Readonly<{
      type: "PERSISTENCE_SAVE_REQUESTED";
      source: WorkspaceEventSource;
      payloadHash: string;
      proposedRevision: number;
    }>
  | Readonly<{
      type: "STORAGE_SAVE_COMMITTED";
      source: WorkspaceEventSource;
      payloadHash: string;
      revision: number;
    }>
  | Readonly<{ type: "STORAGE_SAVE_FAILED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{
      type: "STORAGE_SAVE_RETRY_DUE";
      source: WorkspaceEventSource;
      payloadHash: string;
      attempt: number;
    }>
  | Readonly<{
      type: "STORAGE_SAVE_RETRY_AUTHORIZED";
      source: WorkspaceEventSource;
      ownerId: string;
      payloadHash: string;
      attempt: number;
    }>
  | Readonly<{
      type: "STORAGE_SAVE_RETRIES_EXHAUSTED";
      source: WorkspaceEventSource;
      payloadHash: string;
      attempt: number;
    }>;

const currentSchemaVersion = 1;

const persistenceSetup = setup({
  types: {
    context: {} as LocalWorkspacePersistenceContext,
    input: {} as LocalWorkspacePersistenceInput,
    events: {} as LocalWorkspacePersistenceEvent,
  },
  guards: {
    systemStartup: ({ event }) => event.type === "STORAGE_LOAD_REQUESTED" && event.source === "system",
    trustedMissing: ({ event }) => event.type === "STORAGE_MISSING" && event.source === "tool",
    currentValidRecord: ({ event }) =>
      event.type === "STORAGE_RECORD_LOADED" &&
      event.source === "tool" &&
      event.schemaVersion === currentSchemaVersion &&
      event.shapeValid &&
      event.integrityValid &&
      isNonEmpty(event.payloadHash) &&
      event.revision > 0,
    legacyValidRecord: ({ event }) =>
      event.type === "STORAGE_RECORD_LOADED" &&
      event.source === "tool" &&
      event.schemaVersion === 0 &&
      event.shapeValid &&
      isNonEmpty(event.payloadHash) &&
      event.revision >= 0,
    futureRecord: ({ event }) =>
      event.type === "STORAGE_RECORD_LOADED" && event.source === "tool" && event.schemaVersion > currentSchemaVersion,
    corruptRecord: ({ event }) =>
      (event.type === "STORAGE_LOAD_FAILED" || event.type === "STORAGE_MIGRATION_FAILED") &&
      event.source === "tool" &&
      isNonEmpty(event.errorCode),
    migratedRecord: ({ event }) =>
      event.type === "STORAGE_MIGRATION_SUCCEEDED" &&
      event.source === "tool" &&
      event.schemaVersion === currentSchemaVersion &&
      isNonEmpty(event.payloadHash) &&
      event.revision > 0,
    safeRecovery: ({ event }) =>
      event.type === "WORKSPACE_RECOVERY_APPLIED" &&
      event.source === "system" &&
      event.allAggregatesSafe &&
      event.liveProcessCount === 0,
    changedSave: ({ context, event }) =>
      event.type === "PERSISTENCE_SAVE_REQUESTED" &&
      event.source === "system" &&
      isNonEmpty(event.payloadHash) &&
      event.payloadHash !== context.committedPayloadHash &&
      event.proposedRevision === context.committedRevision + 1,
    duplicateSave: ({ context, event }) =>
      event.type === "PERSISTENCE_SAVE_REQUESTED" &&
      event.source === "system" &&
      event.payloadHash === context.committedPayloadHash &&
      event.proposedRevision === context.committedRevision,
    matchingCommit: ({ context, event }) =>
      event.type === "STORAGE_SAVE_COMMITTED" &&
      event.source === "tool" &&
      event.payloadHash === context.pendingPayloadHash &&
      event.revision === context.pendingRevision &&
      event.revision === context.committedRevision + 1,
    transientSaveFailure: ({ event }) =>
      event.type === "STORAGE_SAVE_FAILED" && event.source === "tool" && isNonEmpty(event.errorCode),
    automaticRetry: ({ context, event }) =>
      event.type === "STORAGE_SAVE_RETRY_DUE" &&
      event.source === "system" &&
      event.payloadHash === context.pendingPayloadHash &&
      event.attempt === context.saveAttempt &&
      event.attempt <= context.maxSaveRetries,
    humanRetry: ({ context, event }) =>
      event.type === "STORAGE_SAVE_RETRY_AUTHORIZED" &&
      event.source === "human" &&
      event.ownerId === context.ownerId &&
      event.payloadHash === context.pendingPayloadHash &&
      event.attempt === context.saveAttempt &&
      event.attempt <= context.maxSaveRetries,
    retriesExhausted: ({ context, event }) =>
      event.type === "STORAGE_SAVE_RETRIES_EXHAUSTED" &&
      event.source === "system" &&
      event.payloadHash === context.pendingPayloadHash &&
      event.attempt === context.saveAttempt &&
      event.attempt > context.maxSaveRetries,
  },
  actions: {
    recordLoaded: assign(({ event }) =>
      event.type === "STORAGE_RECORD_LOADED"
        ? {
            committedPayloadHash: event.payloadHash,
            committedRevision: event.revision,
            errorCode: null,
          }
        : {},
    ),
    recordMigrated: assign(({ event }) =>
      event.type === "STORAGE_MIGRATION_SUCCEEDED"
        ? {
            committedPayloadHash: event.payloadHash,
            committedRevision: event.revision,
            errorCode: null,
          }
        : {},
    ),
    recordLoadError: assign(({ event }) => ({
      errorCode:
        event.type === "STORAGE_LOAD_FAILED" || event.type === "STORAGE_MIGRATION_FAILED"
          ? event.errorCode
          : "storage_incompatible",
    })),
    retainPendingSave: assign(({ event }) =>
      event.type === "PERSISTENCE_SAVE_REQUESTED"
        ? {
            pendingPayloadHash: event.payloadHash,
            pendingRevision: event.proposedRevision,
            saveAttempt: 0,
            errorCode: null,
          }
        : {},
    ),
    adoptCommit: assign(({ event }) =>
      event.type === "STORAGE_SAVE_COMMITTED"
        ? {
            committedPayloadHash: event.payloadHash,
            committedRevision: event.revision,
            pendingPayloadHash: null,
            pendingRevision: null,
            saveAttempt: 0,
            errorCode: null,
          }
        : {},
    ),
    recordSaveFailure: assign(({ context, event }) => ({
      saveAttempt: context.saveAttempt + 1,
      errorCode: event.type === "STORAGE_SAVE_FAILED" ? event.errorCode : "storage_write_failed",
    })),
  },
});

export const localWorkspacePersistenceMachine = persistenceSetup.createMachine({
  id: "localWorkspacePersistence",
  initial: "uninitialized",
  context: ({ input }) => ({
    ownerId: input.ownerId,
    maxSaveRetries: input.maxSaveRetries,
    committedPayloadHash: null,
    committedRevision: 0,
    pendingPayloadHash: null,
    pendingRevision: null,
    saveAttempt: 0,
    errorCode: null,
  }),
  states: {
    uninitialized: {
      on: { STORAGE_LOAD_REQUESTED: { guard: "systemStartup", target: "loading" } },
    },
    loading: {
      on: {
        STORAGE_MISSING: { guard: "trustedMissing", target: "recovering" },
        STORAGE_RECORD_LOADED: [
          { guard: "currentValidRecord", target: "recovering", actions: "recordLoaded" },
          { guard: "legacyValidRecord", target: "migrating" },
          { guard: "futureRecord", target: "incompatible", actions: "recordLoadError" },
        ],
        STORAGE_LOAD_FAILED: { guard: "corruptRecord", target: "corrupt", actions: "recordLoadError" },
      },
    },
    migrating: {
      on: {
        STORAGE_MIGRATION_SUCCEEDED: {
          guard: "migratedRecord",
          target: "recovering",
          actions: "recordMigrated",
        },
        STORAGE_MIGRATION_FAILED: { guard: "corruptRecord", target: "corrupt", actions: "recordLoadError" },
      },
    },
    recovering: {
      on: { WORKSPACE_RECOVERY_APPLIED: { guard: "safeRecovery", target: "ready" } },
    },
    ready: {
      on: {
        PERSISTENCE_SAVE_REQUESTED: [
          { guard: "changedSave", target: "saving", actions: "retainPendingSave" },
          { guard: "duplicateSave" },
        ],
      },
    },
    saving: {
      on: {
        STORAGE_SAVE_COMMITTED: { guard: "matchingCommit", target: "ready", actions: "adoptCommit" },
        STORAGE_SAVE_FAILED: { guard: "transientSaveFailure", target: "save_failed", actions: "recordSaveFailure" },
      },
    },
    save_failed: {
      on: {
        STORAGE_SAVE_RETRY_DUE: { guard: "automaticRetry", target: "saving" },
        STORAGE_SAVE_RETRY_AUTHORIZED: { guard: "humanRetry", target: "saving" },
        STORAGE_SAVE_RETRIES_EXHAUSTED: { guard: "retriesExhausted", target: "storage_blocked" },
      },
    },
    storage_blocked: { type: "final" },
    corrupt: { type: "final" },
    incompatible: { type: "final" },
  },
});

export type LocalWorkspacePersistenceActor = ActorRefFrom<typeof localWorkspacePersistenceMachine>;

export const createLocalWorkspacePersistenceActor = (
  input: LocalWorkspacePersistenceInput,
): LocalWorkspacePersistenceActor => {
  const actor = createActor(localWorkspacePersistenceMachine, { input });
  actor.start();
  return actor;
};

export const workspaceStorageStatus = (actor: LocalWorkspacePersistenceActor): WorkspaceStorageStatus => {
  const snapshot = actor.getSnapshot();
  return {
    state: String(snapshot.value) as WorkspacePersistenceState,
    revision: snapshot.context.committedRevision,
    errorCode: snapshot.context.errorCode,
  };
};
