#!/usr/bin/env bun
// Swarm DAO — graph engineering CLI shim.
//
// The executor moved to @guyghost/swarm-dao-graph (packages/graph-engineering);
// this file keeps the repo scripts (`graph:*`) and historical imports pointed
// at it. Evidence roots resolve through the package helper: an explicit
// --evidence-root wins, then an existing evidence/graph-runs or
// .dao/graph-runs directory, otherwise the frozen model path
// evidence/graph-runs.

import { runGraphCli } from "../../packages/graph-engineering/src/cli.js";

export { runGraphCli };

if (import.meta.main) {
  runGraphCli(process.argv.slice(2)).then((code) => process.exit(code));
}
