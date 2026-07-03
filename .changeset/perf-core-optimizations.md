---
"@guyghost/swarm-dao-core": patch
---

Core performance optimizations across handlers, governance, persistence and HTTP

A set of internal hot-path optimizations with no public API changes. On-disk
state and observable behavior are unchanged; only redundant work is removed.

- Governance handlers: dropped redundant trailing `saveState()` after
  `recordAudit` (which persists internally) in the propose/execute/amend paths.
  The round table now appends audit entries in memory and persists them in a
  single trailing save instead of one full save per proposal (O(k) -> O(1)).
- Deliberation/round-table dispatch: resolve agents through a lookup `Map`
  built once per batch instead of a per-iteration `find()` scan.
- Agent definitions: `loadAgentDefinitions` results are cached per agents
  directory and validated by a file-stat signature, so `dao-*.md` files are not
  re-read from disk on every `dao_deliberate` / `dao_roundtable` call.
- Dependency resolver: build the proposal `Map` once in
  `resolveDependencyOrder` / `getUnexecutedDependencies` and reuse it instead
  of rebuilding it per proposal during the DFS traversal.
- Error redaction: the sensitive-key regexes in `sanitizeErrorMessage` are now
  compiled once at module load and reused, instead of being rebuilt on every
  call (byte-identical redaction output).
- Scoring parser: `parseScoresFromOutput` makes a single `matchAll` pass over
  the agent output instead of running one regex per scoring axis; composite
  averaging uses a single reduce. Parsing results are unchanged.
- HTTP client: add retry with exponential backoff + jitter for transient
  failures (network errors, 429, 5xx), honoring `Retry-After` with a sane cap,
  while never retrying definitive 4xx. A per-instance fetch injection seam is
  added for testability with zero production behavior change.
