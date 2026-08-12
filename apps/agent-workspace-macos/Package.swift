// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "AgentWorkspace",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "AgentWorkspace", targets: ["AgentWorkspace"])
  ],
  targets: [
    .target(name: "AgentWorkspaceKit"),
    .executableTarget(name: "AgentWorkspace", dependencies: ["AgentWorkspaceKit"]),
    .testTarget(name: "AgentWorkspaceKitTests", dependencies: ["AgentWorkspaceKit"]),
  ]
)
