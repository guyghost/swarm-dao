import SwiftUI

struct MissionSidebar: View {
  @Bindable var store: WorkspaceStore
  @Binding var showsLaunchSheet: Bool

  var body: some View {
    List {
      Section("Mission") {
        if let mission = store.projection?.mission {
          LabeledContent("État", value: mission.state.label)
          if let snapshot = mission.templateSnapshot {
            VStack(alignment: .leading, spacing: 4) {
              Text("Instantané")
                .font(.caption)
                .foregroundStyle(.secondary)
              Text(snapshot.sourceTemplateId)
              Text(snapshot.contentHash.prefix(12))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
          }
        } else {
          ProgressView()
        }
        if store.isAvailable(.launch) {
          Button("Configurer et lancer", systemImage: "play.fill") {
            showsLaunchSheet = true
          }
          .disabled(store.templates.isEmpty || store.isWorking)
        }
      }

      Section("Agents") {
        ForEach(store.projection?.agents ?? []) { agent in
          Button {
            store.selectedAgentId = agent.agentId
          } label: {
            HStack {
              VStack(alignment: .leading) {
                Text(agent.role)
                Text(agent.agentId)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Circle()
                .fill(agent.state.tint)
                .frame(width: 8, height: 8)
                .accessibilityLabel(agent.state.label)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }
    .navigationTitle("Agent Workspace")
  }
}

extension MissionState {
  fileprivate var label: String {
    switch self {
    case .draft: "Brouillon"
    case .pending: "En attente"
    case .active: "Active"
    case .pausing: "Mise en pause"
    case .paused: "En pause"
    case .humanInterventionRequired: "Intervention requise"
    case .cancelling: "Annulation"
    case .failing: "Échec en cours"
    case .completed: "Terminée"
    case .cancelled: "Annulée"
    case .failed: "Erreur"
    }
  }
}

extension LocalAgentState {
  var label: String {
    switch self {
    case .ready: "Prêt"
    case .starting: "Démarrage"
    case .active: "Actif"
    case .waitingForHuman: "En attente d’humain"
    case .retryWait: "Nouvel essai"
    case .interrupted: "Interrompu"
    case .stopping: "Arrêt"
    case .failing: "Échec en cours"
    case .completed: "Terminé"
    case .cancelled: "Annulé"
    case .failed: "Erreur"
    }
  }

  var tint: Color {
    switch self {
    case .active: .green
    case .waitingForHuman, .retryWait: .orange
    case .failed, .failing: .red
    case .starting, .stopping: .blue
    default: .secondary
    }
  }
}
