// ============================================================
// Swarm DAO Core — Agent Charter (layered constitution)
// ============================================================
// The swarm-forge constitution pattern, adapted to the DAO: every agent
// prompt is composed from layers instead of repeating shared law —
//
//   1. AGENT_CHARTER   — shared law: deliberation conduct + the exact
//                        output format the tally parses (defined ONCE here)
//   2. role prompt     — the agent's mission and analysis checklist
//   3. project charter — .dao/agents/charter.md, appended for every agent
//   4. agent override  — the body of .dao/agents/dao-<id>.md, appended for
//                        that agent only
//
// Layers only ADD. A project cannot replace the shared charter or a role
// mission — same rule as swarm-forge's "local-* articles never replace
// shared articles". Composition is pure and deterministic.

export const AGENT_CHARTER = `You are an agent in a DAO governance swarm. The swarm deliberates proposals; the deterministic tally of member votes decides outcomes. Your output is a signal for that tally — never an authority over it.

Charter (binding on every agent, regardless of role):
- Deliberate in good faith: ground claims in evidence and state uncertainty explicitly.
- Your vote is yours alone: form it independently of other agents' votes.
- Never claim decision authority and never announce state changes — the model and the human owner decide.
- Always answer in the exact format below; the tally parses it mechanically.

Output format:
## Analysis
[Your analysis]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10] (lower = less effort)
- securityRisk: [0-10] (lower = less risk)
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`;

export interface PromptLayers {
  /** Per-project charter addendum, applied to every agent. */
  projectCharter?: string | null;
  /** Per-agent project instructions, applied to that agent only. */
  agentOverride?: string | null;
}

/**
 * Compose an agent's system prompt from its layers. Pure: the same inputs
 * always produce the same prompt, and layers can only append — never
 * replace — the shared charter or the role mission.
 */
export function composeSystemPrompt(rolePrompt: string, layers: PromptLayers = {}): string {
  const trimmedRole = rolePrompt.trim();
  const parts = [AGENT_CHARTER, trimmedRole];
  const projectCharter = layers.projectCharter?.trim();
  if (projectCharter) parts.push(`## Project Charter Addendum\n\n${projectCharter}`);
  const agentOverride = layers.agentOverride?.trim();
  if (agentOverride) parts.push(`## Project Instructions\n\n${agentOverride}`);
  return parts.join("\n\n");
}
