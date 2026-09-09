---
"@guyghost/swarm-dao-improvement": patch
---

improvement workers: state-detection-free transcript harvest (#148)

herdr state detection misreads busy coding-agent panes: `agent prompt --wait`
reports agent_prompt_stalled with a frozen state_change_seq while the worker
works, and grace-poll recovery re-prompts a live worker (double submission) —
0% worker success under load. Workers now submit the prompt WITHOUT --wait and
poll `herdr agent read` until the transcript's last JSON object satisfies the
worker contract (resolved value, non-placeholder evidence — the echoed prompt
template is rejected) or the output settles (4 identical non-empty polls).
Blocked-agent detection moves to the anchor layer (#145). Harvest deadline
default rises 300s → 600s (ceiling 900s): real observation work legitimately
takes 5–10 min under load. Journal/event formats are unchanged.
