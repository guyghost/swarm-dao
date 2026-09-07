// ============================================================
// Swarm DAO CLI — parent-session detection
// ============================================================
// The CLI is the parent session that pilots herdr/tmux child sessions. To
// "behave accordingly" it detects the terminal multiplexer it runs inside:
//
//   herdr → HERDR_ENV=1 (also HERDR_WORKSPACE_ID / HERDR_PANE_ID …)
//   tmux  → TMUX set (socket path; also TMUX_PANE)
//   none  → bare shell
//
// Auto mode (the default) picks the detected multiplexer for the child
// sessions; a bare shell falls back to herdr (the established CLI default).

export type HostSession = "herdr" | "tmux" | "none";
export type ChildHost = "herdr" | "tmux";

export function detectHostSession(env: NodeJS.ProcessEnv = process.env): HostSession {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.TMUX !== undefined && env.TMUX.length > 0) return "tmux";
  return "none";
}

/** Deterministic child-session name per host (shown to the operator, and the
 *  exact name herdr/tmux create). herdr names carry a stable hash suffix
 *  (herdrAgentName); tmux names are the plain sanitized session names the
 *  tmux adapter creates. */
export function childSessionName(
  host: ChildHost,
  herdrName: (prefix: string, proposalId: number, agentId: string) => string,
  prefix: string,
  proposalId: number,
  agentId: string,
): string {
  if (host === "herdr") return herdrName(prefix, proposalId, agentId);
  return `${prefix}-p${proposalId}-${sanitizeTmuxName(agentId)}`;
}

/** Same charset/trim as the tmux adapter's sanitizeSessionName ([a-zA-Z0-9_-]). */
export function sanitizeTmuxName(raw: string): string {
  const collapsed = raw.replace(/[^a-zA-Z0-9_-]+/g, "-");
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45) start++;
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--;
  const trimmed = collapsed.slice(start, end);
  return trimmed.length > 0 ? trimmed : "agent";
}
