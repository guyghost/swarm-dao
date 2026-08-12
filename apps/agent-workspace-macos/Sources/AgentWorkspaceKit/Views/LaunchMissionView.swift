import SwiftUI

struct LaunchMissionView: View {
  let templates: [TeamTemplate]
  let onLaunch: (LaunchConfiguration) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var selectedTemplateId = ""
  @State private var enabledAgentIds: Set<String> = []
  @State private var allowedTools = "workspace.read, workspace.write"
  @State private var readRoot = "/tmp/mission"
  @State private var writeRoot = "/tmp/mission/output"
  @State private var maxActions = 40
  @State private var maxRuntimeSeconds = 1_800
  @State private var delegationEnabled = true
  @State private var maxDepth = 1
  @State private var maxChildren = 2
  @State private var maxConcurrency = 3
  @State private var humanRetryAttempt = 2

  var body: some View {
    NavigationStack {
      Form {
        Section("Modèle d’équipe") {
          Picker("Modèle", selection: $selectedTemplateId) {
            ForEach(templates) { Text($0.name).tag($0.templateId) }
          }
          ForEach(selectedTemplate?.agents ?? []) { agent in
            Toggle(isOn: enabledBinding(for: agent)) {
              VStack(alignment: .leading) {
                Text(agent.role)
                Text(agent.capabilities.joined(separator: " · "))
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
            .disabled(agent.required)
          }
        }
        Section("Outils et budgets") {
          TextField("Outils autorisés", text: $allowedTools)
          Stepper("Actions maximales : \(maxActions)", value: $maxActions, in: 1...10_000)
          Stepper(
            "Durée maximale : \(maxRuntimeSeconds) s", value: $maxRuntimeSeconds, in: 60...86_400,
            step: 60)
        }
        Section("Accès aux fichiers") {
          TextField("Racine en lecture", text: $readRoot)
          TextField("Racine en écriture", text: $writeRoot)
        }
        Section("Délégation") {
          Toggle("Autoriser les sous-agents", isOn: $delegationEnabled)
          Stepper("Profondeur : \(maxDepth)", value: $maxDepth, in: 0...8)
          Stepper("Enfants par parent : \(maxChildren)", value: $maxChildren, in: 0...16)
          Stepper("Concurrence mission : \(maxConcurrency)", value: $maxConcurrency, in: 1...32)
        }
        Section("Validation et reprises") {
          Stepper(
            "Validation humaine à l’essai \(humanRetryAttempt)", value: $humanRetryAttempt,
            in: 1...10)
          LabeledContent("Dérogation de politique", value: "Confirmation humaine requise")
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Lancer une mission")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Annuler") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Lancer") { onLaunch(configuration) }
            .buttonStyle(.borderedProminent)
            .disabled(!canLaunch)
        }
      }
      .onAppear { selectInitialTemplate() }
      .onChange(of: selectedTemplateId) { selectAgentsForTemplate() }
    }
    .frame(minWidth: 620, minHeight: 640)
  }

  private var selectedTemplate: TeamTemplate? {
    templates.first { $0.templateId == selectedTemplateId }
  }

  private var tools: [String] {
    allowedTools.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter {
      !$0.isEmpty
    }
  }

  private var canLaunch: Bool {
    guard let template = selectedTemplate, !tools.isEmpty, maxActions > 0, maxRuntimeSeconds > 0
    else { return false }
    return template.agents.filter(\.required).allSatisfy { enabledAgentIds.contains($0.agentId) }
  }

  private var configuration: LaunchConfiguration {
    LaunchConfiguration(
      templateId: selectedTemplateId,
      enabledAgentIds: Array(enabledAgentIds).sorted(),
      autonomyContract: AutonomyContract(
        allowedToolIds: tools,
        budgetLimits: .init(maxActions: maxActions, maxRuntimeSeconds: maxRuntimeSeconds),
        delegationLimits: .init(
          enabled: delegationEnabled,
          maxDepth: maxDepth,
          maxChildrenPerParent: maxChildren,
          maxMissionConcurrency: maxConcurrency
        ),
        fileAccessRules: .init(
          readRoots: readRoot.isEmpty ? [] : [readRoot],
          writeRoots: writeRoot.isEmpty ? [] : [writeRoot]
        ),
        validationThresholds: .init(
          humanRetryAttempt: humanRetryAttempt,
          requireHumanForPolicyOverride: true
        ),
        retryLimits: .init(start: 1, runtime: 1, subagentStart: 1, stop: 1)
      )
    )
  }

  private func enabledBinding(for agent: MissionTemplateAgent) -> Binding<Bool> {
    Binding(
      get: { enabledAgentIds.contains(agent.agentId) },
      set: { enabled in
        if enabled {
          enabledAgentIds.insert(agent.agentId)
        } else {
          enabledAgentIds.remove(agent.agentId)
        }
      }
    )
  }

  private func selectInitialTemplate() {
    if selectedTemplateId.isEmpty { selectedTemplateId = templates.first?.templateId ?? "" }
    selectAgentsForTemplate()
  }

  private func selectAgentsForTemplate() {
    enabledAgentIds = Set(selectedTemplate?.agents.map(\.agentId) ?? [])
  }
}
