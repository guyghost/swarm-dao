---
"@guyghost/swarm-dao-core": patch
---

Improvement loop arbitration: the counter-veto now keys on a frozen negative-outcome set (`declined`, `fell`) instead of the single string `declined`. The veto stays prompt-vocabulary independent — a sensor phrasing drift (found by dogfood-002) can no longer silently disarm it. Outcome strings are unchanged, so journal replay stays deterministic. Governed by Graph Engineering run `ge-arbitration-vocabulary` (model hash `417bfd8b…`).
