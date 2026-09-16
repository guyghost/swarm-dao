---
"@guyghost/swarm-dao-pi-adapter": minor
---

Ship the governance Agent Skills (graph-engineering, hexagonal-core,
host-adapter, machine-boundaries) in the package under `skills/`, projected
from the repository's `.agents/skills/` by a `prebuild` generator. Consumers
can copy or symlink them into a project's `.agents/skills/` (or an agent's
user-level skills directory) so coding agents load the same just-in-time
governance context this repository uses.
