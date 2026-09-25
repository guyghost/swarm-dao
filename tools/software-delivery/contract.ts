import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SOFTWARE_DELIVERY_EVENTS,
  SOFTWARE_DELIVERY_STATES,
} from "../../packages/core/src/models/software-delivery.machine.js";
import { DELIVERY_EVENT_PRODUCERS } from "../../packages/software-delivery/src/signal.js";

export type DeliveryContractResult = Readonly<{
  valid: boolean;
  issues: readonly string[];
  modelHash: string;
}>;

type JsonRecord = Record<string, unknown>;

export const APPROVED_DELIVERY_MODEL_HASH = "ddfa68a40b41be3b5030fb6951d3604e27c5dbe43b46124d0fd5885a9ae31e8b";
const APPROVED_DELIVERY_SCHEMA_HASH = "fb78d7e2e0ec9eee8c16cf1c94d15622102c4de0ea2684e5e3bab5359ff380bd";

const MODEL_PATHS = ["models/software-delivery.md", "models/software-delivery.graph.json"] as const;
const REQUIRED_ANCHORS = [
  "delivery-model-contract",
  "delivery-machine-tests",
  "delivery-architecture-contract",
  "rollback-path-exists",
  "delivery-runtime-scenario",
  "delivery-regression",
  "repository-ci",
] as const;
const EXPECTED_COMMANDS: Readonly<Record<string, string>> = {
  "delivery-model-contract": "bun run software-delivery:validate",
  "delivery-machine-tests":
    "bun test packages/core/tests/software-delivery.machine.test.ts packages/core/tests/software-delivery.regression.test.ts",
  "delivery-architecture-contract":
    "bun test packages/core/tests/architecture.contract.test.ts packages/core/tests/application.architecture.test.ts",
  "rollback-path-exists": "bun run software-delivery:anchors",
  "delivery-runtime-scenario": "bun run software-delivery:demo",
  "delivery-regression": "bun run software-delivery:regression",
  "repository-ci": "bun run ci",
};
const EXPECTED_NODES = [
  { id: "modeler", kind: "ai_worker", authority: "signal_only", emits: ["GRAPH_MODEL_DRAFTED"] },
  { id: "intake-validator", kind: "deterministic", authority: "anchor", emits: ["INTAKE_ACCEPTED", "INTAKE_REJECTED"] },
  {
    id: "model-contract-validator",
    kind: "deterministic",
    authority: "anchor",
    emits: ["MODEL_CONTRACT_VALID", "MODEL_CONTRACT_INVALID"],
  },
  {
    id: "graph-child-adapter",
    kind: "deterministic",
    authority: "anchor",
    emits: [
      "GRAPH_APPROVAL_CONFIRMED",
      "GRAPH_APPROVAL_REJECTED",
      "GRAPH_IMPLEMENTATION_STARTED",
      "GRAPH_IMPLEMENTATION_SUCCEEDED",
      "CHILD_FAILED",
      "CHILD_BLOCKED",
      "CHILD_CANCELLED",
    ],
  },
  {
    id: "product-child-adapter",
    kind: "deterministic",
    authority: "anchor",
    emits: [
      "PRODUCT_REVIEW_REQUIRED",
      "PRODUCT_REVIEW_BLOCKED",
      "PRODUCT_SHIP_READY",
      "PRODUCT_SHIP_AUTHORIZED",
      "OBSERVATION_VALIDATED",
      "ROLLBACK_REQUIRED",
      "CORRECTIVE_TASK_OPENED",
      "CHILD_FAILED",
      "CHILD_BLOCKED",
      "CHILD_CANCELLED",
    ],
  },
  { id: "effect-executor", kind: "deterministic", authority: "effect", emits: ["SHIP_CONFIRMED", "CANCEL_SETTLED"] },
  {
    id: "staging-target",
    kind: "deterministic",
    authority: "anchor",
    emits: ["SHIP_CAPABILITY_MISSING", "SHIP_CAPABILITY_CONFIRMED", "ROLLBACK_CONFIRMED"],
  },
  { id: "observer", kind: "deterministic", authority: "anchor", emits: ["OBSERVATION_SAMPLE_RECORDED"] },
] as const;
const EXPECTED_EDGES = [
  "modeler:feeds:model-contract-validator",
  "intake-validator:validates:state-machine",
  "model-contract-validator:validates:state-machine",
  "human-owner:owns_target:state-machine",
  "state-machine:authorizes:effect-executor",
  "effect-executor:authorizes:graph-child-adapter",
  "effect-executor:authorizes:product-child-adapter",
  "effect-executor:authorizes:staging-target",
  "graph-child-adapter:validates:state-machine",
  "product-child-adapter:validates:state-machine",
  "staging-target:validates:state-machine",
  "observer:validates:state-machine",
  "effect-executor:feeds:observer",
] as const;
const EXPECTED_OWNER = {
  id: "human-owner",
  kind: "human",
  authority: ["owns_target", "resolves_risk_classification", "cancels"],
};
const EXPECTED_EXTERNAL_GATES = [
  {
    system: "graph-engineering",
    humanEvent: "MODEL_APPROVED",
    requiredHash: "delivery-model-hash",
    requiredState: "ready",
  },
  {
    system: "product-loop",
    humanEvent: "REVIEW_RESOLVED",
    requiredCondition: "sensitive-deploy-authorized",
    requiredState: "ship",
  },
];

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const sameOrderedStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const computeDeliveryModelHash = async (rootDirectory: string): Promise<string> => {
  let manifest = "";
  for (const relativePath of MODEL_PATHS) {
    const content = await readFile(resolve(rootDirectory, relativePath));
    manifest += `${sha256(content)}  ${relativePath}\n`;
  }
  return sha256(manifest);
};

