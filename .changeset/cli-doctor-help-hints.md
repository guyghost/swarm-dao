---
"@guyghost/swarm-dao-cli": minor
---

CLI onboarding and guidance (UX lot 3).

- `doctor`: one-command diagnostic — runtime, git, herdr worker agents, docker sandbox, DAO storage, improvement config, evidence roots, pending human gates — each green/yellow/red with the fix; exits 1 when a gate is pending.
- Per-command help: `swarm-dao <command> --help` prints that command's usage (exit 0) instead of falling into an error.
- Next-step hints: `propose`, `vote`, and `improve init` end with the exact follow-up command (dimmed `→ next:` line).
