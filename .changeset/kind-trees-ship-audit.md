---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-cli": patch
---

Add the opt-in ship audit challenge (swarm-forge's AUDIT_REQUIRED adapted to shipping): with `ship.auditChallenge: true` in `.dao/config.json`, the first `dao_ship`/`swarm-dao ship` call returns `AUDIT_REQUIRED` instead of executing; only an unchanged second call executes, bound to a deterministic fingerprint of the decision content (votes, gates, scope). Any change re-issues the challenge; a confirmation is single-use (spent on one execution attempt); `--force` is an explicit, recorded human bypass. Pure `ship-audit.machine.ts` (no AI role — confirmation is a deterministic property of two identical requests), an `FsShipAuditStore` under `.dao/ship-audits/`, wired into the host ship handler and the CLI. Gated through the Graph Engineering change-control ceremony (run `ship-audit-1`, model hash approved by the owner). Anchors: `shipaudit:validate`, `shipaudit:demo`, `shipaudit:regression`.
