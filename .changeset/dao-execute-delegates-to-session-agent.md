---
"@guyghost/swarm-dao-core": patch
"@guyghost/swarm-dao-pi-adapter": patch
---

`/dao execute` now hands the work to the session agent instead of silently doing nothing. Two compounding defects: (1) the pi slash-command path rendered the execution result in a UI panel that never reaches the session LLM, so `dao_execute` marked the proposal `executed` and nobody implemented anything; (2) the result text named only a branch, never the isolated workspace path, so the agent could not know where to work. `ExecuteProposalUseCase` now returns the workspace path, `presentExecution` renders it with an explicit begin-implementation directive (workspace, branch, plan, ship step), and the pi `/dao` dispatcher injects execute results into the conversation (`pi.sendMessage`, triggerTurn) so implementation starts immediately. Also stops `/dao rollback` from reporting a rollback that never happened: the use case performs no git operations and the execution snapshot carries no recoverable commit, so it now refuses with the manual-restore path instead of a false "Rollback Successful".
