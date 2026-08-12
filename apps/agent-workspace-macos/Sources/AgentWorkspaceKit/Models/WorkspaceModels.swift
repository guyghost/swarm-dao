import Foundation

public enum MissionState: String, Codable, Sendable, CaseIterable {
  case draft
  case pending
  case active
  case pausing
  case paused
  case humanInterventionRequired = "human_intervention_required"
  case cancelling
  case failing
  case completed
  case cancelled
  case failed
}

public enum LocalAgentState: String, Codable, Sendable {
  case ready
  case starting
  case active
  case waitingForHuman = "waiting_for_human"
  case retryWait = "retry_wait"
  case interrupted
  case stopping
  case failing
  case completed
  case cancelled
  case failed
}

public enum MissionCommand: String, Codable, Sendable, CaseIterable {
  case launch
  case sendMessage = "send_message"
  case pause
  case resume
  case cancel
}

public enum WorkspaceVisibilityKind: String, Codable, Sendable {
  case missionShared = "mission_shared"
  case direct
}

public struct WorkspaceVisibility: Codable, Equatable, Sendable {
  public let kind: WorkspaceVisibilityKind
  public let participantIds: [String]
}

public enum MessageAuthorKind: String, Codable, Sendable {
  case human
  case agent
  case system
}

public struct MessageAuthor: Codable, Equatable, Sendable {
  public let kind: MessageAuthorKind
  public let id: String
  public let displayName: String
}

public enum MessageKind: String, Codable, Sendable {
  case conversation
  case systemNotice = "system_notice"
}

public struct MissionMessage: Codable, Equatable, Identifiable, Sendable {
  public let messageId: String
  public let missionId: String?
  public let author: MessageAuthor
  public let visibility: WorkspaceVisibility
  public let kind: MessageKind
  public let content: String
  public let createdAt: String

  public var id: String { messageId }
}

public struct RetryLimits: Codable, Equatable, Sendable {
  public let start: Int
  public let runtime: Int
  public let subagentStart: Int
  public let stop: Int
}

public struct BudgetLimits: Codable, Equatable, Sendable {
  public let maxActions: Int
  public let maxRuntimeSeconds: Int
}

public struct DelegationLimits: Codable, Equatable, Sendable {
  public let enabled: Bool
  public let maxDepth: Int
  public let maxChildrenPerParent: Int
  public let maxMissionConcurrency: Int
}

public struct FileAccessRules: Codable, Equatable, Sendable {
  public let readRoots: [String]
  public let writeRoots: [String]
}

public struct ValidationThresholds: Codable, Equatable, Sendable {
  public let humanRetryAttempt: Int
  public let requireHumanForPolicyOverride: Bool
}

public struct AutonomyContract: Codable, Equatable, Sendable {
  public let allowedToolIds: [String]
  public let budgetLimits: BudgetLimits
  public let delegationLimits: DelegationLimits
  public let fileAccessRules: FileAccessRules
  public let validationThresholds: ValidationThresholds
  public let retryLimits: RetryLimits
}

public struct MissionTemplateAgent: Codable, Equatable, Identifiable, Sendable {
  public let agentId: String
  public let role: String
  public let capabilities: [String]
  public let required: Bool

  public var id: String { agentId }
}

public enum TeamTemplateOrigin: String, Codable, Sendable {
  case builtIn = "built_in"
  case user
  case duplicate
}

public struct TeamTemplate: Codable, Equatable, Identifiable, Sendable {
  public let templateId: String
  public let revision: Int
  public let name: String
  public let origin: TeamTemplateOrigin
  public let agents: [MissionTemplateAgent]

  public var id: String { templateId }
}

public struct MissionTemplateSnapshot: Codable, Equatable, Sendable {
  public let snapshotId: String
  public let missionId: String
  public let sourceTemplateId: String
  public let sourceRevision: Int
  public let normalizedTeam: [MissionTemplateAgent]
  public let autonomyContract: AutonomyContract
  public let contentHash: String
  public let sealedAt: String
}

public struct MissionProjection: Codable, Equatable, Sendable {
  public let missionId: String
  public let state: MissionState
  public let availableCommands: [MissionCommand]
  public let templateSnapshot: MissionTemplateSnapshot?
}

public struct AgentActivity: Codable, Equatable, Sendable {
  public let kind: String
  public let detail: String
}

public struct AgentProfile: Codable, Equatable, Identifiable, Sendable {
  public let agentId: String
  public let missionId: String
  public let role: String
  public let state: LocalAgentState
  public let parentAgentId: String?
  public let capabilities: [String]
  public let effectivePermissions: [String]
  public let activity: [AgentActivity]

  public var id: String { agentId }
}

public struct WorkspaceProjection: Codable, Equatable, Sendable {
  public let mission: MissionProjection
  public let messages: [MissionMessage]
  public let agents: [AgentProfile]
}

public struct WorkspaceHostResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let error: String?
  public let projection: WorkspaceProjection
  public let templates: [TeamTemplate]
}

public struct LaunchConfiguration: Codable, Equatable, Sendable {
  public let templateId: String
  public let enabledAgentIds: [String]
  public let autonomyContract: AutonomyContract

  public init(templateId: String, enabledAgentIds: [String], autonomyContract: AutonomyContract) {
    self.templateId = templateId
    self.enabledAgentIds = enabledAgentIds
    self.autonomyContract = autonomyContract
  }
}

public enum WorkspaceCommand: Equatable, Sendable, Encodable {
  case getWorkspace
  case launchMission(LaunchConfiguration)
  case sendMessage(String)
  case pauseMission
  case resumeMission
  case cancelMission

  private enum CodingKeys: String, CodingKey {
    case type
    case templateId
    case enabledAgentIds
    case autonomyContract
    case content
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .getWorkspace:
      try container.encode("get_workspace", forKey: .type)
    case .launchMission(let configuration):
      try container.encode("launch_mission", forKey: .type)
      try container.encode(configuration.templateId, forKey: .templateId)
      try container.encode(configuration.enabledAgentIds, forKey: .enabledAgentIds)
      try container.encode(configuration.autonomyContract, forKey: .autonomyContract)
    case .sendMessage(let content):
      try container.encode("send_message", forKey: .type)
      try container.encode(content, forKey: .content)
    case .pauseMission:
      try container.encode("pause_mission", forKey: .type)
    case .resumeMission:
      try container.encode("resume_mission", forKey: .type)
    case .cancelMission:
      try container.encode("cancel_mission", forKey: .type)
    }
  }
}
