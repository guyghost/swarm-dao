# ADR-002: Hexagonal Functional Core

## Status

Accepted (2026-07-15)

## Context

ADR-001 unified duplicated host implementations into one monorepo and a shared package.
That package subsequently accumulated business rules, host orchestration, filesystem persistence,
HTTP integrations, shell execution, global process state, and Markdown rendering. The outer
host/core boundary remained useful, but the internal dependency boundaries were no longer explicit.

## Decision

Evolve the unified monolith into a hexagonal architecture with a functional core and imperative shell:

- `/models`: executable XState workflows and invariants;
- `domain`: pure calculations and policies;
- `application`: use cases returning structured results;
- `ports`: narrow interfaces for repositories, AI workers, clocks, commands, logging, and workspaces;
- `adapters`: instance-owned implementations for filesystems and hosts;
- `presenters`: Markdown, JSON, and CLI projections.

Existing package entry points remain compatible during migration. Compatibility exports and adapters
may delegate to the new architecture, but new application code must not depend on them.

## Consequences

### Positive

- business behavior is testable without filesystem, network, ambient time, or host mocks;
- multiple DAO roots can coexist through isolated repository instances;
- host capabilities can evolve independently through narrow ports;
- state transitions remain deterministic and model-owned;
- presentation formats can evolve without changing workflows.

### Negative

- migration temporarily retains compatibility surfaces;
- use cases and presenters add explicit types and files;
- host packages must own and inject repository instances.

## Deferred alternatives

Event sourcing is deferred until asynchronous execution, replay, multi-process concurrency, or recovery
requirements justify it. Microservices are rejected until an independently deployable or scalable boundary
emerges from observed runtime needs.
