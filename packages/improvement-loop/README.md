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

## Sandbox

`--sandbox docker|container|auto|none` (with `--image`) runs every anchor
command inside a throwaway container: repository mounted at `/workspace`,
**network disabled**, CPU/memory capped. Apple `container` is detected first
on `auto`; a missing runtime fails loudly instead of degrading to the host. A
flagged gate failure never runs on the host implicitly — bounded means bounded.

## Programmatic use

```typescript
import { OrchestratorRunner, resolveAnchorCommands } from "@guyghost/swarm-dao-improvement";

const runner = await OrchestratorRunner.create({ seriesId: "s1", evidenceRoot: ".dao/improvement-series" });
const result = await runner.once({ workDir: process.cwd() });
```

`runner.once()` executes exactly one state-authorized effect per call
(init cycle, sample, seal, audit, arbitrate, anchor, evaluate, observe,
cooldown); loop it to drive a series.
