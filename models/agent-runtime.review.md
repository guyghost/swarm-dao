# Review — Agent Runtime Model

Review of `models/agent-runtime.md` against `models/CONTRACT.md` obligations
(nominal paths, errors, cancellations/retries, permissions, terminal states, AI boundary).

## Coverage matrix

| Obligation | Covered | Where |
|---|---|---|
| Nominal cases | yes | D1 rows 1–3, D2, D3 rows 1 & 3, host table nominal rows |
| Error cases | yes | E1–E5, E-host (pi), per-agent failure semantics §5 |
| Cancellation / retry | n/a → yes | Resolution is instantaneous and stateless (§2); there is no long-lived operation to cancel or retry. Spawn-level timeout/retry stays with existing adapter behavior — unchanged by this model. |
| Permissions / authority | yes | I2, I3: only configuration and code select runtimes; no `.dao/` writes; proposal machine remains sole `.dao/` authority |
| Terminal states | yes | Every failure is a typed terminal result for the affected dispatch; no partial or dangling state (§5) |
| LLM / AI boundary | yes | I2 + §2: agent output cannot select harness/model/flag |
| Determinism / representability | yes | I1, I4; decision tables D1–D4 total and closed |
| Security (injection) | yes | §4.1, §4.2, D3 validation; I5 ARGV-only transport; tmux commands remain operator-owned config |

## Findings

1. **Stateless rationale is sound.** No XState machine is required; forcing one would add
   states with no transitions. The contract tables are exhaustive and closed, satisfying
   "si le comportement ne peut pas être modélisé, il n'est pas prêt à être implémenté".
2. **Precedence conflict resolved explicitly.** `runtime.defaultHarness` > `herdr.kind` is
   documented (D1 note) — no implicit transition.
3. **Silent-drop hazard closed.** E4 forbids silently dropping an explicit model when the
   flag is unknown; remediation text is part of the contract.
4. **Manual hosts are advisory-only by design.** MCP hosts render instructions; the human
   remains the spawn authority there. This matches existing dispatch-plan semantics.
5. **Residual risks accepted.**
   - Flag table correctness is external knowledge (verified 2025: pi/claude/codex/copilot/
     opencode all accept `--model`); config override `runtime.harnessModelFlag` is the
     documented escape hatch, so a wrong table entry is operator-repairable without code.
   - tmux `agentCommands` trust level is identical to the existing global `command`
     (operator-owned); no new attack surface.
   - herdr kind existence is validated by herdr itself at spawn; its error surfaces through
     the existing agent-error channel (unchanged semantics).

## Verdict

**Approve for implementation**, contingent on exact-hash human approval. Test obligations
(§8 of the model) are binding: RED tests must exist before implementation lands.
