import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDaoCommands } from "@guyghost/swarm-dao-core";

const DAO_DIR = path.resolve(import.meta.dirname, "..", "commands", "dao");

describe("claude-adapter command projection (registry → commands/dao/*.md)", () => {
  it("generates one file per Claude-relevant registry command", () => {
    const expected = getDaoCommands("claude").map((c) => `${c.id}.md`);
    const files = readdirSync(DAO_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(files.sort()).toEqual(expected.sort());
  });

  it("each generated file declares the right MCP allowed-tools", () => {
    for (const cmd of getDaoCommands("claude")) {
      const file = readFileSync(path.join(DAO_DIR, `${cmd.id}.md`), "utf-8");
      expect(file).toContain(`description: ${cmd.summary}`);
      if (cmd.tool) expect(file).toContain(`mcp__swarm-dao__${cmd.tool}`);
      expect(file).toContain(`/dao:${cmd.id}`);
    }
  });

  it("keeps the hand-authored guided aliases", () => {
    const cmds = path.resolve(import.meta.dirname, "..", "commands");
    const flat = readdirSync(cmds).filter((f) => f.startsWith("dao-") && f.endsWith(".md"));
    expect(flat.sort()).toEqual(["dao-deliberate.md", "dao-propose.md", "dao-ship.md"]);
  });
});
