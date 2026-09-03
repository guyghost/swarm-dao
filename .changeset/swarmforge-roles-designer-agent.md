---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-opencode-adapter": minor
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-claude-adapter": minor
---

Agent roster grows to 8 with SwarmForge-style role definitions.

- All seven default agent prompts rewritten in an owns / review-method / rules / does-not-own structure (inspired by unclebob/swarm-forge roles): sharper ownership boundaries, structured review phases, and evidence rules per role.
- **New default agent: UX/UI Designer** (`designer`, weight 2) — UX/UI critique and improvement directions across the four surface modes (Persuade / Operate / Read / Experience), accessibility review (WCAG AA as defects), and design-direction output. Uses the impeccable harness lenses (impeccable.style) when the host provides it, and the Mobbin MCP server as optional design-reference material (requires a subscription).
- Per-agent tooling declarations: `tools` frontmatter field in `dao-*.md` is now parsed; the Architect declares `sequential-thinking` (structured step-by-step review), Delivery declares `context7` (library API verification), Designer declares `impeccable` + `mobbin`. Agents degrade gracefully when a tool is not configured by the host.
- `dao_setup` now seeds 8 agents (new DAOs only; existing DAO state is unchanged).
