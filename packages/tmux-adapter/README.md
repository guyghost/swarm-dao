# Swarm DAO tmux Adapter

The swarm-forge execution model for Swarm DAO deliberation: **each agent runs
as its own detached tmux pane** — watchable live by the operator (`tmux
attach`), isolated from every other agent, with completion observable through
filesystem markers.

```
.swarm-dao-p1-strategist   ← pane running the strategist's agent CLI
.swarm-dao-p1-critic       ← pane running the critic's agent CLI
...
```

## How it works

For every agent the adapter:

1. Writes the deliberation prompt to `.dao/tmux/<proposalId>/<agentId>/prompt.md`
   (stale completion markers from previous runs are purged first).
2. Starts a detached tmux session whose **program** is
   `sh -c 'PROMPT="$(cat prompt.md)"; <command> > output.md 2> stderr.log; printf "%s" "$?" > done'`
   — the command runs as the session program, so there is no typing race with
   the pane shell.
3. Polls for the `done` marker up to `timeoutMs`.
4. Harvests `output.md` as the agent's output (exit code and `stderr.log`
   surface as an error output), and kills the session unless `keepSessions`
   is set (which leaves the pane's scrollback alive for inspection).

The outputs feed the **same deterministic tally** as every other host — no AI
authority, no proposal-state mutation.

## Configuration

`.dao/config.json`:

```json
{
  "tmux": {
    "command": "claude -p \"$PROMPT\"",
    "timeoutMs": 300000,
    "sessionPrefix": "swarm-dao",
    "keepSessions": false
  }
}
```

- `command` (**required** for deliberation): the agent CLI. `$PROMPT` carries
  the deliberation prompt; stdout is captured as the agent's output.
- `timeoutMs`: per-agent timeout (default 5 min). A timeout kills the session
  and records a deterministic error output.
- `sessionPrefix`, `keepSessions`: session naming and pane retention.

## Usage

```typescript
import { createTmuxHostAdapter } from "@guyghost/swarm-dao-tmux-adapter";
import { loadConfig, handleDaoDeliberate } from "@guyghost/swarm-dao-core";

const config = await loadConfig(".dao");
const adapter = createTmuxHostAdapter({
  workDir: process.cwd(),
  command: config.tmux?.command,
});

const result = await handleDaoDeliberate(
  { adapter, workDir: process.cwd(), deliberationMode: "auto", controlToolName: "dao_check" },
  1,
);
```

## Boundary

Deliberation is read-only analysis: agents share the repository checkout for
context and never need per-agent worktrees. Execution-side isolation stays
with the delivery layer's `GitWorkspace` (`execution.isolation`).

## Testing

```bash
bun test packages/tmux-adapter          # unit (fake tmux) + real tmux (skipped if absent)
```
