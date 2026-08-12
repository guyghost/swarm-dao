import XCTest

@testable import AgentWorkspaceKit

@MainActor
final class WorkspaceStoreTests: XCTestCase {
  func testDirectVisibilityRemainsDecodableWithoutEnablingPrivateConversation() throws {
    let data = Data(#"{"kind":"direct","participantIds":["human","planner"]}"#.utf8)

    let visibility = try JSONDecoder().decode(WorkspaceVisibility.self, from: data)

    XCTAssertEqual(visibility.kind, .direct)
    XCTAssertEqual(visibility.participantIds, ["human", "planner"])
    XCTAssertFalse(MissionCommand.allCases.map(\.rawValue).contains("send_direct_message"))
  }

  func testStoreForwardsStructuredLaunchAndUsesModelCommands() async {
    let draft = Fixtures.response(state: .draft, commands: [.launch, .sendMessage, .cancel])
    let active = Fixtures.response(state: .active, commands: [.sendMessage, .pause, .cancel])
    let client = FakeWorkspaceModelClient(responses: [draft, active])
    let store = WorkspaceStore(client: client)

    await store.refresh()
    XCTAssertTrue(store.isAvailable(.launch))
    XCTAssertFalse(store.isAvailable(.pause))

    let configuration = Fixtures.launchConfiguration
    await store.launch(configuration)

    XCTAssertEqual(client.commands, [.getWorkspace, .launchMission(configuration)])
    XCTAssertTrue(store.isAvailable(.pause))
    XCTAssertFalse(store.isAvailable(.launch))
    XCTAssertEqual(
      store.projection?.mission.templateSnapshot?.autonomyContract, configuration.autonomyContract)
  }

  func testSharedMessagesNeverMixAgentActivity() async {
    let response = Fixtures.response(
      state: .active,
      commands: [.sendMessage, .pause, .cancel],
      messages: [
        MissionMessage(
          messageId: "m1",
          missionId: "mission",
          author: .init(kind: .agent, id: "planner", displayName: "Planner"),
          visibility: .init(kind: .missionShared, participantIds: []),
          kind: .conversation,
          content: "Plan partagé",
          createdAt: "2026-08-12T12:00:00.000Z"
        )
      ],
      activity: [.init(kind: "worker_roundtrip", detail: "trace privée")]
    )
    let store = WorkspaceStore(client: FakeWorkspaceModelClient(responses: [response]))

    await store.refresh()

    XCTAssertEqual(store.sharedMessages.map(\.content), ["Plan partagé"])
    XCTAssertFalse(store.sharedMessages.contains { $0.content.contains("trace privée") })
    XCTAssertEqual(store.projection?.agents.first?.activity.first?.detail, "trace privée")
  }

  func testStoreProjectsSafeRestartRecoveryWithoutInventingAnAction() async {
    let response = Fixtures.response(
      state: .paused,
      commands: [.sendMessage, .resume, .cancel],
      recovery: .init(
        required: true,
        previousState: .active,
        recoveredAt: "2026-08-12T13:00:00.000Z"))
    let store = WorkspaceStore(client: FakeWorkspaceModelClient(responses: [response]))

    await store.refresh()

    XCTAssertEqual(store.projection?.mission.state, .paused)
    XCTAssertEqual(store.projection?.mission.recovery?.previousState, .active)
    XCTAssertTrue(store.isAvailable(.resume))
    XCTAssertFalse(store.isAvailable(.launch))
    XCTAssertEqual(store.storage, .init(state: .ready, revision: 1, errorCode: nil))
  }
}

@MainActor
private final class FakeWorkspaceModelClient: WorkspaceModelClient {
  private var responses: [WorkspaceHostResponse]
  private(set) var commands: [WorkspaceCommand] = []

  init(responses: [WorkspaceHostResponse]) {
    self.responses = responses
  }

  func send(_ command: WorkspaceCommand) async throws -> WorkspaceHostResponse {
    commands.append(command)
    return responses.removeFirst()
  }
}

private enum Fixtures {
  static let autonomyContract = AutonomyContract(
    allowedToolIds: ["workspace.read"],
    budgetLimits: .init(maxActions: 40, maxRuntimeSeconds: 1_800),
    delegationLimits: .init(
      enabled: true, maxDepth: 1, maxChildrenPerParent: 2, maxMissionConcurrency: 3),
    fileAccessRules: .init(readRoots: ["/tmp/mission"], writeRoots: ["/tmp/mission/output"]),
    validationThresholds: .init(humanRetryAttempt: 2, requireHumanForPolicyOverride: true),
    retryLimits: .init(start: 1, runtime: 1, subagentStart: 1, stop: 1)
  )

  static let launchConfiguration = LaunchConfiguration(
    templateId: "core-duo",
    enabledAgentIds: ["planner"],
    autonomyContract: autonomyContract
  )

  static func response(
    state: MissionState,
    commands: [MissionCommand],
    messages: [MissionMessage] = [],
    activity: [AgentActivity] = [],
    recovery: WorkspaceRecovery? = nil
  ) -> WorkspaceHostResponse {
    let template = TeamTemplate(
      templateId: "core-duo",
      revision: 1,
      name: "Duo cœur",
      origin: .builtIn,
      agents: [
        .init(
          agentId: "planner", role: "Planificateur", capabilities: ["mission_planning"],
          required: true)
      ]
    )
    let snapshot = MissionTemplateSnapshot(
      snapshotId: "mission:snapshot:1",
      missionId: "mission",
      sourceTemplateId: "core-duo",
      sourceRevision: 1,
      normalizedTeam: template.agents,
      autonomyContract: autonomyContract,
      contentHash: "sha256:test",
      sealedAt: "2026-08-12T12:00:00.000Z"
    )
    return WorkspaceHostResponse(
      ok: true,
      error: nil,
      projection: .init(
        mission: .init(
          missionId: "mission",
          state: state,
          availableCommands: commands,
          templateSnapshot: state == .draft ? nil : snapshot,
          recovery: recovery
        ),
        messages: messages,
        agents: [
          .init(
            agentId: "planner",
            missionId: "mission",
            role: "Planificateur",
            state: .active,
            parentAgentId: nil,
            capabilities: ["mission_planning"],
            effectivePermissions: ["workspace.read"],
            activity: activity
          )
        ]
      ),
      templates: [template],
      autonomyConfiguration: autonomyContract,
      storage: .init(state: .ready, revision: 1, errorCode: nil)
    )
  }
}
