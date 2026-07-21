import { describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateImprovementContract } from "../contract.js";

const root = process.cwd();

const stageRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "improvement-contract-"));
  const modelsDir = join(dir, "models");
  await mkdir(modelsDir, { recursive: true });
  await copyFile(join(root, "models/improvement-loop.md"), join(modelsDir, "improvement-loop.md"));
  await copyFile(
    join(root, "models/improvement-loop.graph.schema.json"),
    join(modelsDir, "improvement-loop.graph.schema.json"),
  );
  return dir;
};

const writeGraph = async (dir: string, graph: unknown): Promise<void> => {
  await writeFile(join(dir, "models/improvement-loop.graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
};

const baseGraph = async (): Promise<Record<string, unknown>> => {
  const raw = await readFile(join(root, "models/improvement-loop.graph.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
};

describe("improvement contract validation", () => {
  it("accepts the frozen graph as committed", async () => {
    const dir = await stageRoot();
    try {
      const graph = await baseGraph();
      await writeGraph(dir, graph);
      const result = await validateImprovementContract(dir);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate edge", async () => {
    const dir = await stageRoot();
    try {
      const graph = await baseGraph();
      const edges = Array.isArray(graph.edges) ? [...graph.edges] : [];
      const first = edges[0];
      if (first) edges.push(first);
      graph.edges = edges;
      await writeGraph(dir, graph);
      const result = await validateImprovementContract(dir);
      expect(result.valid).toBe(false);
      expect(result.issues.join("\n")).toMatch(/duplicate edge/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an extra edge that is not in the frozen set", async () => {
    const dir = await stageRoot();
    try {
      const graph = await baseGraph();
      const edges = Array.isArray(graph.edges) ? [...graph.edges] : [];
      edges.push({ from: "sensor", type: "vetoes", to: "state-machine" });
      graph.edges = edges;
      await writeGraph(dir, graph);
      const result = await validateImprovementContract(dir);
      expect(result.valid).toBe(false);
      expect(result.issues.join("\n")).toMatch(/unexpected edge/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
