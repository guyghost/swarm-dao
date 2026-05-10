# Swarm DAO — Observabilité + Prompts Agents

## Goal
1. **Observabilité** — Métriques, tracing, alerting pour le DAO
2. **Prompts Agents** — Versioning, A/B testing, métriques par agent

## Checklist (Observabilité) ✅
- [x] Implémenter `packages/core/src/observability/metrics.ts` (counters, gauges, histograms, DAO_METRICS)
- [x] Implémenter `packages/core/src/observability/tracing.ts` (spans, traces, traced wrapper)
- [x] Implémenter `packages/core/src/observability/alerts.ts` (thresholds, alert rules, 4 règles par défaut)
- [x] Implémenter `packages/core/src/observability/index.ts`
- [x] Intégrer métriques dans le lifecycle (proposals, votes, execution via persistence.ts)
- [x] Tests observabilité (16 tests, 32 expect() calls)
- [x] Exposer métriques dans les adapters (formatMetrics, formatMetricsPrometheus)

## Checklist (Prompts Agents) ✅
- [x] Créer `packages/core/src/agents/prompts.ts` (versioning, A/B testing, metrics)
- [x] Ajouter métriques par agent (response time, vote quality, confidence)
- [x] Implémenter A/B testing via config (prompt variants avec poids)
- [x] Créer `docs/AGENT-PROMPTS.md` (guide des prompts)
- [x] Tests prompts agents (8 tests)

## Résultats
- **Tests observabilité** : 16 pass, 0 fail
- **Tests prompts agents** : 8 pass, 0 fail
- **Compilation core** : ✅
- **Fichiers créés** :
  - `packages/core/src/observability/metrics.ts`
  - `packages/core/src/observability/tracing.ts`
  - `packages/core/src/observability/alerts.ts`
  - `packages/core/src/observability/index.ts`
  - `packages/core/src/agents/prompts.ts`
  - `packages/core/src/agents/index.ts`
  - `packages/core/tests/observability.test.ts`
  - `packages/core/tests/agents.test.ts`
  - `docs/AGENT-PROMPTS.md`