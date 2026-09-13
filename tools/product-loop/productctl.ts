#!/usr/bin/env bun
// Swarm DAO — product loop CLI shim.
//
// The executor moved to @guyghost/swarm-dao-product (packages/product-loop);
// this file keeps the repo scripts (`product:*`) and historical imports
// pointed at it. Evidence roots resolve through the package helper: an
// explicit --evidence-root wins, then an existing evidence/product-loops or
// .dao/product-loops directory, otherwise the frozen model path
// evidence/product-loops.

import { runProductCli } from "../../packages/product-loop/src/cli.js";

export { runProductCli };

if (import.meta.main) {
  runProductCli(process.argv.slice(2)).then((code) => process.exit(code));
}
