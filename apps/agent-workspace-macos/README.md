# Agent Workspace for macOS

This is the first native macOS vertical slice of Swarm DAO's local Agent Workspace. It is a distinct SwiftPM/SwiftUI project inside the monorepo.

The shared mission conversation is the primary surface. Agent process details are projected only into the agent inspector. Mission and agent lifecycle decisions are owned by the XState models in `packages/core/src/models`; SwiftUI receives projections and model-derived commands through a closed local NDJSON protocol.

## Run

```sh
./script/build_and_run.sh
```

Use `--verify`, `--debug`, `--logs`, or `--telemetry` for the corresponding local workflow. The script builds the app-specific XState host, builds the SwiftUI executable, stages `dist/AgentWorkspace.app`, embeds the host in `Contents/Resources`, and launches the bundle.

## Scope boundary

This slice intentionally contains no adapter catalogue, adapter manifests, generic runtime integration, configuration assistant, or private-conversation UI. Direct visibility remains decodable for a later milestone. The local worker is a deterministic process boundary; it emits structured signals and never chooses a model transition.
