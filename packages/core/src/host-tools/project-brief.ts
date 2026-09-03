// ============================================================
// Swarm DAO Core — Deterministic Project Brief ("scout", opt 1)
// ============================================================
//
// Assembles a compact, deterministic project summary (manifest,
// README excerpt, layout, changelog) that is built ONCE per
// deliberation / round table and shared with every participant,
// so agents reason about the actual project instead of inventing
// one. No LLM call involved. Best-effort: any failure yields "".

import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../observability/logging.js";

const MAX_TOTAL_CHARS = 3000;
const README_CHARS = 1200;
const CHANGELOG_CHARS = 600;
const LAYOUT_ENTRIES = 24;
const SUBDIRS_TO_PEEK = ["src", "packages", "lib", "app"] as const;
const IGNORED_ENTRIES = new Set(["node_modules", "dist", "build", "coverage", "vendor", ".next", ".dao"]);

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n…[truncated]`;
}

async function firstExistingFile(root: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    try {
      const filePath = path.join(root, name);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return filePath;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function manifestSection(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { name?: string; description?: string };
    if (!pkg.name && !pkg.description) return null;
    const lines = ["## Manifest"];
    if (pkg.name) lines.push(`- Project: ${pkg.name}`);
    if (pkg.description) lines.push(`- Description: ${pkg.description}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function readmeSection(root: string): Promise<string | null> {
  const filePath = await firstExistingFile(root, ["README.md", "Readme.md", "readme.md"]);
  if (!filePath) return null;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const excerpt = clip(content, README_CHARS);
    return excerpt ? `## README (excerpt)\n\n${excerpt}` : null;
  } catch {
    return null;
  }
}

async function layoutSection(root: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const visible = entries.filter((entry) => !entry.name.startsWith(".") && !IGNORED_ENTRIES.has(entry.name));
  if (visible.length === 0) return null;

  const sorted = [...visible].sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
  const lines = sorted.slice(0, LAYOUT_ENTRIES).map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`);
  if (sorted.length > LAYOUT_ENTRIES) {
    lines.push(`- …${sorted.length - LAYOUT_ENTRIES} more entries`);
  }

  for (const dir of SUBDIRS_TO_PEEK) {
    try {
      const subEntries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
      const subVisible = subEntries
        .filter((entry) => !entry.name.startsWith(".") && !IGNORED_ENTRIES.has(entry.name))
        .slice(0, 12)
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      if (subVisible.length > 0) {
        lines.push("", `Inside ${dir}/:`);
        for (const entry of subVisible) {
          lines.push(`- ${dir}/${entry.name}${entry.isDirectory() ? "/" : ""}`);
        }
      }
    } catch {
      // directory does not exist here — skip
    }
  }

  return `## Layout\n${lines.join("\n")}`;
}

async function changelogSection(root: string): Promise<string | null> {
  const filePath = await firstExistingFile(root, ["CHANGELOG.md", "Changelog.md", "changelog.md"]);
  if (!filePath) return null;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const excerpt = clip(content, CHANGELOG_CHARS);
    return excerpt ? `## Recent changes (excerpt)\n\n${excerpt}` : null;
  } catch {
    return null;
  }
}

/**
 * Build the shared project brief passed to every DAO participant.
 * Returns "" when nothing can be read (the caller skips injection).
 */
export async function buildProjectBrief(root: string): Promise<string> {
  try {
    const sections = (
      await Promise.all([manifestSection(root), readmeSection(root), layoutSection(root), changelogSection(root)])
    ).filter((section): section is string => typeof section === "string" && section.length > 0);
    if (sections.length === 0) return "";

    const brief = `## Project Brief\n\n${sections.join("\n\n")}`;
    return brief.length <= MAX_TOTAL_CHARS ? brief : `${brief.slice(0, MAX_TOTAL_CHARS).trimEnd()}\n…[truncated]`;
  } catch (error) {
    logger.debug("buildProjectBrief failed: %s", error instanceof Error ? error.message : String(error));
    return "";
  }
}
