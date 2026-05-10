# Agent Prompts Guide

> How to customize and test DAO agent prompts

## Prompt Structure

Each agent has a **system prompt** that defines:
- Its mission and role
- Its analysis framework
- Its output format (Vote, Score, Reasoning)

Prompts live in `agents/<agent-id>.md` with YAML frontmatter.

## Default Prompts

| Agent | File | Role |
|-------|------|------|
| Product Strategist | `agents/dao-strategist.md` | Vision, objectives |
| Research Agent | `agents/dao-researcher.md` | Market, competition |
| Solution Architect | `agents/dao-architect.md` | Architecture |
| Critic/Risk Agent | `agents/dao-critic.md` | Risks, objections |
| Prioritization Agent | `agents/dao-prioritizer.md` | Impact/cost |
| Spec Writer | `agents/dao-spec-writer.md` | Specifications |
| Delivery Agent | `agents/dao-delivery.md` | Execution |

## Customizing Prompts

### Via config (per project)

```json
// .dao/config.json
{
  "agentOverrides": {
    "strategist": {
      "systemPrompt": "You are a strategist specialized in B2B SaaS..."
    }
  }
}
```

### Via A/B Testing

```typescript
import { createPromptVariant, registerAgentPrompts, recordPromptInvocation } from "@swarm-dao/core";

// Create two variants
const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt A...", 70);
const v2 = createPromptVariant("strategist", "v2", "Experimental", "Prompt B...", 30);

// Register
registerAgentPrompts("strategist", [v1, v2]);

// Use (automatic selection by weight)
const variant = getPromptVariant("strategist");

// Record results
recordPromptInvocation("strategist", variant.id, 1200, { position: "for", confidence: 8 });
```

### Comparing Performance

```typescript
const comparison = compareVariants("strategist");
// [{ variant, score }, ...] sorted by score

// Promote the best variant
promoteBestVariant("strategist");
```

## Per-Prompt Metrics

| Metric | Description |
|--------|-------------|
| `invocations` | Number of uses |
| `avgResponseTimeMs` | Average response time |
| `votesFor` | "For" votes |
| `votesAgainst` | "Against" votes |
| `avgConfidence` | Average confidence (0-10) |

## Composite Score

A variant's score is calculated as:
```
score = approvalRate * 0.4 + confidenceFactor * 0.3 + volumeFactor * 0.3
```

- **approvalRate**: % of "for" votes
- **confidenceFactor**: normalized average confidence (0-1)
- **volumeFactor**: normalized invocation count (0-1, max at 10)

## Best Practices

1. **Test on 10+ proposals** before drawing conclusions
2. **Vary only one element** at a time (mission, format, temperature)
3. **Document changes** in the CHANGELOG
4. **Reset metrics** between test campaigns

## Complete Example

```typescript
import {
  createPromptVariant,
  registerAgentPrompts,
  getSystemPrompt,
  recordPromptInvocation,
  formatPromptComparison,
} from "@swarm-dao/core";

// Define variants
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

// During deliberation
const agent = getAgent("critic");
const variant = getPromptVariant("critic");
const systemPrompt = variant.systemPrompt;

// After receiving the vote
recordPromptInvocation("critic", variant.id, durationMs, {
  position: vote.position,
  confidence: score.confidence,
});

// Display results
console.log(formatPromptComparison("critic"));
```
