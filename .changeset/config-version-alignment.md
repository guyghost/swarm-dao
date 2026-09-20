---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-cli": minor
---

Config schema versioning: see and align `.dao/config.json` with the running tool.

`ProjectConfig` gains an explicit `configVersion` field (files without one are
legacy v0). `loadConfig` validates it (non-negative integer) and the new
`effectiveConfigVersion`/`CURRENT_CONFIG_VERSION` exports let callers compare
a config's schema version with the tool's. Migrations are pure, ordered
functions (`migrateProjectConfig`); `upgradeConfig` applies them and persists
the result, refusing configs written by a newer tool (no downgrade).

- `swarm-dao config upgrade` — align an outdated config with the current
  schema version (idempotent, preserves all fields)
- `swarm-dao doctor` — new "config version" check: green when aligned,
  warn when the config is older (hint: `swarm-dao config upgrade`), fail when
  the config is newer than the tool (hint: upgrade swarm-dao)
