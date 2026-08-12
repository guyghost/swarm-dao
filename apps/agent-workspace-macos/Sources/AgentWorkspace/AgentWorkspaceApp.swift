import AgentWorkspaceKit
import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }
}

@main
struct AgentWorkspaceApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var store = WorkspaceStore(client: SubprocessWorkspaceModelClient())

  var body: some Scene {
    WindowGroup {
      WorkspaceRootView(store: store)
        .frame(minWidth: 920, minHeight: 640)
    }
    .defaultSize(width: 1_180, height: 780)
    .windowToolbarStyle(.unified)
  }
}
