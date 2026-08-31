#!/usr/bin/env bun
// Swarm DAO — improvement series CLI shim.
//
// The series executor moved to @guyghost/swarm-dao-improvement
// (packages/improvement-loop/src); this file keeps the repo scripts
// (`improvement:series:*`) and historical imports pointed at it. Dogfood
// evidence stays repo-local: defaults remain evidence/improvement-*.

export * from "../../packages/improvement-loop/src/orchestrator.js";

import { runSeriesCli } from "../../packages/improvement-loop/src/orchestrator.js";

// Only run the CLI when executed directly, so tests can import the runner.
if (import.meta.main) {
  runSeriesCli(process.argv.slice(2)).then((code) => process.exit(code));
}
