# XState Proposal Lifecycle Machine

Typed proposal lifecycle orchestration using an XState v5 machine.

## Architecture

The machine drives a proposal through the full governance pipeline:

```text
DRAFT -> INTAKE -> QUALIFICATION -> ANALYSIS -> CRITIQUE -> SCORING
          \                                           /
           \------------------ REJECT ---------------/

SCORING -> COUNCIL -> VOTING -> SPEC_DRAFT -> SPEC_REVIEW -> EXECUTION_GATE
               \          \            \                  \         /
                \---------- REJECT ----- REJECT ---------- REJECT --/

EXECUTION_GATE -> EXECUTING -> POSTMORTEM -> COMPLETED
        \             \
         \             -> EXECUTION_ERROR -> RETRY (max 3)
          \
           -> REJECTED
```

## Core Types

### `ProposalContext`

```ts
interface ProposalContext {
  proposal: Proposal; // The wrapped proposal
  stage: PipelineStage; // Current pipeline stage
  status: ProposalStatus; // Current proposal status
  riskZone?: RiskZone; // green | orange | red
  deliberationCount: number; // Deliberation cycles count
  retryCount: number; // Execution retry attempts
  errorMessage?: string; // Latest error, if any
  lastTransitionTime: string; // ISO8601 timestamp of latest transition
}
```

### `ProposalEvent`

Supported events:

- `SUBMIT`, `QUALIFY`, `ANALYZE`, `CRITIQUE`, `SCORE`
- `SEND_TO_COUNCIL`, `VOTE`, `APPROVE`, `REJECT`
- `REQUEST_SPEC`, `REVIEW_SPEC`, `APPROVE_SPEC`
- `EXECUTION_GATE_PASS`, `EXECUTION_GATE_FAIL`, `EXECUTE`
- `EXECUTION_SUCCESS`, `EXECUTION_FAILED`, `POSTMORTEM`
- `RETRY`, `DISCARD`, `ERROR`

## Usage

### Create an actor

```ts
import { createProposalActor } from "@guyghost/swarm-dao-core/governance";
import type { Proposal } from "@guyghost/swarm-dao-core/types";

const proposal: Proposal = {
  id: 1,
  title: "Add feature X",
  type: "product-feature",
  description: "...",
  proposedBy: "agent-1",
  status: "open",
  votes: [],
  agentOutputs: [],
  createdAt: new Date().toISOString(),
};

const actor = createProposalActor(proposal);
```

### Send events and read state

```ts
import {
  getProposalContext,
  getProposalState,
  sendProposalEvent,
} from "@guyghost/swarm-dao-core/governance";

sendProposalEvent(actor, { type: "SUBMIT" });
sendProposalEvent(actor, { type: "QUALIFY" });

console.log(getProposalState(actor)); // "qualification"
console.log(getProposalContext(actor).status); // "open"
```

### Check and list available transitions

```ts
import {
  canSendProposalEvent,
  getAvailableProposalEvents,
} from "@guyghost/swarm-dao-core/governance";

if (canSendProposalEvent(actor, "ANALYZE")) {
  sendProposalEvent(actor, { type: "ANALYZE" });
}

console.log(getAvailableProposalEvents(actor));
```

### Auto-progress helper

```ts
import { progressProposal } from "@guyghost/swarm-dao-core/governance";

while (progressProposal(actor)) {
  // keep moving through the linear path
}
```

### Observe state changes

```ts
import { onProposalStateChange } from "@guyghost/swarm-dao-core/governance";

const unsubscribe = onProposalStateChange(actor, (state, context) => {
  console.log(state, context.stage, context.status);
});

unsubscribe();
```

## Validation

Proposal machine tests live in:

- `packages/core/tests/proposal.machine.test.ts`

Run focused checks:

```bash
bun run --cwd packages/core build
bun run --cwd packages/core lint
bun run --cwd packages/core test -- proposal.machine.test.ts
```
