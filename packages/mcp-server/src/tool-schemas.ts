// ============================================================
// Swarm DAO MCP Server — Tool Input Schemas (single source of truth)
// ============================================================
// The schemas declared here are BOTH published through ListTools AND
// enforced on every CallTool request (issue #161): the MCP SDK exposes the
// schemas but never validates arguments, so without this layer a client or
// model could submit NaN proposal ids, unbounded rating scores, malformed
// output arrays, or AI-channel tool calls carrying human-only event types.

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  /** Number-only: require a whole value (JSON-schema "integer"). */
  integer?: boolean;
}

/** A schema node: property or nested item. Object nodes may carry
 *  required/properties for structural validation. */
export type SchemaNode = JsonSchemaProperty & {
  required?: string[];
  properties?: Record<string, SchemaNode>;
};

export interface ToolJsonSchema {
  type: "object";
  required?: string[];
  properties?: Record<string, SchemaNode>;
}

const PROPOSAL_ID: JsonSchemaProperty = { type: "number", integer: true, description: "Proposal id" };
const EVIDENCE_ROOT: JsonSchemaProperty = {
  type: "string",
  description: "Evidence root (defaults to a .dao path under the workspace)",
};

export function createToolInputSchemas(inputs: {
  proposalTypes: readonly string[];
  graphAiEvents: readonly string[];
  productAiEvents: readonly string[];
  attentionSources: readonly string[];
}): Record<string, ToolJsonSchema> {
  const { proposalTypes, graphAiEvents, productAiEvents, attentionSources } = inputs;
  return {
    dao_help: { type: "object" },
    dao_setup: { type: "object", properties: { useDefaults: { type: "boolean" } } },
    dao_propose: {
      type: "object",
      required: ["title", "type", "description"],
      properties: {
        title: { type: "string" },
        type: { type: "string", enum: proposalTypes },
        description: { type: "string" },
        context: { type: "string" },
        problemStatement: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        successMetrics: { type: "array", items: { type: "string" } },
        rollbackConditions: { type: "array", items: { type: "string" } },
        affectedPaths: { type: "array", items: { type: "string" } },
      },
    },
    dao_deliberate: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_record_outputs: {
      type: "object",
      required: ["proposalId", "outputs"],
      properties: {
        proposalId: PROPOSAL_ID,
        outputs: {
          type: "array",
          items: {
            type: "object",
            required: ["agentId", "content"],
            properties: {
              agentId: { type: "string" },
              content: { type: "string" },
              durationMs: { type: "number" },
              error: { type: "string" },
            },
          },
        },
      },
    },
    dao_control: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_execute: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_ship: {
      type: "object",
      required: ["proposalId"],
      properties: { proposalId: PROPOSAL_ID, cascade: { type: "boolean" }, force: { type: "boolean" } },
    },
    dao_list: { type: "object" },
    dao_agents: { type: "object" },
    dao_plan: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_artefacts: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_dry_run: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_rollback: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_reject: {
      type: "object",
      required: ["proposalId", "reason"],
      properties: { proposalId: PROPOSAL_ID, reason: { type: "string" } },
    },
    dao_dashboard: { type: "object" },
    dao_roundtable: { type: "object" },
    dao_audit: { type: "object", properties: { proposalId: PROPOSAL_ID } },
    dao_rate: {
      type: "object",
      required: ["proposalId", "score", "comment"],
      properties: {
        proposalId: PROPOSAL_ID,
        score: { type: "number", minimum: 1, maximum: 5 },
        comment: { type: "string" },
      },
    },
    dao_update_proposal: {
      type: "object",
      required: ["proposalId"],
      properties: {
        proposalId: PROPOSAL_ID,
        problemStatement: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        successMetrics: { type: "array", items: { type: "string" } },
        rollbackConditions: { type: "array", items: { type: "string" } },
      },
    },
    dao_propose_amendment: {
      type: "object",
      required: ["title", "description", "amendmentType"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        amendmentType: {
          type: "string",
          enum: ["agent-update", "agent-add", "agent-remove", "config-update", "quorum-update", "gate-update"],
        },
        agentId: { type: "string" },
        agentChanges: { type: "string" },
        newAgentId: { type: "string" },
        newAgentName: { type: "string" },
        newAgentRole: { type: "string" },
        newAgentWeight: { type: "number" },
        configChanges: { type: "string" },
        quorumChanges: { type: "string" },
        addGates: { type: "array", items: { type: "string" } },
        removeGates: { type: "array", items: { type: "string" } },
      },
    },
    dao_check_edit: {
      type: "object",
      required: ["paths"],
      properties: { paths: { type: "array", items: { type: "string" } } },
    },
    dao_config_github: {
      type: "object",
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issues: { type: "boolean", description: "Track proposal modifications as GitHub issues" },
      },
    },
    dao_github_create_branch: { type: "object", required: ["proposalId"], properties: { proposalId: PROPOSAL_ID } },
    dao_github_open_pr: {
      type: "object",
      required: ["proposalId", "headBranch"],
      properties: { proposalId: PROPOSAL_ID, headBranch: { type: "string" } },
    },
    dao_attention: {
      type: "object",
      properties: { sources: { type: "array", items: { type: "string", enum: attentionSources } } },
    },
    dao_improve_status: {
      type: "object",
      required: ["seriesId"],
      properties: { seriesId: { type: "string" }, evidenceRoot: EVIDENCE_ROOT },
    },
    dao_improve_once: {
      type: "object",
      required: ["seriesId"],
      properties: { seriesId: { type: "string" }, evidenceRoot: EVIDENCE_ROOT, cycleRoot: EVIDENCE_ROOT },
    },
    dao_graph_status: {
      type: "object",
      required: ["runId"],
      properties: { runId: { type: "string" }, evidenceRoot: EVIDENCE_ROOT },
    },
    dao_graph_submit: {
      type: "object",
      required: ["runId", "type", "producer", "payload", "evidence"],
      properties: {
        runId: { type: "string" },
        type: { type: "string", enum: graphAiEvents },
        producer: { type: "string" },
        payload: { type: "object" },
        evidence: { type: "array", items: { type: "string" } },
        evidenceRoot: EVIDENCE_ROOT,
      },
    },
    dao_product_status: {
      type: "object",
      required: ["runId"],
      properties: { runId: { type: "string" }, evidenceRoot: EVIDENCE_ROOT },
    },
    dao_product_submit: {
      type: "object",
      required: ["runId", "type", "producer", "payload", "evidence"],
      properties: {
        runId: { type: "string" },
        type: { type: "string", enum: productAiEvents },
        producer: { type: "string" },
        payload: { type: "object" },
        evidence: { type: "array", items: { type: "string" } },
        evidenceRoot: EVIDENCE_ROOT,
      },
    },
  };
}

