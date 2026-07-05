import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDaoCommands } from "@guyghost/swarm-dao-core";

const COMMANDS_DIR = path.resolve(import.meta.dirname, "..", "commands");

describe("claude-adapter command projection (registry → commands/dao:*.md)", () => {
  it("generates one flat file per Claude-relevant registry command", () => {
    const expected = getDaoCommands("claude").map((c) => `dao:${c.id}.md`);
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.startsWith("dao:") && f.endsWith(".md"));
    expect(files.sort()).toEqual(expected.sort());
  });

  it("each generated file declares the right MCP allowed-tools", () => {
    for (const cmd of getDaoCommands("claude")) {
      const file = readFileSync(path.join(COMMANDS_DIR, `dao:${cmd.id}.md`), "utf-8");
      expect(file).toContain(`description: ${cmd.summary}`);
      if (cmd.tool) expect(file).toContain(`mcp__swarm-dao__${cmd.tool}`);
      expect(file).toContain(`/dao:${cmd.id}`);
    }
  });
});
