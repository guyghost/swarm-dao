# Swarm DAO Extension Guide

> How to add a new host (coding agent) to Swarm DAO.

## Prerequisites

- Understand the 4-layer architecture: Governance → Intelligence → Control → Delivery
- Bun ≥ 1.3 installed

## Steps

### 1. Create the Adapter Package

```bash
cd packages/
mkdir -p my-host-adapter/src
```

### 2. Implement HostAdapter

```typescript
// packages/my-host-adapter/src/index.ts
import type { HostAdapter, AgentOutput, DAOAgent, Proposal } from "@guyghost/swarm-dao-core";

const myAdapter: HostAdapter = {
  hostId: "my-host",

  async spawnAgent({ agent, proposal, systemPrompt, timeoutMs }) {
    // Host-specific implementation
    // For example: API call, subprocess, etc.
    return {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: "...",
      durationMs: 1000,
    };
  },

  async spawnAgents({ agents, proposal, maxConcurrent }) {
    // Dispatch multiple agents in parallel
    const outputs: AgentOutput[] = [];
    for (const agent of agents) {
      outputs.push(await this.spawnAgent({ agent, proposal, systemPrompt: agent.systemPrompt }));
    }
    return outputs;
  },

  async log({ level, message, service }) {
    console.log(`[${level}] ${service}: ${message}`);
  },

  getWorkingDirectory() {
    return process.cwd();
  },

  async readFile(path) {
    const fs = await import("fs/promises");
    return fs.readFile(path, "utf-8");
  },

  async writeFile(path, content) {
    const fs = await import("fs/promises");
    await fs.writeFile(path, content, "utf-8");
  },

  async exec(command, options) {
    const { exec } = await import("child_process");
    return new Promise((resolve) => {
      exec(command, options || {}, (err, stdout, stderr) => {
        resolve({ stdout, stderr, exitCode: err ? 1 : 0 });
      });
    });
  },

  hasCapability(capability) {
    return ["read_file", "write_file", "exec", "log"].includes(capability);
  },
};
```

### 3. Register DAO Tools

Use your host's API to register the core tools:

```typescript
import {
  getState, createProposal, getProposal, /* ... */
} from "@guyghost/swarm-dao-core";

// Register dao_setup
host.registerTool("dao_setup", async () => {
  const state = getState();
  if (state.initialized) return "Already initialized";
  // ... initialize agents
});

// Register dao_propose
host.registerTool("dao_propose", async (params) => {
  const proposal = createProposal(params.title, params.type, params.description, "user");
  return `Proposal #${proposal.id} created`;
});

// etc.
```

### 4. Test

```bash
cd packages/my-host-adapter
bun run typecheck
bun test
```

## Checklist

- [ ] Package created with `package.json` and `tsconfig.json`
- [ ] `HostAdapter` implemented with all 8 methods
- [ ] DAO tools registered in the host
- [ ] Type stubs created if the host is not installable as an npm package
- [ ] Tests pass
- [ ] Compiles without errors

## Examples

See existing adapters:
- `packages/pi-adapter/src/index.ts` — Pi Extension
- `packages/opencode-adapter/src/index.ts` — OpenCode Plugin
