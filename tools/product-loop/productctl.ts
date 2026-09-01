#!/usr/bin/env bun
// Swarm DAO — product loop CLI shim.
//
// The executor moved to @guyghost/swarm-dao-product (packages/product-loop);
// this file keeps the repo scripts (`product:*`) and historical imports
// pointed at it. Dogfood evidence stays repo-local: default root remains
// evidence/product-loops.

import { runProductCli } from "../../packages/product-loop/src/cli.js";

export { runProductCli };

if (import.meta.main) {
  runProductCli(process.argv.slice(2), { evidenceRoot: "evidence/product-loops" }).then((code) => process.exit(code));
}
