# Shared Workflow Contract

Invariants every model in `models/` obeys. Individual model docs keep only
their states, events, and anchors — everything below lives here.

1. **Single state owner.** The proposal machine owns proposal status
   (`open→deliberating→approved→controlled→executed|failed|rejected`).
   All other machines set `proposalStateAuthority: "none"`.
2. **Correlation, never mutation.** A run may carry an immutable `proposalId`
   (or `scope`/`cycleId`). That value grants no permission and causes no
   transition in any other machine.
3. **Pure models.** No I/O, clock, randomness, or host SDK in models/domain.
   Application orchestrates models + ports; adapters perform effects.
4. **AI = signals only.** Workers (`sensor`, `modeler`, `explorer`, agents…)
   produce typed signals. Deterministic policies (tally, arbitrator,
   anchor-verifier) select events. No LLM-driven transition.
5. **Human authority.** Budget expansion, scope reduction, retry, cancel,
   reference changes, and ship bypass are human events with exact-hash
   approval (`MODEL_APPROVED`, `REFERENCE_CHANGE_APPROVED`, `FORCE_OVERRIDE`…).
6. **Terminal immutability.** Terminal states never transition. Rollback is a
   compensating technical action from a snapshot, not a rewrite.
7. **Evidence.** NDJSON journal + snapshot per run, SHA-256 ordered manifest,
   frozen command set in `*.graph.json`. `evidence/*` is gitignored;
   only ship-audit persists under `.dao/ship-audits/` via an injected port.
8. **Wrong-source rejection.** Events from a non-owning source are rejected
   and journaled, never applied.

Anchors pattern (6 per workflow): `validate` (contract) → graph tests →
wiring → runtime scenario (`demo`) → `anchors` (ground contact) → `regression`.
