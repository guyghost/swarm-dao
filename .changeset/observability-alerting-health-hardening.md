---
"@guyghost/swarm-dao-core": patch
---

Harden the observability/summary surfaces flagged in the bug hunt:

- Alert rules can read a histogram aggregate (`count` | `sum` | `avg` | `p50` |
  `p95` | `p99`); the default "High Deliberation Time" rule now reads `p95` as
  its description always claimed, instead of comparing the observation count.
  The never-implemented `duration` field is removed from `AlertRule`.
- `formatHealthScore` emits a well-formed metric table (header now matches the
  rows, and each row carries its closing pipe).
- `config.maxVoteWeight` is accepted by the `config-update` amendment with a
  bound (`finite number >= 1`); a below-1 value is rejected because it would
  make `addVoteOn` reject every vote. `repairConfig` drops an invalid
  `maxVoteWeight` from a hand-edited `state.json` for the same reason.
- `HostAdapter.spawnAgents` is documented as a raw-prompt parallel fan-out with
  no dispatch layer.
