---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-copilot-adapter": minor
"@guyghost/swarm-dao-opencode-adapter": minor
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-claude-adapter": minor
---

Agents no longer hardcode a model.

- Removed `model: z.ai/GLM-5.1` from every agent description (`agents/dao-*.md`, `packages/copilot-adapter/agents/*.agent.md`) and dropped the `DEFAULT_AGENT_MODEL` stamp.
- The model now resolves at dispatch time: agent override (frontmatter `model`) → DAO config default (`DAOConfig.defaultModel`, overridable in `.dao/config.json`) → parent session / host default. Agents without an explicit model inherit the session's model on hosts that support it.
