import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS,
  PRODUCT_VOTE_EXPIRY_HOURS,
  REQUIRED_PRODUCT_ANCHORS,
} from "../../packages/core/src/models/product-loop.machine.js";

export type ProductContractResult = Readonly<{
  valid: boolean;
  issues: readonly string[];
  modelHash: string;
}>;

type JsonRecord = Record<string, unknown>;

const MODEL_PATHS = ["models/product-loop.md", "models/product-loop.graph.json"] as const;

const EXPECTED_COMMANDS: Readonly<Record<string, string>> = {
  "qualification-passed": "bun run product:validate",
  "vote-quorum": "bun test packages/core/tests/product-loop.regression.test.ts",
  "budget-envelope": "bun test packages/core/tests/product-loop.regression.test.ts",
  "controls-passed": "bun test packages/core/tests/product-loop.machine.test.ts",
  "auto-ship-policy": "bun test packages/core/tests/product-loop.regression.test.ts",
  "observation-window": "bun test packages/core/tests/product-loop.regression.test.ts",
  "rollback-path-exists": "bun run product:anchors",
  "frozen-set-intact": "bun test packages/core/tests/product-loop.frozen.test.ts",
  regression: "bun run product:regression",
};

// The exact set of producer->state-machine authority edges. Adding a new
// authority path (e.g. an AI node that owns the target) requires a human model
// review that updates this frozen set.
const REQUIRED_EDGES = [
  "explorer:feeds:state-machine",
  "feedback-aggregator:feeds:state-machine",
  "proposer:feeds:state-machine",
  "state-machine:authorizes:proposition-gate",
  "proposition-gate:validates:state-machine",
  "state-machine:authorizes:qualifier",
  "qualifier:validates:state-machine",
  "qualifier:vetoes:state-machine",
  "state-machine:authorizes:vote-tally",
  "vote-tally:validates:state-machine",
  "vote-tally:vetoes:state-machine",
  "state-machine:authorizes:budget-ledger",
  "budget-ledger:validates:state-machine",
  "budget-ledger:vetoes:state-machine",
  "state-machine:authorizes:verifier",
  "verifier:validates:state-machine",
  "verifier:vetoes:state-machine",
  "state-machine:authorizes:observation-gate",
  "observation-gate:validates:state-machine",
  "observation-gate:vetoes:state-machine",
  "rollback-opener:validates:state-machine",
  "contact-relay:validates:state-machine",
  "human-owner:owns_target:state-machine",
] as const;

const EXPECTED_NODE_IDS = [
  "explorer",
  "feedback-aggregator",
  "proposer",
  "proposition-gate",
  "qualifier",
  "vote-tally",
  "budget-ledger",
  "verifier",
  "observation-gate",
  "rollback-opener",
  "contact-relay",
] as const;

const EXPECTED_OWNER_AUTHORITY = [
  "owns_target",
  "resolves_review",
  "expands_budget",
  "reduces_scope",
  "abandons_task",
  "authorizes_verification_retry",
  "authorizes_contact_relay",
  "cancels",
];

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const sameOrderedStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

// Resolve the repo root robustly: when this module is imported from a test run
// inside packages/core/, process.cwd() is not the repo root. Walk up until we
// find the frozen model graph.
const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

