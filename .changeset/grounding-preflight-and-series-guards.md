---
"@guyghost/swarm-dao-improvement": patch
"@guyghost/swarm-dao-cli": patch
---

Grounding preflight and series-identity guards (issues #143, #144). Anchors now refuse to run on a dirty working tree: the grounding step checks `git status --porcelain` first and aborts with the offending path list, so worker debris or operator edits surface as a clear preflight error instead of false anchor failures and burned retries (non-git work directories keep the previous behavior). On the CLI side, `improve status/once/submit` fail with the resolved evidence-root path when the series does not exist there instead of answering from a phantom fresh idle snapshot, and `improve init` refuses an existing journal unless `--force` is passed — replay is never a clean slate, so a fresh series needs a new id while `--force` explicitly acknowledges resuming the recorded state.
