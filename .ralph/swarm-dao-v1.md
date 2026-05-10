# Swarm DAO v1.0 — Production Release

## Goal
Finaliser swarm-dao pour une v1.0 open-source :
1. Intégrations GitLab + Bitbucket
2. Adapters enrichis (Pi + OpenCode) — dry-run, rollback, health score, roundtable, artefacts, config
3. Tests d'intégration des adapters
4. Agents personnalisés (add/remove via config)
5. Changelog, LICENSE, CONTRIBUTING
6. Lint/Format (Biome)
7. Script de release

## Checklist (Batch 1 — Intégrations + Adapters) ✅
- [x] Implémenter `packages/core/src/integrations/gitlab.ts`
- [x] Implémenter `packages/core/src/integrations/bitbucket.ts`
- [x] Enrichir `packages/pi-adapter/src/index.ts` (dao_artefacts, dao_rate, dao_dashboard, dao_dry_run, dao_rollback, dao_roundtable, dao_update_proposal)
- [x] Enrichir `packages/opencode-adapter/src/index.ts` (mêmes tools)
- [x] Tests d'intégration pour Pi adapter (2 tests)
- [x] Tests d'intégration pour OpenCode adapter (2 tests)

## Checklist (Batch 2 — Polish + Release) ✅
- [x] Changelog (`CHANGELOG.md`)
- [x] LICENSE MIT
- [x] CONTRIBUTING.md
- [x] Setup Biome (`biome.json`)
- [x] Script de release (`scripts/release.sh`)
- [x] Mise à jour finale README

## Checklist (Batch 3 — Observabilité) ✅
- [x] Implémenter `packages/core/src/observability/metrics.ts` (counters, gauges, histograms, DAO_METRICS)
- [x] Implémenter `packages/core/src/observability/tracing.ts` (spans, traces, traced wrapper)
- [x] Implémenter `packages/core/src/observability/alerts.ts` (alert rules, evaluation, default rules)
- [x] Tests observabilité (16 tests)
- [x] Intégrer métriques dans le lifecycle (proposals, votes, execution)

## Checklist (Batch 4 — Prompts Agents) ✅
- [x] Implémenter `packages/core/src/agents/prompts.ts` (versioning, A/B testing, metrics)
- [x] Tests prompts agents (8 tests)
- [x] Documentation `docs/AGENT-PROMPTS.md`

## Résultats finaux

### Tests
- **Core** : 61 tests, 154 expect() calls — ✅
- **CLI E2E** : 4 tests, 19 expect() calls — ✅
- **Pi Adapter** : 2 tests — ✅
- **OpenCode Adapter** : 2 tests — ✅
- **Observabilité** : 16 tests, 32 expect() calls — ✅
- **Agents/Prompts** : 8 tests — ✅
- **Total** : **93 tests, 208 expect() calls — ✅**

### Compilation
- `core` ✅ | `pi-adapter` ✅ | `opencode-adapter` ✅ | `cli` ✅

### Fichiers créés (Phase v1 + Observabilité + Prompts)
- `packages/core/src/integrations/gitlab.ts` — Intégration GitLab
- `packages/core/src/integrations/bitbucket.ts` — Intégration Bitbucket
- `packages/core/src/observability/metrics.ts` — Métriques DAO
- `packages/core/src/observability/tracing.ts` — Tracing
- `packages/core/src/observability/alerts.ts` — Alertes
- `packages/core/src/agents/prompts.ts` — Prompts agents (A/B testing)
- `docs/AGENT-PROMPTS.md` — Guide des prompts
- `CHANGELOG.md`, `LICENSE`, `CONTRIBUTING.md`
- `biome.json`, `scripts/release.sh`