#!/usr/bin/env bun
/**
 * Projects the canonical DaoCommandRegistry (from @guyghost/swarm-dao-core)
 * into Claude Code slash-command files under commands/dao/<id>.md.
 *
 * Claude Code maps a subdirectory to the colon namespace, so
 * `commands/dao/propose.md` becomes the `/dao:propose` command with native
 * tab completion. Regenerate after changing the registry:
 *
 *   bun run scripts/generate-commands.ts
 *
 * The 3 hand-authored flat files (dao-propose.md, dao-deliberate.md,
 * dao-ship.md) are preserved as guided multi-step aliases.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DAO_COMMAND_PHASE_LABEL,
  DAO_COMMAND_PHASE_ORDER,
  type DaoCommand,
  getDaoCommands,
} from "@guyghost/swarm-dao-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "commands", "dao");
const MCP_PREFIX = "mcp__swarm-dao__";

function allowedTools(cmd: DaoCommand): string {
  if (!cmd.tool) return "";
  const tools = [`${MCP_PREFIX}${cmd.tool}`];
  if (cmd.id === "ship") {
    tools.push(`${MCP_PREFIX}dao_control`, `${MCP_PREFIX}dao_execute`, `${MCP_PREFIX}dao_rate`);
  }
  if (cmd.id === "deliberate") {
    tools.push(`${MCP_PREFIX}dao_record_outputs`, `${MCP_PREFIX}dao_control`, "Task");
  }
  return tools.join(", ");
}

function body(cmd: DaoCommand): string {
  const usage = cmd.args ? `\`/dao:${cmd.id} ${cmd.args}\`` : `\`/dao:${cmd.id}\``;
  const toolLine = cmd.tool
    ? `Call the \`${MCP_PREFIX}${cmd.tool}\` MCP tool. Pass \`$ARGUMENTS\` through.`
    : `This is a read-only / host-native command; no MCP tool is required.`;
  return [cmd.summary + ".", "", usage, "", toolLine].join("\n");
}

function render(cmd: DaoCommand): string {
  const frontmatter: string[] = ["---"];
  frontmatter.push(`description: ${cmd.summary}`);
  const at = allowedTools(cmd);
  if (at) frontmatter.push(`allowed-tools: ${at}`);
  frontmatter.push("---");
  return `${frontmatter.join("\n")}\n\n${body(cmd)}\n`;
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const cmds = getDaoCommands("claude");
  const byPhase = new Map<string, DaoCommand[]>();
  for (const cmd of cmds) {
    const bucket = byPhase.get(cmd.phase) ?? [];
    bucket.push(cmd);
    byPhase.set(cmd.phase, bucket);
  }

  const indexLines: string[] = [
    "# `/dao` commands (generated)",
    "",
    "> Auto-generated from `@guyghost/swarm-dao-core`'s `DaoCommandRegistry`.",
    "> Do not edit by hand — run `bun run scripts/generate-commands.ts`.",
    "> Claude Code exposes each file as `/dao:<id>` (colon namespace, native completion).",
    "",
  ];

  for (const phase of DAO_COMMAND_PHASE_ORDER) {
    const bucket = byPhase.get(phase);
    if (!bucket || bucket.length === 0) continue;
    indexLines.push(`## ${DAO_COMMAND_PHASE_LABEL[phase]}`);
    for (const cmd of bucket) {
      await writeFile(path.join(OUT, `${cmd.id}.md`), render(cmd), "utf-8");
      const arg = cmd.args ? ` \`${cmd.args}\`` : "";
      indexLines.push(`- [\`/dao:${cmd.id}\`](${cmd.id}.md)${arg} — ${cmd.summary}`);
    }
    indexLines.push("");
  }

  indexLines.push("## Guided aliases (hand-authored)");
  indexLines.push("- `/dao-propose` — scaffold a proposal with prompts for every field.");
  indexLines.push("- `/dao-deliberate` — deliberate, spawn sub-agents, record outputs, control.");
  indexLines.push("- `/dao-ship` — control, execute, ship, and rate in one guided flow.");
  indexLines.push("");

  await writeFile(path.join(OUT, "README.md"), indexLines.join("\n"), "utf-8");

  const files = (await readdir(OUT)).filter((f) => f.endsWith(".md") && f !== "README.md");
  console.log(`✅ Generated ${files.length} commands in commands/dao/`);
}

await main();
