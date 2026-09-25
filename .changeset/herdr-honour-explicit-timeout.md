---
"@guyghost/swarm-dao-herdr-adapter": patch
---

Honour an explicit timeout instead of silently clamping it to 300s: the
5-minute ceiling now guards only the default, so a `--timeout-ms` the operator
asked for (e.g. 10 minutes) is passed through. A missing or invalid value still
falls back to the default.
