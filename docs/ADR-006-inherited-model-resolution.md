# ADR-006: No Default Model — Agents Inherit the Main Model

## Status

Accepted (2026-09-19) — implemented in the same change set: `DAOConfig.defaultModel`
removed, `DelegationProfileEntry.defaultModel` renamed to `model`, resolution
chain reduced to spec-or-inherit, D2 of `models/agent-runtime.md` revised
accordingly (human approval given at implementation time).

## Context

Swarm DAO still carries a **default-model** notion in three places, even
though the intended behaviour is: *every agent inherits the main session's
model unless the user explicitly pinned a model in configuration.*

Current resolution chain (D2, `packages/core/src/intelligence/model.ts`):

```
1. agent.model                                user spec (frontmatter) — kept
2. delegationProfile[archetype].defaultModel  profile "default"       — remove*
3. parent agent's resolved model              delegation inheritance  — kept
4. parent session model                       the main model          — kept
5. DAOConfig.defaultModel                     REQUIRED config field   — remove
   (hardcoded fallback "z.ai/GLM-5.1" in DEFAULT_CONFIG)
6. host default (opencode config / OPENCODE_MODEL / PI_MODEL)         — kept
7. sentinel "default" → host decides (no flag emitted, D3 row 3)      — kept
```

\* see Decision §3.

Problems with the current chain:

1. **`DAOConfig.defaultModel` is a required config field** with a hardcoded
   default (`"z.ai/GLM-5.1"` in `DEFAULT_CONFIG`). Whenever the main session
   model cannot be detected (headless CLI, MCP, CI, hosts without session
   introspection), agents silently run on that pinned model instead of
   inheriting. This is exactly the "default model" notion to remove.
2. **`delegationProfile.*.defaultModel` precedes parent inheritance**, so a
   delegated child can be forced onto the profile model even when the user
   pinned nothing for it. The field's own doc comment ("Model used when a
   child does not override and the parent is not inherited") contradicts the
   implementation.
3. The host default ranks *below* the DAO config default, inverting the
   natural order: the host's own main model is a better inheritance source
   than a DAO-wide pinned model.

## Decision

A model is either **explicitly specified by the user in configuration** or
**inherited from the main model**. There is no third "default" layer.

New chain (first match wins):

```
1. agent.model                    — user spec (agent frontmatter `model:`,
                                    `"inherit"` / omitted ⇒ fall through)
2. delegationProfile[archetype].model — user spec for delegated child
                                    archetypes (renamed from `defaultModel`;
                                    explicit config, not a default)
3. parent agent's resolved model  — delegation inheritance
4. parent session model           — the main model
5. host main model                — hostDefaultModel (opencode config default,
                                    OPENCODE_MODEL, PI_MODEL, …)
6. sentinel "default"             — no model id resolved; host runs its own
                                    main model, no flag emitted (D3 row 3,
                                    unchanged)
```

Concretely:

1. **Core types** (`packages/core/src/types/index.ts`): delete
   `DAOConfig.defaultModel` and its entry in `DEFAULT_CONFIG`. Rename
   `DelegationProfileEntry.defaultModel` → `model` and fix its doc comment
   to match the implementation (explicit per-archetype user spec, ranked
   above parent inheritance).
2. **Resolution** (`packages/core/src/intelligence/model.ts`): drop
   `configDefaultModel` from `ModelResolutionContext`,
   `buildModelResolutionContext`, and `buildChildModelResolutionContext`;
   drop the "(DAO default)" branch from `describeModelResolution`.
3. **Call sites**: `host-tools/handlers.ts`,
   `application/proposals/round-table.use-case.ts`,
   `application/proposals/deliberate-proposal.use-case.ts`,
   `intelligence/delegation.ts`, `intelligence/swarm.ts` — stop threading
   `state.config.defaultModel`.
4. **Amendments** (`governance/amendments.ts`): remove `"defaultModel"` from
   `validConfigFields` for `config-update`.
5. **Back-compat**: `loadConfig` ignores a legacy `defaultModel` key in
   `.dao/config.json` (warn once in the setup/doctor output). Existing agent
   frontmatter `model:` values keep working unchanged — they are user specs.
6. **Decision contract**: `models/agent-runtime.md` §4.4 (D2) is rewritten to
   the chain above; D3 row 3 (`"default"` ⇒ emit nothing) is unchanged;
   failure E3 wording drops the `defaultModel` reference. New revision hash
   requires human approval before ship.
7. **Tests**: update `model.test.ts` (the "DAO default" cases become
   host-default / sentinel cases), `delegation.test.ts`,
   `config.test.ts`, `swarm.test.ts`, `roundtable.test.ts`,
   `intelligence.runtime.test.ts`.

## Consequences

- **Silent model pinning disappears.** On hosts without session-model
  detection, agents run on the host's own main model (or emit no flag at all)
  instead of a hardcoded `z.ai/GLM-5.1`.
- **One mental rule**: *pinned in config, or inherited — never defaulted.*
  Every resolved model is attributable: agent override, profile spec,
  parent, session, or host.
- **Breaking change** for anyone relying on `DAOConfig.defaultModel` as a
  fleet-wide model pin. The supported migration is to pin `model:` per agent
  frontmatter (or per delegation-profile archetype) — explicit over implicit
  (invariant I6).
- The `"default"` sentinel and D3 row 3 stay: "no model id" remains a valid,
  honest resolution meaning *the host decides*.
