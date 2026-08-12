import SwiftUI

struct AgentProfileView: View {
  let agent: AgentProfile

  var body: some View {
    Form {
      Section("Agent") {
        LabeledContent("Rôle", value: agent.role)
        LabeledContent("État", value: agent.state.label)
        LabeledContent("Identifiant", value: agent.agentId)
        if let parent = agent.parentAgentId {
          LabeledContent("Parent", value: parent)
        }
      }
      Section("Capacités") {
        ForEach(agent.capabilities, id: \.self) { Text($0) }
      }
      Section("Permissions effectives") {
        ForEach(agent.effectivePermissions, id: \.self) { Text($0).font(.callout.monospaced()) }
      }
      Section("Journal d’activité") {
        if agent.activity.isEmpty {
          Text("Aucune activité technique").foregroundStyle(.secondary)
        }
        ForEach(Array(agent.activity.enumerated()), id: \.offset) { _, entry in
          VStack(alignment: .leading, spacing: 3) {
            Text(entry.kind).font(.caption).foregroundStyle(.secondary)
            Text(entry.detail).textSelection(.enabled)
          }
        }
      }
    }
    .formStyle(.grouped)
    .navigationTitle(agent.role)
  }
}
