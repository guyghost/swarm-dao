import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GRAPH_MAX_RETRIES, REQUIRED_GRAPH_ANCHORS } from "../../packages/core/src/models/graph-engineering.machine.js";

export type GraphContractResult = Readonly<{
  valid: boolean;
  issues: readonly string[];
  modelHash: string;
}>;

type JsonRecord = Record<string, unknown>;

const MODEL_PATHS = ["models/graph-engineering.md", "models/graph-engineering.graph.json"] as const;
const EXPECTED_COMMANDS: Readonly<Record<string, string>> = {
  "model-contract": "bun run graph:validate",
  "graph-tests": "bun test packages/core/tests/graph-engineering.machine.test.ts tools/graph-engineering/tests",
  "architecture-contract":
    "bun test packages/core/tests/architecture.contract.test.ts packages/core/tests/application.architecture.test.ts",
  "repository-ci": "bun run ci",
  "runtime-scenario": "bun run graph:demo",
  regression: "bun run graph:regression",
};

const REQUIRED_EDGES = [
  "modeler:feeds:model-contract-validator",
  "model-contract-validator:validates:state-machine",
  "human-owner:owns_target:state-machine",
  "state-machine:authorizes:implementer",
  "implementer:feeds:runtime-verifier",
  "architecture-watcher:watches:implementer",
  "regression-watcher:watches:implementer",
  "runtime-verifier:validates:state-machine",
  "architecture-watcher:vetoes:state-machine",
  "regression-watcher:vetoes:state-machine",
] as const;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const sameOrderedStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const computeGraphModelHash = async (rootDirectory: string): Promise<string> => {
  let manifest = "";
  for (const relativePath of MODEL_PATHS) {
    const content = await readFile(resolve(rootDirectory, relativePath));
    manifest += `${sha256(content)}  ${relativePath}\n`;
  }
  return sha256(manifest);
};

export const validateGraphContract = async (rootDirectory: string): Promise<GraphContractResult> => {
  const issues: string[] = [];
  const modelHash = await computeGraphModelHash(rootDirectory);
  const graph = JSON.parse(await readFile(resolve(rootDirectory, "models/graph-engineering.graph.json"), "utf8"));
  const schema = JSON.parse(
    await readFile(resolve(rootDirectory, "models/graph-engineering.graph.schema.json"), "utf8"),
  );

  if (!isRecord(graph)) return { valid: false, issues: ["graph must be an object"], modelHash };
  if (!isRecord(schema)) return { valid: false, issues: ["graph schema must be an object"], modelHash };

  if (graph.id !== "swarm-dao-graph-engineering-pilot") issues.push("graph id changed");
  if (graph.version !== 1) issues.push("graph version must be 1");
  if (graph.scope !== "repository-change-control") issues.push("graph scope changed");
  if (graph.proposalStateAuthority !== "none") issues.push("graph acquired proposal state authority");
  if (graph.evidenceRoot !== "evidence/graph-runs") issues.push("evidence root changed");
  if (graph.maxRetries !== GRAPH_MAX_RETRIES) issues.push("retry budget drifted from the XState model");

  const anchors = strings(graph.requiredAnchors);
  if (!sameOrderedStrings(anchors, REQUIRED_GRAPH_ANCHORS)) {
    issues.push("required anchors drifted from the XState model");
  }

  const commands = isRecord(graph.anchorCommands) ? graph.anchorCommands : {};
  if (JSON.stringify(commands) !== JSON.stringify(EXPECTED_COMMANDS)) {
    issues.push("frozen anchor commands changed");
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  const expectedNodeIds = [
    "modeler",
    "model-contract-validator",
    "implementer",
    "runtime-verifier",
    "architecture-watcher",
    "regression-watcher",
  ];
  const nodeIds = nodes.flatMap((node) => (typeof node.id === "string" ? [node.id] : []));
  if (!sameOrderedStrings(nodeIds, expectedNodeIds)) issues.push("graph node set or order changed");
  if (new Set(nodeIds).size !== nodeIds.length) issues.push("node ids must be unique");
  for (const node of nodes) {
    if (node.kind === "ai_worker" && node.authority !== "signal_only") {
      issues.push(`AI node ${String(node.id)} has state authority`);
    }
  }

  const owner = isRecord(graph.owner) ? graph.owner : {};
  const endpoints = new Set([...nodeIds, "state-machine", String(owner.id)]);
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isRecord) : [];
  const edgeKeys = edges.map((edge) => `${String(edge.from)}:${String(edge.type)}:${String(edge.to)}`);
  for (const edge of edges) {
    if (!endpoints.has(String(edge.from)) || !endpoints.has(String(edge.to))) {
      issues.push(`edge ${String(edge.from)} -> ${String(edge.to)} is orphaned`);
    }
  }
  for (const requiredEdge of REQUIRED_EDGES) {
    if (!edgeKeys.includes(requiredEdge)) issues.push(`missing edge ${requiredEdge}`);
  }

  const schemaProperties = isRecord(schema.properties) ? schema.properties : {};
  const schemaId = isRecord(schemaProperties.id) ? schemaProperties.id.const : undefined;
  const schemaRetries = isRecord(schemaProperties.maxRetries) ? schemaProperties.maxRetries.const : undefined;
  const schemaAnchors = isRecord(schemaProperties.requiredAnchors)
    ? strings(schemaProperties.requiredAnchors.const)
    : [];
  if (schemaId !== graph.id) issues.push("schema id drifted from graph");
  if (schemaRetries !== GRAPH_MAX_RETRIES) issues.push("schema retry budget drifted from the XState model");
  if (!sameOrderedStrings(schemaAnchors, REQUIRED_GRAPH_ANCHORS)) {
    issues.push("schema anchors drifted from the XState model");
  }

  return { valid: issues.length === 0, issues, modelHash };
};
