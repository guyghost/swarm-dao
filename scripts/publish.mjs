#!/usr/bin/env node
/**
 * Publish a Swarm DAO package to npm.
 *
 * Usage:
 *   node scripts/publish.mjs <package-name> [--dry-run]
 *
 * Example:
 *   node scripts/publish.mjs core
 *   node scripts/publish.mjs pi-adapter --dry-run
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

const pkgName = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!pkgName) {
  console.error("Usage: node scripts/publish.mjs <package-name> [--dry-run]");
  process.exit(1);
}

const pkgDir = resolve(`packages/${pkgName}`);
if (!existsSync(pkgDir)) {
  console.error(`Package "${pkgName}" not found at ${pkgDir}`);
  process.exit(1);
}

const distDir = join(pkgDir, "dist");

// 1. Build
console.log(`🔨 Building ${pkgName}...`);
execSync("bun run build", { cwd: pkgDir, stdio: "inherit" });

// 2. Prepare dist/
console.log(`📦 Preparing dist/ for ${pkgName}...`);
execSync("node ../../scripts/prepare-dist.mjs", { cwd: pkgDir, stdio: "inherit" });

// 3. Publish
const npmCmd = dryRun ? "npm publish --dry-run" : "npm publish --access public";
console.log(`🚀 Publishing from ${distDir}...`);
execSync(npmCmd, { cwd: distDir, stdio: "inherit" });

console.log(`✅ ${pkgName} published!`);
