import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  IMPROVEMENT_MAX_RETRIES,
  REQUIRED_IMPROVEMENT_ANCHORS,
} from "../../packages/core/src/models/improvement-loop.machine.js";

export type ImprovementContractResult = Readonly<{
  valid: boolean;
  issues: readonly string[];
  modelHash: string;
}>;

type JsonRecord = Record<string, unknown>;

const MODEL_PATHS = ["models/improvement-loop.md", "models/improvement-loop.graph.json"] as const;
const EXPECTED_COMMANDS: Readonly<Record<string, string>> = {
  "counter-metric-paired": "bun run improvement:validate",
  "drift-audit": "bun test packages/core/tests/improvement-loop.machine.test.ts",
  "arbitration-policy": "bun test packages/core/tests/improvement-loop.arbitration.test.ts",
  "anchor-reality": "bun run improvement:anchors",
  "frozen-set-intact": "bun test packages/core/tests/improvement-loop.frozen.test.ts",
  regression: "bun run improvement:regression",
};

const REQUIRED_EDGES = [
  "sensor:feeds:sample-gate",
  "counter-sensor:feeds:sample-gate",
  "sample-gate:validates:state-machine",
  "state-machine:authorizes:drift-auditor",
  "drift-auditor:feeds:state-machine",
  "state-machine:authorizes:arbitrator",
  "arbitrator:validates:state-machine",
  "arbitrator:vetoes:state-machine",
  "state-machine:authorizes:anchor-verifier",
  "anchor-verifier:validates:state-machine",
  "anchor-verifier:vetoes:state-machine",
  "human-owner:owns_target:state-machine",
] as const;

const EXPECTED_NODE_IDS = [
  "sensor",
  "counter-sensor",
  "sample-gate",
  "drift-auditor",
  "arbitrator",
  "anchor-verifier",
] as const;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const sameOrderedStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const computeImprovementModelHash = async (rootDirectory: string): Promise<string> => {
  let manifest = "";
  for (const relativePath of MODEL_PATHS) {
    const content = await readFile(resolve(rootDirectory, relativePath));
    manifest += `${sha256(content)}  ${relativePath}\n`;
  }
  return sha256(manifest);
};

export const validateImprovementContract = async (rootDirectory: string): Promise<ImprovementContractResult> => {
  const issues: string[] = [];
  const modelHash = await computeImprovementModelHash(rootDirectory);
  const graph = JSON.parse(await readFile(resolve(rootDirectory, "models/improvement-loop.graph.json"), "utf8"));
  const schema = JSON.parse(
    await readFile(resolve(rootDirectory, "models/improvement-loop.graph.schema.json"), "utf8"),
  );

  if (!isRecord(graph)) return { valid: false, issues: ["graph must be an object"], modelHash };
  if (!isRecord(schema)) return { valid: false, issues: ["graph schema must be an object"], modelHash };

  if (graph.id !== "swarm-dao-improvement-loop") issues.push("graph id changed");
  if (graph.version !== 1) issues.push("graph version must be 1");
  if (graph.scope !== "self-improvement-cycle") issues.push("graph scope changed");
  if (graph.proposalStateAuthority !== "none") issues.push("improvement loop acquired proposal/graph state authority");
  if (graph.evidenceRoot !== "evidence/improvement-cycles") issues.push("evidence root changed");
  if (graph.maxRetries !== IMPROVEMENT_MAX_RETRIES) issues.push("retry budget drifted from the XState model");

  const anchors = strings(graph.requiredAnchors);
  if (!sameOrderedStrings(anchors, REQUIRED_IMPROVEMENT_ANCHORS)) {
    issues.push("required anchors drifted from the XState model");
  }

  const commands = isRecord(graph.anchorCommands) ? graph.anchorCommands : {};
  if (JSON.stringify(commands) !== JSON.stringify(EXPECTED_COMMANDS)) {
    issues.push("frozen anchor commands changed");
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  const nodeIds = nodes.flatMap((node) => (typeof node.id === "string" ? [node.id] : []));
  if (!sameOrderedStrings(nodeIds, EXPECTED_NODE_IDS)) issues.push("graph node set or order changed");
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
  if (schemaRetries !== IMPROVEMENT_MAX_RETRIES) issues.push("schema retry budget drifted from the XState model");
  if (!sameOrderedStrings(schemaAnchors, REQUIRED_IMPROVEMENT_ANCHORS)) {
    issues.push("schema anchors drifted from the XState model");
  }

  return { valid: issues.length === 0, issues, modelHash };
};
