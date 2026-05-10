#!/usr/bin/env node
/**
 * Prepare a package's dist/ folder for npm publication.
 *
 * Adjusts package.json entry points to be relative to dist/,
 * removes dev-only fields, and copies LICENSE/README.
 */

import { readFileSync, writeFileSync, cpSync, existsSync } from "fs";
import { join, resolve } from "path";

const pkgDir = process.cwd();
const distDir = join(pkgDir, "dist");
const pkgJsonPath = join(pkgDir, "package.json");

if (!existsSync(distDir)) {
  console.error("dist/ folder not found. Run 'bun run build' first.");
  process.exit(1);
}

const original = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
const publishPkg = structuredClone(original);

// Adjust entry points to be relative to dist/
if (publishPkg.main) publishPkg.main = publishPkg.main.replace("./dist/", "./");
if (publishPkg.types) publishPkg.types = publishPkg.types.replace("./dist/", "./");
if (publishPkg.bin) {
  for (const [key, val] of Object.entries(publishPkg.bin)) {
    publishPkg.bin[key] = val.replace("./dist/", "./");
  }
}

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

// Write publish package.json into dist/
writeFileSync(join(distDir, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");

// Copy README if it exists at package level
const pkgReadme = join(pkgDir, "README.md");
if (existsSync(pkgReadme)) {
  cpSync(pkgReadme, join(distDir, "README.md"));
}

// Copy LICENSE from root
const rootLicense = resolve(join(pkgDir, "../../LICENSE"));
if (existsSync(rootLicense)) {
  cpSync(rootLicense, join(distDir, "LICENSE"));
}

console.log(`✅ ${original.name} dist/ prepared for publish`);