const parseJsonFile = async (path: string, label: string, issues: string[]): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    issues.push(`${label} is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

export const validateDeliveryContract = async (rootDirectory: string): Promise<DeliveryContractResult> => {
  const issues: string[] = [];
  let modelHash = "";
  try {
    modelHash = await computeDeliveryModelHash(rootDirectory);
  } catch (error) {
    issues.push(`approved model manifest is incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (modelHash !== APPROVED_DELIVERY_MODEL_HASH)
    issues.push("model hash does not match the owner's approved exact hash");

  const graph = await parseJsonFile(
    resolve(rootDirectory, "models/software-delivery.graph.json"),
    "delivery graph",
    issues,
  );
  const schemaPath = resolve(rootDirectory, "models/software-delivery.graph.schema.json");
  const schema = await parseJsonFile(schemaPath, "delivery graph schema", issues);
  try {
    if (sha256(await readFile(schemaPath)) !== APPROVED_DELIVERY_SCHEMA_HASH) {
      issues.push("delivery schema content differs from its frozen digest");
    }
  } catch (error) {
    issues.push(`delivery schema digest is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(graph)) return { valid: false, issues, modelHash };
  if (!isRecord(schema)) return { valid: false, issues, modelHash };

  if (graph.$schema !== "./software-delivery.graph.schema.json") issues.push("graph schema reference changed");
  if (graph.id !== "swarm-dao-software-delivery") issues.push("graph id changed");
  if (graph.version !== 1) issues.push("graph version must be 1");
  if (graph.scope !== "repository-native-software-delivery") issues.push("graph scope changed");
  if (graph.proposalStateAuthority !== "none") issues.push("delivery graph acquired proposal state authority");
  if (graph.evidenceRoot !== "evidence/software-deliveries") issues.push("evidence root changed");
  if (!sameJson(graph.owner, EXPECTED_OWNER)) issues.push("owner identity or authority changed");
  if (!sameJson(graph.externalGates, EXPECTED_EXTERNAL_GATES)) issues.push("external human gates changed");

  if (!sameOrderedStrings(strings(graph.states), SOFTWARE_DELIVERY_STATES)) {
    issues.push("state set or order drifted from the XState model");
  }
  if (!sameOrderedStrings(strings(graph.events), SOFTWARE_DELIVERY_EVENTS)) {
    issues.push("event set or order drifted from the XState model");
  }
  if (!sameOrderedStrings(strings(graph.requiredAnchors), REQUIRED_ANCHORS)) {
    issues.push("required anchor set or order changed");
  }
  if (!sameJson(graph.anchorCommands, EXPECTED_COMMANDS)) issues.push("frozen anchor commands changed");

  if (!sameJson(graph.nodes, EXPECTED_NODES)) issues.push("node roles, emissions, or order changed");

  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isRecord) : [];
  const edgeKeys = edges.map((edge) => `${String(edge.from)}:${String(edge.type)}:${String(edge.to)}`);
  if (!sameOrderedStrings(edgeKeys, EXPECTED_EDGES)) issues.push("authority edge set or order changed");
  if (new Set(edgeKeys).size !== edgeKeys.length) issues.push("authority edges must be unique");

  const expectedProducerRows = Object.entries(DELIVERY_EVENT_PRODUCERS).map(([event, authority]) => ({
    event,
    source: authority.source,
    producers: [...authority.producers],
  }));
  if (!sameJson(graph.eventProducers, expectedProducerRows))
    issues.push("event source/producer table drifted from the signal validator");

  const schemaProperties = isRecord(schema.properties) ? schema.properties : {};
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") issues.push("schema dialect changed");
  if (schema.$id !== "software-delivery.graph.schema.json") issues.push("schema id changed");
  if (schema.type !== "object" || schema.additionalProperties !== false)
    issues.push("schema must define a closed object");
  const schemaId = isRecord(schemaProperties.id) ? schemaProperties.id.const : undefined;
  const schemaVersion = isRecord(schemaProperties.version) ? schemaProperties.version.const : undefined;
  const schemaStates = isRecord(schemaProperties.states) ? strings(schemaProperties.states.const) : [];
  const schemaEvents = isRecord(schemaProperties.events) ? strings(schemaProperties.events.const) : [];
  const schemaAnchors = isRecord(schemaProperties.requiredAnchors)
    ? strings(schemaProperties.requiredAnchors.const)
    : [];
  if (schemaId !== graph.id) issues.push("schema graph id drifted from graph");
  if (schemaVersion !== 1) issues.push("schema graph version changed");
  if (!sameOrderedStrings(schemaStates, SOFTWARE_DELIVERY_STATES))
    issues.push("schema states drifted from the XState model");
  if (!sameOrderedStrings(schemaEvents, SOFTWARE_DELIVERY_EVENTS))
    issues.push("schema events drifted from the XState model");
  if (!sameOrderedStrings(schemaAnchors, REQUIRED_ANCHORS))
    issues.push("schema anchors drifted from the frozen contract");
  const schemaCommands = isRecord(schemaProperties.anchorCommands) ? schemaProperties.anchorCommands.properties : null;
  if (
    !isRecord(schemaCommands) ||
    !sameJson(
      Object.fromEntries(
        Object.keys(EXPECTED_COMMANDS).map((key) => [
          key,
          isRecord(schemaCommands[key]) ? schemaCommands[key].const : undefined,
        ]),
      ),
      EXPECTED_COMMANDS,
    )
  ) {
    issues.push("schema anchor commands drifted from the frozen contract");
  }

  return { valid: issues.length === 0, issues, modelHash };
};
