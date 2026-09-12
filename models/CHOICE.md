# Choosing the Right Workflow

One-page guide. All workflows share the same contract: pure XState models own
their state, AI workers emit signals only, humans approve exact hashes, evidence
is journaled. See `models/README.md` for invariants.

| Goal | Use | Owns | Persists |
|------|-----|------|----------|
| Ship an existing proposal (`approved`/`controlled` → `executed`) | Ship audit (`models/ship-audit.md`) | `fresh→challenged→confirmed` only | `.dao/ship-audits/` |
| Implement a local repo change with review gates | Graph Engineering (`models/graph-engineering.md`) | change-run `draft→…→succeeded\|failed` | `evidence/graph-runs/` (gitignored) |
| Calibrate a metric against its counter-metric | Improvement loop (`models/improvement-loop.md`) | cycle `sampling→…→succeeded\|adjusting` | `evidence/improvement-cycles/` (gitignored) |
| Run repeated improvement cycles on fixed scope | Improvement orchestrator (`models/improvement-orchestrator.md`) | series correlation only, owns nothing | `evidence/improvement-series/` (gitignored) |
| Continuous product discovery → ship → observe | Product loop (`models/product-loop.md`) | run `exploration→…→validated` | evidence, never `.dao/` proposals |
| Govern roadmap (proposals, votes, gates) | Proposal lifecycle (`models/README.md`) | `open→…→executed\|rejected\|failed` | `.dao/state.json` — sole authority |

Rules:

- Only the proposal machine mutates `.dao/` proposal status. All other models
  set `proposalStateAuthority: "none"` and correlate via immutable `proposalId`.
- Sandboxed execution (ADR-003) is an authorized effect of `controlled`, not a model.
- When in doubt: proposal for *what*, graph for *how (one change)*,
  improvement for *how well (metric)*, product for *continuous flow*,
  ship-audit for *confirm ship*.
