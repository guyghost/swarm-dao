#!/usr/bin/env bun
// Swarm DAO — graph engineering CLI shim.
//
// The executor moved to @guyghost/swarm-dao-graph (packages/graph-engineering);
// this file keeps the repo scripts (`graph:*`) and historical imports pointed
// at it. Dogfood evidence stays repo-local: default root remains
// evidence/graph-runs (repos without the frozen graph default to .dao/graph-runs).

import { runGraphCli } from "../../packages/graph-engineering/src/cli.js";

export { runGraphCli };

if (import.meta.main) {
  runGraphCli(process.argv.slice(2), { evidenceRoot: "evidence/graph-runs" }).then((code) => process.exit(code));
}
