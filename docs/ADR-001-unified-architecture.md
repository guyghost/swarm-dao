# ADR-001: Architecture Unifiée Swarm DAO

## Statut
Proposé → Accepté (2026-05-10)

## Contexte
Deux projets DAO existaient indépendamment :
- **pi-swarm-dao** : Extension pour l'agent de codage Pi
- **opencode-dao** : Plugin pour OpenCode

Chacun dupliquait ~80% de la logique métier (gouvernance, voting, scoring, lifecycle) tout en étant couplé à son hôte respectif. Cela rendait difficile :
- La maintenance (bugfix à double)
- L'ajout de nouveaux hôtes (Cline, Claude Code, etc.)
- La cohérence des comportements entre hôtes

## Décision
Créer un **monorepo unifié** (`swarm-dao`) avec une architecture en trois couches :

```
┌──────────────────────────────────────┐
│  Host Adapters (Pi, OpenCode, ...)   │
├──────────────────────────────────────┤
│  HostAdapter Interface (8 méthodes)  │
├──────────────────────────────────────┤
│  Swarm DAO Core (logique métier)     │
├──────────────────────────────────────┤
│  Persistence (.dao/ fichiers locaux) │
└──────────────────────────────────────┘
```

### Packages

| Package | Responsabilité | Dépendances hôte |
|---------|---------------|------------------|
| `@swarm-dao/core` | Types, gouvernance, scoring, gates, audit, delivery | Aucune |
| `@swarm-dao/pi-adapter` | Bridge Pi ExtensionAPI → core | `@mariozechner/pi-coding-agent` |
| `@swarm-dao/opencode-adapter` | Bridge OpenCode Plugin → core | `@opencode-ai/plugin` |
| `@swarm-dao/cli` | CLI standalone | Aucune (utilise core) |

### Interface HostAdapter

Tout nouvel hôte doit implémenter :

```typescript
interface HostAdapter {
  hostId: string;
  spawnAgent(params: { agent, proposal, systemPrompt, timeoutMs }): Promise<AgentOutput>;
  spawnAgents(params: { agents, proposal, maxConcurrent }): Promise<AgentOutput[]>;
  log(params: { level, message, service }): Promise<void>;
  getWorkingDirectory(): string;
  readFile(path): Promise<string>;
  writeFile(path, content): Promise<void>;
  exec(command, options): Promise<{ stdout, stderr, exitCode }>;
  hasCapability(capability): boolean;
}
```

## Conséquences

### Positives
- **Single source of truth** pour la logique DAO
- **Ajout d'hôte = ~200 lignes** (adapter seul)
- **Tests centralisés** sur le core
- **Agents partagés** : prompts dans `agents/*.md` consommables par tous les hôtes

### Négatives
- **Complexité de build** : monorepo avec Bun workspaces
- **Couplage indirect** : les adapters dépendent de l'interface core
- **Migration** : les deux projets legacy doivent être migrés

## Alternatives rejetées

1. **Micro-repos séparés** : Rejeté car duplication de code
2. **Lib partagée + adapters in-repo** : Rejeté car moins clair pour les contributeurs
3. **Plugin universel** : Rejeté car aucun standard commun entre agents de codage

## Références
- [pi-swarm-dao](https://github.com/guyghost/pi-swarm-dao)
- [opencode-dao](https://github.com/guyghost/opencode-dao)