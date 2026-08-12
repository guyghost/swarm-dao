import SwiftUI

struct ConversationView: View {
  @Bindable var store: WorkspaceStore
  @State private var draft = ""

  var body: some View {
    VStack(spacing: 0) {
      if store.sharedMessages.isEmpty {
        ContentUnavailableView(
          "Fil de mission",
          systemImage: "bubble.left.and.bubble.right",
          description: Text("Les humains et agents échangeront ici.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
              ForEach(store.sharedMessages) { message in
                MessageRow(message: message)
                  .id(message.id)
              }
            }
            .padding(20)
          }
          .onChange(of: store.sharedMessages.count) {
            if let last = store.sharedMessages.last {
              withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
            }
          }
        }
      }
      Divider()
      composer
    }
    .navigationTitle("Fil partagé")
    .toolbar { missionControls }
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 12) {
      TextField("Écrire dans le fil partagé", text: $draft, axis: .vertical)
        .lineLimit(1...5)
        .textFieldStyle(.roundedBorder)
        .onSubmit(sendDraft)
      Button("Envoyer", systemImage: "paperplane.fill", action: sendDraft)
        .labelStyle(.iconOnly)
        .buttonStyle(.borderedProminent)
    }
    .padding(14)
    .disabled(
      !store.isAvailable(.sendMessage) || store.isWorking
        || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
  }

  @ToolbarContentBuilder
  private var missionControls: some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      ForEach(controlCommands, id: \.self) { command in
        Button(command.label, systemImage: command.systemImage) {
          Task {
            switch command {
            case .pause: await store.pause()
            case .resume: await store.resume()
            case .cancel: await store.cancel()
            case .launch, .sendMessage: break
            }
          }
        }
        .disabled(store.isWorking)
      }
    }
  }

  private var controlCommands: [MissionCommand] {
    (store.projection?.mission.availableCommands ?? []).filter {
      [.pause, .resume, .cancel].contains($0)
    }
  }

  private func sendDraft() {
    let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !content.isEmpty, store.isAvailable(.sendMessage) else { return }
    draft = ""
    Task { await store.sendMessage(content) }
  }
}

private struct MessageRow: View {
  let message: MissionMessage

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: message.author.kind.systemImage)
        .frame(width: 28, height: 28)
        .background(.quaternary, in: Circle())
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(message.author.displayName).font(.headline)
          Text(message.createdAt).font(.caption).foregroundStyle(.tertiary)
        }
        Text(message.content)
          .textSelection(.enabled)
      }
      Spacer(minLength: 24)
    }
    .accessibilityElement(children: .combine)
  }
}

extension MessageAuthorKind {
  fileprivate var systemImage: String {
    switch self {
    case .human: "person.fill"
    case .agent: "cpu"
    case .system: "info.circle"
    }
  }
}

extension MissionCommand {
  fileprivate var label: String {
    switch self {
    case .launch: "Lancer"
    case .sendMessage: "Envoyer"
    case .pause: "Pause"
    case .resume: "Reprendre"
    case .cancel: "Annuler"
    }
  }

  fileprivate var systemImage: String {
    switch self {
    case .launch, .resume: "play.fill"
    case .sendMessage: "paperplane.fill"
    case .pause: "pause.fill"
    case .cancel: "xmark.circle"
    }
  }
}
