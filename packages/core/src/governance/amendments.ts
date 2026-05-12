// ============================================================
// Swarm DAO Core — Self-Amending DAO
// ============================================================

import { getState } from "../persistence.js";
import type { AmendmentPayload, AmendmentSnapshot } from "../types/index.js";

export interface AmendmentValidation {
  valid: boolean;
  errors: string[];
}

export interface AmendmentPreviewDiff {
  field: string;
  before: string;
  after: string;
}

export interface AmendmentExecutionResult {
  success: boolean;
  snapshot?: AmendmentSnapshot;
  error?: string;
}

export function validateAmendmentPayload(payload: AmendmentPayload): AmendmentValidation {
  const errors: string[] = [];

  switch (payload.type) {
    case "agent-update": {
      if (!payload.agentId) errors.push("agentId is required");
      if (!payload.changes || Object.keys(payload.changes).length === 0) {
        errors.push("At least one change is required");
      }
      const validFields = ["name", "role", "description", "weight", "model", "riskLevel", "enabled"];
      for (const key of Object.keys(payload.changes)) {
        if (!validFields.includes(key)) errors.push(`Unknown field: ${key}`);
      }
      if (payload.changes.weight !== undefined) {
        if (payload.changes.weight < 1 || payload.changes.weight > 10) {
          errors.push("weight must be between 1 and 10");
        }
      }
      break;
    }
    case "agent-add": {
      if (!payload.agent.id) errors.push("agent.id is required");
      if (!payload.agent.name) errors.push("agent.name is required");
      if (!payload.agent.weight || payload.agent.weight < 1 || payload.agent.weight > 10) {
        errors.push("agent.weight must be between 1 and 10");
      }
      break;
    }
    case "agent-remove": {
      if (!payload.agentId) errors.push("agentId is required");
      break;
    }
    case "config-update": {
      if (!payload.changes || Object.keys(payload.changes).length === 0) {
        errors.push("At least one config change is required");
      }
      const validConfigFields = [
        "quorumPercent",
        "approvalThreshold",
        "defaultModel",
        "maxConcurrent",
        "riskThreshold",
        "healthWeights",
      ];
      for (const key of Object.keys(payload.changes)) {
        if (!validConfigFields.includes(key)) errors.push(`Unknown config field: ${key}`);
      }
      if (
        payload.changes.quorumPercent !== undefined &&
        (payload.changes.quorumPercent < 1 || payload.changes.quorumPercent > 100)
      ) {
        errors.push("quorumPercent must be 1-100");
      }
      break;
    }
    case "quorum-update": {
      if (!payload.typeQuorum || Object.keys(payload.typeQuorum).length === 0) {
        errors.push("At least one type quorum change is required");
      }
      break;
    }
    case "gate-update": {
      if (
        (!payload.addGates || payload.addGates.length === 0) &&
        (!payload.removeGates || payload.removeGates.length === 0)
      ) {
        errors.push("At least one gate to add or remove is required");
      }
      break;
    }
    case "council-update": {
      if (!payload.agentId) errors.push("agentId is required");
      if (!payload.councils || payload.councils.length === 0) {
        errors.push("At least one council membership is required");
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export function previewAmendment(payload: AmendmentPayload): AmendmentPreviewDiff[] {
  const state = getState();
  const diffs: AmendmentPreviewDiff[] = [];

  switch (payload.type) {
    case "agent-update": {
      const agent = state.agents.find((a) => a.id === payload.agentId);
      if (!agent) {
        diffs.push({ field: "agent", before: "(not found)", after: payload.agentId });
        return diffs;
      }
      for (const [key, value] of Object.entries(payload.changes)) {
        diffs.push({
          field: `${agent.id}.${key}`,
          // biome-ignore lint/suspicious/noExplicitAny: dynamic property access for diff comparison
          before: String((agent as any)[key] ?? "(not set)"),
          after: String(value),
        });
      }
      break;
    }
    case "agent-add": {
      diffs.push({
        field: `agents.${payload.agent.id}`,
        before: "(none)",
        after: `${payload.agent.name} (w=${payload.agent.weight})`,
      });
      break;
    }
    case "agent-remove": {
      const agent = state.agents.find((a) => a.id === payload.agentId);
      diffs.push({
        field: `agents.${payload.agentId}`,
        before: agent ? `${agent.name} (w=${agent.weight})` : "(not found)",
        after: "(removed)",
      });
      break;
    }
    case "config-update": {
      for (const [key, value] of Object.entries(payload.changes)) {
        diffs.push({
          field: `config.${key}`,
          // biome-ignore lint/suspicious/noExplicitAny: dynamic property access for diff comparison
          before: String((state.config as any)[key] ?? "(not set)"),
          after: String(value),
        });
      }
      break;
    }
    case "quorum-update": {
      for (const [type, quorum] of Object.entries(payload.typeQuorum)) {
        const before = state.config.typeQuorum[type as keyof typeof state.config.typeQuorum];
        diffs.push({
          field: `typeQuorum.${type}`,
          before: before ? `${before.quorumPercent}% / ${before.approvalPercent}%` : "(default)",
          after: quorum
            ? `${quorum.quorumPercent ?? before?.quorumPercent}% / ${quorum.approvalPercent ?? before?.approvalPercent}%`
            : "(no change)",
        });
      }
      break;
    }
    case "gate-update": {
      if (payload.addGates) {
        for (const gate of payload.addGates) {
          diffs.push({ field: `gates.${gate}`, before: "(none)", after: "added" });
        }
      }
      if (payload.removeGates) {
        for (const gate of payload.removeGates) {
          diffs.push({ field: `gates.${gate}`, before: "present", after: "removed" });
        }
      }
      break;
    }
    case "council-update": {
      const agent = state.agents.find((a) => a.id === payload.agentId);
      const before = agent?.councils?.map((c) => `${c.council}(${c.role})`).join(", ") ?? "(none)";
      const after = payload.councils.map((c) => `${c.council}(${c.role})`).join(", ");
      diffs.push({ field: `${payload.agentId}.councils`, before, after });
      break;
    }
  }

  return diffs;
}

export function executeAmendment(payload: AmendmentPayload): AmendmentExecutionResult {
  const state = getState();

  // Capture snapshot before changes
  const snapshot: AmendmentSnapshot = {
    agents: state.agents.map((a) => ({ ...a })),
    config: { ...state.config, typeQuorum: { ...state.config.typeQuorum } },
    capturedAt: new Date().toISOString(),
  };

  try {
    switch (payload.type) {
      case "agent-update": {
        const agent = state.agents.find((a) => a.id === payload.agentId);
        if (!agent) return { success: false, error: `Agent ${payload.agentId} not found` };
        Object.assign(agent, payload.changes);
        break;
      }
      case "agent-add": {
        state.agents.push({ ...payload.agent, systemPrompt: payload.agent.systemPrompt || "You are a DAO agent." });
        break;
      }
      case "agent-remove": {
        const idx = state.agents.findIndex((a) => a.id === payload.agentId);
        if (idx === -1) return { success: false, error: `Agent ${payload.agentId} not found` };
        state.agents.splice(idx, 1);
        break;
      }
      case "config-update": {
        Object.assign(state.config, payload.changes);
        break;
      }
      case "quorum-update": {
        for (const [type, quorum] of Object.entries(payload.typeQuorum)) {
          state.config.typeQuorum[type as keyof typeof state.config.typeQuorum] = {
            ...state.config.typeQuorum[type as keyof typeof state.config.typeQuorum],
            ...quorum,
            // biome-ignore lint/suspicious/noExplicitAny: partial spread of quorum settings
          } as any;
        }
        break;
      }
      case "gate-update": {
        if (payload.addGates) {
          state.config.requiredGates = [...new Set([...state.config.requiredGates, ...payload.addGates])];
        }
        if (payload.removeGates) {
          state.config.requiredGates = state.config.requiredGates.filter((g) => !payload.removeGates?.includes(g));
        }
        break;
      }
      case "council-update": {
        const agent = state.agents.find((a) => a.id === payload.agentId);
        if (!agent) return { success: false, error: `Agent ${payload.agentId} not found` };
        agent.councils = payload.councils;
        break;
      }
    }

    return { success: true, snapshot };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, snapshot };
  }
}

export function rollbackAmendment(snapshot: AmendmentSnapshot): void {
  const state = getState();
  state.agents = snapshot.agents;
  state.config = snapshot.config;
}
