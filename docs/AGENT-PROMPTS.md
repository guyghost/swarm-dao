# Guide des Prompts Agents

> Comment personnaliser et tester les prompts des agents DAO

## Structure des prompts

Chaque agent a un **prompt système** qui définit :
- Sa mission et son rôle
- Son framework d'analyse
- Son format de sortie (Vote, Score, Raisonnement)

Les prompts vivent dans `agents/<agent-id>.md` avec un frontmatter YAML.

## Prompts par défaut

| Agent | Fichier | Rôle |
|-------|---------|------|
| Product Strategist | `agents/dao-strategist.md` | Vision, objectifs |
| Research Agent | `agents/dao-researcher.md` | Marché, concurrence |
| Solution Architect | `agents/dao-architect.md` | Architecture |
| Critic/Risk Agent | `agents/dao-critic.md` | Risques, objections |
| Prioritization Agent | `agents/dao-prioritizer.md` | Impact/coût |
| Spec Writer | `agents/dao-spec-writer.md` | Spécifications |
| Delivery Agent | `agents/dao-delivery.md` | Exécution |

## Personnalisation des prompts

### Via config (par projet)

```json
// .dao/config.json
{
  "agentOverrides": {
    "strategist": {
      "systemPrompt": "Vous êtes un stratège spécialisé en B2B SaaS..."
    }
  }
}
```

### Via A/B Testing

```typescript
import { createPromptVariant, registerAgentPrompts, recordPromptInvocation } from "@swarm-dao/core";

// Créer deux variantes
const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt A...", 70);
const v2 = createPromptVariant("strategist", "v2", "Expérimental", "Prompt B...", 30);

// Enregistrer
registerAgentPrompts("strategist", [v1, v2]);

// Utiliser (sélection automatique par poids)
const variant = getPromptVariant("strategist");

// Enregistrer les résultats
recordPromptInvocation("strategist", variant.id, 1200, { position: "for", confidence: 8 });
```

### Comparer les performances

```typescript
const comparison = compareVariants("strategist");
// [{ variant, score }, ...] trié par score

// Promouvoir la meilleure variante
promoteBestVariant("strategist");
```

## Métriques par prompt

| Métrique | Description |
|----------|-------------|
| `invocations` | Nombre d'utilisations |
| `avgResponseTimeMs` | Temps de réponse moyen |
| `votesFor` | Votes "pour" |
| `votesAgainst` | Votes "contre" |
| `avgConfidence` | Confiance moyenne (0-10) |

## Score composite

Le score d'une variante est calculé comme :
```
score = approvalRate * 0.4 + confidenceFactor * 0.3 + volumeFactor * 0.3
```

- **approvalRate** : % de votes "pour"
- **confidenceFactor** : confiance moyenne normalisée (0-1)
- **volumeFactor** : nombre d'invocations normalisé (0-1, max à 10)

## Bonnes pratiques

1. **Tester sur 10+ propositions** avant de tirer des conclusions
2. **Varier un seul élément** à la fois (mission, format, température)
3. **Documenter les changements** dans le CHANGELOG
4. **Réinitialiser les métriques** entre les campagnes de test

## Exemple complet

```typescript
import {
  createPromptVariant,
  registerAgentPrompts,
  getSystemPrompt,
  recordPromptInvocation,
  formatPromptComparison,
} from "@swarm-dao/core";

// Définir les variantes
const standard = createPromptVariant(
  "critic",
  "standard",
  "Standard",
  `You are the Critic. Identify risks and raise objections...`,
  50,
);

const aggressive = createPromptVariant(
  "critic",
  "aggressive",
  "Aggressive",
  `You are the Critic. Be extremely skeptical...`,
  50,
);

registerAgentPrompts("critic", [standard, aggressive]);

// Lors de la deliberation
const agent = getAgent("critic");
const variant = getPromptVariant("critic");
const systemPrompt = variant.systemPrompt;

// Après réception du vote
recordPromptInvocation("critic", variant.id, durationMs, {
  position: vote.position,
  confidence: score.confidence,
});

// Afficher les résultats
console.log(formatPromptComparison("critic"));
```