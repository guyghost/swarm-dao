// ============================================================
// Changeset coverage check
// ============================================================
// Fails when a diff touches a published package's src/ without a
// pending changeset declaring that package. Guards against merged
// runtime changes that never reach npm (happened on #71: core and
// opencode-adapter src changed, only pi-adapter had a changeset).
//
// Usage:
//   bun run check:changesets              # diff against origin/main
//   BASE_SHA=<sha> bun run check:changesets
//
// Rules:
// - Only packages/*/src/** require coverage. Tests, docs, root files,
//   and package.json-only bumps (handled by updateInternalDependencies)
//   are exempt.
// - Private packages (benchmarks, integration-tests) are exempt.
// - Pending changesets are every .changeset/*.md whose frontmatter
//   lists the package, regardless of bump level.
// - Skips (exit 0) when not running against a PR-style diff base:
//   pushes to main have no meaningful base to compare against.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ── Resolve the diff base ────────────────────────────────────

const envBase = process.env.BASE_SHA;
let baseSha: string | undefined = envBase;
if (!baseSha && process.env.GITHUB_EVENT_NAME === "pull_request") {
  baseSha = process.env.PR_BASE_SHA;
}

if (!baseSha) {
  // Fall back to origin/main when it exists (local pre-push usage).
  try {
    baseSha = sh("git rev-parse --verify origin/main");
  } catch {
    console.log("check:changesets — no diff base available (push event or no origin/main); skipping.");
    process.exit(0);
  }
}

if (baseSha === sh("git rev-parse HEAD")) {
  console.log("check:changesets — base is HEAD; nothing to compare.");
  process.exit(0);
}

// The base comes from environment variables and is interpolated into shell
// commands below — accept nothing except a hexadecimal commit id, then
// verify + canonicalize it through git itself.
if (!/^[0-9a-f]{7,40}$/i.test(baseSha)) {
  console.error(`check:changesets — refusing non-SHA base: ${JSON.stringify(baseSha)}`);
  process.exit(1);
}
try {
  baseSha = sh(`git rev-parse --verify ${baseSha}^{commit}`);
} catch {
  console.error(`check:changesets — base commit not found in repository: ${baseSha}`);
  process.exit(1);
}

// ── Changed files ────────────────────────────────────────────

// --no-renames: a file moved out of src/ must appear as a deletion of its
// old path (default rename detection would show only the destination and
// let the move bypass the gate).
const changed = sh(`git diff --name-only --no-renames ${baseSha}...HEAD`).split("\n").filter(Boolean);
const srcTouched = changed.filter((f) => /^packages\/[^/]+\/src\//.test(f));
if (srcTouched.length === 0) {
  console.log("check:changesets — no src/ changes; nothing to cover.");
  process.exit(0);
}

// ── Map src changes to published packages ────────────────────

const required = new Set<string>();
for (const file of srcTouched) {
  const pkgDir = path.join("packages", file.split("/")[1]);
  const manifest = path.join(pkgDir, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; private?: boolean };
  if (!pkg.name || pkg.private) continue;
  required.add(pkg.name);
}
if (required.size === 0) {
  console.log("check:changesets — src/ changes only in private packages; nothing to cover.");
  process.exit(0);
}

// ── Pending changesets ───────────────────────────────────────

const declared = new Set<string>();
const changesetDir = ".changeset";
if (existsSync(changesetDir)) {
  for (const entry of readdirSync(changesetDir)) {
    if (!entry.endsWith(".md")) continue;
    const text = readFileSync(path.join(changesetDir, entry), "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) continue;
    for (const line of frontmatter[1].split("\n")) {
      // Keys in changeset frontmatter are package names ("@scope/pkg": bump
      // or "pkg": bump); skip $schema and anything key-less.
      const key = line
        .split(":")[0]
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!key || key.startsWith("$")) continue;
      declared.add(key);
    }
  }
}

// ── Compare ──────────────────────────────────────────────────

const missing = [...required].filter((p) => !declared.has(p));
if (missing.length > 0) {
  console.error("check:changesets — FAILED");
  console.error(
    `Runtime code changed without a changeset for: ${missing.join(", ")}\n` +
      "Every package whose src/ changes in a PR must be declared in a changeset\n" +
      "(create one with `bunx changeset`, or add the package to an existing\n" +
      ".changeset/*.md frontmatter).",
  );
  process.exit(1);
}

console.log(`check:changesets — OK (${[...required].join(", ")} covered)`);
