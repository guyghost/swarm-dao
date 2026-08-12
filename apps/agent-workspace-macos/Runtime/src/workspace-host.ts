import {
  type AutonomyContract,
  type ClockPort,
  isValidAutonomyContract,
  type LocalAgentProcessPort,
  LocalAgentWorkspaceService,
  type LocalWorkspacePersistedState,
  type LocalWorkspacePersistencePort,
  type SnapshotHashPort,
  type TeamTemplate,
  type WorkspaceProjection,
  type WorkspaceStorageStatus,
} from "../../../../packages/core/src/index.js";

export const builtInTeamTemplates: readonly TeamTemplate[] = [
  {
    templateId: "core-duo",
    revision: 1,
    name: "Duo cœur",
    origin: "built_in",
    agents: [
      {
        agentId: "planner",
        role: "Planificateur",
        capabilities: ["mission_planning", "shared_coordination"],
        required: true,
      },
      {
        agentId: "builder",
        role: "Constructeur",
        capabilities: ["local_execution", "shared_coordination"],
        required: false,
      },
    ],
  },
];

export type WorkspaceRequest =
  | Readonly<{ type: "get_workspace" }>
  | Readonly<{
      type: "launch_mission";
      templateId: string;
      enabledAgentIds: readonly string[];
      autonomyContract: AutonomyContract;
    }>
  | Readonly<{ type: "send_message"; content: string }>
  | Readonly<{ type: "pause_mission" }>
  | Readonly<{ type: "resume_mission" }>
  | Readonly<{ type: "cancel_mission" }>
  | Readonly<{
      type: "create_team_template";
      templateId: string;
      name: string;
      agents: TeamTemplate["agents"];
    }>
  | Readonly<{
      type: "duplicate_team_template";
      sourceTemplateId: string;
      sourceRevision: number;
      templateId: string;
      name: string;
    }>
  | Readonly<{
      type: "save_team_template_revision";
      templateId: string;
      expectedRevision: number;
      name: string;
      agents: TeamTemplate["agents"];
    }>;

export type WorkspaceResponse = Readonly<{
  ok: boolean;
  error: string | null;
  projection: WorkspaceProjection;
  templates: readonly TeamTemplate[];
  autonomyConfiguration: AutonomyContract | null;
  storage: WorkspaceStorageStatus;
}>;

export interface WorkspacePersistenceRuntime extends LocalWorkspacePersistencePort {
  load(): Promise<Readonly<{ state: LocalWorkspacePersistedState | null; migrated: boolean }>>;
  completeRecovery(): void;
  status(): WorkspaceStorageStatus;
}

export type WorkspaceHostDependencies = Readonly<{
  missionId: string;
  ownerId: string;
  processPort: LocalAgentProcessPort;
  clock: ClockPort;
  hash: SnapshotHashPort;
  restoredState?: LocalWorkspacePersistedState;
  persistence?: WorkspacePersistenceRuntime;
  startupError?: string;
  startupStorageStatus?: WorkspaceStorageStatus;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);

const decodeTemplateAgents = (value: unknown): TeamTemplate["agents"] => {
  if (!Array.isArray(value)) throw new Error("agents must be an array");
  return value.map((agent) => {
    if (!isRecord(agent)) throw new Error("team template agent must be an object");
    requireExactKeys(agent, ["agentId", "role", "capabilities", "required"]);
    if (
      typeof agent.agentId !== "string" ||
      typeof agent.role !== "string" ||
      !isStringArray(agent.capabilities) ||
      typeof agent.required !== "boolean"
    ) {
      throw new Error("team template agent is invalid");
    }
    return {
      agentId: agent.agentId,
      role: agent.role,
      capabilities: agent.capabilities,
      required: agent.required,
    };
  });
};

const requireExactKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unsupported workspace command field");
};

export const decodeWorkspaceRequest = (value: unknown): WorkspaceRequest => {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("workspace command must be an object");
  switch (value.type) {
    case "get_workspace":
    case "pause_mission":
    case "resume_mission":
    case "cancel_mission":
      requireExactKeys(value, ["type"]);
      return { type: value.type };
    case "send_message":
      requireExactKeys(value, ["type", "content"]);
      if (typeof value.content !== "string" || value.content.trim().length === 0) {
        throw new Error("message content must be non-empty");
      }
      return { type: value.type, content: value.content };
    case "launch_mission":
      requireExactKeys(value, ["type", "templateId", "enabledAgentIds", "autonomyContract"]);
      if (typeof value.templateId !== "string" || value.templateId.trim().length === 0) {
        throw new Error("templateId must be non-empty");
      }
      if (!isStringArray(value.enabledAgentIds)) throw new Error("enabledAgentIds must be non-empty strings");
      if (!isRecord(value.autonomyContract) || !isValidAutonomyContract(value.autonomyContract as AutonomyContract)) {
        throw new Error("autonomyContract is invalid");
      }
      return {
        type: value.type,
        templateId: value.templateId,
        enabledAgentIds: value.enabledAgentIds,
        autonomyContract: value.autonomyContract as AutonomyContract,
      };
    case "create_team_template":
      requireExactKeys(value, ["type", "templateId", "name", "agents"]);
      if (
        typeof value.templateId !== "string" ||
        value.templateId.trim().length === 0 ||
        typeof value.name !== "string" ||
        value.name.trim().length === 0
      ) {
        throw new Error("team template identity is invalid");
      }
      return {
        type: value.type,
        templateId: value.templateId,
        name: value.name,
        agents: decodeTemplateAgents(value.agents),
      };
    case "duplicate_team_template":
      requireExactKeys(value, ["type", "sourceTemplateId", "sourceRevision", "templateId", "name"]);
      if (
        typeof value.sourceTemplateId !== "string" ||
        typeof value.templateId !== "string" ||
        typeof value.name !== "string" ||
        !Number.isInteger(value.sourceRevision) ||
        Number(value.sourceRevision) < 1
      ) {
        throw new Error("team template duplication is invalid");
      }
      return {
        type: value.type,
        sourceTemplateId: value.sourceTemplateId,
        sourceRevision: Number(value.sourceRevision),
        templateId: value.templateId,
        name: value.name,
      };
    case "save_team_template_revision":
      requireExactKeys(value, ["type", "templateId", "expectedRevision", "name", "agents"]);
      if (
        typeof value.templateId !== "string" ||
        typeof value.name !== "string" ||
        !Number.isInteger(value.expectedRevision) ||
        Number(value.expectedRevision) < 1
      ) {
        throw new Error("team template revision is invalid");
      }
      return {
        type: value.type,
        templateId: value.templateId,
        expectedRevision: Number(value.expectedRevision),
        name: value.name,
        agents: decodeTemplateAgents(value.agents),
      };
    default:
      throw new Error("unsupported workspace command");
  }
};

