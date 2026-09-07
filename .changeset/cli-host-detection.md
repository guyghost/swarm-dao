---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": minor
---

The CLI detects the terminal multiplexer it runs inside and behaves accordingly. `HERDR_ENV=1` → herdr parent session, `TMUX` → tmux parent session, bare shell → herdr default. The multi-agent flows (`deliberate`, `roundtable`, `implement`) resolve their child-session host via a new `--host <herdr|tmux|auto>` flag (`auto` follows detection): inside tmux the children become tmux sessions running the operator-owned `tmux.command` from a new typed `tmux` section of `.dao/config.json` (fail-fast with setup guidance when unset), and the attach hint matches the host (`herdr` / `tmux attach -t <session>`). Child names are previewed with the exact names each host creates.
