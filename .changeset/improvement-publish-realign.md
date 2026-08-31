---
"@guyghost/swarm-dao-improvement": patch
---

Realign npm publishing after the 0.2.1 collision: the first CI publish (0.2.0) failed with E404 because npm Trusted Publishing cannot create a new package, and 0.2.1 was published manually while configuring the Trusted Publisher — colliding with the automated Version Packages release. This patch lets CI publish 0.2.2 and exercises the OIDC trusted-publisher path end-to-end for this package.