export class WorkspaceHost {
  readonly #service: LocalAgentWorkspaceService;
  readonly #persistence?: WorkspacePersistenceRuntime;
  readonly #startupError?: string;
  readonly #startupStorageStatus?: WorkspaceStorageStatus;

  public constructor(dependencies: WorkspaceHostDependencies) {
    this.#persistence = dependencies.persistence;
    this.#startupError = dependencies.startupError;
    this.#startupStorageStatus = dependencies.startupStorageStatus;
    this.#service = new LocalAgentWorkspaceService({
      ...dependencies,
      builtInTemplates: builtInTeamTemplates,
      restoredState: dependencies.restoredState,
      persistence: dependencies.persistence,
    });
  }

  public static async restore(
    dependencies: Omit<WorkspaceHostDependencies, "restoredState" | "startupError">,
  ): Promise<WorkspaceHost> {
    if (!dependencies.persistence) return new WorkspaceHost(dependencies);
    let safeRestoredState: LocalWorkspacePersistedState | null = null;
    try {
      const loaded = await dependencies.persistence.load();
      const host = new WorkspaceHost({ ...dependencies, restoredState: loaded.state ?? undefined });
      if (loaded.state) await host.#service.recoverAfterRestart(dependencies.clock.now(), false);
      safeRestoredState = host.#service.persistedState();
      dependencies.persistence.completeRecovery();
      if (loaded.state) await host.#service.persistCurrentState();
      return host;
    } catch (error) {
      const startupStorageStatus = dependencies.persistence.status();
      return new WorkspaceHost({
        ...dependencies,
        persistence: undefined,
        restoredState: safeRestoredState ?? undefined,
        startupError: error instanceof Error ? error.message : "workspace storage failed",
        startupStorageStatus,
      });
    }
  }

  public async handle(request: WorkspaceRequest): Promise<WorkspaceResponse> {
    try {
      if (this.#isStorageBlocked() && request.type !== "get_workspace") {
        throw new Error(this.#startupError ?? "workspace storage is blocked");
      }
      const projection = await this.#execute(request);
      return this.#response(true, null, projection);
    } catch (error) {
      return this.#response(
        false,
        error instanceof Error ? error.message : "unknown workspace error",
        this.#service.projection(),
      );
    }
  }

  async #execute(request: WorkspaceRequest): Promise<WorkspaceProjection> {
    switch (request.type) {
      case "get_workspace":
        return this.#service.projection();
      case "launch_mission": {
        const template = this.#service.templates().find((candidate) => candidate.templateId === request.templateId);
        if (!template) throw new Error(`unknown team template ${request.templateId}`);
        const knownAgentIds = new Set(template.agents.map((agent) => agent.agentId));
        if (request.enabledAgentIds.some((agentId) => !knownAgentIds.has(agentId))) {
          throw new Error("enabledAgentIds contains an agent outside the selected template");
        }
        return this.#service.launch({
          template,
          enabledAgentIds: request.enabledAgentIds,
          autonomyContract: request.autonomyContract,
        });
      }
      case "send_message":
        return this.#service.sendHumanMessage(request.content);
      case "pause_mission":
        return this.#service.pause();
      case "resume_mission":
        return this.#service.resume();
      case "cancel_mission":
        return this.#service.cancel();
      case "create_team_template":
        await this.#service.createTemplate(request);
        return this.#service.projection();
      case "duplicate_team_template":
        await this.#service.duplicateTemplate(request);
        return this.#service.projection();
      case "save_team_template_revision":
        await this.#service.saveTemplateRevision(request);
        return this.#service.projection();
    }
  }

  #response(ok: boolean, error: string | null, projection: WorkspaceProjection): WorkspaceResponse {
    const storage = this.#storageStatus();
    const blocked = this.#isStorageBlocked(storage);
    return {
      ok: ok && !blocked,
      error: blocked ? (this.#startupError ?? error ?? storage.errorCode ?? "workspace storage is blocked") : error,
      projection: blocked ? { ...projection, mission: { ...projection.mission, availableCommands: [] } } : projection,
      templates: this.#service.templates(),
      autonomyConfiguration: this.#service.lastAutonomyContract(),
      storage,
    };
  }

  #storageStatus(): WorkspaceStorageStatus {
    return (
      this.#persistence?.status() ??
      this.#startupStorageStatus ?? {
        state: this.#startupError ? "storage_blocked" : "ready",
        revision: 0,
        errorCode: this.#startupError ? "storage_startup_failed" : null,
      }
    );
  }

  #isStorageBlocked(status = this.#storageStatus()): boolean {
    return status.state === "storage_blocked" || status.state === "corrupt" || status.state === "incompatible";
  }
}