function validateNode(where: string, value: unknown, node: SchemaNode): string | null {
  switch (node.type) {
    case "string":
      if (typeof value !== "string") return `${where} must be a string`;
      if (node.enum && !node.enum.includes(value)) {
        return `${where} must be one of: ${node.enum.join(", ")} (got '${value.slice(0, 80)}')`;
      }
      return null;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${where} must be a finite number`;
      if (node.integer && !Number.isInteger(value)) return `${where} must be an integer`;
      if (node.minimum !== undefined && value < node.minimum) return `${where} must be >= ${node.minimum}`;
      if (node.maximum !== undefined && value > node.maximum) return `${where} must be <= ${node.maximum}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${where} must be a boolean`;
    case "array": {
      if (!Array.isArray(value)) return `${where} must be an array`;
      if (node.items) {
        for (let i = 0; i < value.length; i++) {
          const error = validateNode(`${where}[${i}]`, value[i], node.items);
          if (error) return error;
        }
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${where} must be an object`;
      }
      const record = value as Record<string, unknown>;
      for (const name of node.required ?? []) {
        if (record[name] === undefined) return `${where} is missing required property '${name}'`;
      }
      for (const [name, childNode] of Object.entries(node.properties ?? {})) {
        if (record[name] === undefined) continue;
        const error = validateNode(`${where}.${name}`, record[name], childNode);
        if (error) return error;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Validate CallTool arguments against the tool's declared schema.
 * Throws with a precise, tool-scoped message on the first violation.
 */
export function validateToolArgs(tool: string, schema: ToolJsonSchema | undefined, args: unknown): void {
  // Shape guard (review): a client sending null/array/string for `arguments`
  // must get a precise validation error, not a TypeError or a silent pass.
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error(`Invalid arguments for ${tool}: arguments must be an object`);
  }
  const record = args as Record<string, unknown>;
  if (!schema) return;
  for (const name of schema.required ?? []) {
    if (record[name] === undefined) {
      throw new Error(`Invalid arguments for ${tool}: '${name}' is required`);
    }
  }
  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    if (record[name] === undefined) continue;
    const error = validateNode(name, record[name], node);
    if (error) throw new Error(`Invalid arguments for ${tool}: ${error}`);
  }
}
