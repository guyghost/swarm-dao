---
"@guyghost/swarm-dao-core": minor
---

Add the improvement orchestrator: a separately modelled continuous series that runs repeated improvement loop cycles on a fixed scope and reference. It ships the series state machine (`improvement-orchestrator.machine.ts`), the reviewed model (`models/improvement-orchestrator.*`), a herdr worker executor, and a series CLI (`improvement:series:init|status|submit|once`). The orchestrator is correlation plus effect execution only — it never owns cycle state and pauses on the same human gates as the cycles it runs.
