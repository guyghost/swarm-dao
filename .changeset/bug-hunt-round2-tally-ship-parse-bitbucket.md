---
"@guyghost/swarm-dao-core": patch
---

Fix six defects found in the bug hunt (round 2), each with a reproduction test:

- Red-zone classification reads the whole proposal, not just `title`/`description`
  (problem statement, acceptance criteria, context, success metrics, rollback
  conditions, affected paths, structured `content`), and `UpdateProposalUseCase`
  reclassifies after an edit — a security-sensitive statement added after creation
  can no longer stay orange and skip the mandatory red-zone dry-run.
- `tallyVotes` counts abstentions in `votingAgents`: an abstention is a cast vote
  (it already weighs into the quorum), so "Votes Cast: X / Y" no longer
  under-reports participation.
- The ship-audit confirmation is spent only when the ship actually happened: a
  failed `dao_ship` (`ok: false`, e.g. unexecuted dependencies) now releases the
  claim without consuming the confirmation, so the unchanged retry proceeds
  instead of forcing a fresh two-call challenge cycle.
- `parseDeliveryPlan` accepts the em-dash separator `formatPlan` emits, so a
  self-produced plan no longer re-parses with zero tasks (silent data loss).
- Bitbucket configuration validates `workspace`/`repo` at the chokepoint
  (GitHub #166 parity) and the API routes percent-encode the slugs and the base
  branch — a `/` in `workspace`, `repo`, or a branch name like `feature/x` can no
  longer re-route the request or 404.
