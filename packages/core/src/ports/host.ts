import type { HostAdapter } from "../types/index.js";

/** Narrow capabilities consumed independently by application use cases. */
export type AgentWorkerPort = Pick<HostAdapter, "spawnAgent" | "spawnAgents" | "getSessionModel">;
export type LoggerPort = Pick<HostAdapter, "log">;
export type WorkspacePort = Pick<HostAdapter, "getWorkingDirectory" | "readFile" | "writeFile">;
export type CommandRunnerPort = Pick<HostAdapter, "exec">;
export type CapabilityPort = Pick<HostAdapter, "hasCapability">;
