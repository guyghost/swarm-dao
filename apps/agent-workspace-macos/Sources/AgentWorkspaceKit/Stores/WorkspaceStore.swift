import Foundation
import Observation

@MainActor
@Observable
public final class WorkspaceStore {
  public private(set) var projection: WorkspaceProjection?
  public private(set) var templates: [TeamTemplate] = []
  public private(set) var autonomyConfiguration: AutonomyContract?
  public private(set) var storage = WorkspaceStorageStatus(
    state: .uninitialized, revision: 0, errorCode: nil)
  public private(set) var isWorking = false
  public private(set) var lastError: String?
  public var selectedAgentId: String?

  private let client: any WorkspaceModelClient

  public init(client: any WorkspaceModelClient) {
    self.client = client
  }

  public var sharedMessages: [MissionMessage] {
    projection?.messages.filter { $0.visibility.kind == .missionShared } ?? []
  }

  public var selectedAgent: AgentProfile? {
    projection?.agents.first { $0.agentId == selectedAgentId }
  }

  public func isAvailable(_ command: MissionCommand) -> Bool {
    projection?.mission.availableCommands.contains(command) == true
  }

  public func refresh() async {
    await execute(.getWorkspace)
  }

  public func launch(_ configuration: LaunchConfiguration) async {
    await execute(.launchMission(configuration))
  }

  public func sendMessage(_ content: String) async {
    await execute(.sendMessage(content))
  }

  public func pause() async {
    await execute(.pauseMission)
  }

  public func resume() async {
    await execute(.resumeMission)
  }

  public func cancel() async {
    await execute(.cancelMission)
  }

  public func createTemplate(name: String, agents: [MissionTemplateAgent]) async {
    await execute(
      .createTeamTemplate(
        templateId: "user-\(UUID().uuidString.lowercased())", name: name, agents: agents))
  }

  public func duplicateTemplate(_ template: TeamTemplate, name: String) async {
    await execute(
      .duplicateTeamTemplate(
        sourceTemplateId: template.templateId,
        sourceRevision: template.revision,
        templateId: "duplicate-\(UUID().uuidString.lowercased())",
        name: name
      ))
  }

  public func saveTemplateRevision(
    _ template: TeamTemplate, name: String, agents: [MissionTemplateAgent]
  ) async {
    await execute(
      .saveTeamTemplateRevision(
        templateId: template.templateId,
        expectedRevision: template.revision,
        name: name,
        agents: agents
      ))
  }

  public func clearError() {
    lastError = nil
  }

  private func execute(_ command: WorkspaceCommand) async {
    isWorking = true
    defer { isWorking = false }
    do {
      let response = try await client.send(command)
      projection = response.projection
      templates = response.templates
      autonomyConfiguration = response.autonomyConfiguration
      storage = response.storage
      lastError = response.ok ? nil : response.error
    } catch {
      lastError = error.localizedDescription
    }
  }
}
