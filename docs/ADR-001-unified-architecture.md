# ADR-001: Unified Swarm DAO Architecture

## Status
Proposed → Accepted (2026-05-10)

## Context
Two DAO projects existed independently:
- **pi-swarm-dao**: Extension for the Pi coding agent
- **opencode-dao**: Plugin for OpenCode

Each duplicated ~80% of business logic (governance, voting, scoring, lifecycle) while being tightly coupled to its respective host. This made it difficult to:
- Maintain (duplicate bug fixes)
- Add new hosts (Cline, Claude Code, etc.)
- Keep behavior consistent across hosts

## Decision
Create a **unified monorepo** (`swarm-dao`) with a three-layer architecture:

```
┌──────────────────────────────────────┐
│  Host Adapters (Pi, OpenCode, ...)   │
├──────────────────────────────────────┤
│  HostAdapter Interface (8 methods)   │
├──────────────────────────────────────┤
│  Swarm DAO Core (business logic)     │
├──────────────────────────────────────┤
│  Persistence (.dao/ local files)     │
└──────────────────────────────────────┘
```

### Packages

| Package | Responsibility | Host Dependencies |
|---------|---------------|-------------------|
| `@guyghost/swarm-dao-core` | Types, governance, scoring, gates, audit, delivery | None |
| `@guyghost/swarm-dao-pi-adapter` | Bridge Pi ExtensionAPI → core | `@earendil-works/pi-coding-agent` |
| `@guyghost/swarm-dao-opencode-adapter` | Bridge OpenCode Plugin → core | `@opencode-ai/plugin` |
| `@guyghost/swarm-dao-cli` | Standalone CLI | None (uses core) |

### HostAdapter Interface

Any new host must implement:

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

## Consequences

### Positive
- **Single source of truth** for DAO logic
- **Adding a host = ~200 lines** (adapter only)
- **Centralized tests** on the core
- **Shared agents**: prompts in `agents/*.md` consumable by all hosts

### Negative
- **Build complexity**: monorepo with Bun workspaces
- **Indirect coupling**: adapters depend on the core interface
- **Migration**: both legacy projects need to be migrated

## Rejected Alternatives

1. **Separate micro-repos**: Rejected due to code duplication
2. **Shared lib + in-repo adapters**: Rejected as less clear for contributors
3. **Universal plugin**: Rejected because no common standard exists between coding agents

## References
- [pi-swarm-dao](https://github.com/guyghost/pi-swarm-dao)
- opencode-dao (legacy predecessor, not publicly released)
