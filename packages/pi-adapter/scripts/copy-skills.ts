#!/usr/bin/env bun
/**
 * Projects the repository's governance Agent Skills (.agents/skills/**) into
 * the published package as skills/<name>/**, so npm consumers of
 * @guyghost/swarm-dao-pi-adapter receive the same just-in-time context their
 * agents get in this repository. Install them into a project by copying (or
 * symlinking) skills/<name> into the project's .agents/skills/ directory.
 * Regenerate after changing any skill:
 *
 *   bun run copy-skills
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.resolve(ROOT, "..", "..", ".agents", "skills");
const OUT = path.join(ROOT, "skills");

async function main(): Promise<void> {
  const skills = (await readdir(SOURCE, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (skills.length === 0) throw new Error(`no skills found in ${SOURCE}`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const skill of skills) {
    await cp(path.join(SOURCE, skill.name), path.join(OUT, skill.name), { recursive: true });
    console.log(`✅ skills/${skill.name}`);
  }
}

main();
