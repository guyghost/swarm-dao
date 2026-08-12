import SwiftUI

public struct WorkspaceRootView: View {
  @Bindable private var store: WorkspaceStore
  @State private var showsLaunchSheet = false

  public init(store: WorkspaceStore) {
    self.store = store
  }

  public var body: some View {
    NavigationSplitView {
      MissionSidebar(store: store, showsLaunchSheet: $showsLaunchSheet)
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 340)
    } detail: {
      ConversationView(store: store)
    }
    .inspector(isPresented: inspectorPresented) {
      if let agent = store.selectedAgent {
        AgentProfileView(agent: agent)
          .inspectorColumnWidth(min: 280, ideal: 320, max: 420)
      }
    }
    .sheet(isPresented: $showsLaunchSheet) {
      LaunchMissionView(
        templates: store.templates,
        initialAutonomyContract: store.autonomyConfiguration,
        onCreateTemplate: { name, agents in
          showsLaunchSheet = false
          Task { await store.createTemplate(name: name, agents: agents) }
        },
        onDuplicateTemplate: { template, name in
          showsLaunchSheet = false
          Task { await store.duplicateTemplate(template, name: name) }
        },
        onSaveTemplateRevision: { template, name, agents in
          showsLaunchSheet = false
          Task { await store.saveTemplateRevision(template, name: name, agents: agents) }
        },
        onLaunch: { configuration in
          showsLaunchSheet = false
          Task { await store.launch(configuration) }
        }
      )
    }
    .alert("Agent Workspace", isPresented: errorPresented) {
      Button("Fermer") { store.clearError() }
    } message: {
      Text(store.lastError ?? "Erreur inconnue")
    }
    .task { await store.refresh() }
  }

  private var inspectorPresented: Binding<Bool> {
    Binding(
      get: { store.selectedAgent != nil },
      set: { if !$0 { store.selectedAgentId = nil } }
    )
  }

  private var errorPresented: Binding<Bool> {
    Binding(
      get: { store.lastError != nil },
      set: { if !$0 { store.clearError() } }
    )
  }
}
