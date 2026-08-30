# Swarm DAO herdr Adapter

Run each Swarm DAO deliberation agent as a **real coding agent inside a
[herdr](https://herdr.dev) workspace** — "the runtime your coding agents live
on". herdr owns the agent's terminal and tracks its lifecycle
(`working` / `idle` / `blocked` / `done`); the operator can attach to any
agent pane live with `herdr` and watch it think.

```
herdr workspace: swarm-dao-p1-strategist   ← real pi/claude/codex/grok… agent
herdr workspace: swarm-dao-p1-critic       ← another agent, another workspace
```

## How it works

For every agent, the adapter:

1. Creates an **isolated herdr workspace** (one root pane, `--no-focus` —
   it never touches your existing layout).
2. Starts the agent: `herdr agent start <name> --kind <kind>` — blocks until
   herdr detects the agent is ready for input.
3. Submits the deliberation prompt: `herdr agent prompt <name> '<prompt>'
   --wait` — settles on `idle`, `done`, or `blocked`.
4. Harvests the ANSI-stripped terminal transcript:
   `herdr agent read <name> --source recent-unwrapped`.
5. Closes the workspace (unless `keepPanes`).

A **blocked** agent (approval/question UI) surfaces as an error output,
never as a vote. Outputs feed the same deterministic tally as every other
host — no AI authority, no proposal-state mutation.

## Prerequisites

- `herdr` installed (`brew install herdr`) and the **server running**
  (run `herdr` once in any terminal)
- The chosen kind's executable installed and authenticated (`pi`, `claude`,
  `codex`, `gemini`, `cursor`, `grok`, `opencode`, …)

## Usage

```typescript
import { createHerdrHostAdapter } from "@guyghost/swarm-dao-herdr-adapter";
import { loadConfig, handleDaoDeliberate } from "@guyghost/swarm-dao-core";

const adapter = createHerdrHostAdapter({
  workDir: process.cwd(),
  kind: "pi", // or "claude", "codex", "grok", …
  // agentArgs: ["-m", "gpt-5.4"],       // passed to the agent executable
  // timeoutMs: 300_000,                 // per-agent prompt timeout
  // keepPanes: true,                    // keep workspaces for inspection
});

const result = await handleDaoDeliberate(
  { adapter, workDir: process.cwd(), deliberationMode: "auto", controlToolName: "dao_check" },
  1,
);
```

## Boundary

Deliberation is read-only analysis: agents share the repository checkout for
context (each workspace's cwd is the repo root). Execution-side isolation
stays with the delivery layer's `GitWorkspace` (`execution.isolation`).

## Testing

```bash
bun test packages/herdr-adapter          # unit (fake runner) + real-server error path
HERDR_IT=1 bun test packages/herdr-adapter   # + full round-trip with a real agent
                                            # (HERDR_KIND, HERDR_KEEP to tune)
```
