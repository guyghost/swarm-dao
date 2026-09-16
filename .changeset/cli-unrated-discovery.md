---
"@guyghost/swarm-dao-cli": minor
---

Surface shipped-but-unrated proposals so the retro loop actually gets closed:

- `swarm-dao list --unrated` — executed proposals with no outcome rating,
  with a `close the loop: swarm-dao rate <id> ...` hint.
- `swarm-dao next` (and `watch`) gains a read-only "Retro loop" section
  listing shipped-but-unrated proposals with the exact rating command. It is
  fully silent in projects without a DAO and never creates `.dao/` as a side
  effect.

Closes the discovery gap left after the `rate` command (#190/#192): ratings
no longer stay pending invisibly.
