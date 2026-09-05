import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildProjectBrief } from "../src/host-tools/project-brief.js";

const execFileAsync = promisify(execFile);

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
      await fs.mkdir(path.join(root, "docs"));
      await fs.writeFile(path.join(root, "docs", "ADR-001-demo.md"), "# ADR\n");
      await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "brief@test"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "brief-test"], { cwd: root });
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-m", "SCOUT-COMMIT-MARKER"], { cwd: root });

      const brief = await buildProjectBrief(root);

      expect(brief.startsWith("## Project Brief")).toBe(true);
      expect(brief).toContain("demo-project");
      expect(brief).toContain("A demo project");
      expect(brief).toContain("SCOUT-README-MARKER");
      expect(brief).toContain("SCOUT-CHANGELOG-MARKER");
      expect(brief).toContain("- src/");
      expect(brief).toContain("src/index.ts");
      expect(brief).toContain("## Recent commits");
      expect(brief).toContain("SCOUT-COMMIT-MARKER");
      expect(brief).toContain("## Docs");
      expect(brief).toContain("docs/ADR-001-demo.md");
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
