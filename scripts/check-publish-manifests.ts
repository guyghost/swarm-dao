// ============================================================
// Publish manifest check
// ============================================================
// Fails when a publishable (non-private) package declares any
// dependency with the `workspace:` protocol. `changeset publish`
// delegates to `npm publish`, which packs the manifest as-is —
// only pnpm rewrites workspace ranges. A leaked `workspace:*`
// makes every consumer install fail with EUNSUPPORTEDPROTOCOL
// (0.12.0 of cli, pi-adapter and 10 other packages shipped that
// way before this check existed).
//
// Usage:
//   bun run check:publish-manifests
//
// Private packages (root, benchmarks, integration-tests) never
// reach npm and may keep `workspace:*`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const packagesDir = path.resolve(import.meta.dir, "..", "packages");

// ── Collect violations ───────────────────────────────────────

const broken: string[] = [];

for (const entry of readdirSync(packagesDir)) {
  const pkgJsonPath = path.join(packagesDir, entry, "package.json");
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (pkg.private) continue;

  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (String(range).startsWith("workspace:")) {
        broken.push(`${pkg.name} → ${section}.${name}: "${range}"`);
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────

if (broken.length > 0) {
  console.error("check:publish-manifests — FAILED");
  console.error(
    `Public packages must not use the "workspace:" protocol:\n` +
      `npm publish does not resolve it; consumers get EUNSUPPORTEDPROTOCOL.\n` +
      `Use "^<version>" ranges instead (changesets bumps them on release).\n` +
      broken.map((b) => `  - ${b}`).join("\n"),
  );
  process.exit(1);
}

console.log("check:publish-manifests — OK (no workspace: protocol in public packages)");
