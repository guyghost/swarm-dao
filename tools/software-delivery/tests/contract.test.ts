import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateDeliveryContract } from "../contract.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const temporaryRoots: string[] = [];

const copyModels = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "swarm-delivery-contract-"));
  temporaryRoots.push(root);
  const models = resolve(root, "models");
  const sourceModels = resolve(repoRoot, "models");
  mkdirSync(models, { recursive: true });
  for (const file of ["software-delivery.md", "software-delivery.graph.json", "software-delivery.graph.schema.json"]) {
    cpSync(resolve(sourceModels, file), resolve(models, file));
  }
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("software delivery frozen contract", () => {
  it("validates the approved graph, schema, machine parity, and exact model hash", async () => {
    const result = await validateDeliveryContract(repoRoot);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.modelHash).toBe("ddfa68a40b41be3b5030fb6951d3604e27c5dbe43b46124d0fd5885a9ae31e8b");
  });

  it("rejects changed states and producer authority edges", async () => {
    const root = copyModels();
    const graphPath = resolve(root, "models/software-delivery.graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    graph.states[0] = "reviewed-intake";
    graph.eventProducers.find((entry: { event: string }) => entry.event === "RISK_CLASSIFICATION_RESOLVED").source =
      "tool";
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const result = await validateDeliveryContract(root);
    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/state|producer|source/);
  });

  it("rejects a model whose ordered manifest no longer matches the approved hash", async () => {
    const root = copyModels();
    const modelPath = resolve(root, "models/software-delivery.md");
    writeFileSync(modelPath, `${readFileSync(modelPath, "utf8")}\nUnapproved contract edit.\n`);

    const result = await validateDeliveryContract(root);
    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/hash|approval/i);
  });

  it("rejects malformed graph JSON and an altered schema event set", async () => {
    const malformedRoot = copyModels();
    writeFileSync(resolve(malformedRoot, "models/software-delivery.graph.json"), "{");
    await expect(validateDeliveryContract(malformedRoot)).resolves.toMatchObject({ valid: false });

    const schemaRoot = copyModels();
    const schemaPath = resolve(schemaRoot, "models/software-delivery.graph.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    schema.properties.events.const[0] = "CANCEL";
    writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
    const result = await validateDeliveryContract(schemaRoot);
    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/schema|hash|approval/i);
  });
});
