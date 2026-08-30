---
"@guyghost/swarm-dao-core": minor
---

Add opt-in sequential (pipeline) deliberation: `deliberation.strategy: "sequential"` in `.dao/config.json` runs agents in registry order, one at a time, each receiving a `## Prior Analyses` section built from the agents before it — analyses only (`extractAnalysis` strips everything from the `## Vote` heading on) and capped at `charsPerAgent` characters (default 1500), so the deterministic tally keeps its independence. Failed spawns record error outputs and the pipeline continues. Manual hosts get the pipeline protocol in the dispatch plan. Parallel remains the default; no proposal states, transitions, or AI boundaries change.
