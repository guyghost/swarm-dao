import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

const SOURCE_ROOT = path.resolve(import.meta.dir, "../src");
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(target) : Promise.resolve(entry.name.endsWith(".ts") ? [target] : []);
    }),
  );
  return nested.flat();
}

describe("hexagonal architecture contracts", () => {
  it("keeps behavioral models free of I/O, ambient time, and async orchestration", async () => {
    const files = await sourceFiles(path.join(SOURCE_ROOT, "models"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      expect(source).not.toMatch(/from ["']node:/);
      expect(source).not.toContain("Date.now(");
      expect(source).not.toContain("new Date(");
      expect(source).not.toMatch(/\basync\b/);
    }
  });

  it("keeps domain code independent from application, adapters, and presenters", async () => {
    const files = await sourceFiles(path.join(SOURCE_ROOT, "domain"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      expect(source).not.toMatch(/from ["'][^"']*(application|adapters|presenters|host-tools)/);
    }
  });

  it("keeps application use cases dependent on ports rather than infrastructure", async () => {
    const files = await sourceFiles(path.join(SOURCE_ROOT, "application"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      expect(source).not.toMatch(/from ["'][^"']*(adapters|host-tools|persistence|presenters)/);
      expect(source).not.toMatch(/from ["']node:/);
    }
  });

  it("routes host lifecycle commands through shared application handlers", async () => {
    const adapterPaths = [
      path.join(REPOSITORY_ROOT, "packages/pi-adapter/src/index.ts"),
      path.join(REPOSITORY_ROOT, "packages/opencode-adapter/src/index.ts"),
    ];
    for (const adapterPath of adapterPaths) {
      const source = await fs.readFile(adapterPath, "utf8");
      expect(source).not.toMatch(/\bdispatchProposalEvent\s*\(/);
      expect(source).not.toMatch(/\brunGates\s*\(/);
      expect(source).not.toMatch(/\bexecuteProposal\s*\(/);
      expect(source).not.toMatch(/\bperformDryRun\s*\(/);
      expect(source).not.toMatch(/\bperformRollback\s*\(/);
      expect(source).not.toMatch(/\brunRoundTable\s*\(/);
      expect(source).not.toMatch(/\bcreateProposalsBatch\s*\(/);
      expect(source).not.toContain("new LegacyDaoStateRepository");
      expect(source).toContain("FileDaoStateRepository.open");
      expect(source).toContain("handleDaoSetup");
      expect(source).toContain("handleDaoPropose");
      expect(source).toContain("handleDaoDeliberate");
      expect(source).toContain("handleDaoControl");
      expect(source).toContain("handleDaoExecute");
      expect(source).toContain("handleDaoDryRun");
      expect(source).toContain("handleDaoRollback");
      expect(source).toContain("handleDaoRoundtable");
    }
  });
});
