---
"@guyghost/swarm-dao-core": patch
"@guyghost/swarm-dao-cli": patch
---

Fix five latent core defects found in the bug hunt:

- Normalize batch size in `dispatchSwarm`/`runRoundTable` so a zero/negative/NaN
  `maxConcurrent` (editable config or `config-update` amendment) can no longer
  stall deliberation forever; the amendment now rejects a non-positive value.
- Repair and validate `state.json` `config` on load: a partial `{ "config": {} }`
  used to replace the whole default and crash `runGates`/`tallyVotes`.
- Emit raw `le` bucket boundaries in the Prometheus exposition instead of the
  internal `le_10` keys.
- Bound RICE inputs before scoring so `effort: 0` no longer yields `Infinity`.
- Share the tally's vote-heading matcher with the sequential pipeline so the
  rendered `Vote`/`Vote:` form cannot leak an upstream vote into later analyses.

Second pass (low-severity hardening):

- Risk classification now matches security keywords on word boundaries:
  "author"/"authoritative" no longer force the red zone, while authentication,
  authorization, token, password, etc. still do.
- Amendments reject non-numeric / out-of-range agent weights and refuse to add
  a duplicate agent id (identity keys must stay unique).
- The ship-audit claim is held until the confirmation is consumed, so two
  concurrent confirms can never proceed from one challenge (INV-6); callers
  release it on error paths.
- Decision-brief approval score uses the decisive (non-abstain) weight, matching
  `tallyVotes`.
- Git ref validation rejects consecutive `/` segments, as documented.
