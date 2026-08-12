import Foundation
import Observation

@MainActor
@Observable
public final class WorkspaceStore {
  public private(set) var projection: WorkspaceProjection?
  public private(set) var templates: [TeamTemplate] = []
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
      lastError = response.ok ? nil : response.error
    } catch {
      lastError = error.localizedDescription
    }
  }
}
