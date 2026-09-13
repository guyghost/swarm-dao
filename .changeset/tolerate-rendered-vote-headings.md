---
"@guyghost/swarm-dao-core": patch
---

Fix vote tally harvesting 0 votes from rendering TUIs (herdr + pi, issue #178): the `## Vote` / `## Reasoning` heading patterns now also accept the rendered form a terminal leaves on screen (`Vote`, `  Vote:`, `Reasoning`) where the `##` glyphs are gone. Charter placeholders (`for | against | abstain`, `<for|against|abstain>`) remain inert, and the raw `## Vote` form keeps parsing as before.
