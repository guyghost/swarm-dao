---
"@guyghost/swarm-dao-core": minor
---

Layer the agent prompts as a constitution (swarm-forge pattern): every agent's system prompt is now composed from a shared `AGENT_CHARTER` (deliberation conduct + the exact parseable output format, defined once instead of duplicated across all seven prompts), a role layer (the agent's mission — the markdown body of `dao-<id>.md` now replaces the default role prompt, consistent with frontmatter overriding name/role/model/weight), and an optional per-project `charter.md` addendum appended to every agent. Layers only add; the shared charter is never replaceable. Composition is pure, deterministic, happens exactly once at the load exits, and the markdown-merge cache now tracks `charter.md` too.
