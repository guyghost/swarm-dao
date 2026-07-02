#!/usr/bin/env node
import { startCopilotServer } from "./index.js";

startCopilotServer().catch((error) => {
  console.error("[swarm-dao-copilot] fatal:", error);
  process.exit(1);
});
