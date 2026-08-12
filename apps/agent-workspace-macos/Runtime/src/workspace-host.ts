import {
  type AutonomyContract,
  type ClockPort,
  isValidAutonomyContract,
  type LocalAgentProcessPort,
  LocalAgentWorkspaceService,
  type SnapshotHashPort,
  type TeamTemplate,
  type WorkspaceProjection,
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
  | Readonly<{ type: "cancel_mission" }>;

export type WorkspaceResponse = Readonly<{
  ok: boolean;
  error: string | null;
  projection: WorkspaceProjection;
  templates: readonly TeamTemplate[];
}>;

export type WorkspaceHostDependencies = Readonly<{
  missionId: string;
  ownerId: string;
  processPort: LocalAgentProcessPort;
  clock: ClockPort;
  hash: SnapshotHashPort;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);

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
    default:
      throw new Error("unsupported workspace command");
  }
};

export class WorkspaceHost {
  readonly #service: LocalAgentWorkspaceService;

  public constructor(dependencies: WorkspaceHostDependencies) {
    this.#service = new LocalAgentWorkspaceService(dependencies);
  }

  public async handle(request: WorkspaceRequest): Promise<WorkspaceResponse> {
    try {
      const projection = await this.#execute(request);
      return { ok: true, error: null, projection, templates: builtInTeamTemplates };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "unknown workspace error",
        projection: this.#service.projection(),
        templates: builtInTeamTemplates,
      };
    }
  }

  async #execute(request: WorkspaceRequest): Promise<WorkspaceProjection> {
    switch (request.type) {
      case "get_workspace":
        return this.#service.projection();
      case "launch_mission": {
        const template = builtInTeamTemplates.find((candidate) => candidate.templateId === request.templateId);
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
    }
  }
}
