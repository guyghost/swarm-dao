---
"@guyghost/swarm-dao-cli": minor
---

`watch` live pane and `improve cancel-cycle`.

- `watch [--interval <s>] [--once]`: one screen refreshed live — pending human gates with runnable commands, cooldown countdowns, in-flight runs. Ctrl-C exits cleanly; `--once` renders a single frame for scripts and non-TTY contexts.
- `improve cancel-cycle --cycle-id <id> --reason <text>`: terminal human gate for standalone cycles (CANCEL), completing the gate command set.
