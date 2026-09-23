---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-cli": patch
"@guyghost/swarm-dao-mcp": patch
"@guyghost/swarm-dao-pi-adapter": patch
"@guyghost/swarm-dao-opencode-adapter": patch
---

Remove the process-global DAO repository singleton (getState/setRepository/Legacy); hosts and handlers own FileDaoStateRepository instances per ADR-002 rule 3.
