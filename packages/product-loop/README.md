# @guyghost/swarm-dao-product

Swarm DAO product-loop run executor.

Runs the frozen product-loop machine (in `@guyghost/swarm-dao-core`) as
journal-replayed runs on disk. Every submitted signal is validated against the
producer-bound authority table: a producer may only emit the event types its
graph node declares, AI signals never carry owner-authority keys, and system
evaluation events are emitted by the runner only.

## Usage

```ts
import { createProductRunner } from "@guyghost/swarm-dao-product";

const runner = await createProductRunner({ evidenceRoot: ".dao/product-loops", runId: "my-run" });
const result = await runner.submit(signal);
```

Or through the CLI entry:

```ts
import { runProductCli } from "@guyghost/swarm-dao-product";
const code = await runProductCli(["status", "--run-id", "my-run"]); // 0 | 1 | 2
```

The `swarm-dao` CLI exposes the same surface as `swarm-dao product
<init|status|submit>`; exit codes are 0 (success), 2 (machine rejection),
1 (usage or execution error).
