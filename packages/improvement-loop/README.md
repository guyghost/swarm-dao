# @guyghost/swarm-dao-improvement

Executor for the Swarm DAO **improvement loop**: continuous improvement series
over journal-replayed cycles, with AI workers as real coding agents (via
[herdr](https://herdr.dev)) and bounded sandbox execution of ground-truth gate
commands (Docker or Apple container).

The machines — the only state authority for cycles and series — live in
`@guyghost/swarm-dao-core/models/improvement`. This package is the executor:
it journals every signal, persists evidence, and executes exactly the effect
the current state authorizes. Free-form text and AI output can never forge a
state transition, select a reference, or waive a gate.

## Use from the CLI

```bash
swarm-dao improve init --series-id s1 --scope ci-health --reference-hash <sha256> --cooldown-ms 60000
swarm-dao improve status --series-id s1
swarm-dao improve once --series-id s1 --sandbox container --image node:22-bookworm
swarm-dao improve submit --series-id s1 --event retry.json
```

The project binds its ground-truth gates in `.dao/improvement.json`:

```json
{
  "anchorCommands": {
    "drift-audit": "npm test",
    "anchor-reality": "npm run build",
    "frozen-set-intact": "npm run lint",
    "regression": "npm run typecheck"
  },
  "sandbox": { "mode": "container", "image": "node:22-bookworm" }
}
```

Exactly the four command-backed anchors (`counter-metric-paired` and
`arbitration-policy` are recorded automatically by the machine). Unknown,
missing, or machine-recorded anchors fail config validation.

### Metric contract (optional)

Without a declared metric, every sensor invents its own "obvious" metric for
the scope — samples stop being comparable across workers and cycles. Bind the
scope's optimizing metric (and its counter-metric) explicitly:

```json
{
  "metric": {
    "name": "backtest-primary-eval-v2",
    "prompt": "Primary metric: net absolute PnL per eval-v2 run over the frozen dataset. Counter-metric: activeSignalRate drift.",
    "evidence": "docs/backtest-diagnostics.md"
  }
}
```

`name` and `prompt` are required together; `evidence` is optional. The
sensor/counter-sensor prompts embed the contract verbatim, so paired samples
measure the same quantity (issue #142).

## Sandbox

`--sandbox docker|container|auto|none` (with `--image`) runs every anchor
command inside a throwaway container: repository mounted at `/workspace`,
**network disabled**, CPU/memory capped. Apple `container` is detected first
on `auto`; a missing runtime fails loudly instead of degrading to the host. A
flagged gate failure never runs on the host implicitly — bounded means bounded.

**Defaults:** when `--sandbox` / `sandbox.mode` is omitted, the executor uses
**`auto`** (fail-closed if no container runtime). Host anchors require an
explicit `none` (CLI flag or `.dao/improvement.json`).

## Execution environments

`improve once --exec branch|worktree|container` selects where the series runs
(executor configuration — never model state):

- `branch` (default): workers and anchor commands run in the current checkout.
- `worktree`: an idempotent git worktree per series — branch
  `dao/loop/<series-id>`, path `.dao/worktrees/<series-id>`. Workers observe
  and anchors execute inside the pinned checkout; the gitignored
  `.dao/improvement.json` is re-synced into the worktree on every prepare.
  Series and cycle evidence stays in the repository's own evidence roots. The
  worktree is never removed automatically (`git worktree remove` is an
  operator decision; the branch survives for the next cycle).
- `container`: anchor commands run in a throwaway bounded container (sandbox
  mode `auto` unless `--sandbox` narrows it). Workers are herdr agents on the
  host — herdr needs a terminal pane, so it never runs inside the image.

`--exec worktree` composes with `--sandbox`: the sandbox mounts the worktree.

## Worker agents

Improvement workers run as real coding agents in [herdr](https://herdr.dev)
workspaces. `--agent <kind>` selects the executable (`pi`, `codex`, `claude`,
`gemini`, `cursor`, … — whatever herdr supports and you have installed);
defaults to `pi` or the `worker.kind` field of `.dao/improvement.json`:

```json
{ "worker": { "kind": "codex", "agentArgs": ["--sandbox", "read-only"] } }
```

`--agent-args "…"` (whitespace-separated) overrides the kind's default extra
arguments. Only `pi` carries defaults (`-ne`: signal-only workers must not
discover the dao_* extension tools); other kinds start with their own
defaults. Kind identifiers are validated — anything else is refused, never
interpolated into a shell command.

### Harvest pacing

Workers are harvested by polling the transcript (`pollIntervalMs`, default
5 s). The attempt ends when the last JSON object satisfies the worker
contract, the output has been stable for `stablePolls` consecutive polls
(default 36 ≈ 3 min — long enough that a worker running an uncached gate
command is not killed mid-command, issue #180), or `timeoutMs` (default
900000) expires. Repos with longer gate suites can widen the window via the
`worker` section:

```json
{ "worker": { "pollIntervalMs": 15000, "stablePolls": 24, "timeoutMs": 900000 } }
```

Non-numeric values are refused; out-of-range numbers are clamped to the
executor's bounds.

## Programmatic use

```typescript
import { OrchestratorRunner, resolveAnchorCommands } from "@guyghost/swarm-dao-improvement";

const runner = await OrchestratorRunner.create({ seriesId: "s1", evidenceRoot: ".dao/improvement-series" });
const result = await runner.once({ workDir: process.cwd() });
```

`runner.once()` executes exactly one state-authorized effect per call
(init cycle, sample, seal, audit, arbitrate, anchor, evaluate, observe,
cooldown); loop it to drive a series.
