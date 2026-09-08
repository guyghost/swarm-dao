---
"@guyghost/swarm-dao-herdr-adapter": patch
"@guyghost/swarm-dao-improvement": patch
---

restore the worker state-reporter fix and parent-linked child sessions

The changeset-release merge (#147) resolved against a stale release branch
and reverted these src changes while keeping their version bumps, so main
briefly published changelog entries for code it no longer contained. This
changeset re-declares the restored worker-reliability and child-session
linkage code that the merge dropped.
