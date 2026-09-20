---
"@guyghost/swarm-dao-core": major
---

Remove the default-model notion — agents inherit the main model (ADR-006).

A model is now either **pinned explicitly in configuration** or **inherited
from the main model**; there is no DAO-wide default layer anymore. Resolution
chain (first match wins): `agent.model` → `delegationProfile[archetype].model`
→ parent agent → parent session (the main model) → host main model → the
`"default"` sentinel (host decides, no flag emitted).

**Breaking:**

- `DAOConfig.defaultModel` is removed (including its hardcoded
  `"z.ai/GLM-5.1"` fallback in `DEFAULT_CONFIG`). DAOs that relied on it as a
  fleet-wide pin must set `model:` per agent frontmatter or delegation
  profile instead. Legacy `defaultModel` keys in `.dao/config.json` are
  ignored (that file never carried the field).
- `DelegationProfileEntry.defaultModel` is renamed to `model` — it is an
  explicit user spec, not a default; its rank in the chain is unchanged.
- `buildModelResolutionContext`, `buildChildModelResolutionContext`, and
  `createDispatchModelContext` drop their `configDefaultModel` parameter.
- `config-update` amendments no longer accept `defaultModel`.

Behavioral effect: on hosts without session-model detection (headless CLI,
MCP, CI), agents now run on the host's own main model — or emit no model flag
at all — instead of silently running on a hardcoded model.
