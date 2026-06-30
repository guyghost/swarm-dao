#!/usr/bin/env node
import { startSwarmDaoMcpServer } from "./server.js";

startSwarmDaoMcpServer().catch((error) => {
  console.error("swarm-dao-mcp failed:", error);
  process.exit(1);
});
