#!/usr/bin/env node
import { startCodexServer } from "./index.js";

startCodexServer().catch((error) => {
  console.error("[swarm-dao-codex] fatal:", error);
  process.exit(1);
});
