#!/usr/bin/env node
import { startClaudeServer } from "./index.js";

startClaudeServer().catch((error) => {
  console.error("[swarm-dao-claude] fatal:", error);
  process.exit(1);
});
