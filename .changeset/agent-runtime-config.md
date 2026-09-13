---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-tmux-adapter": minor
"@guyghost/swarm-dao-herdr-adapter": minor
"@guyghost/swarm-dao-opencode-adapter": minor
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-cli": minor
---

Agent runtime configuration: per-agent LLM model and harness (pi, claude, codex, copilot, opencode).

- Core: `runtime.defaultHarness` / `runtime.harnessModelFlag` project config, `harness` agent frontmatter, deterministic resolution (D1: agent → project → host default), typed E1–E5 failures surfaced per-agent instead of throwing. Runtime resolution activates only when a signal exists — hosts that never opted in keep the legacy dispatch.
- Adapters: herdr spawns `harness <kind> -- <args> --model <model>`; tmux supports per-agent `agentCommands`; pi enforces the host boundary (only "pi" harness); opencode/mcp declare their host default.
- CLI: `dao child` gains `--harness-model-flag`, tmux `agentCommands`, and the kind fallback chain `--kind` → `herdr.kind` → `runtime.defaultHarness` → `pi`.
