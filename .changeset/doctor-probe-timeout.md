---
"@guyghost/swarm-dao-cli": patch
---

doctor: cut tool probes at 1.5s and run them in parallel. A binary that is
installed but wedged (docker CLI with a dead daemon) previously stalled every
doctor call for up to 10s per probe — past the 5s test timeout, so three CLI
tests hung on machines with docker present, and doctor itself felt broken.
