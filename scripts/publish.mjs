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

import { readFileSync, writeFileSync, cpSync, existsSync } from "fs";
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
const pkgJsonPath = join(pkgDir, "package.json");

// 1. Read original package.json
const original = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));

// 2. Build
console.log(`🔨 Building ${original.name}...`);
execSync("bun run build", { cwd: pkgDir, stdio: "inherit" });

// 3. Create publish-ready package.json in dist/
const publishPkg = structuredClone(original);

// Adjust entry points to be relative to dist/
publishPkg.main = publishPkg.main?.replace("./dist/", "./") || "./index.js";
publishPkg.types = publishPkg.types?.replace("./dist/", "./") || "./index.d.ts";

// Adjust exports
if (publishPkg.exports) {
  for (const [key, val] of Object.entries(publishPkg.exports)) {
    if (typeof val === "string") {
      publishPkg.exports[key] = val.replace("./dist/", "./");
    } else if (val && typeof val === "object") {
      for (const [subKey, subVal] of Object.entries(val)) {
        if (typeof subVal === "string") {
          publishPkg.exports[key][subKey] = subVal.replace("./dist/", "./");
        }
      }
    }
  }
}

// Remove fields not needed for publishing
delete publishPkg.scripts;
delete publishPkg.devDependencies;

// Ensure files only includes dist contents
publishPkg.files = ["*.js", "*.d.ts", "*.d.ts.map", "*.js.map"];

// Write publish package.json
writeFileSync(join(distDir, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");

// Copy README if it exists at package level
const pkgReadme = join(pkgDir, "README.md");
if (existsSync(pkgReadme)) {
  cpSync(pkgReadme, join(distDir, "README.md"));
}

// Copy LICENSE from root
const rootLicense = resolve("LICENSE");
if (existsSync(rootLicense)) {
  cpSync(rootLicense, join(distDir, "LICENSE"));
}

// 4. Publish
const npmCmd = dryRun ? "npm publish --dry-run" : "npm publish --access public";
console.log(`📦 Publishing ${original.name}@${original.version}...`);
execSync(npmCmd, { cwd: distDir, stdio: "inherit" });

console.log(`✅ ${original.name}@${original.version} published!`);
