# @guyghost/swarm-dao-graph

Swarm DAO Graph Engineering run executor.

Runs the frozen Graph Engineering machine (in `@guyghost/swarm-dao-core`) as
journal-replayed runs on disk: every submitted signal is validated (AI signals
never carry state targets, commands, approvals, retries, cancellations, or
permission decisions), journaled to `journal.ndjson`, and the snapshot is
persisted for deterministic replay.

## Usage

```ts
import { createGraphRunner, validateGraphSignal } from "@guyghost/swarm-dao-graph";

const runner = await createGraphRunner({ evidenceRoot: ".dao/graph-runs", runId: "my-run" });
const result = await runner.submit(signal);
```

Or through the CLI entry:

```ts
import { runGraphCli } from "@guyghost/swarm-dao-graph";
const code = await runGraphCli(["status", "--run-id", "my-run"]); // 0 | 1 | 2
```

The `swarm-dao` CLI exposes the same surface as `swarm-dao graph
<init|status|submit>`; exit codes are 0 (success), 2 (machine rejection),
1 (usage or execution error).
