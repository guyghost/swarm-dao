import Darwin
import Foundation

@MainActor
public protocol WorkspaceModelClient: AnyObject {
  func send(_ command: WorkspaceCommand) async throws -> WorkspaceHostResponse
}

public enum WorkspaceModelClientError: LocalizedError {
  case runtimeNotFound
  case runtimeStopped
  case emptyResponse
  case pipeWriteFailed

  public var errorDescription: String? {
    switch self {
    case .runtimeNotFound: "L’hôte local Agent Workspace est introuvable."
    case .runtimeStopped: "L’hôte local Agent Workspace s’est arrêté."
    case .emptyResponse: "L’hôte local Agent Workspace a renvoyé une réponse vide."
    case .pipeWriteFailed: "La commande n’a pas pu être écrite vers l’hôte local."
    }
  }
}

private struct RequestEnvelope: Encodable, Sendable {
  let requestId: String
  let command: WorkspaceCommand
}

private actor RuntimeConnection {
  private let executableURL: URL
  private let storageDirectoryURL: URL
  private var process: Process?
  private var inputPipe: Pipe?
  private var outputPipe: Pipe?
  private var input: FileHandle?
  private var output: FileHandle?
  private var bufferedOutput = Data()

  init(executableURL: URL, storageDirectoryURL: URL) {
    self.executableURL = executableURL
    self.storageDirectoryURL = storageDirectoryURL
  }

  deinit {
    process?.terminate()
  }

  func exchange(_ envelope: RequestEnvelope) throws -> WorkspaceHostResponse {
    try startIfNeeded()
    guard let process, process.isRunning, let input, let output else {
      throw WorkspaceModelClientError.runtimeStopped
    }
    var payload = try JSONEncoder().encode(envelope)
    payload.append(0x0A)
    let written = payload.withUnsafeBytes { buffer in
      Darwin.write(input.fileDescriptor, buffer.baseAddress, buffer.count)
    }
    guard written == payload.count else { throw WorkspaceModelClientError.pipeWriteFailed }
    let line = try readLine(from: output)
    return try JSONDecoder().decode(WorkspaceHostResponse.self, from: line)
  }

  private func startIfNeeded() throws {
    if process?.isRunning == true { return }
    guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
      throw WorkspaceModelClientError.runtimeNotFound
    }
    let process = Process()
    let inputPipe = Pipe()
    let outputPipe = Pipe()
    process.executableURL = executableURL
    process.arguments = ["--storage-directory", storageDirectoryURL.path]
    process.standardInput = inputPipe
    process.standardOutput = outputPipe
    process.standardError = FileHandle.standardError
    try process.run()
    self.process = process
    self.inputPipe = inputPipe
    self.outputPipe = outputPipe
    input = inputPipe.fileHandleForWriting
    output = outputPipe.fileHandleForReading
    bufferedOutput.removeAll(keepingCapacity: true)
  }

  private func readLine(from output: FileHandle) throws -> Data {
    while true {
      if let newline = bufferedOutput.firstIndex(of: 0x0A) {
        let line = bufferedOutput[..<newline]
        bufferedOutput.removeSubrange(...newline)
        if !line.isEmpty { return Data(line) }
      }
      let chunk = output.availableData
      guard !chunk.isEmpty else {
        throw WorkspaceModelClientError.emptyResponse
      }
      bufferedOutput.append(chunk)
    }
  }
}

@MainActor
public final class SubprocessWorkspaceModelClient: WorkspaceModelClient {
  private let connection: RuntimeConnection

  public init(runtimeURL: URL? = nil, storageDirectoryURL: URL? = nil) {
    let configuredPath = ProcessInfo.processInfo.environment["AGENT_WORKSPACE_RUNTIME_PATH"]
    let resolvedURL =
      runtimeURL
      ?? configuredPath.map(URL.init(fileURLWithPath:))
      ?? Bundle.main.resourceURL?.appendingPathComponent("AgentWorkspaceRuntime")
      ?? URL(fileURLWithPath: "/missing/AgentWorkspaceRuntime")
    let defaultStorageURL =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("Swarm DAO", isDirectory: true)
      .appendingPathComponent("Agent Workspace", isDirectory: true)
      ?? FileManager.default.temporaryDirectory.appendingPathComponent(
        "Swarm-DAO-Agent-Workspace", isDirectory: true)
    connection = RuntimeConnection(
      executableURL: resolvedURL,
      storageDirectoryURL: storageDirectoryURL ?? defaultStorageURL)
  }

  public func send(_ command: WorkspaceCommand) async throws -> WorkspaceHostResponse {
    let envelope = RequestEnvelope(requestId: UUID().uuidString, command: command)
    return try await connection.exchange(envelope)
  }
}
