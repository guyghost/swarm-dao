// ============================================================
// Docs link check
// ============================================================
// Fails when a relative Markdown link in the repository's docs
// resolves to a missing file or to a heading anchor that no
// longer exists. Agents and humans follow these links as
// context; a dead link silently sends them guessing.
//
// Usage:
//   bun run check:doc-links
//
// Rules:
// - Scans README.md, CONTRIBUTING.md, SECURITY.md, docs/,
//   models/, agents/, and .agents/skills/ for [text](target)
//   and ![alt](target) links, skipping fenced code blocks.
// - Only relative targets are checked. http(s), mailto, and
//   bare scheme links are external concerns.
// - `file.md` must exist relative to the linking document.
// - `file.md#anchor` must match a heading in the target file
//   (GitHub-style slugs, duplicates get -1/-2 suffixes).
// - `#anchor` links are validated against the current file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SCAN_PATHS = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs",
  "models",
  "agents",
  path.join(".agents", "skills"),
];

// ── Collect Markdown files ───────────────────────────────────

function markdownFiles(target: string): string[] {
  const absolute = path.join(ROOT, target);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [absolute];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...markdownFiles(path.join(target, entry.name)));
    else if (entry.name.endsWith(".md")) found.push(path.join(absolute, entry.name));
  }
  return found;
}

const files = SCAN_PATHS.flatMap(markdownFiles).sort();

// ── Heading anchors per file (GitHub-style slugs) ────────────

function githubSlug(text: string): string {
  return text
    .replace(/`/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w- ]/g, "")
    .replace(/ /g, "-");
}

function headingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of content.split("\n")) {
    // Fence-aware like the link scan: GitHub generates no heading anchors
    // from `#` lines inside code fences, and counting them as duplicates
    // would shift a real heading's slug to `slug-1` (false broken link).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    const slug = githubSlug(match[2]);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

const anchorsByFile = new Map<string, Set<string>>(
  files.map((file) => [file, headingAnchors(readFileSync(file, "utf8"))]),
);

// ── Scan links, fence-aware ──────────────────────────────────

const LINK_PATTERN = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const broken: string[] = [];
let checked = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const match of line.matchAll(LINK_PATTERN)) {
      const target = match[2];
      if (/^(https?:|mailto:)/i.test(target)) continue;
      checked++;

      const [rawPath, anchor] = target.split("#");
      const targetPath = rawPath === "" ? file : path.resolve(path.dirname(file), decodeURIComponent(rawPath));

      if (!existsSync(targetPath)) {
        broken.push(`${path.relative(ROOT, file)}:${index + 1} — missing target "${target}"`);
        continue;
      }
      if (anchor === undefined) continue;
      const anchors = anchorsByFile.get(targetPath);
      if (!anchors) {
        broken.push(`${path.relative(ROOT, file)}:${index + 1} — anchor on non-markdown target "${target}"`);
      } else if (!anchors.has(decodeURIComponent(anchor))) {
        broken.push(`${path.relative(ROOT, file)}:${index + 1} — missing anchor "#${anchor}" in "${rawPath || file}"`);
      }
    }
  });
}

// ── Report ───────────────────────────────────────────────────

if (broken.length > 0) {
  console.error(`check:doc-links — ${broken.length} broken link(s):\n`);
  for (const entry of broken) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`check:doc-links — ${checked} relative links OK across ${files.length} files.`);
