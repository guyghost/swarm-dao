---
"@guyghost/swarm-dao-core": patch
---

Fix package exports: add the `./adapters`, `./ports`, and `./delivery/artefacts` subpaths that integration tests and benchmarks consume. Without them, any external consumer importing these subpaths fails to resolve.