const resolveRepoRoot = async (start: string): Promise<string> => {
  let current = resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    if (await exists(resolve(current, "models/product-loop.graph.json"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
};

export const computeProductModelHash = async (rootDirectory: string): Promise<string> => {
  const root = await resolveRepoRoot(rootDirectory);
  let manifest = "";
  for (const relativePath of MODEL_PATHS) {
    const content = await readFile(resolve(root, relativePath));
    manifest += `${sha256(content)}  ${relativePath}\n`;
  }
  return sha256(manifest);
};

export const validateProductContract = async (rootDirectory: string): Promise<ProductContractResult> => {
  const issues: string[] = [];
  const root = await resolveRepoRoot(rootDirectory);
  const modelHash = await computeProductModelHash(root);
  const graph = JSON.parse(await readFile(resolve(root, "models/product-loop.graph.json"), "utf8"));
  const schema = JSON.parse(await readFile(resolve(root, "models/product-loop.graph.schema.json"), "utf8"));

  if (!isRecord(graph)) return { valid: false, issues: ["graph must be an object"], modelHash };
  if (!isRecord(schema)) return { valid: false, issues: ["graph schema must be an object"], modelHash };

  if (graph.id !== "swarm-dao-product-loop") issues.push("graph id changed");
  if (graph.version !== 1) issues.push("graph version must be 1");
  if (graph.scope !== "continuous-product-loop") issues.push("graph scope changed");
  if (graph.proposalStateAuthority !== "none") issues.push("product loop acquired proposal/graph state authority");
  if (graph.evidenceRoot !== "evidence/product-loops") issues.push("evidence root changed");

  if (JSON.stringify(graph.voteExpiryHours) !== JSON.stringify(PRODUCT_VOTE_EXPIRY_HOURS)) {
    issues.push("vote expiry drifted from the XState model");
  }
  if (graph.observationConsecutiveMeasurements !== PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS) {
    issues.push("observation threshold drifted from the XState model");
  }

  const anchors = strings(graph.requiredAnchors);
  if (!sameOrderedStrings(anchors, REQUIRED_PRODUCT_ANCHORS)) {
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
  const ALLOWED_NODE_KINDS = new Set(["ai_worker", "deterministic"]);
  for (const node of nodes) {
    if (!ALLOWED_NODE_KINDS.has(String(node.kind))) {
      issues.push(`node ${String(node.id)} has an unexpected kind ${String(node.kind)}`);
    }
    if (node.kind === "ai_worker" && node.authority !== "signal_only") {
      issues.push(`AI node ${String(node.id)} has state authority`);
    }
    if (node.kind === "deterministic" && node.authority !== "anchor") {
      issues.push(`deterministic node ${String(node.id)} must be anchor authority`);
    }
  }

  // The product loop is human-owned. Owner kind, id, and authority set are
  // authority-critical invariants the JSON-schema check does not cover, so
  // enforce them explicitly: weakening owner.kind to "ai" would let an AI node
  // resolve reviews, expand budgets, or authorize contact relay.
  const owner = isRecord(graph.owner) ? graph.owner : {};
  if (owner.id !== "human-owner") issues.push("owner id must be human-owner");
  if (owner.kind !== "human") issues.push("owner kind must be human");
  if (!sameOrderedStrings(strings(owner.authority), EXPECTED_OWNER_AUTHORITY)) {
    issues.push("owner authority set drifted from the frozen model");
  }

  const endpoints = new Set([...nodeIds, "state-machine", String(owner.id)]);
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isRecord) : [];
  const edgeKeys = edges.map((edge) => `${String(edge.from)}:${String(edge.type)}:${String(edge.to)}`);
  for (const edge of edges) {
    if (!endpoints.has(String(edge.from)) || !endpoints.has(String(edge.to))) {
      issues.push(`edge ${String(edge.from)} -> ${String(edge.to)} is orphaned`);
    }
  }
  // Edges encode authority relationships, so the graph must be exactly the
  // frozen set: no missing edges, no duplicates, no extras that could
  // introduce new authority paths.
  const requiredEdgeSet = new Set<string>(REQUIRED_EDGES);
  const seenEdges = new Set<string>();
  for (const edgeKey of edgeKeys) {
    if (seenEdges.has(edgeKey)) {
      issues.push(`duplicate edge ${edgeKey}`);
    } else {
      seenEdges.add(edgeKey);
    }
    if (!requiredEdgeSet.has(edgeKey)) {
      issues.push(`unexpected edge ${edgeKey}`);
    }
  }
  for (const requiredEdge of REQUIRED_EDGES) {
    if (!edgeKeys.includes(requiredEdge)) issues.push(`missing edge ${requiredEdge}`);
  }

  const schemaProperties = isRecord(schema.properties) ? schema.properties : {};
  const schemaId = isRecord(schemaProperties.id) ? schemaProperties.id.const : undefined;
  const schemaAnchors = isRecord(schemaProperties.requiredAnchors)
    ? strings(schemaProperties.requiredAnchors.const)
    : [];
  if (schemaId !== graph.id) issues.push("schema id drifted from graph");
  if (!sameOrderedStrings(schemaAnchors, REQUIRED_PRODUCT_ANCHORS)) {
    issues.push("schema anchors drifted from the XState model");
  }

  return { valid: issues.length === 0, issues, modelHash };
};
