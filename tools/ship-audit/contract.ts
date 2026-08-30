// Ship-audit model contract: validates models/ship-audit.graph.json against
// the frozen expectations and computes the exact model hash submitted for
// human approval (run ship-audit-1, hash 482756e9…58ad3).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ShipAuditContractResult = Readonly<{
  valid: boolean;
  issues: readonly string[];
  modelHash: string;
}>;

const MODEL_PATHS = ["models/ship-audit.md", "models/ship-audit.graph.json"] as const;

const EXPECTED_COMMANDS: Readonly<Record<string, string>> = {
  "audit-model-contract": "bun run shipaudit:validate",
  "audit-graph-tests": "bun test packages/core/tests/ship-audit.machine.test.ts tools/ship-audit/tests",
  "audit-wiring-contract": "bun test packages/core/tests/ship-audit.wiring.test.ts",
  "audit-regression": "bun run shipaudit:regression",
  "audit-runtime-scenario": "bun run shipaudit:demo",
};

const REQUIRED_EDGES = [
  "ship-handler:feeds:fingerprint-sealer",
  "fingerprint-sealer:validates:state-machine",
  "ship-handler:requests:state-machine",
  "state-machine:authorizes:ship-handler",
  "state-machine:authorizes:audit-recorder",
  "audit-recorder:validates:state-machine",
  "human-owner:owns_target:state-machine",
  "human-owner:force_overrides:state-machine",
] as const;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const computeShipAuditModelHash = async (rootDirectory: string): Promise<string> => {
  let manifest = "";
  for (const relativePath of MODEL_PATHS) {
    const content = await readFile(resolve(rootDirectory, relativePath));
    manifest += `${sha256(content)}  ${relativePath}\n`;
  }
  return sha256(manifest);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateShipAuditContract = async (rootDirectory: string): Promise<ShipAuditContractResult> => {
  const issues: string[] = [];
  const modelHash = await computeShipAuditModelHash(rootDirectory);

  let graph: unknown;
  try {
    graph = JSON.parse(await readFile(resolve(rootDirectory, "models/ship-audit.graph.json"), "utf8"));
  } catch {
    return { valid: false, issues: ["models/ship-audit.graph.json is missing or unreadable"], modelHash };
  }
  if (!isRecord(graph)) return { valid: false, issues: ["graph contract is not an object"], modelHash };

  if (graph.id !== "swarm-dao-ship-audit") issues.push("id must be swarm-dao-ship-audit");
  if (graph.proposalStateAuthority !== "none") issues.push("proposalStateAuthority must be 'none'");
  if (graph.evidenceRoot !== ".dao/ship-audits") issues.push("evidenceRoot must be .dao/ship-audits");
  if (graph.maxRetries !== 0) issues.push("maxRetries must be 0 (the challenge never auto-retries)");

  // No AI node may exist anywhere (INV-3).
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (isRecord(node) && (node.kind === "ai_worker" || node.authority === "signal_only")) {
      issues.push(`node ${String(node.id)} is an AI worker — the audit challenge has no AI role`);
    }
  }

  const edges = new Set<string>(
    (Array.isArray(graph.edges) ? graph.edges : [])
      .filter(isRecord)
      .map((edge) => `${String(edge.from)}:${String(edge.type)}:${String(edge.to)}`),
  );
  for (const required of REQUIRED_EDGES) {
    if (!edges.has(required)) issues.push(`missing edge ${required}`);
  }

  const commands = isRecord(graph.anchorCommands) ? graph.anchorCommands : {};
  const expectedKeys = Object.keys(EXPECTED_COMMANDS).sort();
  const actualKeys = Object.keys(commands).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    issues.push("anchorCommands keys must match the frozen anchor set");
  }
  for (const [anchor, command] of Object.entries(EXPECTED_COMMANDS)) {
    if (commands[anchor] !== command) issues.push(`anchorCommands['${anchor}'] must be exactly '${command}'`);
  }

  return { valid: issues.length === 0, issues, modelHash };
};
