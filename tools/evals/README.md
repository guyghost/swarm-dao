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

## Layout

- `suite.ts` — suite data + scorecard types (pure)
- `compare.ts` — scorecard diff (pure)
- `evalctl.ts` — CLI shell (list / run / compare)
- `tests/` — integrity and diff logic tests (`bun run test:tools`)
