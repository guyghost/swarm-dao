import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProjectBrief } from "../src/host-tools/project-brief.js";

describe("host-tools/project-brief.ts", () => {
  it("assembles a deterministic brief from manifest, README, layout and changelog", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-brief-"));
    try {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "demo-project", description: "A demo project" }),
      );
      await fs.writeFile(path.join(root, "README.md"), "# Demo\n\nSCOUT-README-MARKER\n");
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src", "index.ts"), "export {};\n");
      await fs.writeFile(path.join(root, "CHANGELOG.md"), "## 1.0.0\n\nSCOUT-CHANGELOG-MARKER\n");

      const brief = await buildProjectBrief(root);

      expect(brief.startsWith("## Project Brief")).toBe(true);
      expect(brief).toContain("demo-project");
      expect(brief).toContain("A demo project");
      expect(brief).toContain("SCOUT-README-MARKER");
      expect(brief).toContain("SCOUT-CHANGELOG-MARKER");
      expect(brief).toContain("- src/");
      expect(brief).toContain("src/index.ts");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty brief for an unreadable/empty project", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-brief-empty-"));
    try {
      expect(await buildProjectBrief(root)).toBe("");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty brief when the root does not exist", async () => {
    expect(await buildProjectBrief(path.join(tmpdir(), "definitely-missing-dir"))).toBe("");
  });
});
