# Swarm DAO — OpenCode Adapter + Tests + Artefacts

## Goal
Ajouter trois composants au monorepo swarm-dao :
1. **Adapter OpenCode** (`packages/opencode-adapter/`) — Bridge vers `@opencode-ai/plugin`
2. **Tests unitaires** (`packages/core/tests/`) — Tests Bun pour le core
3. **Artefacts** (`packages/core/src/delivery/artefacts.ts`) — Génération auto de Decision Brief, ADR, Risk Report, PRD Lite, Implementation Plan, Test Plan, Release Packet

## Checklist
- [x] Scaffold `packages/opencode-adapter/package.json`, tsconfig.json
- [x] Implémenter l'adapter OpenCode (tools: setup, propose, deliberate, record_outputs, control, execute, audit, plan, amendments)
- [x] Créer stubs de types OpenCode pour compilation standalone
- [x] Adapter compile sans erreurs (`npx tsc --noEmit`)
- [x] Tests pour governance/agents.ts
- [x] Tests pour governance/voting.ts
- [x] Tests pour governance/scoring.ts
- [x] Tests pour governance/lifecycle.ts
- [x] Tests pour control/gates.ts
- [x] Tests pour persistence.ts
- [x] Tests pour delivery/plans.ts
- [x] Tests pour delivery/execution.ts
- [x] Implémenter delivery/artefacts.ts (generateAllArtefacts)
- [x] Tests pour artefacts
- [x] Tous les tests passent (`bun test`) — **33 pass, 0 fail, 85 expect() calls**

## Résultats

### Adapter OpenCode
- Plugin complet avec 12 tools mappés sur `@opencode-ai/plugin`
- Dispatch plan manuel (sub-agents via `task` tool natif OpenCode)
- HostAdapter implémenté pour log, exec, read/write file

### Tests (5 fichiers, 33 tests)
| Fichier | Tests | Statut |
|---------|-------|--------|
| `governance.test.ts` | 10 | ✅ |
| `control.test.ts` | 2 | ✅ |
| `persistence.test.ts` | 6 | ✅ |
| `delivery.test.ts` | 4 | ✅ |
| `artefacts.test.ts` | 11 | ✅ |

### Artefacts (7 types)
- Decision Brief, ADR, Risk Report, PRD Lite, Implementation Plan, Test Plan, Release Packet
- Tests de génération et formatage pour chaque type

### Compilation
- `core` ✅ | `pi-adapter` ✅ | `opencode-adapter` ✅ | `cli` ✅