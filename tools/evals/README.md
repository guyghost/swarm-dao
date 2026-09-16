# Swarm DAO Evals

Gates, replayed as one battery. The suite in `suite.ts` mirrors the
anchor tables in [`models/README.md`](../../models/README.md) plus the
cross-cutting architecture and docs gates. Running it produces a
**scorecard**; comparing scorecards is the model-adoption loop:

```bash
bun run evals:list                                   # show the battery
bun run evals:run --label baseline                   # reference scorecard
# ... bind a candidate harness/model in .dao/config.json ...
bun run evals:run --label candidate
bun run evals:compare \
  --base evidence/evals/baseline.json \
  --candidate evidence/evals/candidate.json          # exit 1 on regression
```

Scorecards land under `evidence/evals/` (gitignored, like the other
evidence roots). `--filter <id-prefix>` reruns a slice; `--json <path>`
overrides the output path.

## Determinism boundary

The battery is deterministic: no LLM calls. It proves that the
*governance machinery* holds under a candidate binding (resolution,
machines, anchors, gates). Live-model scenario evals — dispatching
fixed prompts to a real agent via the herdr worker executor and
grading outputs with deterministic rubrics — are the deferred next
layer; they will emit scorecards in the same shape so `compare`
covers them unchanged.

## Live model scenarios

`evals:scenario` dispatches the fixed prompts in `scenarios.ts` to a real
agent through the same herdr worker executor the improvement series uses,
then grades the harvested answer with deterministic rubrics — never an LLM
judge. Requirements: herdr ≥ 0.9 and the harness CLI authenticated.

```bash
bun run evals:scenario --label live-baseline                        # kind pi, default model
bun run evals:scenario --label live-candidate --model z.ai/GLM-5.1  # candidate model
bun run evals:compare --base evidence/evals/live-baseline.json \
  --candidate evidence/evals/live-candidate.json                    # exit 1 on regression
```

`--kind` selects the herdr harness (pi, claude, codex, copilot, opencode);
`--model` is carried by the frozen per-harness flag table
(`packages/core/src/intelligence/runtime.ts`). The answer must end with the
standard worker JSON envelope (`driftClass: "none"` + filled `evidence`) —
that is the transport contract the executor's harvest predicate accepts;
scenario-specific fields ride alongside it and only they are graded.

Safety: the scenario agent runs in this checkout with prompts under a
read-only discipline. Run live scenarios on a clean tree (or a worktree
checkout) so an off-script agent cannot touch in-flight work.

## Automated PR review

`evals:review` is the first-pass reviewer for a small PR — deterministic
gates first, agent judgment second, both gated:

```bash
bun run evals:review                      # base = merge-base(origin/main, HEAD)
bun run evals:review --base main --label my-review
```

1. **Candidate battery** — the full gate suite on the current tree;
2. **Base battery** — the same suite in a throwaway `git worktree` at the
   merge-base, with `node_modules` staged so `@guyghost/*` links point at the
   worktree's own packages (candidate sources can never mask a regression);
   any passed→failed regression blocks;
3. **Changeset coverage** — `check:changesets` pinned to the merge-base;
4. **Agent review** — a real reviewer agent (herdr harness, `--kind`/`--model`)
   inspects the diff itself and returns a typed verdict in the worker
   envelope; the vocabulary is closed (`approve` | `changes-requested`), so a
   reworded approval cannot flip the outcome.

Exit 1 if any step fails. `--no-agent` skips step 4 for a fully
deterministic review (CI-friendly — no herdr or model access needed).
Scorecard lands in `evidence/evals/` like the
other runs, so adoption regressions and review verdicts diff with the same
tool.

## Layout

- `suite.ts` — gate suite data + scorecard types (pure)
- `scenarios.ts` — live scenario data + deterministic grading (pure)
- `review.ts` — review prompt + verdict grading (pure)
- `compare.ts` — scorecard diff (pure)
- `evalctl.ts` — CLI shell (list / run / scenario / review / compare)
- `tests/` — integrity, grading, and diff logic tests (`bun run test:tools`)
