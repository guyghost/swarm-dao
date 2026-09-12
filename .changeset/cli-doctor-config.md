---
"@guyghost/swarm-dao-cli": patch
---

doctor: validate .dao/config.json strictly (await loadConfig on the real dao root). Invalid config is a failing check with the fix hint; enforce-without-criticalPaths is a warning. Previously the check was un-awaited, pointed at the wrong path, and swallowed errors.
