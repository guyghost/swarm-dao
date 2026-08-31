# Swarm DAO CLI (`swarm-dao`)

Standalone command-line interface for [Swarm DAO](https://github.com/guyghost/swarm-dao) —
multi-agent AI governance for your repositories: swarm deliberation on proposals,
deterministic quality gates, a continuous improvement loop driven by real coding
agents, and bounded sandbox execution.

Works in **any project**: all state lives in a `.dao/` directory at the project root.

## Installation

```bash
npm install -g @guyghost/swarm-dao-cli
```

Requires [Bun](https://bun.sh) ≥ 1.3 on your `PATH` (the binary runs through it)
and `git`. Apple `container` (macOS 26+) and/or Docker are optional, for
sandboxed gate execution.

From source:

```bash
git clone https://github.com/guyghost/swarm-dao.git
cd swarm-dao && bun install
bun run --filter '@guyghost/swarm-dao-cli' build
bun packages/cli/dist/cli.js --help
```

## Configuration

### 1. Project storage

```bash
cd your-project
swarm-dao init    # creates .dao/ (proposals, state, config, audit trail)
swarm-dao setup   # seeds the 7 default agents
```

### 2. GitHub integration (optional — for branch/PR automation)

```bash
swarm-dao github-config --token <github-token> --owner myorg --repo myrepo
```

The token is redacted in `.dao/config.json`; to avoid re-entering it, export
`DAO_GITHUB_TOKEN`.

### 3. Improvement loop (optional)

Declare the project's ground-truth gates in `.dao/improvement.json`:

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

Exactly those four anchors are required — `counter-metric-paired` and
`arbitration-policy` are recorded automatically by the machine and cannot be
overridden. The `sandbox` section is optional: `mode` is `none` (default),
`docker`, `container` (Apple), or `auto`; `image` is the OCI image gates run
in. Evidence accumulates under `.dao/improvement-series/` and
`.dao/improvement-cycles/` (override with `--evidence-root` / `--cycle-root`).

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Initialize the `.dao/` storage directory |
| `setup` | Seed the default agents |
| `config` | Print the DAO configuration |
| `status` | Show DAO status |
| `propose` | Create a proposal |
| `list` | List proposals (`--status`, `--type`) |
| `show <id>` | Show full proposal details |
| `vote <id>` | Cast an agent vote |
| `ship <id>` | Execute an approved proposal |
| `github-config` | Configure the GitHub integration |
| `github-branch <id>` | Create the proposal's GitHub branch |
| `github-pr <id>` | Open a pull request for a proposal |
| `audit` | View the audit trail (`--proposal <id>`) |
| `attention` | List pending human gates across workflow runs |
| `improve` | Run an improvement loop series (see below) |
| `help` | Full help |

### Proposals

```bash
swarm-dao propose --title "Add dark mode" --type product-feature \
  --description "Implement dark theme for the app" [--by <name>] [--depends-on <id1,id2>]

swarm-dao vote 1 --position for --reasoning "Low risk, high impact" --weight 3 [--agent <name>]

swarm-dao ship 1 [--cascade]      # --cascade ships unexecuted dependencies first
swarm-dao ship 1 --force          # skip dependency checks (recorded bypass)
```

Proposal types: `product-feature`, `security-change`, `technical-change`,
`release-change`, `governance-change`.

## The improvement loop

A **series** runs repeated **cycles** over a fixed scope and reference. Each
cycle: two AI sensors sample the optimizing and counter metrics, a drift
auditor compares behavior to the reference, a deterministic arbitrator
combines the pair (the counter-metric can veto), the project's gate commands
run as anchors, and the cycle ends `succeeded`, `adjusting` (human must review
the reference), `retrying`, or `failed`. Evidence is journaled and replayed
deterministically — a state transition is only ever produced by the machine.

```bash
# Reference = sha256 of the reference commit id (the state gates must match).
REF=$(echo -n "$(git rev-parse HEAD)" | shasum -a 256 | cut -d' ' -f1)

swarm-dao improve init --series-id s1 --scope ci-health \
  --reference-hash "$REF" --cooldown-ms 60000

swarm-dao improve once --series-id s1 --sandbox container --image node:22-bookworm
```

`once` executes exactly **one** state-authorized effect (init cycle → sample →
seal → audit → arbitrate → anchor → evaluate → observe → cooldown) and prints
the resulting state as JSON. Loop it — from a script, a cron job, or an agent —
to drive the series.

```bash
swarm-dao improve status --series-id s1

# Human decisions flow through events (the only human channel):
echo '{"type": "RETRY_WORKERS", "source": "human"}' > retry.json
swarm-dao improve submit --series-id s1 --event retry.json
```

Human events: `RETRY_WORKERS`, `RESTART_SERIES`, `CANCEL_SERIES` (with a
reason). AI workers are signal-only: they can never select a state, change the
reference, or waive a gate — every run's boundary is journaled.

### Sandboxed gates

`--sandbox docker|container|auto|none --image <ref>` runs every gate command
inside a throwaway container: repository mounted at `/workspace`, **network
disabled**, CPU/memory capped. `auto` prefers Apple `container` (macOS 26+),
then Docker; a requested runtime that is missing fails loudly instead of
falling back to the host. Defaults come from the `sandbox` section of
`.dao/improvement.json`.

### Exit codes

`0` success · `2` the state machine rejected the event (journaled) · `1` usage
or execution error.

## Requirements

- Bun ≥ 1.3, git
- For worker execution (sampling/audit phases): [herdr](https://herdr.dev) and
  a coding agent CLI (e.g. `pi`)
- For sandboxed gates: Docker and/or Apple `container`
