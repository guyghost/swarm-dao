---
"@guyghost/swarm-dao-pi-adapter": patch
---

Fix `/dao` commands silently doing nothing in Pi: command handlers returned a string, but Pi's real `registerCommand` contract is `Promise<void>` — the return value is discarded in every mode, so `/dao help`, `/dao status`, `/dao list`, etc. produced no visible output. Output is now rendered explicitly: interactive sessions get a focused bordered panel (Enter/Esc to close) via `ctx.ui.custom`; headless hosts (print mode) expose a `ui.custom` that resolves without ever invoking the component factory — detecting that signal selects a process-write fallback, the only channel those hosts leave visible (Pi's output guard redirects process writes to stderr to protect the stdout stream). Verified end-to-end against the real `pi` binary in print mode.
