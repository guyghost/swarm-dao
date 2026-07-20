import { GRAPH_TERMINAL_STATES } from "../../packages/core/src/models/graph-engineering.machine.js";

export type StopGateResult = Readonly<{
  continue: boolean;
  stopReason?: string;
  systemMessage?: string;
}>;

const terminalStates = new Set<string>(GRAPH_TERMINAL_STATES);

export const evaluateStopGate = (snapshot: unknown): StopGateResult => {
  if (snapshot === null || snapshot === undefined) return { continue: true };
  if (typeof snapshot !== "object" || !("state" in snapshot) || typeof snapshot.state !== "string") {
    return {
      continue: false,
      stopReason: "active graph snapshot is invalid",
      systemMessage: "Graph Engineering stopped: invalid active snapshot.",
    };
  }
  if (terminalStates.has(snapshot.state)) return { continue: true };
  return {
    continue: false,
    stopReason: `active graph run is still ${snapshot.state}`,
    systemMessage: "Graph Engineering requires an explicit terminal state before this task can stop.",
  };
};
