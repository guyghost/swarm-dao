---
"@guyghost/swarm-dao-improvement": patch
"@guyghost/swarm-dao-cli": patch
---

Fail fast on concurrent improvement runners instead of corrupting journal.ndjson (issue #139): the series journal sequence lived only in the running process's memory, so two `improve once`/`improve submit` processes on the same series interleaved appends and produced a duplicate sequence — after which every command failed the sequence contract and the series was unreadable without manual repair. Every append now re-reads the journal tail first and aborts with a clear, recoverable `concurrent improvement runner detected` error when another writer advanced the file (nothing is written; re-running reloads the state). Also completes `improve` usage/error help with the cycle- and series-level human-gate subcommands (`retry`, `reference`, `cancel-cycle`, `retry-workers`, `restart`, `cancel`, `cycles`), which shipped in CLI 0.5.0 but were missing from the short usage string.
