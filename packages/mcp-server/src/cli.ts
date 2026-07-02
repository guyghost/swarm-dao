#!/usr/bin/env node
import { startSwarmDaoMcpServer } from "./server.js";

startSwarmDaoMcpServer().catch((error) => {
  console.error("[swarm-dao-mcp] fatal:", error);
  process.exit(1);
});
