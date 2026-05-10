# Guide d'Extension Swarm DAO

> Comment ajouter un nouvel hôte (agent de codage) à Swarm DAO

## Prérequis

- Comprendre l'architecture 4 couches : Governance → Intelligence → Control → Delivery
- Avoir un environnement avec Bun ≥ 1.3

## Étapes

### 1. Créer le package adapter

```bash
cd packages/
mkdir mon-hote-adapter/src
```

### 2. Implémenter HostAdapter

```typescript
// packages/mon-hote-adapter/src/index.ts
import type { HostAdapter, AgentOutput, DAOAgent, Proposal } from "@swarm-dao/core";

const monAdapter: HostAdapter = {
  hostId: "mon-hote",

  async spawnAgent({ agent, proposal, systemPrompt, timeoutMs }) {
    // Implémentation spécifique à votre hôte
    // Par exemple : appel API, subprocess, etc.
    return {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: "...",
      durationMs: 1000,
    };
  },

  async spawnAgents({ agents, proposal, maxConcurrent }) {
    // Dispatcher plusieurs agents en parallèle
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

### 3. Enregistrer les tools DAO

Utilisez l'API de votre hôte pour enregistrer les tools du core :

```typescript
import {
  getState, createProposal, getProposal, /* ... */
} from "@swarm-dao/core";

// Enregistrer dao_setup
hote.registerTool("dao_setup", async () => {
  const state = getState();
  if (state.initialized) return "Already initialized";
  // ... initialiser agents
});

// Enregistrer dao_propose
hote.registerTool("dao_propose", async (params) => {
  const proposal = createProposal(params.title, params.type, params.description, "user");
  return `Proposal #${proposal.id} created`;
});

// etc.
```

### 4. Tester

```bash
cd packages/mon-hote-adapter
bun run typecheck
bun test
```

## Checklist

- [ ] Package créé avec `package.json` et `tsconfig.json`
- [ ] `HostAdapter` implémenté avec les 8 méthodes
- [ ] Tools DAO enregistrés dans l'hôte
- [ ] Types stubs créés si l'hôte n'est pas installable
- [ ] Tests passent
- [ ] Compilation sans erreurs

## Exemples

Voir les adapters existants :
- `packages/pi-adapter/src/index.ts` — Extension Pi
- `packages/opencode-adapter/src/index.ts` — Plugin OpenCode