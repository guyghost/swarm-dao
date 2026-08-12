import Foundation
import XCTest

@testable import AgentWorkspaceKit

@MainActor
final class WorkspaceRuntimeIntegrationTests: XCTestCase {
  func testNativeClientDrivesOnlyModelAuthorizedRuntimeCommands() async throws {
    let sourceRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let runtimeURL =
      ProcessInfo.processInfo.environment["AGENT_WORKSPACE_RUNTIME_PATH"]
      .map(URL.init(fileURLWithPath:))
      ?? sourceRoot.appendingPathComponent(".build/runtime/AgentWorkspaceRuntime")
    guard FileManager.default.isExecutableFile(atPath: runtimeURL.path) else {
      throw XCTSkip("Build AgentWorkspaceRuntime before running the integration test")
    }
    let storageURL = FileManager.default.temporaryDirectory.appendingPathComponent(
      "AgentWorkspaceRuntimeTests-\(UUID().uuidString)", isDirectory: true)
    defer {
      if FileManager.default.fileExists(atPath: storageURL.path) {
        try? FileManager.default.removeItem(at: storageURL)
      }
    }
    let client = SubprocessWorkspaceModelClient(
      runtimeURL: runtimeURL, storageDirectoryURL: storageURL)

    let initial = try await client.send(.getWorkspace)
    XCTAssertEqual(initial.projection.mission.state, .draft)
    XCTAssertEqual(initial.projection.mission.availableCommands, [.launch, .sendMessage, .cancel])

    let launched = try await client.send(.launchMission(Fixtures.runtimeLaunchConfiguration))
    XCTAssertTrue(launched.ok)
    XCTAssertEqual(launched.projection.mission.state, .active)
    XCTAssertEqual(launched.projection.agents.map(\.state), [.active])
    XCTAssertNotNil(launched.projection.mission.templateSnapshot?.contentHash)

    let messaged = try await client.send(.sendMessage("Orchestre la mission"))
    XCTAssertTrue(messaged.projection.messages.allSatisfy { $0.visibility.kind == .missionShared })
    XCTAssertTrue(messaged.projection.messages.contains { $0.author.kind == .agent })
    XCTAssertTrue(
      messaged.projection.agents.first?.activity.contains { $0.kind == "worker_roundtrip" } == true)

    let paused = try await client.send(.pauseMission)
    XCTAssertEqual(paused.projection.mission.state, .paused)
    let resumed = try await client.send(.resumeMission)
    XCTAssertEqual(resumed.projection.mission.state, .active)
    let cancelled = try await client.send(.cancelMission)
    XCTAssertEqual(cancelled.projection.mission.state, .cancelled)
    XCTAssertTrue(cancelled.projection.mission.availableCommands.isEmpty)

    let forbidden = try await client.send(.sendMessage("Transition terminale interdite"))
    XCTAssertFalse(forbidden.ok)
    XCTAssertEqual(forbidden.projection.mission.state, .cancelled)
  }
}

private enum Fixtures {
  static let runtimeLaunchConfiguration = LaunchConfiguration(
    templateId: "core-duo",
    enabledAgentIds: ["planner"],
    autonomyContract: AutonomyContract(
      allowedToolIds: ["workspace.read"],
      budgetLimits: .init(maxActions: 20, maxRuntimeSeconds: 600),
      delegationLimits: .init(
        enabled: true, maxDepth: 1, maxChildrenPerParent: 2, maxMissionConcurrency: 3),
      fileAccessRules: .init(readRoots: ["/tmp/mission"], writeRoots: ["/tmp/mission/output"]),
      validationThresholds: .init(humanRetryAttempt: 2, requireHumanForPolicyOverride: true),
      retryLimits: .init(start: 1, runtime: 1, subagentStart: 1, stop: 1)
    )
  )
}
